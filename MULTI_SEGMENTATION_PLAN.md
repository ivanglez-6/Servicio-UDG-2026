# Multi-Segmentation Feature - Implementation Plan

## Overview
Allow users to create, manage, and visualize multiple segmentations simultaneously with independent 2D/3D visibility controls.

---

## Data Model Change

### Current (Single Segmentation)
```python
user_data['segmentation_mask'] = np.zeros(dims, dtype=np.uint8)
user_data['last_polygon_operation'] = {...}
```

### New (Multiple Segmentations)
```python
user_data['segmentations'] = {
    'seg_001': {
        'name': 'Segmentación 1',           # User-facing name
        'mask': np.array(...),               # 3D uint8 volume
        'color': '#00FFFF',                  # Hex color for rendering
        'visible_2d': True,                  # Show in 2D slices?
        'visible_3d': False,                 # Show in 3D view?
        'created_at': timestamp,
        'last_operation': {...}              # Undo data (per-segmentation)
    },
    'seg_002': {...},
    # Uploaded RT structures also stored here with type='rt_struct'
}
user_data['active_segmentation_id'] = 'seg_001'  # Currently editing
user_data['segmentation_counter'] = 2            # For auto-naming
```

---

## Color Strategy
**Fixed palette** (assigned sequentially):
```python
SEGMENTATION_COLORS = [
    '#00FFFF',  # Cyan
    '#FF00FF',  # Magenta
    '#FFFF00',  # Yellow
    '#00FF00',  # Green
    '#FF6600',  # Orange
    '#9966FF',  # Purple
]
```
Cycle through if user creates >6 segmentations.

---

## UI Layout

### Segmentation Tool Panel (render.html)
```
┌─────────────────────────────────────┐
│ 🖌️ Crear Segmentación              │
├─────────────────────────────────────┤
│ [+ Nueva Segmentación]              │  ← Creates new with auto-name
│                                     │
│ Segmentaciones:                     │
│ ○ Segmentación 1  [👁][🗑]         │  ← Radio=active, Eye=2D visible, Trash=delete
│ ● Segmentación 2  [👁][🗑]         │  ← Filled=currently editing
│ ○ RT Struct       [👁][🗑]         │  ← Uploaded RT also listed
│                                     │
│ Herramienta: [Pincel][Polígono]    │
│ Tamaño: (1)(3)(5)(7)               │
│ [Modo: Pintar]                      │
│ [Deshacer Último]                   │
│                                     │
│ --- Visualización 3D ---           │
│ ☑ Segmentación 1  [Actualizar]     │  ← Checkbox=3D visible, Button=render
│ ☑ Segmentación 2  [Actualizar]     │
│ ☐ RT Struct       [Actualizar]     │
│ [🔄 Actualizar Todo]                │
│                                     │
│ [Borrar Todo] [Exportar]           │
└─────────────────────────────────────┘
```

---

## User Flow

### Creating Segmentation
1. Click **"+ Nueva Segmentación"**
2. Auto-named "Segmentación N" (N = counter++)
3. Auto-assigned next color from palette
4. Becomes active (radio selected)
5. 2D visible by default, 3D hidden by default

### Editing Segmentation
1. Click radio button → Switch active segmentation
2. Clear polygon state (if drawing)
3. Update polygon color to match active segmentation
4. All polygon/brush operations paint into active mask

### Visibility Controls
- **2D Eye Icon**: Toggle immediately (reloads image slices)
- **3D Checkbox**: Mark for rendering (doesn't auto-render)
- **3D "Actualizar" Button**: Renders THAT segmentation in 3D (manual)
- **"Actualizar Todo"**: Renders ALL checked segmentations

### Deletion
1. Click trash icon
2. Confirm dialog: "¿Eliminar Segmentación 2?"
3. Remove from dict
4. If was active → Switch to first available segmentation
5. Reload 2D views, remove from 3D if rendered

---

## Backend Endpoints Needed

### New Routes
```python
POST /create_segmentation → {id, name, color}
POST /delete_segmentation → {id}
POST /switch_active_segmentation → {id}
POST /toggle_2d_visibility → {id, visible}
POST /toggle_3d_visibility → {id, visible}
POST /render_3d_segmentation → {id} (or {ids: []} for batch)
```

### Modified Routes
```python
/fill_polygon → Paint into active_segmentation_id mask
/undo_last_polygon → Undo from active segmentation's history
/clear_segmentation → Clear active OR all (parameter?)
/export_segmentation → Export selected segmentations (multiselect?)
/get_image → Composite ALL visible_2d=True segmentations with alpha blending
```

### New Helper Function
```python
def add_segmentation_to_plotter(user_data, seg_id):
    """Add single segmentation mesh to 3D scene"""
    seg = user_data['segmentations'][seg_id]
    if seg['mask'].sum() == 0: return  # Empty

    # Create grid (copy RT structure logic)
    grid = pv.ImageData(...)
    grid.cell_data["values"] = seg['mask'].flatten(order="F")
    surface = grid.contour([127.5])

    # Add with custom color
    plotter.add_mesh(surface, color=seg['color'], opacity=0.6, name=seg_id)
```

---

## Frontend Changes

### New JavaScript State
```javascript
const segmentationState = {
    list: {},  // Fetched from backend
    activeId: null,
    counter: 1
};
```

### Event Handlers
```javascript
// Create new segmentation
$('#newSegmentationBtn').click() → POST /create_segmentation → Refresh list UI

// Switch active
$('input[name="activeSegmentation"]').change() → POST /switch_active → Update polygon color

// Toggle 2D visibility
$('.seg-eye-icon').click() → POST /toggle_2d_visibility → Reload all views

// Delete
$('.seg-trash-icon').click() → Confirm → POST /delete_segmentation → Refresh list

// 3D rendering
$('.seg-3d-update-btn').click() → POST /render_3d_segmentation → Update iframe

// Update all 3D
$('#updateAll3DBtn').click() → POST /render_3d_segmentation with checked IDs
```

---

## Key Design Decisions

1. **Auto-naming**: "Segmentación 1", "Segmentación 2" (simple, no user input required initially)
2. **Fixed colors**: Cycle through 6-color palette (simple, predictable)
3. **Manual 3D rendering**: Avoids performance lag, user controls when to update
4. **Separate 2D/3D visibility**: Different use cases (view all in 2D, subset in 3D)
5. **Per-segmentation undo**: Each has own history (cleaner than global undo)
6. **RT structures integrated**: Uploaded RT appears in same list, treated as read-only segmentation

---

## Migration Strategy

### Phase 1: Backend Architecture
1. Convert single mask → segmentations dict
2. Auto-create "Segmentación 1" on DICOM load (backward compatible)
3. Modify fill/undo/clear to use active_segmentation_id
4. Test with single segmentation (should work identically)

### Phase 2: Frontend UI
1. Add segmentation list UI component
2. Add "Nueva Segmentación" button
3. Wire up radio buttons, eye icons, trash icons
4. Test creating/switching/deleting

### Phase 3: Multi-Segmentation Rendering
1. Modify /get_image to composite multiple overlays
2. Add 3D visibility controls
3. Implement per-segmentation 3D rendering
4. Test overlapping segmentations

### Phase 4: Polish
1. Add rename functionality (optional)
2. Add export multi-select
3. Add color customization (optional)
4. Performance optimization (if needed)

---

## Memory Impact

**Per segmentation (512×512×200 volume):**
- Mask: 52 MB
- Undo snapshot: 52 MB
- **Total: 104 MB per segmentation**

**5 segmentations = 520 MB per user**
**10 users × 5 segmentations = 5.2 GB RAM**

Consider compression or delta storage if this becomes issue.

---

## Testing Checklist

- [ ] Create multiple segmentations
- [ ] Switch active segmentation while drawing polygon
- [ ] Toggle 2D visibility (should update all views)
- [ ] Delete non-active segmentation
- [ ] Delete active segmentation (should switch to another)
- [ ] Render multiple in 3D with different colors
- [ ] Overlapping segmentations (check alpha blending)
- [ ] Undo works per-segmentation
- [ ] Export multiple segmentations
- [ ] Uploaded RT coexists with manual segmentations

---

## Open Questions

1. **Export format**: Separate NRRD per segmentation? Or merged multi-label NRRD?
2. **Rename UI**: Modal? Inline edit? Later phase?
3. **Color picker**: Future enhancement? Or fixed palette sufficient?
4. **Max segmentations**: Enforce limit (e.g., 10)? Or unlimited?
5. **Undo scope**: Clear history when switching active? Or preserve?
