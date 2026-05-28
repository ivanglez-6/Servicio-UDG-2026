# 3D Multi-Layer Segmentation Rendering — Implementation Plan

## Context

The 3D viewer currently renders only the active segmentation layer in hardcoded cyan.
This plan replaces that with a full multi-layer 3D render that mirrors the 2D behaviour:
every visible layer is drawn in its own stored color, and the hide/delete/create/import
actions already wired to the 2D views will also update the 3D view.

A second feature is added in the same pass: a toggle button that shows or hides the main
anatomical volume so the user can inspect segmentation surfaces without the anatomy
obstructing the view.

The 3D update strategy is a full rebuild on each action (same philosophy as `get_image`
for 2D: regenerate everything from scratch rather than tracking incremental actor state).

---

## Files to Modify

| File | Change |
|------|--------|
| `main.py` | Replace one function; modify one function; add two routes; add one reset line |
| `templates/render.html` | Add one toggle button |
| `static/js/viewer.js` | Add one helper function; wire it into five existing handlers; add one new event listener |

---

## Step 1 — Replace `add_segmentation_to_plotter` with `_add_all_segmentations_to_plotter` in `main.py`

**Location**: Delete the entire existing `add_segmentation_to_plotter` function (lines 303–348)
and write a new function `_add_all_segmentations_to_plotter` in its place.

**What the new function must do, in order**:

1. Accept a single argument: `user_data`.
2. Retrieve `plotter`, `panel_vtk`, and `grid_full` from `user_data`. If any of the three
   is missing or `None`, return immediately without error.
3. Retrieve `user_data.get('segmentations', {})`. If it is empty, return immediately.
4. Iterate over every `(seg_id, seg_entry)` pair in the segmentations dict. For each pair:
   a. If `seg_entry.get('visible', True)` is `False`, skip this entry and continue.
   b. Retrieve `seg_entry.get('mask')`. If it is `None` or `np.max(mask) == 0`, skip and
      continue.
   c. Create a `pv.ImageData` with:
      - `dimensions` equal to `np.array(mask.shape) + 1`
      - `spacing` equal to `grid_full.spacing`
      - `origin` equal to `grid_full.origin`
   d. Set `seg_grid.cell_data["values"]` to `mask.flatten(order="F")`.
   e. Convert with `seg_grid = seg_grid.cell_data_to_point_data()`.
   f. Generate the surface with `surface = seg_grid.contour([1.0])`.
   g. If `surface.n_points == 0`, skip this entry and continue.
   h. Call `plotter.add_mesh` with:
      - `surface` as the mesh
      - `color=seg_entry['color']` (PyVista accepts `#RRGGBB` hex strings directly)
      - `opacity=0.8`
      - `name=f"seg_{seg_id}"` (this unique name allows future actor replacement)
      - `smooth_shading=True`
5. Do **not** call `panel_vtk.param.trigger('object')` inside this function.
   Triggering is `update_3d_render`'s responsibility.

---

## Step 2 — Update `update_3d_render` in `main.py`

**Location**: the function body at lines 195–246. Two changes are needed.

### 2a. Wrap the volume rendering block with a visibility guard

Find the block that reads (lines 210–229):
```
if mode == 'isosurface':
    ...
elif mode == 'mip':
    ...
elif mode == 'mip_inverted':
    ...
else:
    ...
```

Wrap the entire `if/elif/else` structure (all four branches) inside:
```
if user_data.get('show_volume_3d', True):
```

The default is `True` so the volume renders as before when the key is absent.

### 2b. Replace the old segmentation call

Find lines 236–240:
```python
active_id = user_data.get('active_segmentation_id')
if active_id and 'segmentations' in user_data and active_id in user_data['segmentations']:
    seg_mask = user_data['segmentations'][active_id]['mask']
    if seg_mask is not None and np.any(seg_mask):
        add_segmentation_to_plotter(user_data)
```

Delete all five lines and replace them with one line:
```
_add_all_segmentations_to_plotter(user_data)
```

The new function handles its own guards internally.

---

## Step 3 — Reset `show_volume_3d` when a new DICOM is loaded

**Location**: find the block in `main.py` (around line 609–613) where a new DICOM load
initialises the segmentation state:
```python
user_data['segmentations'] = {}
user_data['active_segmentation_id'] = None
user_data['brush_size'] = 1
user_data['paint_mode'] = 'paint'
```

Add one line immediately after those four:
```
user_data['show_volume_3d'] = True
```

This ensures that loading a new patient always starts with the volume visible.

---

## Step 4 — Add `/refresh_3d` route in `main.py`

**Location**: insert the new route immediately after the closing line of `update_render_mode`
(currently at line 786), before the `/image/<view>/<int:layer>` route.

**What the route function must do**:

1. Decorator: `@app.route("/refresh_3d", methods=["POST"])`.
2. Call `get_user_data()`.
3. If `'vtk_plotter'` is not in `user_data`, return
   `jsonify({"status": "no_plotter"})` with HTTP 200 (not an error — the 3D view
   simply has not been opened yet).
4. Call `update_3d_render(user_data, user_data.get('render_mode', 'isosurface'))`.
5. Return `jsonify({"status": "success"})` with HTTP 200.

---

## Step 5 — Add `/toggle_volume_3d` route in `main.py`

**Location**: insert immediately after the `/refresh_3d` route added in Step 4.

**What the route function must do**:

1. Decorator: `@app.route("/toggle_volume_3d", methods=["POST"])`.
2. Call `get_user_data()`.
3. Flip the flag: read `user_data.get('show_volume_3d', True)`, negate it, and store the
   result back into `user_data['show_volume_3d']`. Assign the new value to a local
   variable `new_value`.
4. If `'vtk_plotter'` is in `user_data`, call
   `update_3d_render(user_data, user_data.get('render_mode', 'isosurface'))`.
5. Return `jsonify({"status": "success", "show_volume": new_value})` with HTTP 200.

---

## Step 6 — Add the volume toggle button in `render.html`

**Location**: open `templates/render.html` and find the `"Visualización 3D & Color"`
sidebar group (around line 66). The render-mode radio buttons end at the closing `</div>`
at line 100 and the group ends at line 101. Insert the following immediately after line 100
(before `</div>` at line 101):

**What to add**:

A wrapping `<div>` with classes `px-2 mt-2` containing one `<button>` element with:
- `id="toggleVolume3dBtn"`
- CSS classes: `btn btn-sm btn-outline-secondary w-100`
- A Bootstrap icon: `<i class="bi bi-eye" id="toggleVolumeIcon"></i>`
- Label text after the icon: `"Ocultar volumen"`

The button label and icon will be updated dynamically by JavaScript on each click.
The initial state (volume visible, label "Ocultar volumen", icon `bi-eye`) matches the
default server-side value of `show_volume_3d = True`.

---

## Step 7 — Add `refresh3D()` helper function in `viewer.js`

**Location**: insert the new function immediately after the closing brace of
`function loadSegmentations()` (currently ending at line 1286).

**What the function must do**:

1. Select the element with id `DicomRender` (the 3D iframe). If it is `null`, return.
2. Set `iframe.style.opacity = '0.5'` to give visual feedback that the 3D is updating.
3. Retrieve the CSRF token from `document.querySelector('meta[name="csrf-token"]')`,
   same pattern as all other POST calls in this file.
4. Call `fetch('/refresh_3d')` with:
   - `method: 'POST'`
   - `headers: { 'X-CSRFToken': csrfToken }`
   - No body is needed.
5. In the `.then()` handler, parse the response as JSON. If the JSON `status` field is
   `'success'`, set `iframe.src` to the current iframe src with its query string stripped
   and a cache-busting timestamp appended:
   `iframe.src.split('?')[0] + '?t=' + new Date().getTime()`.
6. In the `.finally()` handler, schedule restoring `iframe.style.opacity = '1'` after
   1000 milliseconds using `setTimeout`.
7. Add a `.catch()` handler that logs the error to `console.error`.

---

## Step 8 — Wire `refresh3D()` into existing action handlers in `viewer.js`

Add one call to `refresh3D()` at the end of each of the following `.then()` success
blocks. In every case it goes **after** the existing `VIEWS.forEach(...)` updateImage
loop or after `loadSegmentations()`, whichever is last in that block.

### 8a. `toggleSegmentationVisibility()` — around line 1468

Find the `.then(data => { ... })` block that updates `entry.visible`, calls
`renderSegmentationsList()`, and loops through `VIEWS.forEach(...)`. Add `refresh3D()`
as the last statement inside that block, after the `VIEWS.forEach` call.

### 8b. `deleteSegmentation()` — around line 1415

Find the `.then(() => { ... })` block that calls `loadSegmentations()` and loops through
`VIEWS.forEach(...)`. Add `refresh3D()` as the last statement inside that block.

### 8c. `submitCreateSegmentation()` — around line 1394

Find the `.then(() => { ... })` block that calls `loadSegmentations()` and
`hideCreateSegmentationForm()`. Add `refresh3D()` as the last statement inside that block.

### 8d. Import segmentation success handler — around line 1800

Find the second `.then()` block of the import fetch chain — the one that calls
`loadSegmentations()`, the `VIEWS.forEach(...)` updateImage loop, and `alert(...)`.
Add `refresh3D()` as the statement immediately before the `alert(...)` call.

---

## Step 9 — Add the volume toggle button event listener in `viewer.js`

**Location**: find the `importSegFileInput` change handler block (currently around
line 1779). Insert the new block immediately after that block ends.

**What the new block must do**:

1. Select the element with id `toggleVolume3dBtn`. Guard with an `if` null check.
2. Attach a `click` event listener.
3. Inside the listener:
   a. Retrieve the CSRF token.
   b. Disable the button (`toggleVolume3dBtn.disabled = true`) to prevent double-clicks.
   c. Call `fetch('/toggle_volume_3d')` with method `'POST'` and the `X-CSRFToken` header.
   d. In the first `.then()`, parse as JSON. If `response.ok` is `false`, throw a new
      `Error` using the `message` field from the JSON body.
   e. In the second `.then(data => { ... })`:
      - If `data.show_volume` is `true`: set the button's text node to `"Ocultar volumen"`
        and update the icon element (id `toggleVolumeIcon`) to classes `"bi bi-eye"`.
      - If `data.show_volume` is `false`: set the button's text node to `"Mostrar volumen"`
        and update the icon element to classes `"bi bi-eye-slash"`.
      - Reload the iframe by selecting `DicomRender` and setting its `src` with the
        cache-busting timestamp pattern used in `refresh3D()`.
   f. In the `.catch()` handler, call `alert()` with the error message.
   g. In the `.finally()` handler, re-enable the button (`toggleVolume3dBtn.disabled = false`).

**Note on updating the button text**: the button contains both an `<i>` icon element and a
text node. To update the text without removing the icon, select the last child text node of
the button and set its `textContent`, or use `insertAdjacentText` — do not use
`innerHTML` on the button itself or the icon element will be destroyed.

---

## Step 10 — Manual Testing Checklist

### Multi-layer 3D rendering

- [ ] Load a DICOM series and open the 3D view.
- [ ] Create two segmentation layers ("Tumor" and "Edema"). Paint voxels in each.
- [ ] Verify both layers appear in the 3D view simultaneously, each in its own color.
- [ ] Hide "Tumor" via the eye button in the sidebar. Verify it disappears from 3D.
- [ ] Show it again. Verify it reappears.
- [ ] Delete "Edema". Verify only "Tumor" remains in 3D.
- [ ] Navigate 2D slices and verify the 2D overlays are not affected by 3D refresh.

### Volume toggle

- [ ] With a DICOM loaded and at least one segmentation layer visible, click
      "Ocultar volumen". Verify the anatomical surface disappears from 3D and only
      the segmentation mesh(es) remain.
- [ ] Verify the button label changes to "Mostrar volumen" and the icon changes to
      `bi-eye-slash`.
- [ ] Click "Mostrar volumen". Verify the anatomical volume reappears.
- [ ] Verify the button label reverts to "Ocultar volumen" and icon to `bi-eye`.
- [ ] Load a second DICOM series. Verify the volume is visible again by default
      (the toggle resets on new DICOM load).

### Integration with existing features

- [ ] Import a multilabel `.seg.nrrd` file. Verify the imported layers appear in 3D
      immediately after import, without needing to manually trigger a refresh.
- [ ] Verify the RT struct (red overlay) is unaffected by all changes above.
- [ ] Verify all three render modes (Isosurface, MIP, Volumétrico) still work after
      toggling the volume and switching modes.
- [ ] Verify the 2D views (all three: axial, coronal, sagittal) are not affected by
      any 3D-related actions.

### Regression tests

- [ ] Confirm "Exportar Activa", "Exportar Todas", and "Exportar multilabel" still work.
- [ ] Confirm the RT struct upload still displays a red 3D contour.
- [ ] Confirm painting voxels with the brush and polygon tools still updates 2D correctly.
