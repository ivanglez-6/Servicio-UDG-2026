document.addEventListener('DOMContentLoaded', function() {
    // --- ESTADO GLOBAL Y CONFIGURACIÓN ---
    const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]');
    // Agregamos { trigger: 'hover' } para que el clic no deje pegado el tooltip
    [...tooltipTriggerList].map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl, {
        trigger: 'hover' 
    }));

    // --- FUNCIÓN DEBOUNCE (Para escritura manual) ---
    function debounce(func, delay = 250) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                func.apply(this, args);
            }, delay);
        };
    }

    // --- LÓGICA PARA BOTONES PERSONALIZADOS ---
    function setupCustomSpinner(inputId, step, updateCallback) {
        const input = document.getElementById(inputId);
        const minusBtn = document.getElementById(`${inputId}-minus`);
        const plusBtn = document.getElementById(`${inputId}-plus`);

        if (!input || !minusBtn || !plusBtn) return;

        minusBtn.addEventListener('click', () => {
            const currentValue = parseFloat(input.value);
            if (isNaN(currentValue)) return;
            input.value = (currentValue - step).toFixed(input.step.includes('.') ? 1 : 0); // Respetar decimales
            // Llama a la función de actualización INMEDIATAMENTE
            updateCallback();
        });

        plusBtn.addEventListener('click', () => {
            const currentValue = parseFloat(input.value);
            if (isNaN(currentValue)) return;
            input.value = (currentValue + step).toFixed(input.step.includes('.') ? 1 : 0);
            // Llama a la función de actualización INMEDIATAMENTE
            updateCallback();
        });
    }

    // --- ESTADO GLOBAL DEL VISOR ---
    const VIEWS = ['axial', 'sagital', 'coronal'];
    const viewState = {
        ww: 400,
        wc: 40,
        baseImages: { axial: null, sagital: null, coronal: null },
        inspectorMode: false,
        segmentationMode: false,
        brushSize: 1,
        paintMode: 'paint',
        segmentationTool: 'brush', // 'brush' or 'polygon'
        scales: { axial: 1.0, coronal: 1.0, sagittal: 1.0 }, // Aspect ratio scaling factors
        colormap: 'gray',
        lastVoxel: { x: null, y: null, z: null },
        activeSegmentationId: null,
        segmentations: [],
        modality: null,
        displayMin: -1024,
        displayMax: 3071,
    };

    // --- POLYGON STATE ---
    const polygonState = {
        vertices: [],           // Array of {x, y} in internal pixel coordinates
        isDrawing: false,       // Currently drawing a polygon?
        currentView: null,      // Which view (axial/sagital/coronal)
        currentLayer: null,     // Which slice index
        lastOperation: null     // Store last polygon for undo: {view, layer, vertices, mode}
    };
    const segUndoState = {};  // {segmentationId: bool}
    const zoomState = {
        axial:   { scale: 1, panX: 0, panY: 0, isDragging: false },
        sagital: { scale: 1, panX: 0, panY: 0, isDragging: false },
        coronal: { scale: 1, panX: 0, panY: 0, isDragging: false }
    };

    // --- ESTADO DEL EDITOR DE CONTRASTE ---
    const contrastState = {
        points: [{ x: -1024, y: 0 }, { x: 3071, y: 255 }],
        activePointIndex: null,
        isDragging: false,
        histogramData: null,
        cutoff: 7.0,
        logScale: false,
        minHU: -1024,
        maxHU: 3071,
    };
    contrastState.lut = new Uint8ClampedArray(256).map((_, i) => i);

    // --- LÓGICA DE PLUGINS (Versión Limpia) ---
    function setupPluginButton(btnId, containerId, onToggleCallback) {
        const btn = document.getElementById(btnId);
        const container = containerId ? document.getElementById(containerId) : null;
        
        if (!btn) return;

        btn.addEventListener('click', () => {
            const isActive = btn.classList.contains('btn-udg-rojo');
            
            if (isActive) {
                // DESACTIVAR
                btn.classList.remove('btn-udg-rojo');
                if (container) container.style.display = 'none';
            } else {
                // ACTIVAR
                btn.classList.add('btn-udg-rojo');
                if (container) container.style.display = 'block';
            }

            if (onToggleCallback) onToggleCallback(!isActive);
        });
    }

    setupPluginButton('rtStructPluginBtn', 'rtStructPluginContainer');

    setupPluginButton('segmentationToolBtn', 'segmentationToolContainer', (isActive) => {
        viewState.segmentationMode = isActive;

        if (isActive) {
            // Change cursor to crosshair
            updateCursorStyle('crosshair');

            // Deactivate Inspector if active
            if (viewState.inspectorMode) {
                const inspectorBtn = document.getElementById('inspectorPluginBtn');
                const inspectorContainer = document.getElementById('inspectorPluginContainer');
                if (inspectorBtn) inspectorBtn.classList.remove('btn-udg-rojo');
                if (inspectorContainer) inspectorContainer.style.display = 'none';
                viewState.inspectorMode = false;
            }
        } else {
            // Clear overlays and restore cursor
            VIEWS.forEach(view => clearOverlay(view));
            updateCursorStyle('grab');
        }
    });

    setupPluginButton('windowLevelBtn', 'windowLevelControls');

    setupPluginButton('contrastEditorBtn', 'contrastEditorContainer', (isActive) => {
        if (isActive && !contrastState.histogramData) {
            fetchHistogram();
        } else {
            drawCurveAndHistogram();
        }
    });

    // Configuración del botón Inspector
    setupPluginButton('inspectorPluginBtn', 'inspectorPluginContainer', (isActive) => {
        viewState.inspectorMode = isActive;

        if (isActive) {
            // Cambiar cursor a pointer en todas las vistas
            updateCursorStyle('pointer');

            // Deactivate segmentation if active
            if (viewState.segmentationMode) {
                const segBtn = document.getElementById('segmentationToolBtn');
                const segContainer = document.getElementById('segmentationToolContainer');
                if (segBtn) segBtn.classList.remove('btn-udg-rojo');
                if (segContainer) segContainer.style.display = 'none';
                viewState.segmentationMode = false;
            }

        } else {
            // Limpiamos los canvas de todas las vistas para borrar las líneas
            VIEWS.forEach(view => clearOverlay(view));

            // Restaurar cursor a grab
            updateCursorStyle('grab');

            // Limpiar el display de resultados
            const huResult = document.getElementById('huResult');
            if (huResult) huResult.innerHTML = '-';
        }
    });

    // --- LÓGICA DE AJUSTE DE VENTANA (WW/WC) ---
    const wwSlider = document.getElementById('ww_slider');
    const wcSlider = document.getElementById('wc_slider');

    function updateWWWC(ww, wc, updateSource = null) {
        viewState.ww = Math.max(1, ww);
        viewState.wc = wc;
        
        // Actualizar la posición visual de las barras (Solo si no las estamos moviendo nosotros)
        if (updateSource !== 'sliders') {
            if(wwSlider) wwSlider.value = viewState.ww;
            if(wcSlider) wcSlider.value = viewState.wc;
        }
        
        // Actualizar los inputs numéricos de arriba (Solo si no estamos escribiendo en ellos)
        if (updateSource !== 'fields') {
            const levelIn = document.getElementById('levelInput');
            const windowIn = document.getElementById('windowInput');
            if(levelIn) levelIn.value = Math.round(viewState.wc);
            if(windowIn) windowIn.value = Math.round(viewState.ww);
        }

        //--- Actualizar SIEMPRE los textos pequeños al lado del título ---
        // Esto debe ocurrir sin importar de dónde venga el cambio
        const wwDisp = document.getElementById('ww_val_display');
        const wcDisp = document.getElementById('wc_val_display');
        if (wwDisp) wwDisp.textContent = viewState.ww;
        if (wcDisp) wcDisp.textContent = viewState.wc;
        // -----------------------------------------------------------------------------

        VIEWS.forEach(view => updateImage(view, document.getElementById(`slider_${view}`)?.value, true));
    }
    
    // El debounce se mantiene para la escritura manual en los campos.
    const debouncedUpdateFromFields = debounce((ww, wc) => {
        updateWWWC(ww, wc, 'fields');
    });

    levelInput?.addEventListener('input', () => debouncedUpdateFromFields(parseInt(windowInput.value), parseInt(levelInput.value)));
    windowInput?.addEventListener('input', () => debouncedUpdateFromFields(parseInt(windowInput.value), parseInt(levelInput.value)));
    minInput?.addEventListener('input', () => {
        const min = parseInt(minInput.value);
        const max = parseInt(maxInput.value);
        debouncedUpdateFromFields(max - min, (max + min) / 2);
    });
    maxInput?.addEventListener('input', () => {
        const min = parseInt(minInput.value);
        const max = parseInt(maxInput.value);
        debouncedUpdateFromFields(max - min, (max + min) / 2);
    });
    
    // --- LÓGICA DE PRESETS CON FEEDBACK VISUAL ---

    const ALL_PRESET_IDS = ['presetBtnLung', 'presetBtnBone', 'presetBtnSoftTissue', 'presetBtnAuto', 'presetBtnFullRange'];

    // Función para resaltar el botón activo
    function highlightPreset(activeId) {
        ALL_PRESET_IDS.forEach(id => {
            const btn = document.getElementById(id);
            if (btn) {
                btn.classList.remove('preset-active');
                btn.classList.add('btn-outline-secondary');
            }
        });
        if (activeId) {
            const activeBtn = document.getElementById(activeId);
            if (activeBtn) {
                activeBtn.classList.remove('btn-outline-secondary');
                activeBtn.classList.add('preset-active');
            }
        }
    }

    // CT Preset listeners
    document.getElementById('presetBtnLung')?.addEventListener('click', () => {
        updateWWWC(1500, -600);
        highlightPreset('presetBtnLung');
    });

    document.getElementById('presetBtnBone')?.addEventListener('click', () => {
        updateWWWC(2500, 480);
        highlightPreset('presetBtnBone');
    });

    document.getElementById('presetBtnSoftTissue')?.addEventListener('click', () => {
        updateWWWC(400, 40);
        highlightPreset('presetBtnSoftTissue');
    });

    // MRI Preset listeners
    document.getElementById('presetBtnAuto')?.addEventListener('click', () => {
        fetchViewerConfig();
        highlightPreset('presetBtnAuto');
    });

    document.getElementById('presetBtnFullRange')?.addEventListener('click', () => {
        const wc = (viewState.displayMax + viewState.displayMin) / 2;
        const ww = viewState.displayMax - viewState.displayMin;
        updateWWWC(ww, wc);
        highlightPreset('presetBtnFullRange');
    });

    wwSlider?.addEventListener('input', () => {
        updateWWWC(parseInt(wwSlider.value), parseInt(wcSlider.value), 'sliders');
        highlightPreset(null);
    });

    wcSlider?.addEventListener('input', () => {
        updateWWWC(parseInt(wwSlider.value), parseInt(wcSlider.value), 'sliders');
        highlightPreset(null);
    });


    // --- LÓGICA DE SLIDERS DE CORTE ---
    function setupSliceSlider(view) {
        const slider = document.getElementById(`slider_${view}`);
        const number = document.getElementById(`number_${view}`);
        if (!slider || !number) return;

        let isUpdating = false; // Flag to prevent circular updates

        // Slider changes: update number input and image (uses 'input' for smooth dragging)
        slider.addEventListener('change', () => {
            if (isUpdating) return;
            isUpdating = true;
            number.value = slider.value;
            updateImage(view, slider.value, true);

            // Clear polygon if slice changes while drawing
            if (polygonState.isDrawing && polygonState.currentView === view) {
                clearPolygon();
            }

            setTimeout(() => { isUpdating = false; }, 0);
        });

        // Number input changes: use 'change' event instead of 'input'
        // 'change' only fires when user is done (releases mouse/focus), not continuously
        number.addEventListener('change', () => {
            if (isUpdating) return;
            isUpdating = true;
            slider.value = number.value;
            updateImage(view, number.value, true);
            setTimeout(() => { isUpdating = false; }, 0);
        });
    }

    // --- LÓGICA DE IMAGEN Y CANVAS ---
    function updateImage(view, layer, forceReloadFromServer, showLoader = false) {
        const slider = document.getElementById(`slider_${view}`);
        if (!slider) return;
        const currentLayer = layer ?? slider.value;
        if (forceReloadFromServer) {
            if (showLoader) showViewLoader(view);
            const img = new Image();
            img.crossOrigin = "Anonymous";
            img.onload = () => {
                if (showLoader) hideViewLoader(view);
                viewState.baseImages[view] = img;
                applyLutAndDraw(view);
            };
            if (showLoader) img.onerror = () => hideViewLoader(view);
            const cmapParam = viewState.colormap ? `&cmap=${viewState.colormap}` : '';
            img.src = `/image/${view}/${currentLayer}?ww=${viewState.ww}&wc=${viewState.wc}${cmapParam}&t=${new Date().getTime()}`;
        } else {
            applyLutAndDraw(view);
        }
    }

    function applyLutAndDraw(view) {
        const baseImage = viewState.baseImages[view];
        const canvas = document.getElementById(`canvas_${view}`);
        const overlay = document.getElementById(`overlay_${view}`);
        if (!baseImage || !canvas || !baseImage.complete || baseImage.naturalWidth === 0) return;
        const ctx = canvas.getContext('2d', { willReadFrequently: true });

        // 1. Sincronizar dimensiones internas
        canvas.width = baseImage.naturalWidth;
        canvas.height = baseImage.naturalHeight;

        // 2. LÓGICA DE CENTRADO SEGURO
        const zs = zoomState[view];
        const wrapper = canvas.parentElement;
        // Solo centramos automáticamente si es la carga inicial (escala 1 y sin paneo)
        if (zs.scale === 1 && zs.panX === 0 && zs.panY === 0) {
            zs.panX = (wrapper.clientWidth - canvas.width) / 2;
            zs.panY = (wrapper.clientHeight - canvas.height) / 2;
        }

        // 3. Dibujar imagen base
        ctx.drawImage(baseImage, 0, 0);

        // 4. APLICAR LUT DEL HISTOGRAMA (Respuesta en tiempo real)
        // Solo aplica si no hay un mapa de color activo (para no alterar colores térmicos/médicos)
        if (viewState.colormap === 'gray' || !viewState.colormap) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            const lut = contrastState.lut;

            for (let i = 0; i < data.length; i += 4) {
                // Skip LUT for colored overlays (segmentation cyan, RT struct red)
                const isGrayscale = (data[i] === data[i+1] && data[i+1] === data[i+2]);
                if (isGrayscale) {
                    const val = data[i]; // Rojo (R=G=B en escala de grises)
                    const newVal = lut[val];
                    data[i] = data[i + 1] = data[i + 2] = newVal;
                }
                // If not grayscale (colored overlay), preserve original RGB values
            }
            ctx.putImageData(imageData, 0, 0);
        }

        // 5. SINCRONIZAR CAPAS (Imagen + Herramientas)
        if (overlay) {
            // Evitamos borrar el overlay si el tamaño ya es correcto
            if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
                overlay.width = canvas.width;
                overlay.height = canvas.height;
            }
            
            const transform = `translate(${zs.panX}px, ${zs.panY}px) scale(${zs.scale})`;
            canvas.style.transform = transform;
            canvas.style.transformOrigin = '0 0';
            overlay.style.transform = transform;
            overlay.style.transformOrigin = '0 0';
        }

        // 6. PERSISTENCIA DEL INSPECTOR
        // Si el usuario marcó un punto, lo redibujamos automáticamente tras la actualización
        if (viewState.lastVoxel && viewState.lastVoxel.x !== null) {
            drawCrosshairFromVoxel(view);
        }

        updateMinimap(view);
    }
    
    // --- LÓGICA DEL HISTOGRAMA ---
    const histogramCanvas = document.getElementById('histogramCanvas');
    const cutoffInput = document.getElementById('cutoffInput');
    const logScaleCheckbox = document.getElementById('logScaleCheckbox');
    const histCtx = histogramCanvas.getContext('2d');

    async function fetchHistogram() {
        try {
            const response = await fetch('/get_histogram');
            if (!response.ok) throw new Error('Failed to fetch histogram');
            const data = await response.json();
            contrastState.histogramData = data;
            drawCurveAndHistogram();
        } catch (error) {
            console.error(error);
        }
    }

    function drawHistogram() {
        if (!contrastState.histogramData) return;
        
        const { width, height } = histogramCanvas;
        histCtx.clearRect(0, 0, width, height);
        
        const data = contrastState.histogramData;
        
        // --- 1. MODO BINARIO (Para máscaras, se queda igual) ---
        if (data.mode === 'binary') {
            const counts = data.counts;
            const labels = data.labels || [];
            const maxCount = Math.max(...counts) || 1;
            const barWidth = width / counts.length;
            
            counts.forEach((count, i) => {
                const barHeight = (count / maxCount) * (height * 0.9);
                const x = i * barWidth;
                const y = height - barHeight;
                
                histCtx.fillStyle = labels[i] === '0' ? '#444444' : '#0dcaf0';
                histCtx.fillRect(x + 5, y, barWidth - 10, barHeight);
                
                histCtx.fillStyle = 'white';
                histCtx.font = '10px monospace';
                if(labels[i]) histCtx.fillText(labels[i], x + (barWidth/2) - 5, height - 5);
            });
            return;
        }

        // --- 2. MODO ITK-SNAP (CORREGIDO: Ignorar Aire para escalar) ---
        const { counts, bin_edges } = data;
        
        // CÁLCULO DE ESCALA INTELIGENTE:
        // Ignoramos los primeros 5 bins (que contienen el aire/fondo -1000 HU)
        // para calcular la altura máxima. Así el tejido no se ve aplastado.
        let maxCount = 1;
        if (counts.length > 20) {
             // Cortamos el inicio (aire) y un poco del final (metal/ruido)
             const tissueCounts = counts.slice(10, counts.length - 5); 
             maxCount = Math.max(...tissueCounts) || 1;
        } else {
             maxCount = Math.max(...counts) || 1;
        }

        const binCount = counts.length;
        const barWidth = width / binCount; 

        for (let i = 0; i < binCount; i++) {
            const count = counts[i];
            if (count === 0) continue;
            
            // Altura (Usamos Logarítmica para suavizar picos)
            let barHeight;
            if (contrastState.logScale) {
                barHeight = (Math.log1p(count) / Math.log1p(maxCount)) * height;
            } else {
                // Limitamos la altura al 100% del canvas para que el aire no se salga
                const rawHeight = (count / maxCount) * height;
                barHeight = Math.min(rawHeight, height); 
            }
            
            const x = i * barWidth;
            const y = height - barHeight;
            
            // --- COLOREADO: CT uses HU-based tissue colors; all other modalities use neutral gray ---
            const huVal = bin_edges[i];
            let color = '#6c757d';

            // HU-based tissue thresholds are CT-specific; MRI bars use uniform gray.
            if (data.modality === 'CT') {
                if (huVal < -300) color = '#343a40';
                else if (huVal >= -150 && huVal < -30) color = '#ffc107';
                else if (huVal >= 30   && huVal < 100) color = '#dc3545';
                else if (huVal >= 200) color = '#f8f9fa';
            }
            
            histCtx.fillStyle = color;
            
            // Dibujamos la barra con un pequeño espacio (-0.5) para definición
            const finalWidth = barWidth > 1 ? barWidth - 0.5 : barWidth;
            
            if (barHeight > 0) {
                 histCtx.fillRect(x, y, finalWidth, barHeight);
            }
        }
    }

    cutoffInput?.addEventListener('change', () => {
        contrastState.cutoff = parseFloat(cutoffInput.value) || 0;
        drawCurveAndHistogram();
    });
    logScaleCheckbox?.addEventListener('change', () => {
        contrastState.logScale = logScaleCheckbox.checked;
        drawCurveAndHistogram();
    });

    // --- LÓGICA DEL EDITOR DE CURVA DE CONTRASTE ---
    const curveCanvas = document.getElementById('curveCanvas');
    const resetContrastBtn = document.getElementById('resetContrastBtn');
    const selectedPointInfo = document.getElementById('selectedPointInfo');
    const addPointBtn = document.getElementById('addPointBtn');
    const removePointBtn = document.getElementById('removePointBtn');
    const prevPointBtn = document.getElementById('prevPointBtn');
    const nextPointBtn = document.getElementById('nextPointBtn');
    const curveCtx = curveCanvas.getContext('2d');

    function drawCurveAndHistogram() {
        requestAnimationFrame(() => {
            if (histogramCanvas.offsetParent !== null) {
                drawHistogram();
                drawCurve();
            }
        });
    }

    function computeAndUpdateLUT() {
        const lut = new Uint8ClampedArray(256);
        const sortedPoints = [...contrastState.points].sort((a, b) => a.x - b.x);
        const interp = (x0, y0, x1, y1, x) => (y0 + (x - x0) * (y1 - y0) / (x1 - x0));
        for (let i = 0; i < lut.length; i++) {
            const huValue = contrastState.minHU + (i / 255) * (contrastState.maxHU - contrastState.minHU);
            let y_hu;
            if (huValue <= sortedPoints[0].x) {
                y_hu = sortedPoints[0].y;
            } else if (huValue >= sortedPoints[sortedPoints.length - 1].x) {
                y_hu = sortedPoints[sortedPoints.length - 1].y;
            } else {
                for (let j = 0; j < sortedPoints.length - 1; j++) {
                    if (huValue >= sortedPoints[j].x && huValue <= sortedPoints[j + 1].x) {
                        y_hu = interp(sortedPoints[j].x, sortedPoints[j].y, sortedPoints[j+1].x, sortedPoints[j+1].y, huValue);
                        break;
                    }
                }
            }
            let norm = Math.max(0, Math.min(1, y_hu / 255));
            lut[i] = Math.round(norm * 255);
        }
        contrastState.lut = lut;
        VIEWS.forEach(view => applyLutAndDraw(view));
    }

    function drawCurve() {
        const { width, height } = curveCanvas;
        curveCtx.clearRect(0, 0, width, height);
        const { minHU, maxHU } = contrastState;
        const pointsToCanvas = (p) => ({
            x: ((p.x - minHU) / (maxHU - minHU)) * width,
            y: height - (p.y / 255) * height,
        });
        const canvasPoints = contrastState.points.map(pointsToCanvas).sort((a,b) => a.x - b.x);
        curveCtx.strokeStyle = '#FFD700';
        curveCtx.lineWidth = 2;
        curveCtx.beginPath();
        curveCtx.moveTo(canvasPoints[0].x, canvasPoints[0].y);
        for (let i = 1; i < canvasPoints.length; i++) {
            curveCtx.lineTo(canvasPoints[i].x, canvasPoints[i].y);
        }
        curveCtx.stroke();
        canvasPoints.forEach((pt, idx) => {
            const originalIndex = contrastState.points.findIndex(p => pointsToCanvas(p).x === pt.x && pointsToCanvas(p).y === pt.y);
            curveCtx.beginPath();
            curveCtx.fillStyle = originalIndex === contrastState.activePointIndex ? '#AE1C28' : '#343a40';
            curveCtx.arc(pt.x, pt.y, 5, 0, Math.PI * 2);
            curveCtx.fill();
        });
    }

    function updateSelectedPointInfo() {
        const pointIdVal = document.getElementById('pointIdVal');
        const pointXVal = document.getElementById('pointXVal');
        const pointYVal = document.getElementById('pointYVal');
        if (!pointIdVal || !pointXVal || !pointYVal) return;
        if (contrastState.activePointIndex !== null && contrastState.points[contrastState.activePointIndex]) {
            const pt = contrastState.points[contrastState.activePointIndex];
            pointIdVal.textContent = contrastState.activePointIndex;
            pointXVal.textContent = pt.x.toFixed(1);
            pointYVal.textContent = (pt.y / 255).toFixed(3);
        } else {
            pointIdVal.textContent = `(ninguno)`;
            pointXVal.textContent = '-';
            pointYVal.textContent = '-';
        }
    }

    function handleCurveInteraction(e) {
        e.preventDefault();
        const rect = curveCanvas.getBoundingClientRect();
        const clientX = e.touches ? e.touches[0].clientX : e.clientX;
        const clientY = e.touches ? e.touches[0].clientY : e.clientY;
        const canvasX = clientX - rect.left;
        const canvasY = clientY - rect.top;
        const x_hu = contrastState.minHU + (canvasX / rect.width) * (contrastState.maxHU - contrastState.minHU);
        const y_val = 255 - (canvasY / rect.height) * 255;
        if (e.type === 'mousedown' || e.type === 'touchstart') {
            let nearestIdx = -1, minDist = 15;
            contrastState.points.forEach((pt, idx) => {
                const canvasPt = { x: (pt.x - contrastState.minHU) / (contrastState.maxHU - contrastState.minHU) * rect.width, y: rect.height - (pt.y / 255) * rect.height };
                const d = Math.hypot(canvasPt.x - canvasX, canvasPt.y - canvasY);
                if (d < minDist) {
                    minDist = d;
                    nearestIdx = idx;
                }
            });
            if (nearestIdx !== -1) {
                contrastState.activePointIndex = nearestIdx;
                contrastState.isDragging = true;
            } else {
                contrastState.activePointIndex = null;
            }
        } else if ((e.type === 'mousemove' || e.type === 'touchmove') && contrastState.isDragging && contrastState.activePointIndex !== null) {
            const activePoint = contrastState.points[contrastState.activePointIndex];
            if (activePoint) {
                if (contrastState.activePointIndex > 0 && contrastState.activePointIndex < contrastState.points.length - 1) {
                    activePoint.x = x_hu;
                }
                activePoint.y = y_val;
            }
        } else if (e.type === 'mouseup' || e.type === 'touchend') {
            contrastState.isDragging = false;
        } else if (e.type === 'dblclick') {
            contrastState.points.push({ x: x_hu, y: y_val });
        }
        contrastState.points.sort((a,b) => a.x - b.x);
        updateSelectedPointInfo();
        drawCurveAndHistogram();
        computeAndUpdateLUT();
    }
    
    curveCanvas.addEventListener('mousedown', handleCurveInteraction);
    window.addEventListener('mousemove', handleCurveInteraction);
    window.addEventListener('mouseup', handleCurveInteraction);
    curveCanvas.addEventListener('dblclick', handleCurveInteraction);
    curveCanvas.addEventListener('touchstart', handleCurveInteraction, { passive: false });
    window.addEventListener('touchmove', handleCurveInteraction, { passive: false });
    window.addEventListener('touchend', handleCurveInteraction);
    
    resetContrastBtn?.addEventListener('click', () => {
        contrastState.points = [{ x: contrastState.minHU, y: 0 }, { x: contrastState.maxHU, y: 255 }];
        contrastState.activePointIndex = null;
        updateSelectedPointInfo();
        drawCurveAndHistogram();
        computeAndUpdateLUT();
    });

    addPointBtn?.addEventListener('click', () => {
        if (contrastState.points.length < 2) return;
        const lastPt = contrastState.points[contrastState.points.length-1];
        const secondLastPt = contrastState.points[contrastState.points.length-2];
        const newX = (lastPt.x + secondLastPt.x) / 2;
        const newY = (lastPt.y + secondLastPt.y) / 2;
        contrastState.points.push({x: newX, y: newY});
        contrastState.points.sort((a,b) => a.x - b.x);
        drawCurveAndHistogram();
        computeAndUpdateLUT();
    });

    removePointBtn?.addEventListener('click', () => {
        if (contrastState.activePointIndex !== null && contrastState.activePointIndex > 0 && contrastState.activePointIndex < contrastState.points.length - 1) {
            contrastState.points.splice(contrastState.activePointIndex, 1);
            contrastState.activePointIndex = null;
            updateSelectedPointInfo();
            drawCurveAndHistogram();
            computeAndUpdateLUT();
        }
    });

    prevPointBtn?.addEventListener('click', () => {
        if (contrastState.points.length === 0) return;
        let newIndex = (contrastState.activePointIndex === null || contrastState.activePointIndex === 0)
          ? contrastState.points.length - 1
          : contrastState.activePointIndex - 1;
        contrastState.activePointIndex = newIndex;
        updateSelectedPointInfo();
        drawCurveAndHistogram();
    });

    nextPointBtn?.addEventListener('click', () => {
        if (contrastState.points.length === 0) return;
        let newIndex = (contrastState.activePointIndex === null || contrastState.activePointIndex >= contrastState.points.length - 1)
            ? 0
            : contrastState.activePointIndex + 1;
        contrastState.activePointIndex = newIndex;
        updateSelectedPointInfo();
        drawCurveAndHistogram();
    });


    function cssToPngPixels(canvasEl, evt) {
        const wrapper = canvasEl.parentElement;
        const wrapRect = wrapper.getBoundingClientRect();
        const view = canvasEl.id.split('_')[1]; 
        const zs = zoomState[view];

        // 1. Posición del mouse relativa al contenedor negro
        const mouseX = evt.clientX - wrapRect.left;
        const mouseY = evt.clientY - wrapRect.top;

        // 2. FÓRMULA MAESTRA: Píxel = (Mouse - Paneo) / Escala
        const xPix = (mouseX - zs.panX) / zs.scale;
        const yPix = (mouseY - zs.panY) / zs.scale;

        // 3. Validación de límites
        if (xPix < 0 || yPix < 0 || xPix >= canvasEl.width || yPix >= canvasEl.height) {
            return null;
        }

        return {
            xPix: Math.floor(xPix),
            yPix: Math.floor(yPix),
            cssX: xPix, 
            cssY: yPix
        };
    }

    function clearOverlay(view) {
        const overlay = document.getElementById(`overlay_${view}`);
        if (overlay) {
             const ctx = overlay.getContext("2d");
             ctx.clearRect(0, 0, overlay.width, overlay.height);
        }
    }

    function showViewLoader(view) {
        const wrapper = document.getElementById(`card_${view}`)?.querySelector('.image-wrapper');
        if (!wrapper || wrapper.querySelector('.view-loading-overlay')) return;
        const loader = document.createElement('div');
        loader.className = 'view-loading-overlay';
        loader.innerHTML = '<div class="spinner-border spinner-border-sm text-light" role="status"></div>';
        wrapper.appendChild(loader);
    }

    function hideViewLoader(view) {
        const wrapper = document.getElementById(`card_${view}`)?.querySelector('.image-wrapper');
        if (!wrapper) return;
        wrapper.querySelectorAll('.view-loading-overlay').forEach(el => el.remove());
    }

    function updateCursorStyle(cursorType) {
        // Update cursor style for all view wrappers, canvases, and overlays
        VIEWS.forEach(view => {
            const wrapper = document.getElementById(`card_${view}`).querySelector('.image-wrapper');
            const canvas = document.getElementById(`canvas_${view}`);
            const overlay = document.getElementById(`overlay_${view}`);

            if (wrapper) wrapper.style.cursor = cursorType;
            if (canvas) canvas.style.cursor = cursorType;
            if (overlay) overlay.style.cursor = cursorType;
        });
    }

    // --- LÓGICA DEL FORMULARIO RT STRUCT (Robustecida) ---
    const rtStructForm = document.getElementById('rtStructForm');
    if (rtStructForm) {
        rtStructForm.addEventListener("submit", function (event) {
            event.preventDefault();
            
            let formData = new FormData(this);
            const token = document.querySelector('meta[name="csrf-token"]').content;
            const loader = document.getElementById('loader-wrapper');
            const submitBtn = this.querySelector('button[type="submit"]');
            const iframe = document.getElementById('DicomRender');

            // Feedback visual: mostrar carga y deshabilitar botón
            if (loader) { loader.style.display = 'flex'; loader.style.opacity = '1'; }
            if (submitBtn) { submitBtn.disabled = true; submitBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Procesando...'; }

            fetch("/upload_RT", {
                method: "POST",
                headers: { 'X-CSRFToken': token },
                body: formData
            })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'success') {
                    // ÉXITO: Forzamos actualización del iframe 3D
                    console.log("RT cargado:", data.message);
                    if (iframe) {
                        // Truco del timestamp para obligar al navegador a redibujar
                        const currentSrc = iframe.src.split('?')[0];
                        iframe.src = currentSrc + '?t=' + new Date().getTime();
                    }
                    alert("Segmentación cargada correctamente.");
                } else {
                    // ERROR CONTROLADO (Backend dijo que no pudo)
                    throw new Error(data.message || "Error desconocido al procesar.");
                }
            })
            .catch(error => {
                // ERROR DE RED O PROCESAMIENTO
                console.error("Error RT:", error);
                alert("⚠️ No se pudo cargar la segmentación:\n" + error.message + "\n\nLa visualización actual se mantendrá.");
            })
            .finally(() => {
                // RESTAURAR UI (Pase lo que pase)
                if (loader) {
                    loader.style.opacity = '0';
                    setTimeout(() => { loader.style.display = 'none'; }, 500);
                }
                if (submitBtn) { 
                    submitBtn.disabled = false; 
                    submitBtn.innerHTML = '<i class="bi bi-upload"></i> Procesar'; 
                }
                // Limpiar el input file
                rtStructForm.reset();
            });
        });
    }

    // --- LÓGICA DE CAMBIO DE RENDERIZADO 3D Y COLOR ---
    function setup3DRendererControls() {
        const renderModeRadios = document.querySelectorAll('input[name="renderMode"]');
        const colormapSelect = document.getElementById('colormapSelect'); // <--- Nuevo ID
        const iframe = document.getElementById('DicomRender');
        
        if (!iframe) return;

        // Función para enviar cambios al servidor 3D
        const updateServer3D = () => {
            iframe.style.opacity = '0.5'; 
            
            const activeRadio = document.querySelector('input[name="renderMode"]:checked');
            const mode = activeRadio ? activeRadio.value : 'volume';
            const cmap = viewState.colormap;

            const token = document.querySelector('meta[name="csrf-token"]').content;
            
            fetch('/update_render_mode', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': token },
                body: JSON.stringify({ mode: mode, cmap: cmap })
            })
            .then(response => response.json())
            .then(data => {
                if(data.status === 'success') { 
                    // Recargar iframe solo si es necesario
                    iframe.src = iframe.src.split('?')[0] + '?t=' + new Date().getTime(); 
                }
            })
            .finally(() => { setTimeout(() => { iframe.style.opacity = '1'; }, 1000); });
        };

        // Cambio de MODO 3D (Recarga el iframe)
        renderModeRadios.forEach(radio => {
            radio.addEventListener('change', updateServer3D);
        });

        // Listener Dropdown Color
        if (colormapSelect) {
            colormapSelect.addEventListener('change', function() {
                viewState.colormap = this.value;
                
                // 1. Actualizar vistas 2D (inmediato)
                VIEWS.forEach(view => {
                    const slider = document.getElementById(`slider_${view}`);
                    if (slider) updateImage(view, slider.value, true);
                });

                // NO llamamos a updateServer() aquí. 
                // El 3D se actualizará solo cuando cambies de modo (MIP/ISO) o rotes la imagen.
            });
        }
    }

    // --- LÓGICA DE ZOOM Y PANEO ---
    function setupZoomPan(view) {
        const wrapper = document.getElementById(`card_${view}`).querySelector('.image-wrapper');
        const canvas = document.getElementById(`canvas_${view}`);
        const overlay = document.getElementById(`overlay_${view}`);
        
        if (!wrapper || !canvas || !overlay) return;

        const updateTransform = () => {
            const zs = zoomState[view];
            const transform = `translate(${zs.panX}px, ${zs.panY}px) scale(${zs.scale})`;
            
            // Aplicamos transformación a la imagen Y al dibujo (overlay)
            canvas.style.transform = transform;
            canvas.style.transformOrigin = '0 0'; 
            overlay.style.transform = transform;
            overlay.style.transformOrigin = '0 0';
            // --- NUEVO: Actualizar el mini-mapa al mover o hacer zoom ---
            updateMinimap(view);
        };

        // ZOOM (Rueda del mouse)
        wrapper.addEventListener('wheel', (e) => {
            // Disable zoom when inspector mode or segmentation mode is active
            if (viewState.inspectorMode || viewState.segmentationMode) return;

            e.preventDefault();
            const zs = zoomState[view];
            const zoomIntensity = 0.1;
            const delta = e.deltaY < 0 ? 1 : -1;

            const newScale = Math.min(Math.max(1, zs.scale + (delta * zoomIntensity)), 10);

            // Matemáticas para hacer zoom hacia el puntero del mouse
            const canvasRect = canvas.getBoundingClientRect();
            const mouseX = e.clientX - canvasRect.left;
            const mouseY = e.clientY - canvasRect.top;

            if (newScale === 1) {
                zs.panX = 0;
                zs.panY = 0;
            } else {
                zs.panX = mouseX - (mouseX - zs.panX) * (newScale / zs.scale);
                zs.panY = mouseY - (mouseY - zs.panY) * (newScale / zs.scale);
            }

            zs.scale = newScale;
            updateTransform();
        });

        let isDown = false;
        let startX, startY;
        let initialPanX, initialPanY;

        wrapper.addEventListener('mousedown', (e) => {
            // Disable panning when inspector mode or segmentation mode is active
            if (viewState.inspectorMode || viewState.segmentationMode) return;

            isDown = true;
            zoomState[view].isDragging = false;

            startX = e.clientX;
            startY = e.clientY;

            initialPanX = zoomState[view].panX;
            initialPanY = zoomState[view].panY;

            wrapper.style.cursor = 'grabbing';
            canvas.style.cursor = 'grabbing';
            overlay.style.cursor = 'grabbing';
        });

        window.addEventListener('mousemove', (e) => {
            if (!isDown) return;
            e.preventDefault();
            
            // Calculamos cuánto se movió el mouse
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
                zoomState[view].isDragging = true;
            }

            zoomState[view].panX = initialPanX + dx;
            zoomState[view].panY = initialPanY + dy;
            
            updateTransform();
        });

        window.addEventListener('mouseup', () => {
            isDown = false;
            // Only restore grab cursor if not in inspector mode or segmentation mode
            if (!viewState.inspectorMode && !viewState.segmentationMode) {
                wrapper.style.cursor = 'grab';
                canvas.style.cursor = 'grab';
                overlay.style.cursor = 'grab';
            }

            setTimeout(() => {
                zoomState[view].isDragging = false;
            }, 50);
        });

        // Reset con doble clic
        wrapper.addEventListener('dblclick', () => {
            zoomState[view] = { scale: 1, panX: 0, panY: 0, isDragging: false };
            updateTransform();
        });


        // Dentro de setupZoomPan(view)...
        const minimapContainer = document.getElementById(`minimap_container_${view}`);
        minimapContainer.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            
            const miniCanvas = document.getElementById(`minimap_canvas_${view}`);
            const mainCanvas = document.getElementById(`canvas_${view}`);
            const rect = miniCanvas.getBoundingClientRect();
            const zs = zoomState[view];
            const wrapper = mainCanvas.parentElement;
            
            // 1. Obtener porcentaje del clic dentro del Mini-mapa (0 a 1)
            const pctX = (e.clientX - rect.left) / rect.width;
            const pctY = (e.clientY - rect.top) / rect.height;
            
            // 2. Centrar la vista: movemos el paneo para que el punto clicado esté en el centro del cuadrante
            // pan = (Centro del Visor) - (Punto en Imagen * Zoom)
            zs.panX = (wrapper.clientWidth / 2) - (pctX * mainCanvas.width * zs.scale);
            zs.panY = (wrapper.clientHeight / 2) - (pctY * mainCanvas.height * zs.scale);

            updateTransform();
        });

        // Función para sincronizar la "cámara" en las 3 vistas
        function syncTransforms(sourceView) {
            const sourceState = zoomState[sourceView];
            VIEWS.forEach(targetView => {
                if (targetView !== sourceView && targetView !== '3D') {
                    const targetState = zoomState[targetView];
                    targetState.scale = sourceState.scale;
                    targetState.panX = sourceState.panX;
                    targetState.panY = sourceState.panY;
                    
                    // Forzar actualización visual del canvas y su minimapa
                    const canvas = document.getElementById(`canvas_${targetView}`);
                    const overlay = document.getElementById(`overlay_${targetView}`);
                    const transform = `translate(${targetState.panX}px, ${targetState.panY}px) scale(${targetState.scale})`;
                    
                    if (canvas) canvas.style.transform = transform;
                    if (overlay) overlay.style.transform = transform;
                    
                    updateMinimap(targetView);
                }
            });
        }
    }

    // --- LÓGICA DEL INSPECTOR 3D (CROSSHAIR) ---
    function drawCrosshair(view, x, y) {
        const overlay = document.getElementById(`overlay_${view}`);
        const mainCanvas = document.getElementById(`canvas_${view}`);
        if (!overlay || !mainCanvas) return;

        // Limpiar y preparar
        overlay.width = mainCanvas.width;
        overlay.height = mainCanvas.height;
        const ctx = overlay.getContext("2d");
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        // x, y are already in internal pixel coordinates (from cssToPngPixels)
        // The overlay canvas has the same transform as the main canvas,
        // so we just draw at the pixel coordinates directly.
        // The browser will apply the zoom/pan transform automatically.
        const zs = zoomState[view];

        // Dibujar Cruz (Azul cian muy visible)
        ctx.strokeStyle = "#00FFFF";
        ctx.lineWidth = 1 / zs.scale; // Scale line width so it appears constant size on screen
        ctx.setLineDash([5 / zs.scale, 3 / zs.scale]); // Scale dash pattern too

        // Línea Vertical - draw at pixel coordinate x
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, overlay.height);
        ctx.stroke();

        // Línea Horizontal - draw at pixel coordinate y
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(overlay.width, y);
        ctx.stroke();
    }

    function syncViewsFromVoxel(sourceView, voxel) {
        // NEW: Uses voxel coordinates from backend (accounts for aspect ratio scaling)
        // voxel = {x, y, z} in volume space

        let updates = {};

        // The backend returns voxel coordinates in (z, y, x) order
        // We need to map these to the correct slider positions for each view

        if (sourceView === 'axial') {
            // Axial view: we clicked on slice Z, pixel position (X, Y)
            // Update sagittal to X position, coronal to Y position
            updates['sagital'] = voxel.x;
            updates['coronal'] = voxel.y;
        } else if (sourceView === 'coronal') {
            // Coronal view: we clicked on slice Y, pixel position (X, Z)
            // Update sagittal to X position, axial to Z position
            updates['sagital'] = voxel.x;
            updates['axial'] = voxel.z;
        } else if (sourceView === 'sagital') {
            // Sagittal view: we clicked on slice X, pixel position (Y, Z)
            // Update coronal to Y position, axial to Z position
            updates['coronal'] = voxel.y;
            updates['axial'] = voxel.z;
        }

        // Aplicar actualizaciones a los sliders
        Object.keys(updates).forEach(targetView => {
            const slider = document.getElementById(`slider_${targetView}`);
            const number = document.getElementById(`number_${targetView}`);
            if (slider) {
                let val = Math.max(0, Math.min(updates[targetView], slider.max));

                if (Math.abs(slider.value - val) > 0) {
                    slider.value = val;
                    number.value = val;
                    updateImage(targetView, val, true);
                }
            }
        });

        // Draw crosshairs on ALL views to show the 3D intersection point
        drawCrosshairsOnAllViews(voxel);
    }

    function drawCrosshairsOnAllViews(voxel) {
        // Draw crosshair on each view at the corresponding 2D position
        // voxel = {x, y, z} in volume space
        // Need to convert voxel coords to pixel coords using aspect ratio scaling

        // Axial view: crosshair at (X, Y) pixel position
        // Axial Y needs to be scaled by scale_axial
        const axialPixelX = voxel.x;
        const axialPixelY = Math.round(voxel.y * viewState.scales.axial);
        drawCrosshair('axial', axialPixelX, axialPixelY);

        // Coronal view: crosshair at (X, Z) pixel position
        // Coronal Z needs to be scaled by scale_coronal
        const coronalPixelX = voxel.x;
        const coronalPixelZ = Math.round(voxel.z * viewState.scales.coronal);
        drawCrosshair('coronal', coronalPixelX, coronalPixelZ);

        // Sagittal view: crosshair at (Y, Z) pixel position
        // Sagittal Z needs to be scaled by scale_sagittal
        const sagittalPixelY = voxel.y;
        const sagittalPixelZ = Math.round(voxel.z * viewState.scales.sagittal);
        drawCrosshair('sagital', sagittalPixelY, sagittalPixelZ);
    }

    function bindInspector(view) {
        const wrapper = document.getElementById(`card_${view}`).querySelector('.image-wrapper');
        const mainCanvas = document.getElementById(`canvas_${view}`);

        if (!wrapper) return;

        // Helper function to get voxel coordinates from backend and update HU display
        function getVoxelCoordinates(view, mapped, callback) {
            const slider = document.getElementById(`slider_${view}`);
            const idx = parseInt(slider.value, 10);
            const huResult = document.getElementById('huResult');

            fetch(`/hu_value?view=${view}&x=${mapped.xPix}&y=${mapped.yPix}&index=${idx}`)
                .then(r => r.json())
                .then(data => {
                    if (!data.error && data.voxel) {
                        // Store the scaling factors for crosshair drawing
                        if (data.scales) {
                            viewState.scales = data.scales;
                        }

                        // Update HU display panel with formatted output
                        if (huResult) {
                            // MRI signal has no standardized physical unit, so the UH suffix is CT-only.
                            const isCT       = viewState.modality === 'CT';
                            const valueLabel = isCT ? 'Densidad:' : 'Señal:';
                            const valueText  = isCT ? `${data.hu} UH` : `${data.hu}`;
                            huResult.innerHTML = `
                                <div class="mb-1 lh-1">
                                    <span style="color: #bbbbbb; font-size: 0.7rem; letter-spacing: 1px; text-transform: uppercase;">Coordenadas:</span>
                                </div>

                                <div class="d-flex justify-content-between mb-2 font-monospace px-1" style="font-size: 0.9rem;">
                                    <span><span style="color: #777;">x:</span> <span style="color: #fff;">${data.voxel.x}</span></span>
                                    <span><span style="color: #777;">y:</span> <span style="color: #fff;">${data.voxel.y}</span></span>
                                    <span><span style="color: #777;">z:</span> <span style="color: #fff;">${data.voxel.z}</span></span>
                                </div>

                                <div class="d-flex justify-content-between align-items-center pt-2" style="border-top: 1px solid #444;">
                                    <span style="color: #bbbbbb; font-size: 0.7rem; letter-spacing: 1px; text-transform: uppercase;">${valueLabel}</span>
                                    <span style="color: #0dcaf0; font-weight: bold; font-size: 1rem;">${valueText}</span>
                                </div>
                            `;
                        }

                        callback(data.voxel);
                    } else if (data.error && huResult) {
                        huResult.textContent = "Error: " + data.error;
                    }
                })
                .catch(err => {
                    console.error("Inspector coordinate fetch error:", err);
                    if (huResult) huResult.textContent = "Error al obtener valor UH.";
                });
        }

        // Evento de Arrastre (Drag) para navegación fluida
        wrapper.addEventListener('mousemove', (e) => {
            // Solo si está activo el modo y se está presionando el clic (buttons === 1)
            if (!viewState.inspectorMode || e.buttons !== 1) return;

            const mapped = cssToPngPixels(mainCanvas, e);
            if (!mapped) return;

            // 1. Dibujar cruz en la vista actual
            drawCrosshair(view, mapped.cssX, mapped.cssY);

            // 2. Get correct voxel coordinates from backend, then sync
            getVoxelCoordinates(view, mapped, (voxel) => {
                syncViewsFromVoxel(view, voxel);
            });
        });

        // Evento Click simple (para posicionar sin arrastrar)
        wrapper.addEventListener('mousedown', (e) => {
            if (!viewState.inspectorMode) return;
            const mapped = cssToPngPixels(mainCanvas, e);
            if (!mapped) return;

            drawCrosshair(view, mapped.cssX, mapped.cssY);

            getVoxelCoordinates(view, mapped, (voxel) => {
                syncViewsFromVoxel(view, voxel);
            });
        });

        // Limpiar al soltar
        wrapper.addEventListener('mouseup', () => {
             if (viewState.inspectorMode) {
                 // Opcional: Si quieres que la cruz desaparezca al soltar, descomenta esto:
                 // clearOverlay(view);
             }
        });
    }

    // --- MULTI-SEGMENTATION MANAGEMENT FUNCTIONS ---

    function loadSegmentations() {
        fetch('/get_segmentations')
            .then(r => r.json())
            .then(data => {
                viewState.segmentations = data.segmentations;
                viewState.activeSegmentationId = data.active_id;
                // Rebuild segUndoState
                data.segmentations.forEach(entry => {
                    segUndoState[entry.id] = entry.has_undo;
                });
                renderSegmentationsList();
                // Update undo button
                const undoBtn = document.getElementById('undoLastPolygonBtn');
                if (undoBtn) {
                    if (viewState.activeSegmentationId !== null && segUndoState[viewState.activeSegmentationId]) {
                        undoBtn.disabled = false;
                        undoBtn.classList.remove('btn-outline-secondary');
                        undoBtn.classList.add('btn-outline-warning');
                    } else {
                        undoBtn.disabled = true;
                        undoBtn.classList.remove('btn-outline-warning');
                        undoBtn.classList.add('btn-outline-secondary');
                    }
                }
            })
            .catch(err => console.error('loadSegmentations error:', err));
    }

    function refresh3D() {
        const iframe = document.getElementById('DicomRender');
        if (!iframe) return;
        iframe.style.opacity = '0.5';
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        fetch('/refresh_3d', {
            method: 'POST',
            headers: { 'X-CSRFToken': csrfToken }
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                iframe.src = iframe.src.split('?')[0] + '?t=' + new Date().getTime();
            }
        })
        .catch(err => console.error(err))
        .finally(() => {
            setTimeout(() => { iframe.style.opacity = '1'; }, 1000);
        });
    }

    function renderSegmentationsList() {
        const countDisplay = document.getElementById('segCountDisplay');
        if (countDisplay) countDisplay.textContent = `${viewState.segmentations.length}`;

        const newSegBtn = document.getElementById('newSegmentationBtn');
        if (newSegBtn) {
            newSegBtn.disabled = false;
        }

        const container = document.getElementById('segmentationsListContainer');
        if (!container) return;

        if (viewState.segmentations.length === 0) {
            container.innerHTML = '<p class="text-muted small text-center mb-1">No hay segmentaciones. Crea una nueva.</p>';
            return;
        }

        container.innerHTML = '';
        viewState.segmentations.forEach(entry => {
            const row = document.createElement('div');
            row.className = 'seg-row' + (entry.id === viewState.activeSegmentationId ? ' seg-row-active' : '');
            row.dataset.segId = entry.id;

            const swatch = document.createElement('span');
            swatch.className = 'seg-color-swatch';
            swatch.style.backgroundColor = entry.color;

            const nameSpan = document.createElement('span');
            nameSpan.className = 'seg-row-name';
            nameSpan.textContent = entry.name;

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'seg-row-actions';

            const visBtn = document.createElement('button');
            visBtn.className = 'btn btn-sm seg-visibility-btn';
            visBtn.dataset.segId = entry.id;
            visBtn.title = entry.visible ? 'Ocultar' : 'Mostrar';
            visBtn.innerHTML = `<i class="bi ${entry.visible ? 'bi-eye' : 'bi-eye-slash'}"></i>`;

            const delBtn = document.createElement('button');
            delBtn.className = 'btn btn-sm btn-outline-danger seg-delete-btn';
            delBtn.dataset.segId = entry.id;
            delBtn.title = 'Eliminar';
            delBtn.innerHTML = '<i class="bi bi-trash"></i>';

            actionsDiv.appendChild(visBtn);
            actionsDiv.appendChild(delBtn);

            row.appendChild(swatch);
            row.appendChild(nameSpan);
            row.appendChild(actionsDiv);

            row.addEventListener('click', () => setActiveSegmentation(parseInt(entry.id)));
            visBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                toggleSegmentationVisibility(parseInt(entry.id));
            });
            delBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                deleteSegmentation(parseInt(entry.id));
            });

            container.appendChild(row);
        });
    }

    function showCreateSegmentationForm() {
        const btn = document.getElementById('newSegmentationBtn');
        const form = document.getElementById('createSegmentationForm');
        const input = document.getElementById('newSegNameInput');
        if (btn) btn.style.display = 'none';
        if (form) form.style.display = 'block';
        if (input) { input.value = ''; input.focus(); }
    }

    function hideCreateSegmentationForm() {
        const btn = document.getElementById('newSegmentationBtn');
        const form = document.getElementById('createSegmentationForm');
        const input = document.getElementById('newSegNameInput');
        if (btn) btn.style.display = '';
        if (form) form.style.display = 'none';
        if (input) { input.value = ''; input.classList.remove('is-invalid'); }
    }

    function submitCreateSegmentation() {
        const input = document.getElementById('newSegNameInput');
        if (!input) return;
        const trimmedValue = input.value.trim();
        if (!trimmedValue) {
            input.classList.add('is-invalid');
            return;
        }
        input.classList.remove('is-invalid');
        const saveBtn = document.getElementById('saveNewSegBtn');
        if (saveBtn) saveBtn.disabled = true;
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        fetch('/create_segmentation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
            body: JSON.stringify({ name: trimmedValue })
        })
        .then(response => {
            if (!response.ok) return response.json().then(d => { throw new Error(d.message || 'Error al crear'); });
            return response.json();
        })
        .then(() => {
            loadSegmentations();
            hideCreateSegmentationForm();
            refresh3D();
        })
        .catch(err => { alert('Error: ' + err.message); })
        .finally(() => { if (saveBtn) saveBtn.disabled = false; });
    }

    function deleteSegmentation(id) {
        if (!confirm('¿Eliminar esta segmentación? Esta acción no se puede deshacer.')) return;
        if (polygonState.isDrawing) clearPolygon();
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        fetch('/delete_segmentation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
            body: JSON.stringify({ id: id })
        })
        .then(response => {
            if (!response.ok) return response.json().then(d => { throw new Error(d.message || 'Error al eliminar'); });
            return response.json();
        })
        .then(() => {
            loadSegmentations();
            VIEWS.forEach(view => {
                const slider = document.getElementById('slider_' + view);
                if (slider) updateImage(view, parseInt(slider.value), true, true);
            });
            refresh3D();
        })
        .catch(err => { alert('Error: ' + err.message); });
    }

    function setActiveSegmentation(id) {
        if (polygonState.isDrawing) clearPolygon();
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        fetch('/set_active_segmentation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
            body: JSON.stringify({ id: id })
        })
        .then(response => {
            if (!response.ok) return response.json().then(d => { throw new Error(d.message || 'Error'); });
            return response.json();
        })
        .then(data => {
            viewState.activeSegmentationId = data.id;
            segUndoState[data.id] = data.has_undo;
            renderSegmentationsList();
            const undoBtn = document.getElementById('undoLastPolygonBtn');
            if (undoBtn) {
                if (data.has_undo) {
                    undoBtn.disabled = false;
                    undoBtn.classList.remove('btn-outline-secondary');
                    undoBtn.classList.add('btn-outline-warning');
                } else {
                    undoBtn.disabled = true;
                    undoBtn.classList.remove('btn-outline-warning');
                    undoBtn.classList.add('btn-outline-secondary');
                }
            }
        })
        .catch(err => { alert('Error: ' + err.message); });
    }

    function toggleSegmentationVisibility(id) {
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
        fetch('/toggle_segmentation_visibility', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
            body: JSON.stringify({ id: id })
        })
        .then(response => {
            if (!response.ok) return response.json().then(d => { throw new Error(d.message || 'Error'); });
            return response.json();
        })
        .then(data => {
            const entry = viewState.segmentations.find(e => e.id === id);
            if (entry) entry.visible = data.visible;
            renderSegmentationsList();
            VIEWS.forEach(view => {
                const slider = document.getElementById('slider_' + view);
                if (slider) updateImage(view, parseInt(slider.value), true, true);
            });
            refresh3D();
        })
        .catch(err => { alert('Error: ' + err.message); });
    }

    // --- SEGMENTATION CLICK HANDLER ---
    function handleSegmentationClick(view, evt) {
        if (!viewState.segmentationMode) return;
        if (viewState.activeSegmentationId === null) {
            alert('Crea o selecciona una segmentación primero.');
            return;
        }

        const canvas = document.getElementById('canvas_' + view);
        if (!canvas) return;

        // Convert screen coordinates to pixel coordinates
        const coords = cssToPngPixels(canvas, evt);

        // Get current layer
        const slider = document.getElementById('slider_' + view);
        const layer = parseInt(slider.value);

        // Handle based on tool mode
        if (viewState.segmentationTool === 'brush') {
            // BRUSH MODE: Paint voxel immediately
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

            const payload = {
                view: view,
                xPix: coords.xPix,
                yPix: coords.yPix,
                layer: layer,
                brush_size: viewState.brushSize,
                mode: viewState.paintMode
            };

            fetch('/paint_voxel', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                },
                body: JSON.stringify(payload)
            })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'success') {
                    updateImage(view, layer, true, true);
                }
            })
            .catch(error => {
                console.error('Paint error:', error);
            });

        } else if (viewState.segmentationTool === 'polygon') {
            // POLYGON MODE: Add vertex or close polygon

            // Check if starting new polygon on different view/layer
            if (polygonState.isDrawing &&
                (polygonState.currentView !== view || polygonState.currentLayer !== layer)) {
                alert('Termina el polígono actual antes de cambiar de vista o capa.');
                return;
            }

            // Check if clicking near first vertex to close
            if (isNearFirstVertex(coords.xPix, coords.yPix, view)) {
                closeAndFillPolygon(view);
                return;
            }

            // Add vertex
            polygonState.vertices.push({ x: coords.xPix, y: coords.yPix });
            polygonState.isDrawing = true;
            polygonState.currentView = view;
            polygonState.currentLayer = layer;

            // Update vertex count display
            const vertexCount = document.getElementById('vertexCount');
            if (vertexCount) vertexCount.textContent = polygonState.vertices.length;

            // Redraw polygon
            drawPolygon(view);
        }
    }

    // Attach click listeners to all canvas elements
    VIEWS.forEach(view => {
        const canvas = document.getElementById('canvas_' + view);
        if (canvas) {
            canvas.addEventListener('click', (evt) => {
                handleSegmentationClick(view, evt);
            });
        }
    });

    // --- POLYGON MOUSEMOVE HANDLER (Preview Line) ---
    VIEWS.forEach(view => {
        const canvas = document.getElementById('canvas_' + view);
        if (canvas) {
            canvas.addEventListener('mousemove', (evt) => {
                if (!viewState.segmentationMode || viewState.segmentationTool !== 'polygon') return;
                if (!polygonState.isDrawing || polygonState.currentView !== view) return;

                const coords = cssToPngPixels(canvas, evt);
                drawPolygon(view, coords.xPix, coords.yPix);
            });
        }
    });

    // --- KEYBOARD HANDLERS FOR POLYGON ---
    document.addEventListener('keydown', (evt) => {
        if (!viewState.segmentationMode || viewState.segmentationTool !== 'polygon') return;
        if (!polygonState.isDrawing) return;

        // ESC: Cancel polygon
        if (evt.key === 'Escape') {
            clearPolygon();
            evt.preventDefault();
        }

        // Backspace: Remove last vertex
        if (evt.key === 'Backspace') {
            if (polygonState.vertices.length > 0) {
                polygonState.vertices.pop();

                // Update vertex count
                const vertexCount = document.getElementById('vertexCount');
                if (vertexCount) vertexCount.textContent = polygonState.vertices.length;

                // Redraw
                if (polygonState.vertices.length === 0) {
                    clearPolygon();
                } else {
                    drawPolygon(polygonState.currentView);
                }
            }
            evt.preventDefault();
        }

        // Enter: Close polygon
        if (evt.key === 'Enter') {
            closeAndFillPolygon(polygonState.currentView);
            evt.preventDefault();
        }
    });

    // --- SEGMENTATION UI CONTROLS ---

    // Brush size radio buttons
    const brushRadios = document.querySelectorAll('input[name="brushSize"]');
    brushRadios.forEach(radio => {
        radio.addEventListener('change', function() {
            viewState.brushSize = parseInt(this.value);
        });
    });

    // Paint/Erase toggle button
    const paintToggleBtn = document.getElementById('paintModeToggleBtn');
    if (paintToggleBtn) {
        paintToggleBtn.addEventListener('click', () => {
            if (viewState.paintMode === 'paint') {
                viewState.paintMode = 'erase';
                paintToggleBtn.className = 'btn btn-sm btn-danger w-100';
                paintToggleBtn.innerHTML = '<i class="bi bi-eraser-fill"></i> Modo: Borrar';
            } else {
                viewState.paintMode = 'paint';
                paintToggleBtn.className = 'btn btn-sm btn-success w-100';
                paintToggleBtn.innerHTML = '<i class="bi bi-brush-fill"></i> Modo: Pintar';
            }
        });
    }

    // Clear active segmentation button
    const clearSegBtn = document.getElementById('clearActiveSegmentationBtn');
    if (clearSegBtn) {
        clearSegBtn.addEventListener('click', () => {
            if (!confirm('¿Borrar la segmentación activa?')) return;

            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

            fetch('/clear_segmentation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                }
            })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'success') {
                    // Reload all views
                    VIEWS.forEach(view => {
                        const slider = document.getElementById('slider_' + view);
                        const layer = parseInt(slider.value);
                        updateImage(view, layer, true, true);
                    });

                    // Clear undo state and disable button
                    polygonState.lastOperation = null;
                    segUndoState[viewState.activeSegmentationId] = false;
                    const undoBtn = document.getElementById('undoLastPolygonBtn');
                    if (undoBtn) {
                        undoBtn.disabled = true;
                        undoBtn.classList.remove('btn-outline-warning');
                        undoBtn.classList.add('btn-outline-secondary');
                    }
                }
            })
            .catch(error => {
                console.error('Clear error:', error);
            });
        });
    }

    // Export active segmentation button
    const exportActiveSegBtn = document.getElementById('exportActiveSegBtn');
    if (exportActiveSegBtn) {
        exportActiveSegBtn.addEventListener('click', () => {
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            fetch('/export_segmentation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
                body: JSON.stringify({ mode: 'active' })
            })
            .then(response => {
                if (!response.ok) throw new Error('Export failed');
                return response.blob();
            })
            .then(blob => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'segmentacion.nrrd';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            })
            .catch(error => { alert('Error al exportar: ' + error); });
        });
    }

    // Export all segmentations button
    const exportAllSegBtn = document.getElementById('exportAllSegBtn');
    if (exportAllSegBtn) {
        exportAllSegBtn.addEventListener('click', () => {
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            fetch('/export_segmentation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
                body: JSON.stringify({ mode: 'all' })
            })
            .then(response => {
                if (!response.ok) throw new Error('Export failed');
                return response.blob();
            })
            .then(blob => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'segmentaciones.zip';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            })
            .catch(error => { alert('Error al exportar: ' + error); });
        });
    }

    // Export multilabel segmentation button
    const exportMultilabelSegBtn = document.getElementById('exportMultilabelSegBtn');
    if (exportMultilabelSegBtn) {
        exportMultilabelSegBtn.addEventListener('click', () => {
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            fetch('/export_segmentation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
                body: JSON.stringify({ mode: 'multilabel' })
            })
            .then(response => {
                if (!response.ok) throw new Error('Export failed');
                return response.blob();
            })
            .then(blob => {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = 'segmentaciones_multilabel.seg.nrrd';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            })
            .catch(error => { alert('Error al exportar: ' + error); });
        });
    }

    // Import segmentation button — open file picker
    const importSegBtn = document.getElementById('importSegBtn');
    if (importSegBtn) {
        importSegBtn.addEventListener('click', () => {
            document.getElementById('importSegFileInput').click();
        });
    }

    // Import segmentation file input — handle file selection and upload
    const importSegFileInput = document.getElementById('importSegFileInput');
    if (importSegFileInput) {
        importSegFileInput.addEventListener('change', function () {
            const file = this.files[0];
            if (!file) return;
            const confirmed = confirm('Importar esta segmentación reemplazará TODAS las capas actuales. ¿Deseas continuar?');
            if (!confirmed) {
                this.value = '';
                return;
            }
            const formData = new FormData();
            formData.append('file', file);
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            const loader = document.getElementById('loader-wrapper');
            if (loader) { loader.style.display = 'flex'; loader.style.opacity = '1'; }
            importSegBtn.disabled = true;
            fetch('/import_segmentation', {
                method: 'POST',
                headers: { 'X-CSRFToken': csrfToken },
                body: formData
            })
            .then(response => response.json().then(data => {
                if (!response.ok) throw new Error(data.message);
                return data;
            }))
            .then(data => {
                loadSegmentations();
                VIEWS.forEach(view => {
                    const slider = document.getElementById('slider_' + view);
                    updateImage(view, slider.value, true);
                });
                refresh3D();
                alert('Segmentación importada correctamente.');
            })
            .catch(error => { alert(error.message); })
            .finally(() => {
                if (loader) {
                    loader.style.opacity = '0';
                    setTimeout(() => { loader.style.display = 'none'; }, 500);
                }
                importSegBtn.disabled = false;
                importSegFileInput.value = '';
            });
        });
    }

    const toggleVolume3dBtn = document.getElementById('toggleVolume3dBtn');
    if (toggleVolume3dBtn) {
        toggleVolume3dBtn.addEventListener('click', () => {
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            toggleVolume3dBtn.disabled = true;
            fetch('/toggle_volume_3d', {
                method: 'POST',
                headers: { 'X-CSRFToken': csrfToken }
            })
            .then(response => response.json().then(data => {
                if (!response.ok) throw new Error(data.message);
                return data;
            }))
            .then(data => {
                const icon = document.getElementById('toggleVolumeIcon');
                const textNode = toggleVolume3dBtn.lastChild;
                if (data.show_volume) {
                    if (icon) icon.className = 'bi bi-eye';
                    if (textNode) textNode.textContent = ' Ocultar volumen';
                } else {
                    if (icon) icon.className = 'bi bi-eye-slash';
                    if (textNode) textNode.textContent = ' Mostrar volumen';
                }
                const iframe = document.getElementById('DicomRender');
                if (iframe) {
                    iframe.src = iframe.src.split('?')[0] + '?t=' + new Date().getTime();
                }
            })
            .catch(err => { alert(err.message); })
            .finally(() => { toggleVolume3dBtn.disabled = false; });
        });
    }

    const cleanNoiseState = { segId: null, components: [], totalComponents: 0,
                              restCount: 0, restVoxels: 0 };

    const cleanNoiseModal = document.getElementById('cleanNoiseModal');
    if (cleanNoiseModal) {
        cleanNoiseModal.addEventListener('show.bs.modal', () => {
            const cleanNoiseMaskSelect = document.getElementById('cleanNoiseMaskSelect');
            const cleanNoiseResults = document.getElementById('cleanNoiseResults');
            const cleanNoiseTotalCount = document.getElementById('cleanNoiseTotalCount');
            const cleanNoiseTableBody = document.getElementById('cleanNoiseTableBody');
            const cleanNoiseThreshold = document.getElementById('cleanNoiseThreshold');
            const cleanNoiseFeedback = document.getElementById('cleanNoiseFeedback');
            cleanNoiseMaskSelect.innerHTML = '';
            viewState.segmentations.forEach(entry => {
                const option = document.createElement('option');
                option.value = entry.id;
                option.textContent = entry.name;
                if (entry.id === viewState.activeSegmentationId) option.selected = true;
                cleanNoiseMaskSelect.appendChild(option);
            });
            cleanNoiseResults.style.display = 'none';
            cleanNoiseTotalCount.textContent = '';
            cleanNoiseTableBody.innerHTML = '';
            cleanNoiseThreshold.value = '';
            cleanNoiseFeedback.textContent = '';
            cleanNoiseState.segId = null;
            cleanNoiseState.components = [];
            cleanNoiseState.totalComponents = 0;
            cleanNoiseState.restCount = 0;
            cleanNoiseState.restVoxels = 0;
        });
    }

    const analyzeComponentsBtn = document.getElementById('analyzeComponentsBtn');
    if (analyzeComponentsBtn) {
        analyzeComponentsBtn.addEventListener('click', () => {
            const cleanNoiseMaskSelect = document.getElementById('cleanNoiseMaskSelect');
            const cleanNoiseResults = document.getElementById('cleanNoiseResults');
            const cleanNoiseTotalCount = document.getElementById('cleanNoiseTotalCount');
            const cleanNoiseTableBody = document.getElementById('cleanNoiseTableBody');
            const segId = parseInt(cleanNoiseMaskSelect.value);
            cleanNoiseState.segId = segId;
            analyzeComponentsBtn.disabled = true;
            analyzeComponentsBtn.textContent = 'Analizando...';
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            fetch('/analyze_components', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
                body: JSON.stringify({ seg_id: segId })
            })
            .then(response => response.json().then(data => {
                if (!response.ok) throw new Error(data.message);
                return data;
            }))
            .then(data => {
                if (data.total_components === 0) {
                    alert('La máscara está vacía.');
                    return;
                }
                cleanNoiseState.components = data.top_components;
                cleanNoiseState.totalComponents = data.total_components;
                cleanNoiseState.restCount = data.rest_count;
                cleanNoiseState.restVoxels = data.rest_voxels;
                cleanNoiseTotalCount.textContent = `${data.total_components} componentes encontrados`;
                cleanNoiseTableBody.innerHTML = '';
                data.top_components.forEach(entry => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = `<td>${entry.rank}</td><td>${entry.voxels.toLocaleString()}</td><td>${entry.mm3.toLocaleString()}</td>`;
                    cleanNoiseTableBody.appendChild(tr);
                });
                if (data.rest_count > 0) {
                    const tr = document.createElement('tr');
                    tr.className = 'text-muted';
                    tr.innerHTML = `<td>...</td><td>${data.rest_voxels.toLocaleString()} vóx. (${data.rest_count} comp.)</td><td>—</td>`;
                    cleanNoiseTableBody.appendChild(tr);
                }
                cleanNoiseResults.style.display = '';
            })
            .catch(err => { alert('Error: ' + err.message); })
            .finally(() => {
                analyzeComponentsBtn.disabled = false;
                analyzeComponentsBtn.innerHTML = '<i class="bi bi-diagram-3"></i> Analizar componentes';
            });
        });
    }

    const cleanNoiseThresholdEl = document.getElementById('cleanNoiseThreshold');
    if (cleanNoiseThresholdEl) {
        cleanNoiseThresholdEl.addEventListener('input', function() {
            const cleanNoiseFeedback = document.getElementById('cleanNoiseFeedback');
            const threshold = parseInt(this.value) || 0;
            if (threshold <= 0 || cleanNoiseState.components.length === 0) {
                cleanNoiseFeedback.textContent = '';
                return;
            }
            let toRemoveFromTop = cleanNoiseState.components.filter(entry => entry.voxels < threshold).length;
            let totalToRemove = toRemoveFromTop;
            if (threshold > 1) totalToRemove += cleanNoiseState.restCount;
            const toKeep = cleanNoiseState.totalComponents - totalToRemove;
            cleanNoiseFeedback.textContent = `Se eliminarán ~${totalToRemove} componentes, quedarán ~${toKeep}.`;
        });
    }

    const keepLargestBtn = document.getElementById('keepLargestBtn');
    if (keepLargestBtn) {
        keepLargestBtn.addEventListener('click', () => {
            if (cleanNoiseState.segId === null) {
                alert('Analiza primero una capa.');
                return;
            }
            keepLargestBtn.disabled = true;
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            fetch('/clean_segmentation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
                body: JSON.stringify({ seg_id: cleanNoiseState.segId, mode: 'largest' })
            })
            .then(response => response.json().then(data => {
                if (!response.ok) throw new Error(data.message);
                return data;
            }))
            .then(() => {
                bootstrap.Modal.getInstance(document.getElementById('cleanNoiseModal')).hide();
                VIEWS.forEach(view => {
                    const slider = document.getElementById('slider_' + view);
                    updateImage(view, slider.value, true, true);
                });
                refresh3D();
            })
            .catch(err => { alert('Error: ' + err.message); })
            .finally(() => { keepLargestBtn.disabled = false; });
        });
    }

    const applyThresholdBtn = document.getElementById('applyThresholdBtn');
    if (applyThresholdBtn) {
        applyThresholdBtn.addEventListener('click', () => {
            if (cleanNoiseState.segId === null) {
                alert('Analiza primero una capa.');
                return;
            }
            const cleanNoiseThreshold = document.getElementById('cleanNoiseThreshold');
            const threshold = parseInt(cleanNoiseThreshold.value) || 0;
            if (threshold < 1) {
                alert('Introduce un umbral mayor que cero.');
                return;
            }
            applyThresholdBtn.disabled = true;
            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');
            fetch('/clean_segmentation', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrfToken },
                body: JSON.stringify({ seg_id: cleanNoiseState.segId, mode: 'threshold', threshold_voxels: threshold })
            })
            .then(response => response.json().then(data => {
                if (!response.ok) throw new Error(data.message);
                return data;
            }))
            .then(() => {
                bootstrap.Modal.getInstance(document.getElementById('cleanNoiseModal')).hide();
                VIEWS.forEach(view => {
                    const slider = document.getElementById('slider_' + view);
                    updateImage(view, slider.value, true, true);
                });
                refresh3D();
            })
            .catch(err => { alert('Error: ' + err.message); })
            .finally(() => { applyThresholdBtn.disabled = false; });
        });
    }

    // Undo last polygon button
    const undoLastPolygonBtn = document.getElementById('undoLastPolygonBtn');
    if (undoLastPolygonBtn) {
        undoLastPolygonBtn.addEventListener('click', () => {
            if (!polygonState.lastOperation) {
                alert('No hay operación para deshacer.');
                return;
            }

            const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

            fetch('/undo_last_polygon', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                }
            })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'success') {
                    // Reload all views to show updated segmentation
                    VIEWS.forEach(view => {
                        const slider = document.getElementById('slider_' + view);
                        if (slider) {
                            const layer = parseInt(slider.value);
                            updateImage(view, layer, true, true);
                        }
                    });

                    // Clear last operation and disable undo button
                    polygonState.lastOperation = null;
                    segUndoState[viewState.activeSegmentationId] = false;
                    undoLastPolygonBtn.disabled = true;
                    undoLastPolygonBtn.classList.remove('btn-outline-warning');
                    undoLastPolygonBtn.classList.add('btn-outline-secondary');

                    console.log('Undo successful');
                } else {
                    alert('Error al deshacer: ' + (data.message || 'Unknown error'));
                }
            })
            .catch(error => {
                console.error('Undo error:', error);
                alert('Error al deshacer: ' + error);
            });
        });
    }

    // --- POLYGON DRAWING FUNCTIONS ---

    function clearPolygon() {
        polygonState.vertices = [];
        polygonState.isDrawing = false;
        polygonState.currentView = null;
        polygonState.currentLayer = null;

        // Clear overlays on all views
        VIEWS.forEach(view => clearOverlay(view));

        // Update vertex count display
        const vertexCount = document.getElementById('vertexCount');
        if (vertexCount) vertexCount.textContent = '0';
    }

    function drawPolygon(view, previewX = null, previewY = null) {
        const overlay = document.getElementById(`overlay_${view}`);
        if (!overlay) return;

        const ctx = overlay.getContext('2d');
        const zs = zoomState[view];

        // Clear overlay
        ctx.clearRect(0, 0, overlay.width, overlay.height);

        if (polygonState.vertices.length === 0) return;

        // --- COLOR BASED ON PAINT/ERASE MODE AND ACTIVE SEGMENTATION ---
        const isEraseMode = viewState.paintMode === 'erase';
        const activeSeg = viewState.segmentations.find(s => s.id === viewState.activeSegmentationId);
        const segColor = activeSeg ? activeSeg.color : '#00FFFF';
        const drawColor = isEraseMode ? '#FF0000' : segColor;
        const hex = isEraseMode ? '#FF0000' : segColor;
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const fillAlpha = `rgba(${r}, ${g}, ${b}, 0.3)`;

        // --- FILL PREVIEW (after 3+ vertices) ---
        if (polygonState.vertices.length >= 3) {
            ctx.fillStyle = fillAlpha; // Red or Cyan preview
            ctx.beginPath();
            ctx.moveTo(polygonState.vertices[0].x, polygonState.vertices[0].y);
            for (let i = 1; i < polygonState.vertices.length; i++) {
                ctx.lineTo(polygonState.vertices[i].x, polygonState.vertices[i].y);
            }
            ctx.closePath();
            ctx.fill();
        }

        // --- VERTICES AND LINES ---
        ctx.strokeStyle = drawColor; // Red or Cyan
        ctx.fillStyle = drawColor;
        ctx.lineWidth = 2 / zs.scale;

        // Draw vertices
        polygonState.vertices.forEach((vertex, index) => {
            ctx.beginPath();
            ctx.arc(vertex.x, vertex.y, 4 / zs.scale, 0, 2 * Math.PI);
            ctx.fill();

            // Draw connecting lines
            if (index > 0) {
                ctx.beginPath();
                ctx.moveTo(polygonState.vertices[index - 1].x, polygonState.vertices[index - 1].y);
                ctx.lineTo(vertex.x, vertex.y);
                ctx.stroke();
            }
        });

        // Draw preview line (from last vertex to mouse position)
        if (previewX !== null && previewY !== null && polygonState.vertices.length > 0) {
            const lastVertex = polygonState.vertices[polygonState.vertices.length - 1];
            ctx.strokeStyle = drawColor;
            ctx.setLineDash([5 / zs.scale, 3 / zs.scale]);
            ctx.beginPath();
            ctx.moveTo(lastVertex.x, lastVertex.y);
            ctx.lineTo(previewX, previewY);
            ctx.stroke();
            ctx.setLineDash([]); // Reset dash
        }
    }

    function isNearFirstVertex(x, y, view) {
        if (polygonState.vertices.length < 3) return false;

        const firstVertex = polygonState.vertices[0];
        const threshold = 10 / zoomState[view].scale; // 10 pixels in internal space

        const dx = x - firstVertex.x;
        const dy = y - firstVertex.y;
        const distance = Math.sqrt(dx * dx + dy * dy);

        return distance <= threshold;
    }

    function closeAndFillPolygon(view) {
        if (viewState.activeSegmentationId === null) {
            alert('Crea o selecciona una segmentación primero.');
            return;
        }
        if (polygonState.vertices.length < 3) {
            alert('Se necesitan al menos 3 vértices para crear un polígono.');
            clearPolygon();
            return;
        }

        // Get current layer
        const slider = document.getElementById('slider_' + view);
        const layer = parseInt(slider.value);

        // Get CSRF token
        const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute('content');

        // Prepare payload
        const payload = {
            view: view,
            layer: layer,
            vertices: polygonState.vertices.map(v => ({ xPix: v.x, yPix: v.y })),
            mode: viewState.paintMode
        };

        // --- STORE OPERATION FOR UNDO (before sending) ---
        polygonState.lastOperation = {
            view: view,
            layer: layer,
            vertices: JSON.parse(JSON.stringify(polygonState.vertices)), // Deep copy
            mode: viewState.paintMode
        };

        // Show loaders immediately — covers both backend processing and image re-render time
        VIEWS.forEach(v => showViewLoader(v));

        // Send to backend
        fetch('/fill_polygon', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRFToken': csrfToken
            },
            body: JSON.stringify(payload)
        })
        .then(response => response.json())
        .then(data => {
            if (data.status === 'success') {
                // Reload ALL views to show filled polygon (fixes paint AND erase mode)
                VIEWS.forEach(v => {
                    const slider = document.getElementById('slider_' + v);
                    if (slider) {
                        updateImage(v, parseInt(slider.value), true, true);
                    }
                });

                // Update segUndoState and enable undo button
                segUndoState[viewState.activeSegmentationId] = true;
                const undoBtn = document.getElementById('undoLastPolygonBtn');
                if (undoBtn) {
                    undoBtn.disabled = false;
                    undoBtn.classList.remove('btn-outline-secondary');
                    undoBtn.classList.add('btn-outline-warning');
                }

                // Clear polygon state
                clearPolygon();
            } else {
                VIEWS.forEach(v => hideViewLoader(v));
                alert('Error: ' + (data.message || 'Unknown error'));
                // Don't store failed operation
                polygonState.lastOperation = null;
            }
        })
        .catch(error => {
            VIEWS.forEach(v => hideViewLoader(v));
            console.error('Polygon fill error:', error);
            alert('Error al rellenar polígono: ' + error);
            // Don't store failed operation
            polygonState.lastOperation = null;
        });
    }

    // --- TOOL SWITCHING (Brush vs Polygon) ---
    const toolRadios = document.querySelectorAll('input[name="segTool"]');
    const brushControls = document.getElementById('brushControls');
    const polygonControls = document.getElementById('polygonControls');
    const segToolInfo = document.getElementById('segToolInfo');

    toolRadios.forEach(radio => {
        radio.addEventListener('change', function() {
            viewState.segmentationTool = this.value;

            if (this.value === 'brush') {
                brushControls.style.display = 'block';
                polygonControls.style.display = 'none';
                segToolInfo.innerHTML = '<i class="bi bi-info-circle"></i> Haz clic para pintar.';

                // Clear any polygon in progress
                clearPolygon();
            } else if (this.value === 'polygon') {
                brushControls.style.display = 'none';
                polygonControls.style.display = 'block';
                segToolInfo.innerHTML = '<i class="bi bi-info-circle"></i> Clic para agregar vértices.';

                // Clear overlays
                VIEWS.forEach(v => clearOverlay(v));
            }
        });
    });

    // --- LÓGICA DEL PLUGIN DE INTELIGENCIA ARTIFICIAL ---
    const runAiBtn = document.getElementById('runAiBtn');
    if (runAiBtn) {
        runAiBtn.addEventListener('click', () => {
            // Confirmación porque es un proceso pesado
            if (!confirm("Esto iniciará la red neuronal para segmentar la imagen. El proceso puede tardar entre 30 segundos y varios minutos dependiendo del hardware. ¿Deseas continuar?")) return;

            // 1. Mostrar pantalla de carga y bloquear botón
            const loader = document.getElementById('loader-wrapper');
            if (loader) { loader.style.display = 'flex'; loader.style.opacity = '1'; }
            runAiBtn.disabled = true;
            runAiBtn.innerHTML = '<span class="spinner-border spinner-border-sm"></span> Procesando IA...';

            const csrfToken = document.querySelector('meta[name="csrf-token"]')?.getAttribute('content') || '';

            // 2. Hacer la petición al servidor web
            fetch('/api/run_ai_segmentation', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRFToken': csrfToken
                }
            })
            .then(response => response.json())
            .then(data => {
                if (data.status === 'success') {
                    alert("Segmentación inteligente completada con éxito.");
                    
                    // 3. Forzar recarga de las 3 vistas para que se dibuje la nueva segmentación
                    VIEWS.forEach(view => {
                        const slider = document.getElementById(`slider_${view}`);
                        if (slider) updateImage(view, slider.value, true);
                    });

                    // Actualizar lista de segmentaciones en el panel lateral
                    loadSegmentations();
                } else {
                    alert("⚠️ Error en IA: " + data.message);
                }
            })
            .catch(error => {
                console.error("Error de red con la IA:", error);
                alert("Ocurrió un error de conexión al procesar la IA.");
            })
            .finally(() => {
                // 4. Ocultar loader y restaurar botón, pase lo que pase
                if (loader) {
                    loader.style.opacity = '0';
                    setTimeout(() => { loader.style.display = 'none'; }, 500);
                }
                runAiBtn.disabled = false;
                runAiBtn.innerHTML = '<i class="bi bi-cpu"></i> Auto-Segmentar (Swin-UNETR)';
            });
        });
    }

    // --- CARGAR METADATA ---
    async function loadMetadata() {
        // Buscamos el cuerpo de la tabla del modal
        const tableBody = document.getElementById('metadataTableBody');
        if (!tableBody) return;

        try {
            const response = await fetch('/get_dicom_metadata');
            if (!response.ok) throw new Error('Error de red');
            
            const data = await response.json();
            
            // Limpiar tabla
            tableBody.innerHTML = '';
            
            // Crear filas de tabla
            for (const [key, value] of Object.entries(data)) {
                // Ocultamos datos técnicos que no deben verse en la tabla
                if (key === 'Spacing' || key === 'Origin') continue;
                const row = document.createElement('tr');
                row.innerHTML = `
                    <td class="fw-bold text-secondary ps-4" style="width: 40%;">${key}</td>
                    <td class="text-light font-monospace">${value}</td>
                `;
                tableBody.appendChild(row);
            }
        } catch (error) {
            tableBody.innerHTML = '<tr><td colspan="2" class="text-center text-danger">Error cargando información.</td></tr>';
            console.error(error);
        }
    }

    // --- Conectar Inputs Numéricos (+/-) con la lógica ---
    function bindWindowLevelInput(inputId, type) {
        const input = document.getElementById(inputId);
        const btnMinus = document.getElementById(`${inputId}-minus`);
        const btnPlus = document.getElementById(`${inputId}-plus`);
        
        if (!input) return;

        const triggerUpdate = () => {
            let val = parseInt(input.value, 10);
            if (isNaN(val)) return;

            // Leemos los sliders para tener el otro valor
            const currentW = parseInt(document.getElementById('ww_slider').value, 10);
            const currentL = parseInt(document.getElementById('wc_slider').value, 10);

            if (type === 'ww') updateWWWC(val, currentL, 'fields');
            else updateWWWC(currentW, val, 'fields');
            
            highlightPreset(null); // Apagar presets si editamos manual
        };

        input.addEventListener('change', triggerUpdate); // Al dar Enter
        
        if (btnMinus) {
            btnMinus.onclick = () => {
                input.value = parseInt(input.value || 0) - 10;
                triggerUpdate();
            };
        }
        if (btnPlus) {
            btnPlus.onclick = () => {
                input.value = parseInt(input.value || 0) + 10;
                triggerUpdate();
            };
        }
    }

    // --- MODALITY-AWARE CONFIG ---

    function fetchViewerConfig() {
        fetch('/get_viewer_config')
            .then(r => { if (!r.ok) throw new Error('config unavailable'); return r.json(); })
            .then(data => {
                viewState.modality   = data.modality;
                viewState.displayMin = data.display_min;
                viewState.displayMax = data.display_max;

                updateWWWC(data.initial_ww, data.initial_wc);

                // Anchor the LUT editor endpoints to the actual data range, not hardcoded CT bounds.
                contrastState.minHU = data.display_min;
                contrastState.maxHU = data.display_max;
                contrastState.points = [
                    { x: data.display_min, y: 0 },
                    { x: data.display_max, y: 255 }
                ];
                computeAndUpdateLUT();
                applyModalityUI();

                if (data.orientation_labels) {
                    ['axial', 'coronal', 'sagital'].forEach(view => {
                        const labels = data.orientation_labels[view];
                        if (!labels) return;
                        ['top', 'bottom', 'left', 'right'].forEach(pos => {
                            const el = document.getElementById(`label_${pos}_${view}`);
                            if (el) el.textContent = labels[pos] ?? '';
                        });
                    });
                }
            })
            .catch(() => {}); // Silent fail — CT defaults remain active
    }

    function applyModalityUI() {
        const ctPresets  = document.getElementById('ctPresets');
        const mriPresets = document.getElementById('mriPresets');
        if (!ctPresets || !mriPresets) return;

        if (viewState.modality === 'CT') {
            ctPresets.style.display  = '';
            mriPresets.style.display = 'none';
        } else {
            // null modality (nothing loaded yet) falls through here — MRI preset panel is harmless default.
            ctPresets.style.display  = 'none';
            mriPresets.style.display = '';
        }
    }

    // --- INICIALIZACIÓN ---

    // Usamos la nueva función para Ventana/Nivel
    bindWindowLevelInput('windowInput', 'ww'); 
    bindWindowLevelInput('levelInput', 'wc');
    
    // Para el histograma
    setupCustomSpinner('cutoffInput', 0.5, () => {
        contrastState.cutoff = parseFloat(cutoffInput.value) || 0;
        drawCurveAndHistogram();
    });

    setup3DRendererControls();
    loadMetadata();

    // --- MULTI-SEGMENTATION UI EVENT LISTENERS ---
    document.getElementById('newSegmentationBtn')?.addEventListener('click', showCreateSegmentationForm);
    document.getElementById('saveNewSegBtn')?.addEventListener('click', submitCreateSegmentation);
    document.getElementById('cancelNewSegBtn')?.addEventListener('click', hideCreateSegmentationForm);
    document.getElementById('newSegNameInput')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitCreateSegmentation(); }
    });

    loadSegmentations();

    // Inicializa los sliders de corte y carga las imágenes iniciales.

    VIEWS.forEach(view => {
        const slider = document.getElementById(`slider_${view}`);
        if (slider) {
            setupSliceSlider(view);
            setupZoomPan(view);
            bindInspector(view);
            updateImage(view, slider.value, true);

            // Set initial cursor to grab (for pan/zoom mode)
            const wrapper = document.getElementById(`card_${view}`).querySelector('.image-wrapper');
            const canvas = document.getElementById(`canvas_${view}`);
            const overlay = document.getElementById(`overlay_${view}`);

            if (wrapper) wrapper.style.cursor = 'grab';
            if (canvas) canvas.style.cursor = 'grab';
            if (overlay) overlay.style.cursor = 'grab';
        }
    });
    
    fetchViewerConfig();

    const curveEditorWrapper = document.getElementById('curve-editor-wrapper');
    if(curveEditorWrapper){
        const curveResizeObserver = new ResizeObserver(entries => {
            if(entries[0].contentRect.width > 0) {
                const newWidth = entries[0].contentRect.width;
                const newHeight = newWidth / 1.5;
                if (histogramCanvas) {
                    histogramCanvas.width = newWidth;
                    histogramCanvas.height = newHeight;
                }
                if (curveCanvas) {
                    curveCanvas.width = newWidth;
                    curveCanvas.height = newHeight;
                }
                drawCurveAndHistogram();
            }
        });
        curveResizeObserver.observe(curveEditorWrapper);
    }

    function updateMinimap(view) {
        const container = document.getElementById(`minimap_container_${view}`);
        const miniCanvas = document.getElementById(`minimap_canvas_${view}`);
        const viewport = document.getElementById(`minimap_viewport_${view}`);
        const mainCanvas = document.getElementById(`canvas_${view}`);
        const zs = zoomState[view];

        if (!mainCanvas || !miniCanvas || !viewport) return;

        // Solo mostrar si el zoom es significativo
        container.style.display = (zs.scale > 1.1) ? 'block' : 'none';
        if (zs.scale <= 1.1) return;

        const ctx = miniCanvas.getContext('2d');
        const wrapper = mainCanvas.parentElement;

        // 1. Ajustar miniatura (Mantenemos 120px de ancho para mejor visibilidad)
        const miniWidth = 120;
        miniCanvas.width = miniWidth;
        miniCanvas.height = miniWidth * (mainCanvas.height / mainCanvas.width);

        // Sincronizar el contenedor con el canvas para evitar desfases de margen
        container.style.width = miniCanvas.width + 'px';
        container.style.height = miniCanvas.height + 'px';

        // 2. Dibujar miniatura (hereda brillo/contraste)
        ctx.clearRect(0, 0, miniCanvas.width, miniCanvas.height);
        ctx.drawImage(mainCanvas, 0, 0, miniCanvas.width, miniCanvas.height);

        // 3. LÓGICA DE SINCRONIZACIÓN 100% (Basada en la "Ventana" de visión)
        // Calculamos cuánto de la imagen cabe en el wrapper (cuadrante negro)
        const totalScaledWidth = mainCanvas.width * zs.scale;
        const totalScaledHeight = mainCanvas.height * zs.scale;

        // Proporción del tamaño del visor respecto a la imagen con zoom
        const widthRatio = wrapper.clientWidth / totalScaledWidth;
        const heightRatio = wrapper.clientHeight / totalScaledHeight;

        // Posición del visor relativa al origen de la imagen (0 a 1)
        // Restamos el paneo y dividimos por el tamaño total escalado
        const leftOffset = (-zs.panX) / totalScaledWidth;
        const topOffset = (-zs.panY) / totalScaledHeight;

        // 4. Aplicar dimensiones al recuadro amarillo
        // Limitamos a 100% para que el recuadro no se salga de la miniatura
        viewport.style.width = Math.min(100, widthRatio * 100) + '%';
        viewport.style.height = Math.min(100, heightRatio * 100) + '%';
        viewport.style.left = Math.max(0, leftOffset * 100) + '%';
        viewport.style.top = Math.max(0, topOffset * 100) + '%';
    }

    function drawCrosshairFromVoxel(view) {
        const v = viewState.lastVoxel;
        const s = viewState.scales;
        if (v.x === null) return;

        let px, py;
        // Mapeo según la vista para posicionar la cruz correctamente en los 3 planos
        if (view === 'axial') { px = v.x; py = v.y * s.axial; }
        else if (view === 'coronal') { px = v.x; py = v.z * s.coronal; }
        else if (view === 'sagital') { px = v.y; py = v.z * s.sagittal; }

        drawCrosshair(view, px, py);
    }
});

// --- FUNCIONES GLOBALES ---
function toggleFullscreen(id) {
    const element = document.getElementById(id);
    if (!element) return;

    if (element.classList.contains('fullscreen-active')) {
        element.classList.remove('fullscreen-active');
    } else {
        element.classList.add('fullscreen-active');
    }
}
