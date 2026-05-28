# --- 1. IMPORTACIONES DE LIBRERÍAS ---
# Flask y extensiones para la aplicación web y formularios
from flask import Flask, render_template, request, redirect, url_for, jsonify, send_file
from flask import session, flash
from werkzeug.security import generate_password_hash, check_password_hash
from flask_wtf import FlaskForm, CSRFProtect
from flask_wtf.csrf import generate_csrf
from wtforms import StringField, PasswordField, SubmitField
from wtforms.validators import InputRequired, Length, EqualTo

# Utilidades del sistema y manejo de archivos
import os
import tempfile
import zipfile
from collections import defaultdict
from uuid import uuid4
from io import BytesIO

# Librerías para procesamiento científico y de imágenes
import numpy as np
import time
import shutil
import nibabel as nib
from scipy.ndimage import zoom, label
import subprocess
import json
import numpy.ma as ma
import pydicom  # Para leer archivos DICOM
import nrrd     # Para leer archivos NRRD (RT Struct)

# Librerías de visualización
import pyvista as pv
import panel as pn
import matplotlib
matplotlib.use('Agg') # Modo no interactivo para servidores
import matplotlib.pyplot as plt
from matplotlib.backends.backend_agg import FigureCanvasAgg as FigureCanvas
from matplotlib.colors import LinearSegmentedColormap

# --- CONFIGURACIÓN INICIAL DE PYVISTA ---
pv.OFF_SCREEN = True # Asegura que PyVista no intente crear ventanas visibles
pv.global_theme.jupyter_backend = 'static' # Usa un motor gráfico que no depende de la pantalla

# --- 2. CONFIGURACIÓN DE LA APLICACIÓN FLASK ---
app = Flask(__name__)

# Claves secretas para seguridad de la sesión y formularios
app.secret_key = os.environ.get("FLASK_SECRET_KEY", os.urandom(24))
app.config['WTF_CSRF_ENABLED'] = True
app.config['WTF_CSRF_SECRET_KEY'] = os.environ.get("WTF_CSRF_SECRET_KEY", app.secret_key)
csrf = CSRFProtect(app)

# --- 3. SISTEMA DE SESIÓN PARA MÚLTIPLES USUARIOS ---

# Diccionario global que funciona como un almacén en memoria para los datos de cada sesión
SERVER_SIDE_SESSION_STORE = {}

def get_user_data():
    """
    Gestiona y recupera el diccionario de datos para el usuario actual.
    Si el usuario es nuevo, le asigna un ID único y crea un espacio para sus datos.
    """
    if 'user_session_id' not in session:
        user_id = str(uuid4())
        session['user_session_id'] = user_id
        SERVER_SIDE_SESSION_STORE[user_id] = {}
    user_id = session['user_session_id']
    # setdefault asegura que si el user_id se perdió por alguna razón, se cree un dict vacío
    return SERVER_SIDE_SESSION_STORE.setdefault(user_id, {})

# --- 4. CONFIGURACIÓN Y VARIABLES GLOBALES DE LA APP ---

# Inyecta variables globales en todas las plantillas HTML para saber si el usuario está logueado
@app.context_processor
def inject_user_and_csrf():
    return {
        'user_logged_in': session.get('user_logged_in', False),
        'user_initials': session.get('user_initials', ''),
        'csrf_token': generate_csrf
    }

# Definición de carpetas para almacenar archivos subidos
UPLOAD_FOLDER = 'uploads'
UPLOAD_FOLDER_NRRD = 'upload_nrrd'
ANONIMIZADO_FOLDER = os.path.join(os.getcwd(), 'anonimizado')
# Crea las carpetas si no existen al iniciar la aplicación
for folder in [UPLOAD_FOLDER, UPLOAD_FOLDER_NRRD, ANONIMIZADO_FOLDER]:
    if not os.path.exists(folder):
        os.makedirs(folder)

def _make_seg_color(index):
    """Returns a visually distinct hex color using golden ratio hue stepping in HSV space."""
    import colorsys
    hue = (index * 0.618033988749895) % 1.0
    r, g, b = colorsys.hsv_to_rgb(hue, 0.75, 0.90)
    return '#{:02X}{:02X}{:02X}'.format(int(r * 255), int(g * 255), int(b * 255))

def _hex_to_nrrd_color(hex_color):
    """Converts a #RRGGBB hex string to a space-separated RGB float string for .seg.nrrd headers."""
    r = round(int(hex_color[1:3], 16) / 255, 6)
    g = round(int(hex_color[3:5], 16) / 255, 6)
    b = round(int(hex_color[5:7], 16) / 255, 6)
    return f"{r} {g} {b}"

def _nrrd_color_to_hex(color_str):
    """Converts a space-separated RGB float string (0.0–1.0) to an uppercase #RRGGBB hex string."""
    try:
        parts = color_str.split()
        if len(parts) != 3:
            return "#AAAAAA"
        r, g, b = int(round(float(parts[0]) * 255)), int(round(float(parts[1]) * 255)), int(round(float(parts[2]) * 255))
        return '#{:02X}{:02X}{:02X}'.format(r, g, b)
    except Exception:
        return "#AAAAAA"

def _merge_to_multilabel(segs, dims):
    """Merges separate binary segmentation masks into a single multilabel uint8 array."""
    multilabel = np.zeros(dims, dtype=np.uint8)
    sorted_keys = sorted(segs.keys())
    segment_info = []
    for label_value, key in enumerate(sorted_keys, start=1):
        seg = segs[key]
        multilabel[seg['mask'] > 0] = label_value
        segment_info.append({
            'label_value': label_value,
            'name': seg['name'],
            'color_hex': seg.get('color', '#FFFFFF')
        })
    return multilabel, segment_info

# Inicialización de Panel y Bokeh para la vista 3D
pn.extension('vtk')
bokeh_server_started = False
def start_bokeh_server(panel_layout):
    """Inicia el servidor de Bokeh en un hilo separado si aún no se ha iniciado."""
    global bokeh_server_started
    if not bokeh_server_started:
        pn.serve({'/panel': panel_layout}, show=False, allow_websocket_origin=["*"], port=5010, threaded=True)
        bokeh_server_started = True

# --- 5. LÓGICA DE VISUALIZACIÓN Y PROCESAMIENTO DICOM ---

def create_or_get_plotter(user_data):
    """
    Inicializa el plotter, procesa el volumen 3D y configura el panel.
    """
    if 'vtk_panel_column' in user_data:
        return user_data['vtk_panel_column']

    # --- 1. CREAR EL GRID (VOLUMEN 3D) ---
    # Recuperamos la imagen procesada (HU)
    dicom_image = user_data.get('Image', np.array([]))
    if dicom_image.size == 0: return None

    # Recuperamos metadatos espaciales para que no se vea aplastado
    unique_id = user_data.get("unique_id")
    series_info = user_data.get('dicom_series', {}).get(unique_id, {})
    
    # Valores por defecto seguros
    origin = series_info.get("ImagePositionPatient", [0,0,0])
    spacing_xy = series_info.get("PixelSpacing", [1, 1])
    spacing_z = series_info.get("SliceThickness", 1)
    spacing = (spacing_z, spacing_xy[0], spacing_xy[1])

    # Creamos el objeto PyVista (ImageData) con el volumen completo
    grid_full = pv.ImageData(dimensions=np.array(dicom_image.shape) + 1, origin=origin, spacing=spacing)
    grid_full.cell_data["values"] = dicom_image.flatten(order="F")
    grid_full = grid_full.cell_data_to_point_data() # Necesario para contornos y volumen
    
    # GUARDAMOS EL GRID EN LA SESIÓN
    user_data['grid_full'] = grid_full
    # -------------------------------------

    # Configuración inicial del plotter
    plotter = pv.Plotter(off_screen=True)
    plotter.set_background("black")
    plotter.enable_depth_peeling()
    
    panel_vtk = pn.pane.VTK(plotter.ren_win, width=400, height=500, name='vtk_pane')
    panel_column = pn.Column(panel_vtk)
    
    # Guardamos los componentes en la sesión
    user_data.update({
        'vtk_plotter': plotter,
        'vtk_panel': panel_vtk,
        'vtk_panel_column': panel_column
    })
    
    # Aplicamos el renderizado inicial
    initial_mode = user_data.get('render_mode', 'isosurface')
    update_3d_render(user_data, mode=initial_mode)
    
    return panel_column

def update_3d_render(user_data, mode):
    """
    Actualiza el 3D. (Lógica Ivan + Mejoras Visuales Luis)
    """
    plotter = user_data.get('vtk_plotter')
    panel_vtk = user_data.get('vtk_panel')
    grid = user_data.get('grid_full') 
    
    if not plotter or not panel_vtk or grid is None: return

    # Recuperamos el colormap actual (o 'bone' por defecto)
    current_cmap = user_data.get('current_cmap', 'bone')

    plotter.clear()

    if user_data.get('show_volume_3d', True):
        if mode == 'isosurface':
            try:
                surface_bone = grid.contour([175])
                surface_skin = grid.contour([-200])
                plotter.add_mesh(surface_bone, color="white", smooth_shading=True, name="bone")
                plotter.add_mesh(surface_skin, color="peachpuff", opacity=0.5, smooth_shading=True, name="skin")
            except:
                plotter.add_volume(grid, cmap=current_cmap, opacity="linear", blending="composite")

        elif mode == 'mip':
            plotter.add_volume(grid, cmap=current_cmap, opacity="linear", blending="maximum")

        elif mode == 'mip_inverted':
            # Forzamos el mapa de color invertido si no lo está ya
            cmap_inv = f"{current_cmap}_r" if not current_cmap.endswith('_r') else current_cmap
            plotter.add_volume(grid, cmap=cmap_inv, opacity="linear", blending="maximum")
        # ------------------------------------

        else: # Volume
            plotter.add_volume(grid, cmap=current_cmap, opacity="linear", blending="composite")

    # Re-dibujar RT Struct si existe (Lógica de Ivan intacta)
    if 'RT' in user_data and 'RT_aligned' in user_data:
        add_RT_to_plotter(user_data)
        
    # Re-dibujar Segmentación desde el sistema Multicapa
    _add_all_segmentations_to_plotter(user_data)

    plotter.view_isometric()
    try:
        panel_vtk.param.trigger('object')
    except Exception:
        pass


def add_RT_to_plotter(user_data):
    """
    Intenta añadir la máscara RT aplicando las transformaciones de ejes originales.
    """
    plotter = user_data.get('vtk_plotter')
    panel_vtk = user_data.get('vtk_panel')
    grid_full = user_data.get('grid_full') 
    
    if not all([plotter, panel_vtk, 'RT' in user_data, grid_full]): 
        return False, "Faltan datos base."

    try:
        # 1. Obtener datos crudos
        rt_data = user_data['RT'] 
        
    
        # -----------------------------------------------------

        # 2. Crear la malla a la medida de los datos YA TRANSFORMADOS
        rt_dims = np.array(rt_data.shape) + 1
        
        rt_grid = pv.ImageData(
            dimensions=rt_dims, 
            spacing=grid_full.spacing, 
            origin=grid_full.origin
        )
        
        # 3. Inyección de datos
        # Usamos flatten order="F" (Fortran-style) que es estándar para VTK/PyVista
        rt_grid.cell_data["values"] = rt_data.flatten(order="F")
        
        # Convertir a puntos para el contorno (corrección anterior)
        rt_grid = rt_grid.cell_data_to_point_data()

        # 4. Guardamos para 2D (Overlay)
        # Para el 2D, usamos la misma transformación para que coincida
        user_data['RT_aligned'] = rt_data

        # 5. Crear contorno y añadir
        surface = rt_grid.contour([0.5]) 
        
        plotter.remove_actor("rt_struct") 
        plotter.add_mesh(surface, color="red", opacity=0.5, name="rt_struct", smooth_shading=True)
        
        panel_vtk.param.trigger('object')
        
        msg = "Segmentación cargada (Ejes transformados)."
        return True, msg

    except Exception as e:
        error_msg = f"Error crítico RT: {str(e)}"
        print(error_msg)
        return False, error_msg
    
def _add_all_segmentations_to_plotter(user_data):
    plotter = user_data.get('vtk_plotter')
    panel_vtk = user_data.get('vtk_panel')
    grid_full = user_data.get('grid_full')

    if not plotter or not panel_vtk or grid_full is None:
        return

    segmentations = user_data.get('segmentations', {})
    if not segmentations:
        return

    for seg_id, seg_entry in segmentations.items():
        if not seg_entry.get('visible', True):
            continue
        mask = seg_entry.get('mask')
        if mask is None or np.max(mask) == 0:
            continue
        seg_grid = pv.ImageData(
            dimensions=np.array(mask.shape) + 1,
            spacing=grid_full.spacing,
            origin=grid_full.origin
        )
        seg_grid.cell_data["values"] = mask.flatten(order="F")
        seg_grid = seg_grid.cell_data_to_point_data()
        surface = seg_grid.contour([1.0])
        if surface.n_points == 0:
            continue
        plotter.add_mesh(surface, color=seg_entry['color'], opacity=0.8, name=f"seg_{seg_id}", smooth_shading=True)

def _extract_spacing_for_series(unique_id, user_data):
    """Calcula el espaciado entre píxeles (dx, dy, dz) de forma robusta."""
    files = user_data['dicom_series'][unique_id]["ruta_archivos"]
    dx, dy, dz = 1.0, 1.0, 1.0
    try:
        ds0 = pydicom.dcmread(files[0], stop_before_pixels=True, force=True)
        ps = getattr(ds0, "PixelSpacing", [1.0, 1.0]); dy, dx = float(ps[0]), float(ps[1])
    except Exception: pass
    zs = [float(pydicom.dcmread(p, stop_before_pixels=True, force=True).ImagePositionPatient[2]) for p in files if hasattr(pydicom.dcmread(p, stop_before_pixels=True, force=True), 'ImagePositionPatient')]
    if len(zs) >= 2:
        diffs = np.diff(sorted(zs)); dz = float(np.median(diffs)) if diffs.size > 0 else 1.0
    else:
        try: dz = float(user_data['dicom_series'][unique_id].get("SliceThickness", 1.0))
        except: dz = 1.0
    dx, dy, dz = [val if np.isfinite(val) and val > 0 else 1.0 for val in (dx, dy, dz)]
    return dx, dy, dz

def _compute_view_scales(dx, dy, dz):
    """Calcula factores de escala para que las imágenes no se vean distorsionadas."""
    eps = 1e-8; return max(eps, dy / dx), max(eps, dz / dx), max(eps, dz / dy)

def _slice_2d_and_target_size(view, index, user_data):
    """Extrae un corte 2D de un volumen 3D para una vista y capa específicas."""
    vol = user_data.get("volume_raw"); dims = user_data.get("dims")
    if vol is None or dims is None: return None, None, None
    Z, Y, X = dims
    v = "sagittal" if view.lower() == "sagital" else view.lower()
    # Return actual voxel dimensions - CSS will handle aspect ratio scaling
    if v == "axial" and 0 <= index < Z: img = vol[index, :, :]; w, h = X, Y
    elif v == "coronal" and 0 <= index < Y: img = vol[:, index, :]; w, h = X, Z
    elif v == "sagittal" and 0 <= index < X: img = vol[:, :, index]; w, h = Y, Z
    else: return None, None, None
    return img, max(1, int(w)), max(1, int(h))

# DICOM LPS patient coordinate system: X+=Left, Y+=Posterior, Z+=Superior.
_AXIS_LABELS = {
    0: ('L', 'R'),  # X+ → Left (patient),  X- → Right
    1: ('P', 'A'),  # Y+ → Posterior,        Y- → Anterior
    2: ('S', 'I'),  # Z+ → Superior,         Z- → Inferior
}

def _cosine_to_label(v):
    """Return the anatomical direction label for a 3-element LPS cosine vector."""
    v = list(v)
    dominant = max(range(3), key=lambda i: abs(v[i]))
    pos_label, neg_label = _AXIS_LABELS[dominant]
    return pos_label if v[dominant] >= 0 else neg_label

def compute_orientation_labels(iop):
    """
    Given ImageOrientationPatient (6 floats: row_cos[3] + col_cos[3]),
    return edge labels for all three standard MPR views.

    row vector: goes left→right across the image plane.
    col vector: goes top→bottom down the image plane.
    normal = row × col: points along the slice-stack axis (first slice → last slice).

    Radiological convention for axial/coronal: left of screen = patient's right.
    Volume is sorted ascending by InstanceNumber; for typical HFS acquisitions
    the stack direction is head→feet, so normal[2]>0 (Z+) maps to superior-at-top
    in coronal/sagittal without sign inversion.
    """
    row = iop[:3]
    col = iop[3:]
    normal = [
        row[1]*col[2] - row[2]*col[1],
        row[2]*col[0] - row[0]*col[2],
        row[0]*col[1] - row[1]*col[0],
    ]
    neg = lambda v: [-x for x in v]

    return {
        # vol[z, :, :] → displayed as (Y rows top→bottom, X cols left→right)
        # Radiological: left of image = patient right → neg(row) at left, row at right
        'axial':   {'top':    _cosine_to_label(neg(col)),
                    'bottom': _cosine_to_label(col),
                    'left':   _cosine_to_label(neg(row)),
                    'right':  _cosine_to_label(row)},
        # vol[:, y, :] → displayed as (Z rows top→bottom, X cols left→right)
        # vol index 0 = first InstanceNumber = most superior for HFS → top = normal direction
        'coronal': {'top':    _cosine_to_label(normal),
                    'bottom': _cosine_to_label(neg(normal)),
                    'left':   _cosine_to_label(neg(row)),
                    'right':  _cosine_to_label(row)},
        # vol[:, :, x] → displayed as (Z rows top→bottom, Y cols left→right)
        'sagital': {'top':    _cosine_to_label(normal),
                    'bottom': _cosine_to_label(neg(normal)),
                    'left':   _cosine_to_label(neg(col)),
                    'right':  _cosine_to_label(col)},
    }

def process_dicom_folder(directory, user_data):
    """Lee una carpeta de archivos, los agrupa por series y extrae metadatos clave."""
    dicom_series = defaultdict(lambda: {
        "ruta_archivos": [], "slices": [], "Anonimize": {
            'PatientName': '', 'PatientID': '', 'PatientBirthDate': '', 'PatientSex': '', 'PatientAge': '',
            'StudyDate': '', 'StudyTime': '', 'AccessionNumber': '', 'ReferringPhysicianName': '',
            'MedicalRecordLocator': '', 'InstitutionName': '', 'InstitutionAddress': '',
            'StudyDescription': '', 'SeriesDescription': '', 'OperatorName': '', 'SeriesNumber': '', 'InstanceNumber': ''
        }})
    
    loaded_series = set()
    for file_path in directory:
        try:
            dicom_data = pydicom.dcmread(file_path, force=True)
            unique_id = f"{dicom_data.StudyInstanceUID}-{dicom_data.SeriesInstanceUID}"
            series = dicom_series[unique_id]
            series["ruta_archivos"].append(file_path)

            if unique_id not in loaded_series: # Solo llenar metadatos una vez por serie
                loaded_series.add(unique_id)
                series["paciente"] = str(dicom_data.PatientName)
                series["RescaleSlope"] = dicom_data.RescaleSlope
                series["RescaleIntercept"] = dicom_data.RescaleIntercept
                series["ImagePositionPatient"] = dicom_data.ImagePositionPatient
                series["PixelSpacing"] = dicom_data.PixelSpacing
                series["SliceThickness"] = dicom_data.get("SliceThickness", 1)
                series["Modality"] = str(getattr(dicom_data, 'Modality', 'CT'))
                iop_raw = getattr(dicom_data, 'ImageOrientationPatient', None)
                series["ImageOrientationPatient"] = [float(x) for x in iop_raw] if iop_raw is not None else None
                # WindowCenter/WindowWidth may hold multiple presets (MultiValue); always take the first.
                _wc = getattr(dicom_data, 'WindowCenter', None)
                _ww = getattr(dicom_data, 'WindowWidth', None)
                try:
                    series["WindowCenter"] = float(_wc[0]) if hasattr(_wc, '__len__') else float(_wc) if _wc is not None else None
                except (TypeError, ValueError):
                    series["WindowCenter"] = None
                try:
                    series["WindowWidth"] = float(_ww[0]) if hasattr(_ww, '__len__') else float(_ww) if _ww is not None else None
                except (TypeError, ValueError):
                    series["WindowWidth"] = None
                for tag in series["Anonimize"]:
                    if hasattr(dicom_data, tag):
                        value = getattr(dicom_data, tag)
                        series["Anonimize"][tag] = str(value) if value is not None else ''
        except Exception:
            continue

    for uid, series in dicom_series.items():
        if series["ruta_archivos"]:
            dcm = pydicom.dcmread(series["ruta_archivos"][0])
            series["dimensiones"] = (len(series["ruta_archivos"]), dcm.Rows, dcm.Columns)
            series["tipo"] = "3D" if len(series["ruta_archivos"]) > 1 else "2D"

    user_data['dicom_series'] = dict(dicom_series)
    return user_data['dicom_series']
    
# --- 6. RUTAS DE LA APLICACIÓN WEB ---

@app.route("/")
def home():
    """Ruta principal, muestra la página de inicio."""
    return render_template('index.html')

@app.route('/loadDicom', methods=['GET', 'POST'])
def loadDicom():
    """Maneja la subida de la carpeta de archivos DICOM."""
    user_data = get_user_data()
    if request.method == 'POST':
        folder = request.files.getlist('folder')
        if not folder: return redirect(request.url)
        saved_files = []
        for file in folder:
            file_path = os.path.join(UPLOAD_FOLDER, os.path.basename(file.filename))
            file.save(file_path)
            saved_files.append(file_path)
        dicom_series = process_dicom_folder(saved_files, user_data)
        return render_template('resultsTableDicom.html', dicom_series=dicom_series)
    return render_template('loadDicom.html')
    
@app.route('/loadDicomMetadata/<unique_id>')
def load_dicom_metadata(unique_id):
    """Carga los metadatos de la serie seleccionada (llamado por AJAX desde la tabla de resultados)."""
    user_data = get_user_data()
    dicom_series = user_data.get('dicom_series', {})
    if unique_id not in dicom_series: return jsonify({"error": "ID de serie no encontrado"}), 404
    first_file_data = pydicom.dcmread(dicom_series[unique_id]["ruta_archivos"][0], force=True)
    return jsonify({"metadata": str(first_file_data.PatientName)})

@app.route('/process_selected_dicom', methods=['POST'])
def process_selected_dicom():
    """
    Procesa la serie DICOM seleccionada.
    CORRECCIÓN: Actualiza el volumen 3D existente en lugar de borrarlo, 
    para que el servidor no pierda la conexión.
    """
    user_data = get_user_data()
    unique_id = request.json.get('unique_id')
    user_data["unique_id"] = unique_id
    
    if not unique_id or not user_data.get('dicom_series'): 
        return jsonify({"error": "Datos inválidos"}), 400
    
    # 1. Cargar los nuevos datos 2D
    files = user_data['dicom_series'][unique_id]["ruta_archivos"]
    slices = sorted([(int(pydicom.dcmread(f).InstanceNumber), pydicom.dcmread(f).pixel_array) for f in files])
    volume_raw = np.array([s[1] for s in slices])
    user_data['dicom_series'][unique_id]["slices"] = volume_raw
    
    if volume_raw.size == 0: return jsonify({"error": "Serie sin slices"}), 400
    
    # Metadatos básicos
    slope = float(user_data['dicom_series'][unique_id].get("RescaleSlope", 1.0))
    intercept = float(user_data['dicom_series'][unique_id].get("RescaleIntercept", 0.0))
    dx, dy, dz = _extract_spacing_for_series(unique_id, user_data)
    s_ax, s_co, s_sa = _compute_view_scales(dx, dy, dz)
    
    # Actualizar sesión
    user_data.update({
        "volume_raw": volume_raw.astype(np.int16),
        "dims": volume_raw.shape,
        "slope": slope, "intercept": intercept,
        "Image": (volume_raw * slope + intercept).astype(np.int16),
        "scale_axial": s_ax, "scale_coronal": s_co, "scale_sagittal": s_sa
    })

    # --- DISPLAY CONFIGURATION (Modality-aware windowing) ---
    series_meta = user_data['dicom_series'][unique_id]
    modality = series_meta.get('Modality', 'CT')
    dicom_wc = series_meta.get('WindowCenter')
    dicom_ww = series_meta.get('WindowWidth')

    image_flat = user_data['Image'].flatten().astype(np.float32)
    # Scanner background is zero-padded; excluding zeros prevents skewed percentiles.
    non_zero = image_flat[image_flat != 0]
    if non_zero.size == 0:
        non_zero = image_flat

    p0_5  = float(np.percentile(non_zero, 0.5))
    p2    = float(np.percentile(non_zero, 2))
    p98   = float(np.percentile(non_zero, 98))
    p99_5 = float(np.percentile(non_zero, 99.5))

    display_min = p0_5
    display_max = p99_5
    auto_wc = (p2 + p98) / 2.0
    auto_ww = float(p98 - p2)

    # Priority: DICOM-embedded window tags → CT physics default → percentile auto-window.
    if dicom_wc is not None and dicom_ww is not None:
        initial_wc, initial_ww = dicom_wc, dicom_ww
    elif modality == 'CT':
        initial_wc, initial_ww = 40.0, 400.0
    else:
        initial_wc, initial_ww = auto_wc, auto_ww

    iop = series_meta.get('ImageOrientationPatient')
    orientation_labels = compute_orientation_labels(iop) if iop is not None else None

    user_data.update({
        'modality':           modality,
        'initial_wc':         initial_wc,
        'initial_ww':         initial_ww,
        'display_min':        display_min,
        'display_max':        display_max,
        'orientation_labels': orientation_labels,
    })
    # ---------------------------------------------------------

    # Initialize segmentation data model
    user_data['segmentations'] = {}
    user_data['active_segmentation_id'] = None
    user_data['brush_size'] = 1
    user_data['paint_mode'] = 'paint'
    user_data['show_volume_3d'] = True

    # --- CORRECCIÓN CLAVE: REGENERAR EL GRID 3D AQUÍ ---
    # En lugar de borrar 'vtk_panel_column', actualizamos 'grid_full'
    
    series_info = user_data['dicom_series'][unique_id]
    origin = series_info.get("ImagePositionPatient", [0,0,0])
    spacing = (dz, dy, dx) # Z, Y, X (Ajustado a tu lógica de spacing)

    # Crear nuevo grid con el NUEVO paciente
    grid_full = pv.ImageData(dimensions=np.array(volume_raw.shape) + 1, origin=origin, spacing=spacing)
    image_hu = user_data['Image']
    grid_full.cell_data["values"] = image_hu.flatten(order="F")
    grid_full = grid_full.cell_data_to_point_data()
    
    # Guardar el nuevo grid en la sesión
    user_data['grid_full'] = grid_full
    
    # Si el visor 3D ya existía, forzamos su actualización visual AHORA MISMO
    if 'vtk_plotter' in user_data:
        # Limpiamos cualquier RT Struct viejo que hubiera
        user_data.pop('RT', None)
        user_data.pop('RT_aligned', None)
        
        # Redibujamos la escena con el nuevo paciente
        current_mode = user_data.get('render_mode', 'isosurface')
        update_3d_render(user_data, mode=current_mode)
        
    return jsonify({"mensaje": "Ok"})

@app.route('/get_histogram')
def get_histogram():
    """Histograma estilo ITK-SNAP: rango y segmentos anatómicos adaptados a la modalidad."""
    user_data = get_user_data()
    image = user_data.get('Image')
    if image is None: return jsonify({"error": "No hay imagen"}), 404
    try:
        pixel_data = image.flatten()
        modality    = user_data.get('modality', 'CT')
        display_min = user_data.get('display_min', -1024)
        display_max = user_data.get('display_max', 1000)
        num_bins = 300

        valid_pixels = pixel_data[(pixel_data >= display_min) & (pixel_data <= display_max)]
        counts, bin_edges = np.histogram(valid_pixels, bins=num_bins, range=[display_min, display_max])

        # HU-based anatomical thresholds are physically meaningful only for CT.
        segments = {}
        if modality == 'CT':
            segments = {
                "Aire":   int(np.sum(valid_pixels < -300)),
                "Grasa":  int(np.sum((valid_pixels >= -120) & (valid_pixels < -30))),
                "Tejido": int(np.sum((valid_pixels >= 30)   & (valid_pixels < 60))),
                "Hueso":  int(np.sum(valid_pixels > 300))
            }

        return jsonify({
            "mode":        "tissue",
            "counts":      counts.tolist(),
            "bin_edges":   bin_edges.tolist(),
            "segments":    segments,
            "range":       [display_min, display_max],
            "modality":    modality,
            "display_min": display_min,
            "display_max": display_max,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/get_dicom_metadata')
def get_dicom_metadata():
    """
    Devuelve metadatos técnicos COMPLETOS para la ficha técnica.
    """
    user_data = get_user_data()
    uid = user_data.get('unique_id')
    if not uid: return jsonify({"error": "No data"}), 400
    try:
        files = user_data['dicom_series'][uid]["ruta_archivos"]
        ds = pydicom.dcmread(files[0], stop_before_pixels=True)
        
        # Recuperar geometría (Necesaria para Inspector, pero oculta en tabla)
        grid = user_data.get('grid_full')
        if grid:
            spacing = list(grid.spacing) 
            origin = list(grid.origin)
        else:
            spacing = [1.0, 1.0, 1.0]
            origin = [0.0, 0.0, 0.0]
        
        # --- DICCIONARIO COMPLETO (En Español) ---
        metadata = {
            "Paciente": str(ds.get("PatientName", "Anónimo")), 
            "ID Paciente": str(ds.get("PatientID", "-")),
            "Modalidad": str(ds.get("Modality", "N/A")), 
            "Fecha Estudio": str(ds.get("StudyDate", "N/A")),
            "Institución": str(ds.get("InstitutionName", "-")),
            "Fabricante": str(ds.get("Manufacturer", "-")),
            "Modelo": str(ds.get("ManufacturerModelName", "-")),
            "KVp (Voltaje)": str(ds.get("KVP", "-")),
            "mA (Corriente)": str(ds.get("XRayTubeCurrent", "-")),
            "Tiempo Exp.": str(ds.get("ExposureTime", "-")),
            "Espesor Corte": f"{ds.get('SliceThickness', 0)} mm",
            "Ubicación": f"{ds.get('SliceLocation', '-')}",
            "Matriz": f"{ds.get('Rows', 0)} x {ds.get('Columns', 0)}",
            
            # Datos técnicos internos (El JS los filtra para no mostrarlos en la tabla)
            "Spacing": spacing, 
            "Origin": origin
        }
        return jsonify(metadata)
    except Exception as e:
        print(f"Error metadata: {e}") 
        return jsonify({"error": "Error"}), 500

@app.route("/render/<render>")
def render(render): 
    """Muestra la página principal del visor con los 4 cuadrantes."""
    user_data = get_user_data()
    image = user_data.get('Image')
    if image is None or image.size == 0:
        return render_template("render.html", success=0)
    
    # Obtiene o crea el plotter y el layout de panel
    panel_layout = create_or_get_plotter(user_data)
    
    # Inicia el servidor de Bokeh si es la primera vez
    if panel_layout:
        start_bokeh_server(panel_layout)
        
    dims = user_data.get("dims", (1, 1, 1))
    # Pasamos la variable 'render' a la plantilla
    current_mode = user_data.get('render_mode', 'isosurface')

    # El cambio clave está aquí: 'render=render_type' se convierte en 'render=render'
    return render_template("render.html", success=1, render=render,
                           max_value_axial=dims[0] - 1,
                           max_value_coronal=dims[1] - 1,
                           max_value_sagital=dims[2] - 1,
                           current_render_mode=current_mode)

@app.route('/get_viewer_config')
def get_viewer_config():
    """Returns modality-aware windowing config for the frontend on page load."""
    user_data = get_user_data()
    required = ['modality', 'initial_wc', 'initial_ww', 'display_min', 'display_max']
    if not all(k in user_data for k in required):
        return jsonify({"error": "No volume loaded"}), 400
    return jsonify({
        'modality':           user_data['modality'],
        'initial_wc':         user_data['initial_wc'],
        'initial_ww':         user_data['initial_ww'],
        'display_min':        user_data['display_min'],
        'display_max':        user_data['display_max'],
        'orientation_labels': user_data.get('orientation_labels'),
    })

@app.route('/update_render_mode', methods=['POST'])
def update_render_mode():
    user_data = get_user_data()
    data = request.json
    
    # Guardamos los nuevos valores
    new_mode = data.get('mode')
    new_cmap = data.get('cmap') 
    
    user_data['render_mode'] = new_mode
    if new_cmap: user_data['current_cmap'] = new_cmap 

    if 'vtk_plotter' in user_data:
        update_3d_render(user_data, mode=new_mode)

    return jsonify({"status": "success"})


@app.route("/refresh_3d", methods=["POST"])
def refresh_3d():
    user_data = get_user_data()
    if 'vtk_plotter' not in user_data:
        return jsonify({"status": "no_plotter"})
    update_3d_render(user_data, user_data.get('render_mode', 'isosurface'))
    return jsonify({"status": "success"})


@app.route("/toggle_volume_3d", methods=["POST"])
def toggle_volume_3d():
    user_data = get_user_data()
    new_value = not user_data.get('show_volume_3d', True)
    user_data['show_volume_3d'] = new_value
    if 'vtk_plotter' in user_data:
        update_3d_render(user_data, user_data.get('render_mode', 'isosurface'))
    return jsonify({"status": "success", "show_volume": new_value})


@app.route("/analyze_components", methods=["POST"])
def analyze_components():
    user_data = get_user_data()
    seg_id = int(request.json['seg_id'])
    segs = user_data.get('segmentations', {})
    if seg_id not in segs:
        return jsonify({"message": "Segmentación no encontrada."}), 400
    try:
        mask = segs[seg_id]['mask']
        if np.max(mask) == 0:
            return jsonify({"total_components": 0, "top_components": [], "rest_count": 0, "rest_voxels": 0}), 200
        binary = mask > 0
        labeled_array, num_features = label(binary)
        if num_features == 0:
            return jsonify({"total_components": 0, "top_components": [], "rest_count": 0, "rest_voxels": 0}), 200
        component_sizes = np.bincount(labeled_array.ravel())[1:]
        unique_id = user_data.get('unique_id')
        dx, dy, dz = _extract_spacing_for_series(unique_id, user_data)
        voxel_mm3 = dx * dy * abs(dz)
        sorted_indices = np.argsort(component_sizes)[::-1]
        top_n = min(5, num_features)
        top_components = []
        for rank, idx in enumerate(sorted_indices[:top_n], start=1):
            size = component_sizes[idx]
            top_components.append({
                "rank": rank,
                "voxels": int(size),
                "mm3": round(float(size) * voxel_mm3, 1)
            })
        rest_count = max(0, num_features - 5)
        if num_features > 5:
            rest_voxels = int(np.sum(component_sizes[sorted_indices[5:]]))
        else:
            rest_voxels = 0
        return jsonify({
            "total_components": num_features,
            "top_components": top_components,
            "rest_count": rest_count,
            "rest_voxels": rest_voxels
        }), 200
    except Exception as e:
        return jsonify({"message": f"Error al analizar: {str(e)}"}), 500


@app.route("/clean_segmentation", methods=["POST"])
def clean_segmentation():
    user_data = get_user_data()
    seg_id = int(request.json['seg_id'])
    mode = request.json['mode']
    segs = user_data.get('segmentations', {})
    if seg_id not in segs:
        return jsonify({"message": "Segmentación no encontrada."}), 400
    mask = segs[seg_id]['mask']
    try:
        if np.max(mask) == 0:
            return jsonify({"status": "success"}), 200
        labeled_array, num_features = label(mask > 0)
        if num_features <= 1:
            return jsonify({"status": "success"}), 200
        component_sizes = np.bincount(labeled_array.ravel())[1:]
        if mode == "largest":
            largest_label = int(np.argmax(component_sizes)) + 1
            new_mask = np.where(labeled_array == largest_label, 255, 0).astype(np.uint8)
            segs[seg_id]['mask'] = new_mask
        elif mode == "threshold":
            threshold_voxels = int(request.json['threshold_voxels'])
            if threshold_voxels < 1:
                threshold_voxels = 1
            new_mask = np.zeros(mask.shape, dtype=np.uint8)
            for i, size in enumerate(component_sizes):
                if size >= threshold_voxels:
                    new_mask[labeled_array == i + 1] = 255
            segs[seg_id]['mask'] = new_mask
        segs[seg_id]['last_polygon_operation'] = None
        return jsonify({"status": "success"}), 200
    except Exception as e:
        return jsonify({"message": f"Error al limpiar: {str(e)}"}), 500


@app.route('/image/<view>/<int:layer>')
def get_image(view, layer):
    user_data = get_user_data()
    ww = request.args.get('ww', 400, type=float)
    wc = request.args.get('wc', 40, type=float)
    cmap = request.args.get('cmap', 'gray') # NUEVO PARÁMETRO

    img2d, w_px, h_px = _slice_2d_and_target_size(view, layer, user_data)
    if img2d is None: return "Error", 400

    slope = user_data.get("slope", 1.0); intercept = user_data.get("intercept", 0.0)
    hu2d = (img2d.astype(np.float32) * slope) + intercept

    # Aplicar ventana (Normalizar 0 a 1 para Matplotlib)
    lower, upper = wc - ww/2, wc + ww/2
    img_norm = (np.clip(hu2d, lower, upper) - lower) / (upper - lower) if upper > lower else np.zeros_like(hu2d)
    
    # Calcular Aspect Ratio
    dx, dy, dz = _extract_spacing_for_series(user_data.get("unique_id"), user_data)
    v_lower = view.lower()
    if v_lower == "axial": display_w, display_h = w_px, h_px
    else: display_w, display_h = w_px, int(h_px * (dz/dx))

    fig, ax = plt.subplots(figsize=(display_w/100, display_h/100), dpi=100)
    fig.subplots_adjust(left=0, right=1, top=1, bottom=0)
    
    # 1. DIBUJAR BASE CON COLORMAP (Lógica Luis)
    ax.imshow(img_norm, cmap=cmap, vmin=0, vmax=1, interpolation="lanczos", aspect='auto')
    ax.axis("off")

    # 2. OVERLAY RT STRUCT (Lógica Ivan - SE MANTIENE)
    if 'RT_aligned' in user_data:
        try:
            rt = user_data['RT_aligned']
            if v_lower == 'axial': seg = rt[layer, :, :]
            elif v_lower in ['sagital', 'sagittal']: seg = rt[:, :, layer]
            elif v_lower == 'coronal': seg = rt[:, layer, :]
            ax.imshow(ma.masked_where(seg==0, seg), cmap='Reds', alpha=0.8, aspect='auto', interpolation="nearest")
        except: pass
        
    # 3. OVERLAY SEGMENTACIONES MÚLTIPLES
    for seg_entry in user_data.get('segmentations', {}).values():
        if not seg_entry.get('visible', True):
            continue
        try:
            seg_mask = seg_entry['mask']
            if v_lower == 'axial': seg = seg_mask[layer, :, :]
            elif v_lower in ['sagital', 'sagittal']: seg = seg_mask[:, :, layer]
            elif v_lower == 'coronal': seg = seg_mask[:, layer, :]
            else: continue
            seg_cmap = LinearSegmentedColormap.from_list(f"seg_{id(seg_entry)}", ['#000000', seg_entry['color']])
            ax.imshow(ma.masked_where(seg==0, seg), cmap=seg_cmap, vmin=0, vmax=255, alpha=0.6, aspect='auto', interpolation='nearest')
        except:
            pass

    buf = BytesIO()
    fig.savefig(buf, format='png', transparent=True, pad_inches=0)
    plt.close(fig)
    buf.seek(0)
    return send_file(buf, mimetype='image/png')

@app.route("/upload_RT", methods=["POST"])
def upload_RT():
    """Maneja la subida de un archivo RT Struct y guarda sus metadatos."""
    user_data = get_user_data()
    
    file = request.files.get("file")
    if not file or file.filename == '':
        return jsonify({"status": "error", "message": "No se seleccionó ningún archivo."}), 400
    
    if not file.filename.lower().endswith('.nrrd'):
        return jsonify({"status": "error", "message": "Formato inválido. Solo se aceptan archivos .nrrd"}), 400

    try:
        filepath = os.path.join(UPLOAD_FOLDER_NRRD, file.filename)
        file.save(filepath)
        
        # --- CAMBIO IMPORTANTE: Leemos y GUARDAMOS el header ---
        rt_data, rt_header = nrrd.read(filepath)
        
        user_data['RT'] = rt_data 
        user_data['RT_header'] = rt_header # <--- Aquí está la clave de la posición
        # -------------------------------------------------------
        
        success, message = add_RT_to_plotter(user_data)
        
        if success:
            return jsonify({"status": "success", "message": message})
        else:
            return jsonify({"status": "error", "message": message}), 500

    except Exception as e:
        return jsonify({"status": "error", "message": f"Error interno: {str(e)}"}), 500

@app.route("/hu_value")
def hu_value():
    """Devuelve el valor HU en una coordenada específica."""
    user_data = get_user_data()
    vol = user_data.get("volume_raw"); dims = user_data.get("dims")
    if vol is None or dims is None: return jsonify({"error": "No hay volumen cargado"}), 500
    try:
        view, x, y, index = request.args.get("view", "").lower(), int(request.args.get("x", "-1")), int(request.args.get("y", "-1")), int(request.args.get("index", "-1"))
    except ValueError: return jsonify({"error": "Parámetros inválidos"}), 400
    Z, Y, X = dims
    if view == "sagital": view = "sagittal" # Compatibilidad
    s_ax, s_co, s_sa = user_data["scale_axial"], user_data["scale_coronal"], user_data["scale_sagittal"]
    if view == "axial": z, yy, xx = index, int(round(y / max(1e-8, s_ax))), int(round(x))
    elif view == "coronal": z, yy, xx = int(round(y / max(1e-8, s_co))), index, x
    elif view == "sagittal": z, yy, xx = int(round(y / max(1e-8, s_sa))), x, index
    else: return jsonify({"error": "Vista inválida"}), 400
    if not (0 <= z < Z and 0 <= yy < Y and 0 <= xx < X): return jsonify({"error": "Coordenadas fuera de rango"}), 400
    pv = int(vol[z, yy, xx]); hu = int(pv * user_data.get("slope", 1.0) + user_data.get("intercept", 0.0))
    return jsonify({
        "voxel": {"z": z, "y": yy, "x": xx},
        "hu": hu,
        "scales": {"axial": s_ax, "coronal": s_co, "sagittal": s_sa}
    })

@app.route("/paint_voxel", methods=["POST"])
def paint_voxel():
    """Paints or erases voxels in the segmentation mask."""
    user_data = get_user_data()
    active_id = user_data.get('active_segmentation_id')
    if active_id is None or active_id not in user_data.get('segmentations', {}):
        return jsonify({"status": "error", "message": "No hay segmentación activa"}), 400
    seg_data = user_data['segmentations'][active_id]

    # Extract parameters from JSON request
    data = request.json
    view = data.get('view', '').lower()
    xPix = data.get('xPix', -1)
    yPix = data.get('yPix', -1)
    layer = data.get('layer', -1)
    brush_size = data.get('brush_size', 1)
    mode = data.get('mode', 'paint')

    # Get segmentation mask from active segmentation
    seg_mask = seg_data['mask']
    if seg_mask is None:
        return jsonify({"status": "error", "message": "Segmentation mask not initialized"}), 500

    # Get volume dimensions
    dims = user_data.get('dims')
    if dims is None:
        return jsonify({"status": "error", "message": "Volume dimensions not found"}), 500

    Z, Y, X = dims

    # Get scaling factors
    s_ax = user_data.get('scale_axial', 1.0)
    s_co = user_data.get('scale_coronal', 1.0)
    s_sa = user_data.get('scale_sagittal', 1.0)

    # Normalize view name
    if view == "sagital":
        view = "sagittal"

    # Convert pixel coordinates to voxel coordinates (EXACT same logic as /hu_value)
    if view == "axial":
        z = layer
        yy = int(round(yPix / max(1e-8, s_ax)))
        xx = xPix
    elif view == "coronal":
        z = int(round(yPix / max(1e-8, s_co)))
        yy = layer
        xx = xPix
    elif view == "sagittal":
        z = int(round(yPix / max(1e-8, s_sa)))
        yy = xPix
        xx = layer
    else:
        return jsonify({"status": "error", "message": "Invalid view"}), 400

    # Validate voxel coordinates are within bounds
    if not (0 <= z < Z and 0 <= yy < Y and 0 <= xx < X):
        return jsonify({"status": "error", "message": "Coordinates out of range"}), 400

    # Determine paint value
    if mode == 'paint':
        paint_value = 255
    elif mode == 'erase':
        paint_value = 0
    else:
        return jsonify({"status": "error", "message": "Invalid mode"}), 400

    # Paint a 2D kernel on the current slice only
    radius = brush_size
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            ny = yy + dy
            nx = xx + dx
            if 0 <= ny < Y and 0 <= nx < X:
                seg_mask[z, ny, nx] = paint_value

    return jsonify({"status": "success"})

@app.route("/fill_polygon", methods=["POST"])
def fill_polygon():
    """Fills a polygon region in the segmentation mask."""
    try:
        from skimage.draw import polygon
    except ImportError:
        return jsonify({"status": "error", "message": "scikit-image not installed"}), 500

    user_data = get_user_data()
    active_id = user_data.get('active_segmentation_id')
    if active_id is None or active_id not in user_data.get('segmentations', {}):
        return jsonify({"status": "error", "message": "No hay segmentación activa"}), 400
    seg_data = user_data['segmentations'][active_id]

    # Extract parameters from JSON request
    data = request.json
    view = data.get('view', '').lower()
    layer = data.get('layer', -1)
    vertices = data.get('vertices', [])  # List of {xPix, yPix}
    mode = data.get('mode', 'paint')

    # Validate inputs
    if not vertices or len(vertices) < 3:
        return jsonify({"status": "error", "message": "At least 3 vertices required"}), 400

    seg_mask = seg_data['mask']
    if seg_mask is None:
        return jsonify({"status": "error", "message": "Segmentation mask not initialized"}), 500

    dims = user_data.get('dims')
    if dims is None:
        return jsonify({"status": "error", "message": "Volume dimensions not found"}), 500

    Z, Y, X = dims

    # Get scaling factors
    s_ax = user_data.get('scale_axial', 1.0)
    s_co = user_data.get('scale_coronal', 1.0)
    s_sa = user_data.get('scale_sagittal', 1.0)

    # Normalize view name
    if view == "sagital":
        view = "sagittal"

    # Extract pixel coordinates from vertices
    pixel_x = [v['xPix'] for v in vertices]
    pixel_y = [v['yPix'] for v in vertices]

    # Determine paint value
    if mode == 'paint':
        paint_value = 255
    elif mode == 'erase':
        paint_value = 0
    else:
        return jsonify({"status": "error", "message": "Invalid mode"}), 400

    # --- STORE OPERATION FOR UNDO (before modifying mask) ---
    # Store a snapshot of the mask before this operation
    seg_data['last_polygon_operation'] = {
        'view': view,
        'layer': layer,
        'vertices': vertices,
        'mode': mode,
        'mask_before': seg_mask.copy()  # Full snapshot for 1-level undo
    }

    # Convert to voxel coordinates and fill based on view
    try:
        if view == "axial":
            # Polygon in X-Y plane at Z = layer
            voxel_x = pixel_x  # Direct mapping
            voxel_y = [int(round(py / max(1e-8, s_ax))) for py in pixel_y]

            # Validate layer
            if not (0 <= layer < Z):
                return jsonify({"status": "error", "message": "Layer out of range"}), 400

            # Get polygon interior points
            rr, cc = polygon(voxel_y, voxel_x, shape=(Y, X))

            # Fill at current Z layer
            seg_mask[layer, rr, cc] = paint_value

        elif view == "coronal":
            # Polygon in X-Z plane at Y = layer
            voxel_x = pixel_x  # Direct mapping
            voxel_z = [int(round(py / max(1e-8, s_co))) for py in pixel_y]

            # Validate layer
            if not (0 <= layer < Y):
                return jsonify({"status": "error", "message": "Layer out of range"}), 400

            # Get polygon interior points (rows=Z, cols=X)
            zz, xx = polygon(voxel_z, voxel_x, shape=(Z, X))

            # Fill at current Y layer
            seg_mask[zz, layer, xx] = paint_value

        elif view == "sagittal":
            # Polygon in Y-Z plane at X = layer
            voxel_y = pixel_x  # xPix maps to Y in sagittal
            voxel_z = [int(round(py / max(1e-8, s_sa))) for py in pixel_y]

            # Validate layer
            if not (0 <= layer < X):
                return jsonify({"status": "error", "message": "Layer out of range"}), 400

            # Get polygon interior points (rows=Z, cols=Y)
            zz, yy = polygon(voxel_z, voxel_y, shape=(Z, Y))

            # Fill at current X layer
            seg_mask[zz, yy, layer] = paint_value

        else:
            return jsonify({"status": "error", "message": "Invalid view"}), 400

        return jsonify({"status": "success"})

    except Exception as e:
        return jsonify({"status": "error", "message": f"Fill failed: {str(e)}"}), 500

@app.route("/undo_last_polygon", methods=["POST"])
def undo_last_polygon():
    """Undoes the last polygon operation by restoring the mask snapshot."""
    user_data = get_user_data()
    active_id = user_data.get('active_segmentation_id')
    if active_id is None or active_id not in user_data.get('segmentations', {}):
        return jsonify({"status": "error", "message": "No hay segmentación activa"}), 400
    seg_data = user_data['segmentations'][active_id]

    last_op = seg_data.get('last_polygon_operation')

    if last_op is None:
        return jsonify({"status": "error", "message": "No operation to undo"}), 400

    seg_mask = seg_data['mask']
    if seg_mask is None:
        return jsonify({"status": "error", "message": "No segmentation mask found"}), 400

    try:
        # Restore mask to state before last polygon
        mask_before = last_op.get('mask_before')
        if mask_before is not None:
            # Copy the snapshot back to the active mask
            np.copyto(seg_mask, mask_before)

            # Clear the last operation (can only undo once)
            seg_data['last_polygon_operation'] = None

            return jsonify({"status": "success", "message": "Last polygon undone"})
        else:
            return jsonify({"status": "error", "message": "Snapshot not found"}), 500

    except Exception as e:
        return jsonify({"status": "error", "message": f"Undo failed: {str(e)}"}), 500

@app.route("/clear_segmentation", methods=["POST"])
def clear_segmentation():
    """Clears the active segmentation mask by filling it with zeros."""
    user_data = get_user_data()
    active_id = user_data.get('active_segmentation_id')
    if active_id is None or active_id not in user_data.get('segmentations', {}):
        return jsonify({"status": "error", "message": "No hay segmentación activa"}), 400
    seg_data = user_data['segmentations'][active_id]

    seg_mask = seg_data['mask']

    if seg_mask is not None:
        seg_mask.fill(0)
        # Clear undo history when clearing
        seg_data['last_polygon_operation'] = None
        return jsonify({"status": "success", "message": "Segmentation cleared"})

    return jsonify({"status": "error", "message": "No segmentation mask found"}), 400

@app.route("/get_segmentations")
def get_segmentations():
    user_data = get_user_data()
    segs = user_data.get('segmentations', {})
    if not segs:
        return jsonify({"segmentations": [], "active_id": None})
    seg_list = [
        {
            "id": sid,
            "name": s['name'],
            "color": s['color'],
            "visible": s['visible'],
            "has_undo": s['last_polygon_operation'] is not None
        }
        for sid, s in segs.items()
    ]
    return jsonify({"segmentations": seg_list, "active_id": user_data.get('active_segmentation_id')})


@app.route("/create_segmentation", methods=["POST"])
def create_segmentation():
    user_data = get_user_data()
    name = (request.json or {}).get('name', '')
    if not name.strip():
        return jsonify({"status": "error", "message": "El nombre no puede estar vacío"}), 400
    segs = user_data.get('segmentations', {})
    new_id = next(i for i in range(10000) if i not in segs)
    color = _make_seg_color(new_id)
    dims = user_data.get('dims', (1, 1, 1))
    segs[new_id] = {
        'name': name.strip(),
        'mask': np.zeros(dims, dtype=np.uint8),
        'color': color,
        'visible': True,
        'last_polygon_operation': None
    }
    user_data['active_segmentation_id'] = new_id
    seg_list = [
        {
            "id": sid,
            "name": s['name'],
            "color": s['color'],
            "visible": s['visible'],
            "has_undo": s['last_polygon_operation'] is not None
        }
        for sid, s in segs.items()
    ]
    return jsonify({
        "status": "success",
        "id": new_id,
        "name": name.strip(),
        "color": color,
        "segmentations": seg_list,
        "active_id": new_id
    })


@app.route("/delete_segmentation", methods=["POST"])
def delete_segmentation():
    user_data = get_user_data()
    seg_id = (request.json or {}).get('id')
    segs = user_data.get('segmentations', {})
    if seg_id not in segs:
        return jsonify({"status": "error", "message": "Segmentación no encontrada"}), 400
    del segs[seg_id]
    if not segs:
        user_data['active_segmentation_id'] = None
    else:
        user_data['active_segmentation_id'] = min(segs.keys())
    return jsonify({"status": "success", "new_active_id": user_data['active_segmentation_id']})


@app.route("/set_active_segmentation", methods=["POST"])
def set_active_segmentation():
    user_data = get_user_data()
    seg_id = (request.json or {}).get('id')
    segs = user_data.get('segmentations', {})
    if seg_id not in segs:
        return jsonify({"status": "error", "message": "Segmentación no encontrada"}), 400
    user_data['active_segmentation_id'] = seg_id
    has_undo = segs[seg_id]['last_polygon_operation'] is not None
    return jsonify({"status": "success", "id": seg_id, "has_undo": has_undo})


@app.route("/toggle_segmentation_visibility", methods=["POST"])
def toggle_segmentation_visibility():
    user_data = get_user_data()
    seg_id = (request.json or {}).get('id')
    segs = user_data.get('segmentations', {})
    if seg_id not in segs:
        return jsonify({"status": "error", "message": "Segmentación no encontrada"}), 400
    segs[seg_id]['visible'] = not segs[seg_id]['visible']
    return jsonify({"status": "success", "id": seg_id, "visible": segs[seg_id]['visible']})


@app.route("/export_segmentation", methods=["POST"])
def export_segmentation():
    """Exports one or all segmentation masks as NRRD file(s)."""
    user_data = get_user_data()
    active_id = user_data.get('active_segmentation_id')
    segs = user_data.get('segmentations', {})
    mode = (request.json or {}).get('mode', 'active') if request.json else 'active'

    try:
        # Get spacing information
        unique_id = user_data.get('unique_id')
        dx, dy, dz = _extract_spacing_for_series(unique_id, user_data)

        # Get origin information
        grid_full = user_data.get('grid_full')
        origin = grid_full.origin if grid_full is not None else [0, 0, 0]

        def make_header():
            return {
                'space': 'left-posterior-superior',
                'kinds': ['domain', 'domain', 'domain'],
                'space directions': [[dz, 0, 0], [0, dy, 0], [0, 0, dx]],
                'space origin': origin
            }

        if mode == 'all':
            if not segs:
                return jsonify({"status": "error", "message": "No hay segmentaciones para exportar"}), 400
            with tempfile.TemporaryDirectory() as tmpdir:
                for seg in segs.values():
                    safe_name = seg['name'].replace('/', '_').replace('\\', '_')
                    filepath = os.path.join(tmpdir, f"{safe_name}.nrrd")
                    nrrd.write(filepath, seg['mask'], make_header())
                zip_path = os.path.join(ANONIMIZADO_FOLDER, 'segmentaciones.zip')
                with zipfile.ZipFile(zip_path, 'w') as zipf:
                    for seg in segs.values():
                        safe_name = seg['name'].replace('/', '_').replace('\\', '_')
                        filepath = os.path.join(tmpdir, f"{safe_name}.nrrd")
                        zipf.write(filepath, f"{safe_name}.nrrd")
                return send_file(zip_path, as_attachment=True, download_name='segmentaciones.zip')
        elif mode == 'multilabel':
            if not segs:
                return jsonify({"status": "error", "message": "No hay segmentaciones para exportar"}), 400
            dims = user_data.get('dims')
            multilabel_array, segment_info = _merge_to_multilabel(segs, dims)
            header = {
                'space': 'left-posterior-superior',
                'kinds': ['domain', 'domain', 'domain'],
                'space directions': [[dz, 0, 0], [0, dy, 0], [0, 0, dx]],
                'space origin': origin
            }
            for N, info in enumerate(segment_info):
                header[f"Segment{N}_Name"] = info['name']
                header[f"Segment{N}_Color"] = _hex_to_nrrd_color(info['color_hex'])
                header[f"Segment{N}_LabelValue"] = str(info['label_value'])
            filepath = os.path.join(ANONIMIZADO_FOLDER, 'segmentaciones_multilabel.seg.nrrd')
            nrrd.write(filepath, multilabel_array, header)
            return send_file(filepath, as_attachment=True, download_name='segmentaciones_multilabel.seg.nrrd')
        else:
            # Active mode
            if active_id is None or active_id not in segs:
                return jsonify({"status": "error", "message": "No hay segmentación activa"}), 400
            seg_data = segs[active_id]
            seg_mask = seg_data['mask']
            seg_name = seg_data['name']
            safe_name = seg_name.replace('/', '_').replace('\\', '_')
            filepath = os.path.join(ANONIMIZADO_FOLDER, f"{safe_name}.nrrd")
            nrrd.write(filepath, seg_mask, make_header())
            return send_file(filepath, as_attachment=True, download_name=f"{safe_name}.nrrd")

    except Exception as e:
        return jsonify({"status": "error", "message": f"Export failed: {str(e)}"}), 500

@app.route("/import_segmentation", methods=["POST"])
def import_segmentation():
    """Importa un archivo .seg.nrrd multilabel y restaura las capas de segmentación."""
    user_data = get_user_data()
    file = request.files.get("file")
    if not file or file.filename == '':
        return jsonify({"status": "error", "message": "No se seleccionó ningún archivo."}), 400
    if not file.filename.lower().endswith('.nrrd'):
        return jsonify({"status": "error", "message": "Solo se aceptan archivos .nrrd"}), 400
    try:
        filepath = os.path.join(UPLOAD_FOLDER_NRRD, file.filename)
        file.save(filepath)
        data_array, header_dict = nrrd.read(filepath)
        flat = dict(header_dict)
        flat.update(header_dict.get('keyvaluepairs', {}))

        if "Segment0_LabelValue" not in flat:
            return jsonify({"status": "error", "message": "Este archivo no es una segmentación exportada. Para RT Struct, usa el botón de carga correspondiente."}), 400

        dims = user_data.get('dims')
        if dims is None:
            return jsonify({"status": "error", "message": "Carga un estudio DICOM antes de importar una segmentación."}), 400

        parsed_segments = []
        N = 0
        while True:
            if f"Segment{N}_LabelValue" not in flat:
                break
            label_value = int(flat[f"Segment{N}_LabelValue"])
            name = flat.get(f"Segment{N}_Name", f"Segmentación {N + 1}")
            color_str = flat.get(f"Segment{N}_Color", "0.667 0.667 0.667")
            hex_color = _nrrd_color_to_hex(color_str)
            parsed_segments.append({'label_value': label_value, 'name': name, 'color': hex_color})
            N += 1

        if not parsed_segments:
            return jsonify({"status": "error", "message": "El archivo no contiene segmentaciones válidas."}), 400

        Z, Y, X = dims
        for entry in parsed_segments:
            mask = (data_array == entry['label_value']).astype(np.uint8) * 255
            if mask.shape != (Z, Y, X):
                zoom_factors = (Z / mask.shape[0], Y / mask.shape[1], X / mask.shape[2])
                mask = zoom(mask, zoom_factors, order=0)
            entry['mask'] = mask

        user_data['segmentations'] = {}
        user_data['active_segmentation_id'] = None
        first_slot = None
        segs = user_data['segmentations']
        for entry in parsed_segments:
            slot = next(i for i in range(10000) if i not in segs)
            segs[slot] = {
                'name': entry['name'],
                'mask': entry['mask'],
                'color': entry['color'],
                'visible': True,
                'last_polygon_operation': None
            }
            if first_slot is None:
                first_slot = slot
        user_data['active_segmentation_id'] = first_slot

        return jsonify({"status": "success"}), 200

    except Exception as e:
        return jsonify({"status": "error", "message": f"Error al importar: {str(e)}"}), 500

@app.route('/anonimize')
def anonimize():
    """Muestra la página para anonimizar los datos DICOM."""
    user_data = get_user_data()
    dicom_series, unique_id = user_data.get('dicom_series'), user_data.get('unique_id')
    if dicom_series and unique_id:
        return render_template('anonimize.html', dicom_series=dicom_series[unique_id]['Anonimize'], success=1, unique_id=unique_id)
    return render_template('anonimize.html', success=0)

@app.route('/guardar_cambios', methods=['POST'])
def guardar_cambios():
    """Guarda los cambios de anonimización hechos por el usuario."""
    user_data = get_user_data()
    cambios = request.json.get('cambios', {})
    unique_id = user_data.get('unique_id')
    if unique_id and cambios:
        for campo, valor in cambios.items():
            if campo in user_data['dicom_series'][unique_id]['Anonimize']:
                user_data['dicom_series'][unique_id]['Anonimize'][campo] = valor
    return jsonify({"mensaje": "Cambios guardados"})

@app.route('/exportar_dicom', methods=['POST'])
def exportar_dicom():
    """Exporta la serie DICOM actual con los datos de anonimización aplicados."""
    user_data = get_user_data()
    unique_id = user_data.get('unique_id')
    if not unique_id: return jsonify({"error": "Datos inválidos"}), 400
    with tempfile.TemporaryDirectory() as tmpdir:
        out_dir = os.path.join(tmpdir, "anon"); os.makedirs(out_dir, exist_ok=True)
        for archivo in user_data['dicom_series'][unique_id]["ruta_archivos"]:
            try:
                dicom_data = pydicom.dcmread(archivo)
                for campo, valor in user_data['dicom_series'][unique_id]['Anonimize'].items():
                    if hasattr(dicom_data, campo):
                        data_element = dicom_data.data_element(campo)
                        if data_element:
                            data_element.value = valor
                dicom_data.save_as(os.path.join(out_dir, f"anonimo_{os.path.basename(archivo)}"))
            except Exception: continue
        zip_path = os.path.join(tmpdir, 'archivos_anonimizados.zip')
        with zipfile.ZipFile(zip_path, 'w') as zipf:
            for f in os.listdir(out_dir): zipf.write(os.path.join(out_dir, f), f)
        return send_file(zip_path, as_attachment=True, download_name='archivos_anonimizados.zip')

# --- 7. RUTAS DE LOGIN Y REGISTRO ---
class LoginForm(FlaskForm):
    username = StringField('Usuario', validators=[InputRequired(), Length(min=4, max=15)])
    password = PasswordField('Contraseña', validators=[InputRequired(), Length(min=4, max=20)])
    submit = SubmitField('Iniciar sesión')

class RegisterForm(FlaskForm):
    username = StringField('Usuario', validators=[InputRequired(), Length(min=4, max=15)])
    password = PasswordField('Contraseña', validators=[InputRequired(), Length(min=4, max=20)])
    confirm_password = PasswordField('Confirmar contraseña', validators=[InputRequired(), EqualTo('password')])
    submit = SubmitField('Registrarse')

usuarios = {}

@app.route('/login', methods=['GET', 'POST'])
def login():
    form = LoginForm()
    if form.validate_on_submit():
        user, password = form.username.data, form.password.data
        if user in usuarios and check_password_hash(usuarios[user], password):
            session['user_logged_in'] = True; session['user_initials'] = user[:2].upper()
            flash('Inicio de sesión exitoso', 'success'); return redirect(url_for('home'))
        else:
            flash('Usuario o contraseña incorrectos', 'danger')
    return render_template('login.html', form=form)

@app.route('/register', methods=['GET', 'POST'])
def register():
    form = RegisterForm()
    if form.validate_on_submit():
        user, password = form.username.data, form.password.data
        if user in usuarios: flash('El usuario ya existe', 'danger')
        else:
            usuarios[user] = generate_password_hash(password)
            flash('Registro exitoso. Ahora puedes iniciar sesión.', 'success'); return redirect(url_for('login'))
    return render_template('register.html', form=form)

@app.route('/logout')
def logout():
    """Limpia la sesión del usuario, incluyendo los datos del visor."""
    user_id = session.get('user_session_id')
    if user_id and user_id in SERVER_SIDE_SESSION_STORE:
        del SERVER_SIDE_SESSION_STORE[user_id]
    session.clear()
    flash('Has cerrado sesión', 'info')
    return redirect(url_for('home'))

# --- LÓGICA DE IA SWIN-UNETR ---

def _find_medaimg_python():
    """
    Localiza el ejecutable Python del entorno 'medaimg'.
    Prioridad: variable de entorno MEDAIMG_PYTHON > venv > conda.
    """
    from_env = os.environ.get("MEDAIMG_PYTHON")
    if from_env and os.path.isfile(from_env):
        return from_env

    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, "medaimg_venv", "bin", "python"),
        os.path.join(home, "medaimg_venv", "Scripts", "python.exe"),
        os.path.join(home, "anaconda3", "envs", "medaimg", "bin", "python"),
        os.path.join(home, "miniconda3", "envs", "medaimg", "bin", "python"),
        os.path.join(home, "miniforge3", "envs", "medaimg", "bin", "python"),
        os.path.join(home, "anaconda3", "envs", "medaimg", "python.exe"),
        os.path.join(home, "miniconda3", "envs", "medaimg", "python.exe"),
    ]
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None

def ejecutar_ia_swin(dicom_input_path, output_folder):
    """
    Llama al microservicio de IA usando el Python del entorno conda 'medaimg'.
    Detecta automáticamente la ruta en macOS, Linux y Windows.
    Se puede forzar con la variable de entorno MEDAIMG_PYTHON.
    """
    base_dir = os.path.dirname(os.path.abspath(__file__))

    ruta_script = os.path.join(base_dir, 'plugin_ia_swin', 'run_ai_cli.py')
    ruta_pesos = os.path.join(base_dir, 'plugin_ia_swin', 'best_swin_unetr_model.pth')

    python_ia_exe = _find_medaimg_python()
    if not python_ia_exe:
        return {"status": "error", "message": "No se encontró el entorno 'medaimg'. Instálalo con: conda env create -f plugin_ia_swin/environment_macos.yml (o environment.yml en Windows). También puedes definir la variable MEDAIMG_PYTHON con la ruta al ejecutable."}

    comando = [
        python_ia_exe, ruta_script,
        "--input", dicom_input_path,
        "--out_dir", output_folder,
        "--weights", ruta_pesos
    ]
    
    print(f"\nIniciando Motor de IA...")
    print(f"Ejecutando: {' '.join(comando)}\n")
    
    proceso = subprocess.run(comando, capture_output=True, text=True)
    
    try:
        # Buscamos la respuesta JSON en la salida
        lineas = [line for line in proceso.stdout.strip().split('\n') if line]
        if not lineas:
            raise ValueError("El script de IA no devolvió ninguna salida.")
            
        respuesta = json.loads(lineas[-1])
        return respuesta
    except Exception as e:
        print(">>> ERROR CRÍTICO EN IA <<<")
        print("STDOUT:", proceso.stdout)
        print("STDERR:", proceso.stderr)
        return {"status": "error", "message": "Fallo al ejecutar el modelo de IA. Revisa la consola."}

def normalize_ai_mask(mask_data, user_data, z_inverted=False):
    """
    Convierte una máscara del modelo IA al formato exacto del visor (Z,Y,X).
    Blindada contra inversiones anatómicas y rotaciones de 90 grados.
    """
    from scipy.ndimage import zoom
    import numpy as np

    vol = user_data.get("volume_raw")
    if vol is None:
        raise ValueError("No hay un volumen base cargado en el visor.")

    Z, Y, X = vol.shape
    mask = np.array(mask_data)

    # 1. Eliminar batch o canal extra si el modelo lo exportó (ej. [1, Z, Y, X])
    if mask.ndim == 4:
        mask = mask[0]

    # 2. SEGURO BIOMÉDICO: Invertir el eje Z si el NIfTI va en contra del DICOM
    if z_inverted:
        print("Inversión de Eje Z detectada. Corrigiendo...")
        mask = mask[::-1, :, :]

    # 3. Transposición de la librería externa (nibabel lee X,Y,Z por defecto)
    if mask.shape == (X, Y, Z):
        mask = np.transpose(mask, (2, 1, 0))
    elif mask.shape == (Y, X, Z):
        mask = np.transpose(mask, (2, 0, 1))
    elif mask.shape == (Z, X, Y):
        mask = np.transpose(mask, (0, 2, 1))

    # 4. Reescalado forzado por fuerza bruta (Zoom Nearest Neighbor)
    if mask.shape != (Z, Y, X):
        print(f"Forzando reescalado de máscara: {mask.shape} -> {(Z, Y, X)}")
        zoom_factors = (Z / mask.shape[0], Y / mask.shape[1], X / mask.shape[2])
        mask = zoom(mask, zoom_factors, order=0)

    # 5. Binarización estricta (Solo tumor visible al 100%)
    mask = (mask > 0).astype(np.uint8) * 255

    print("VOL SHAPE (Lienzo):", vol.shape)
    print("MASK SHAPE (Final):", mask.shape)

    return mask

@app.route('/api/run_ai_segmentation', methods=['POST'])
def api_run_ai_segmentation():
    user_data = get_user_data()
    unique_id = user_data.get('unique_id')
    
    if not unique_id or 'dicom_series' not in user_data or unique_id not in user_data['dicom_series']:
        return jsonify({"status": "error", "message": "No hay un estudio cargado en el visor."})
        
    rutas = user_data['dicom_series'][unique_id]["ruta_archivos"]
    if not rutas:
        return jsonify({"status": "error", "message": "No se encontraron los archivos DICOM físicos."})
        
    base_dir = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.abspath(os.path.join(base_dir, 'anonimizado', 'AI_RESULTS'))
    os.makedirs(out_dir, exist_ok=True)
    
    # Aislamiento de serie DICOM
    import shutil
    temp_dicom_dir = os.path.join(out_dir, f"temp_dicom_{unique_id}")
    os.makedirs(temp_dicom_dir, exist_ok=True)
    
    for f in os.listdir(temp_dicom_dir):
        os.remove(os.path.join(temp_dicom_dir, f))
        
    for ruta_relativa in rutas:
        src_path = os.path.abspath(os.path.join(base_dir, ruta_relativa))
        if os.path.exists(src_path):
            shutil.copy(src_path, temp_dicom_dir)
            
    dicom_input_path = temp_dicom_dir
    
    # Ejecución del microservicio
    resultado = ejecutar_ia_swin(dicom_input_path, out_dir)
    
    if resultado.get("status") == "success":
        mask_path = resultado.get("mask_path")
        
        try:
            import SimpleITK as sitk
            import pydicom
            import numpy as np
            
            # 1. LEER LA MÁSCARA ALINEADA
            # SITK devuelve directamente el formato nativo (Z, Y, X) sin rotaciones raras
            mask_sitk = sitk.ReadImage(mask_path)
            mask_data = sitk.GetArrayFromImage(mask_sitk)
            
            # 2. SINCRONIZACIÓN DEL EJE Z (El anti-código de barras)
            # Detectamos cómo ordenó tu Flask las imágenes (InstanceNumber)
            viewer_files = [os.path.abspath(os.path.join(base_dir, r)) for r in rutas]
            viewer_files_sorted = sorted(viewer_files, key=lambda f: int(pydicom.dcmread(f, stop_before_pixels=True).InstanceNumber))
            
            z_start_flask = float(pydicom.dcmread(viewer_files_sorted[0], stop_before_pixels=True).ImagePositionPatient[2])
            z_end_flask = float(pydicom.dcmread(viewer_files_sorted[-1], stop_before_pixels=True).ImagePositionPatient[2])
            flask_z_dir = z_end_flask - z_start_flask
            
            # Detectamos cómo ordenó SimpleITK las imágenes (Físicamente)
            reader = sitk.ImageSeriesReader()
            sitk_files = reader.GetGDCMSeriesFileNames(dicom_input_path)
            z_start_sitk = float(pydicom.dcmread(sitk_files[0], stop_before_pixels=True).ImagePositionPatient[2])
            z_end_sitk = float(pydicom.dcmread(sitk_files[-1], stop_before_pixels=True).ImagePositionPatient[2])
            sitk_z_dir = z_end_sitk - z_start_sitk
            
            # Si pydicom ordenó al revés que las coordenadas físicas, empatamos las matrices
            if (flask_z_dir * sitk_z_dir) < 0:
                mask_data = mask_data[::-1, :, :]
                
            # 3. SEGURO DIMENSIONAL FINAL (Zoom escalar)
            target_shape = user_data['dims']
            if mask_data.shape != target_shape:
                from scipy.ndimage import zoom
                zoom_factors = [t/m for t, m in zip(target_shape, mask_data.shape)]
                mask_data = zoom(mask_data, zoom_factors, order=0)
                
            # 4. INYECCIÓN MULTI-CLASE
            if 'segmentations' not in user_data:
                user_data['segmentations'] = {}

            segs = user_data['segmentations']

            # Inject one layer per detected class (1–7), skipping empty classes
            first_ai_slot = None
            for class_id in range(1, 8):
                class_mask = np.where(mask_data == class_id, 255, 0).astype(np.uint8)
                if not np.any(class_mask):
                    continue
                slot = next(i for i in range(10000) if i not in segs)
                segs[slot] = {
                    'name': f'IA Clase {class_id}',
                    'mask': class_mask,
                    'color': _make_seg_color(slot),
                    'visible': True,
                    'last_polygon_operation': None
                }
                if first_ai_slot is None:
                    first_ai_slot = slot

            if first_ai_slot is None:
                return jsonify({"status": "error", "message": "El modelo no detectó ninguna estructura en este volumen."})

            user_data['active_segmentation_id'] = first_ai_slot

            print(f"\n[ÉXITO] Matriz normalizada y proyectada perfectamente sin usar TorchIO Inverse.")
            return jsonify({"status": "success"})
            
        except Exception as e:
            print(f"Error crítico en inyección: {str(e)}")
            return jsonify({"status": "error", "message": f"Error de inyección: {e}"})
    else:
        return jsonify({"status": "error", "message": resultado.get("message", "Error desconocido")})

# --- 8. INICIO DE LA APLICACIÓN ---
if __name__ == '__main__':
    # Se ejecuta solo cuando el script es el punto de entrada principal
    app.run(debug=True, port=5001, threaded=False)