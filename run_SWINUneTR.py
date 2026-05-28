# -*- coding: utf-8 -*-
"""
Preprocesamiento e inferencia de imagen cerebral única (NIfTI o DICOM).
Abre un explorador de archivos para seleccionar la imagen.
"""

import os
import time
import ants
import torch
import torchio as tio
import nibabel as nib
import numpy as np
import warnings
import tkinter as tk
from tkinter import filedialog
from monai.networks.nets import SwinUNETR
from monai.inferers import sliding_window_inference
from torch.amp import autocast

warnings.filterwarnings("ignore")

# ─────────────────────────────────────────────
#  CONFIGURACION DEL MODELO
# ─────────────────────────────────────────────

WEIGHTS_PATH = r"best_swin_unetr_model.pth"
PATCH_SIZE    = (96, 96, 96)
FEATURE_SIZE  = 24

BASE_DIR     = os.path.dirname(os.path.abspath(__file__))
MNI_TEMPLATE = os.path.join(BASE_DIR, "assets", "mni152", "mni_icbm152_t1_tal_nlin_sym_09a.nii.gz")
MNI_MASK     = os.path.join(BASE_DIR, "assets", "mni152", "mni_icbm152_t1_tal_nlin_sym_09a_mask.nii.gz")

# ─────────────────────────────────────────────
#  DETECCION DE MODALIDAD (T1)
# ─────────────────────────────────────────────

T1_KEYWORDS = [
    "t1", "mprage", "spgr", "bravo", "tfe", "flash",
    "3dfspgr", "ir-fspgr", "mp-rage", "t1w", "t1-weighted",
    "sagittal 3d", "t1_mpr", "t1_se", "t1_fl", "t1mprage"
]

def check_if_t1_nifti(filepath):
    """Intenta determinar si un NIfTI es T1 a partir de su nombre o header."""
    name_lower = os.path.basename(filepath).lower()
    if any(k in name_lower for k in T1_KEYWORDS):
        return True, "nombre de archivo"
    try:
        img = nib.load(filepath)
        hdr = img.header
        desc = ""
        for field in ['descrip', 'aux_file', 'intent_name']:
            try:
                val = str(hdr[field]).lower()
                desc += val
            except Exception:
                pass
        if any(k in desc for k in T1_KEYWORDS):
            return True, "header NIfTI"
    except Exception:
        pass
    return False, None

def check_if_t1_dicom(ds):
    """Intenta determinar si un DICOM es T1 a partir de sus tags."""
    fields_to_check = [
        getattr(ds, 'SeriesDescription', ''),
        getattr(ds, 'ProtocolName', ''),
        getattr(ds, 'SequenceName', ''),
        getattr(ds, 'ScanningSequence', ''),
        getattr(ds, 'ImageType', []),
        getattr(ds, 'ContrastBolusAgent', ''),
        getattr(ds, 'StudyDescription', ''),
    ]
    combined = " ".join(
        " ".join(f) if isinstance(f, (list, tuple)) else str(f)
        for f in fields_to_check
    ).lower()
    if any(k in combined for k in T1_KEYWORDS):
        return True, "tags DICOM"
    return False, None


# ─────────────────────────────────────────────
#  CARGA Y VALIDACIÓN DE ARCHIVOS
# ─────────────────────────────────────────────

def load_nifti(filepath):
    """Carga y valida que el NIfTI sea 3D. Devuelve (img_nib, is_t1, source)."""
    img = nib.load(filepath)
    shape = img.shape
    ndim = len([s for s in shape if s > 1])  # dimensiones efectivas

    # Acepta (X,Y,Z) o (X,Y,Z,1)
    if len(shape) == 4 and shape[3] == 1:
        print(f"  Imagen 4D con un solo volumen temporal — se tratará como 3D.")
    elif len(shape) != 3:
        raise ValueError(
            f"El archivo NIfTI tiene forma {shape}. "
            "Se requiere un volumen 3D (o 4D con exactamente 1 volumen temporal)."
        )

    is_t1, source = check_if_t1_nifti(filepath)
    return filepath, is_t1, source


def load_dicom_series(dcm_path):
    """
    Dado un archivo .dcm, localiza todos los DICOM de la misma serie
    en la misma carpeta, construye el volumen 3D con SimpleITK y lo
    guarda temporalmente como NIfTI. Devuelve (tmp_nifti_path, is_t1, source).
    """
    import pydicom
    import SimpleITK as sitk

    folder = os.path.dirname(dcm_path)
    selected_filename = os.path.basename(dcm_path)

    # Leer el archivo seleccionado para obtener SeriesInstanceUID
    try:
        ref_ds = pydicom.dcmread(dcm_path, stop_before_pixels=True)
        ref_series_uid = getattr(ref_ds, 'SeriesInstanceUID', None)
        ref_study_uid  = getattr(ref_ds, 'StudyInstanceUID', None)
    except Exception as e:
        raise ValueError(f"No se pudo leer el archivo DICOM seleccionado: {e}")

    # Buscar todos los .dcm en la carpeta
    all_dcm = [
        f for f in os.listdir(folder)
        if f.lower().endswith('.dcm') or f.lower().endswith('.ima')
    ]
    if len(all_dcm) < 2:
        raise ValueError(
            f"Solo se encontró {len(all_dcm)} archivo(s) DICOM en la carpeta.\n"
            "Para reconstruir un volumen 3D se necesitan múltiples cortes."
        )

    # Filtrar los que pertenecen a la misma serie
    series_files = []
    for fname in all_dcm:
        fpath = os.path.join(folder, fname)
        try:
            ds = pydicom.dcmread(fpath, stop_before_pixels=True)
            series_uid = getattr(ds, 'SeriesInstanceUID', None)
            study_uid  = getattr(ds, 'StudyInstanceUID', None)
            if ref_series_uid and series_uid == ref_series_uid:
                series_files.append(fpath)
            elif ref_study_uid and study_uid == ref_study_uid and not ref_series_uid:
                series_files.append(fpath)
        except Exception:
            continue  # omitir archivos ilegibles

    if len(series_files) < 2:
        raise ValueError(
            f"Solo se encontraron {len(series_files)} archivos DICOM de la misma serie.\n"
            "Asegúrate de que todos los cortes de la serie estén en la misma carpeta."
        )

    print(f"  Serie DICOM: {len(series_files)} cortes encontrados en la misma carpeta.")

    # Determinar T1 antes de leer píxeles
    is_t1, source = check_if_t1_dicom(ref_ds)

    # Construir volumen 3D con SimpleITK
    reader = sitk.ImageSeriesReader()
    reader.SetFileNames(sorted(series_files))
    reader.MetaDataDictionaryArrayUpdateOn()
    reader.LoadPrivateTagsOn()
    sitk_img = reader.Execute()

    vol_shape = sitk_img.GetSize()  # (X, Y, Z) en SimpleITK
    if len(vol_shape) != 3 or vol_shape[2] < 2:
        raise ValueError(
            f"El volumen reconstruido tiene forma {vol_shape[::-1]}. "
            "Se requiere un volumen 3D con al menos 2 cortes en Z."
        )
    print(f" Volumen 3D reconstruido: {vol_shape[::-1]} (Z, Y, X)")

    # Guardar como NIfTI temporal
    tmp_path = os.path.join(folder, "_tmp_dicom_vol.nii.gz")
    sitk.WriteImage(sitk_img, tmp_path)
    return tmp_path, is_t1, source


# ─────────────────────────────────────────────
#  PIPELINE ANTs
# ─────────────────────────────────────────────

def pipeline_ants_single(img_path, mni_template, mni_mask):
    img = ants.image_read(img_path)
    img = ants.reorient_image2(img, orientation="RPI")
    img_n4 = ants.n4_bias_field_correction(img, shrink_factor=3)
    tx = ants.registration(fixed=mni_template, moving=img_n4, type_of_transform='AffineFast')

    mask_solid_patient = ants.apply_transforms(
        fixed=img_n4,
        moving=mni_mask,
        transformlist=tx['fwdtransforms'],
        whichtoinvert=[True],
        interpolator='nearestNeighbor'
    )

    img_stripped = img_n4 * mask_solid_patient
    img_cropped = ants.crop_image(img_stripped, mask_solid_patient)
    img_final = ants.n4_bias_field_correction(img_cropped, shrink_factor=2)

    return img_final


# ─────────────────────────────────────────────
#  FORMATTER TorchIO (idéntico al original)
# ─────────────────────────────────────────────

dl_formatter = tio.Compose([
    tio.Resample(1.0),
    tio.RescaleIntensity(
        out_min_max=(0, 1),
        percentiles=(0.1, 99.9),
        masking_method=lambda x: x > 0
    ),
    tio.CropOrPad((160, 192, 160), padding_mode=0)
])


# ─────────────────────────────────────────────
#  SELECCIÓN DE ARCHIVO
# ─────────────────────────────────────────────

def select_file():
    """Abre un explorador de archivos y devuelve la ruta seleccionada."""
    root = tk.Tk()
    root.withdraw()
    root.lift()
    root.attributes('-topmost', True)

    filepath = filedialog.askopenfilename(
        title="Selecciona una imagen cerebral (NIfTI o DICOM)",
        filetypes=[
            ("Imagenes cerebrales", "*.nii *.nii.gz *.dcm *.ima"),
            ("NIfTI", "*.nii *.nii.gz"),
            ("DICOM", "*.dcm *.ima"),
            ("Todos los archivos", "*.*"),
        ]
    )
    root.destroy()
    return filepath


# ─────────────────────────────────────────────
#  INFERENCIA
# ─────────────────────────────────────────────

def load_model(weights_path, device):
    """Carga el Swin-UNETR con los pesos entrenados."""
    model = SwinUNETR(
        in_channels=1,
        out_channels=8,
        feature_size=FEATURE_SIZE,
        use_checkpoint=False
    ).to(device)

    model.load_state_dict(torch.load(weights_path, map_location=device))
    model.eval()
    return model


def run_inference(preprocessed_path, model, device, out_dir):
    """
    Carga la imagen preprocesada, realiza sliding window inference
    y guarda la mascara de segmentacion resultado.
    """
    filename = os.path.basename(preprocessed_path)
    mask_out_path = os.path.join(out_dir, filename.replace("DL_INF_", "MASK_"))

    subject = tio.Subject(mri=tio.ScalarImage(preprocessed_path))
    input_tensor = subject.mri.data.unsqueeze(0).to(device)

    with torch.no_grad():
        with autocast('cuda'):
            logits = sliding_window_inference(
                inputs=input_tensor,
                roi_size=PATCH_SIZE,
                sw_batch_size=4,
                predictor=model,
                overlap=0.5,
                mode="gaussian"
            )

    mask_tensor = torch.argmax(logits, dim=1, keepdim=True).cpu()
    mask_image  = tio.LabelMap(tensor=mask_tensor[0], affine=subject.mri.affine)
    mask_image.save(mask_out_path)

    return mask_out_path


if __name__ == '__main__':
    print("=" * 55)
    print("=" * 55)

    selected_path = select_file()

    if not selected_path:
        exit(0)

    print(f"\nArchivo seleccionado:\n   {selected_path}")

    ext            = selected_path.lower()
    tmp_dicom_path = None

    try:
        # --- Validacion y carga ---
        if ext.endswith('.nii') or ext.endswith('.nii.gz'):
            print("\nFormato: NIfTI")
            print("   Verificando volumen 3D...", end="", flush=True)
            nifti_path, is_t1, t1_source = load_nifti(selected_path)
            print(" OK")

        elif ext.endswith('.dcm') or ext.endswith('.ima'):
            print("\nFormato: DICOM")
            print("   Buscando cortes de la misma serie en la carpeta...")
            nifti_path, is_t1, t1_source = load_dicom_series(selected_path)
            tmp_dicom_path = nifti_path
            print("   Volumen 3D construido correctamente.")

        else:
            raise ValueError(
                "Formato no reconocido. Selecciona un archivo .nii, .nii.gz, .dcm o .ima"
            )

        # --- Modalidad T1 ---
        if is_t1:
            print(f"\nModalidad T1 confirmada (detectada por {t1_source}).")
        else:
            print("\nNo se pudo confirmar modalidad T1 (metadata ausente/anonimizada). Continuando.")

        # --- Template MNI ---
        print("\nCargando template MNI152...", end="", flush=True)
        mni_template = ants.image_read(MNI_TEMPLATE)
        mni_mask     = ants.image_read(MNI_MASK)
        print(" OK")

        # --- Rutas de salida ---
        base_name = os.path.basename(selected_path)
        for ext_strip in ('.nii.gz', '.nii', '.dcm', '.ima'):
            if base_name.lower().endswith(ext_strip):
                base_name = base_name[: -len(ext_strip)]
                break
        out_dir       = os.path.dirname(selected_path)
        prep_out_path = os.path.join(out_dir, f"DL_INF_{base_name}.nii.gz")
        temp_img_path = os.path.join(out_dir, "_temp_img.nii.gz")

        # --- Pipeline ANTs ---
        start_t = time.time()

        print("   1. Reorientacion, N4, Registro MNI y Skull Stripping...",
              end="", flush=True)
        img_ants = pipeline_ants_single(nifti_path, mni_template, mni_mask)
        ants.image_write(img_ants, temp_img_path)
        print(" OK")

        # --- TorchIO ---
        print("   2. Resample + RescaleIntensity + Crop Or Pad...",
              end="", flush=True)
        subject    = tio.Subject(mri=tio.ScalarImage(temp_img_path))
        subject_dl = dl_formatter(subject)
        subject_dl.mri.save(prep_out_path)
        print(" OK")

        prep_elapsed = time.time() - start_t
        print(f"\nPreprocesamiento completado en {prep_elapsed:.1f}s")
        print(f"Imagen preprocesada guardada en:\n   {prep_out_path}")

        # --- Carga del modelo ---
        print("\n" + "=" * 55)
        device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        print(f"   Dispositivo: {device}")

        try:
            model = load_model(WEIGHTS_PATH, device)
            print("   Pesos cargados correctamente.")
        except Exception as e:
            raise RuntimeError(f"Error al cargar los pesos del modelo: {e}")

        inf_start = time.time()

        mask_path = run_inference(prep_out_path, model, device, out_dir)

        inf_elapsed = time.time() - inf_start

        total_elapsed = time.time() - start_t
        print(f"\n{'='*55}")
        print(f"Proceso completo en {total_elapsed:.1f}s")
        print(f"Imagen preprocesada: {prep_out_path}")
        print(f"Mascara de segmentacion: {mask_path}")
        print("=" * 55)

    except ValueError as ve:
        print(f"\nError de validacion: {ve}")

    except RuntimeError as re:
        print(f"\nError de modelo: {re}")

    except Exception as e:
        print(f"\nError inesperado: {e}")
        import traceback
        traceback.print_exc()

    finally:
        for tmp in [
            tmp_dicom_path,
            os.path.join(os.path.dirname(selected_path) if selected_path else "", "_temp_img.nii.gz")
        ]:
            if tmp and os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except Exception:
                    pass
