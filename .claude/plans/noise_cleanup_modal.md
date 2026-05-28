# Segmentation Noise Cleanup Modal — Implementation Plan

## Context

AI segmentation produces many small disconnected voxel fragments ("islands") alongside the
main anatomical structure. This feature adds a modal dialog that lets the user analyze
the connected components of any segmentation mask and either keep only the largest
component or remove all components below a voxel-count threshold.

The operation works on one mask at a time. The user selects which mask to process from a
dropdown inside the modal (defaulting to the active mask). Analysis runs on demand (not
automatically). The mask is mutated in place on the server when the user confirms an
action; 2D and 3D views refresh automatically afterwards.

**Algorithm**: `scipy.ndimage.label` labels every connected 3D component in the binary
mask. Components are ranked by voxel count. The backend returns the top 5 by size plus
a summary of everything else. The user chooses a mode and the backend overwrites the mask.

---

## Files to Modify

| File | Change |
|------|--------|
| `main.py` | Extend one import line; add two new routes |
| `templates/render.html` | Add one trigger button; add one modal |
| `static/js/viewer.js` | Add one state object and five event listener blocks |

---

## Step 1 — Extend the `scipy.ndimage` import in `main.py`

**Location**: line 24, which currently reads:
```
from scipy.ndimage import zoom
```

Change it to:
```
from scipy.ndimage import zoom, label
```

No other imports need to change.

---

## Step 2 — Add `/analyze_components` route in `main.py`

**Location**: insert immediately after the `/clean_segmentation` route added in Step 3
(see ordering note at end of Step 3). In practice, place both new routes together after
the `/toggle_volume_3d` route (currently around line 790). Insert `/analyze_components`
first, then `/clean_segmentation` directly after it.

**Route declaration**: `@app.route("/analyze_components", methods=["POST"])`

**What the route function must do, in order**:

1. Call `get_user_data()`.
2. Read `seg_id` from `request.json` and cast to `int`.
3. Retrieve `segs = user_data.get('segmentations', {})`. If `seg_id` not in `segs`,
   return a JSON error with HTTP 400 and message `"Segmentación no encontrada."`.
4. Retrieve the mask array: `mask = segs[seg_id]['mask']`.
5. If `np.max(mask) == 0`, return `{"total_components": 0, "top_components": [],
   "rest_count": 0, "rest_voxels": 0}` with HTTP 200 (empty mask, nothing to analyze).
6. Create a binary version of the mask: `binary = mask > 0`.
7. Call `labeled_array, num_features = label(binary)`.
8. If `num_features == 0`, return the same empty response as step 5.
9. Compute per-component sizes using `np.bincount(labeled_array.ravel())`. This returns
   an array where index 0 is the background count; slice off index 0 so that
   `component_sizes[i]` is the size of component with label `i + 1`.
10. Compute the voxel volume in mm³:
    a. Retrieve `unique_id = user_data.get('unique_id')`.
    b. Call `dx, dy, dz = _extract_spacing_for_series(unique_id, user_data)`.
    c. `voxel_mm3 = dx * dy * abs(dz)`.
11. Sort the components by size in descending order. Use `np.argsort` with the result
    reversed to get indices of the largest components first.
12. Take the top 5 (or fewer if `num_features < 5`). For each of the top N components,
    build a dict with three keys:
    - `"rank"`: integer starting at 1.
    - `"voxels"`: the component size as a Python `int`.
    - `"mm3"`: `round(float(size) * voxel_mm3, 1)`.
    Store these dicts in a list called `top_components`.
13. Compute the "rest" summary for all components beyond the top 5:
    - `rest_count`: number of components not in the top 5 (`max(0, num_features - 5)`).
    - `rest_voxels`: sum of voxel counts for those components, as a Python `int`. If
      `num_features <= 5`, set to 0.
14. Return a JSON response with HTTP 200 containing four keys:
    `"total_components"`, `"top_components"`, `"rest_count"`, `"rest_voxels"`.
15. Wrap steps 4–14 in a `try/except Exception as e` block. On any exception, return a
    JSON error with HTTP 500 and message `f"Error al analizar: {str(e)}"`.

---

## Step 3 — Add `/clean_segmentation` route in `main.py`

**Location**: insert immediately after `/analyze_components`.

**Route declaration**: `@app.route("/clean_segmentation", methods=["POST"])`

**What the route function must do, in order**:

1. Call `get_user_data()`.
2. Read `seg_id` from `request.json` and cast to `int`.
3. Read `mode` from `request.json` (string, either `"largest"` or `"threshold"`).
4. Retrieve `segs = user_data.get('segmentations', {})`. If `seg_id` not in `segs`,
   return a JSON error with HTTP 400.
5. Retrieve `mask = segs[seg_id]['mask']`.
6. Wrap steps 7–17 in a `try/except Exception as e` returning HTTP 500 on error.
7. If `np.max(mask) == 0`, return `{"status": "success"}` immediately (nothing to do).
8. Call `labeled_array, num_features = label(mask > 0)`.
9. If `num_features <= 1`, return `{"status": "success"}` immediately (already clean).
10. Compute `component_sizes = np.bincount(labeled_array.ravel())[1:]` (skip index 0).

**If `mode == "largest"`**:

11. Find the label index of the largest component:
    `largest_label = int(np.argmax(component_sizes)) + 1`
    (add 1 because `component_sizes[0]` corresponds to label 1 in `labeled_array`).
12. Build the new mask: set every voxel where `labeled_array == largest_label` to 255,
    all other voxels to 0. The result must have dtype `uint8`.
13. Store the new mask: `segs[seg_id]['mask'] = new_mask`.

**If `mode == "threshold"`**:

14. Read `threshold_voxels` from `request.json` and cast to `int`. If it is less than 1,
    set it to 1.
15. Create a zeros array of the same shape and dtype `uint8` as `mask`.
16. Iterate over `component_sizes` with their index. For each component whose size is
    greater than or equal to `threshold_voxels`, set the corresponding voxels in the
    new mask to 255. The label for index `i` in `component_sizes` is `i + 1`.
17. Store the result: `segs[seg_id]['mask'] = new_mask`.

**After both branches**:

18. Invalidate the undo state for this mask: set
    `segs[seg_id]['last_polygon_operation'] = None`.
19. Return `{"status": "success"}` with HTTP 200.

---

## Step 4 — Add the trigger button in `render.html`

**Location**: open `templates/render.html`. Find the `importSegBtn` button (currently at
line 241–243). Insert the following immediately after the closing `>` of that button
(after line 243, before the `</div>` at line 244).

**What to add**:

A `<button>` element with:
- `id="cleanNoiseBtn"`
- `class="btn btn-sm btn-outline-secondary w-100 mt-1"`
- `data-bs-toggle="modal"`
- `data-bs-target="#cleanNoiseModal"`
- A Bootstrap icon: `<i class="bi bi-funnel"></i>`
- Label text: `"Limpiar ruido"`

Using `data-bs-toggle` means Bootstrap opens the modal automatically on click, which
allows the JavaScript `show.bs.modal` event (wired in Step 6) to populate the dropdown
before the modal becomes visible.

---

## Step 5 — Add the modal HTML in `render.html`

**Location**: find the closing `</div>` of `#metadataModal` (currently around line 470).
Insert the new modal immediately after it.

**Structure** — follow the exact same pattern as `#metadataModal` (same CSS variables,
same class names, same header/footer structure). The new modal id is `cleanNoiseModal`.

The modal must contain, in order:

### Modal header
- Title with icon `bi-funnel` and text "Limpieza de ruido".
- A `btn-close btn-close-white` dismiss button.

### Modal body

**Mask selector block** (`<div class="mb-3">`):
- A `<label>` with class `small text-muted` and text "Capa a procesar".
- A `<select>` with id `cleanNoiseMaskSelect` and classes
  `form-select form-select-sm bg-dark text-light border-secondary`.
  Leave it empty — JS will populate it.

**Analyze button**:
- `id="analyzeComponentsBtn"`
- Classes: `btn btn-sm btn-outline-secondary w-100 mb-3`
- Icon `bi-diagram-3` and label "Analizar componentes".

**Results section** (`<div id="cleanNoiseResults" style="display:none;">`):
- A `<p>` with id `cleanNoiseTotalCount` and class `small text-muted mb-2`. Empty.
- A `<table>` with classes `table table-dark table-sm mb-2` and inline style
  `font-size: 0.85rem`. Its `<thead>` must have one row with three `<th>` cells:
  `"#"`, `"Vóxeles"`, `"mm³"`. Its `<tbody>` must have id `cleanNoiseTableBody`
  and be empty (JS fills it).
- A threshold block (`<div class="mb-3">`):
  - A `<label>` with class `small text-muted` and text
    "Umbral mínimo (vóxeles) — eliminar componentes más pequeños que este valor".
  - An `<input>` with id `cleanNoiseThreshold`, type `number`, min `1`,
    classes `form-control form-control-sm bg-dark text-light border-secondary`,
    and placeholder `"Ej: 100"`.
  - A `<p>` with id `cleanNoiseFeedback`, classes `small text-warning mt-1 mb-0`.
    Empty.
- An action buttons block (`<div class="d-grid gap-2 mt-2">`):
  - Button id `keepLargestBtn`, classes `btn btn-sm btn-outline-success`,
    icon `bi-check-circle`, label "Mantener solo el mayor".
  - Button id `applyThresholdBtn`, classes `btn btn-sm btn-outline-warning`,
    icon `bi-funnel-fill`, label "Aplicar umbral".

### Modal footer
- A single `data-bs-dismiss="modal"` close button with class `btn btn-sm btn-secondary`
  and label "Cerrar". Same as `#metadataModal`.

---

## Step 6 — Add event listeners in `viewer.js`

**Location**: find the `toggleVolume3dBtn` click handler block added in the previous
implementation (currently the last block in the segmentation section, around line 1847).
Insert all five new blocks immediately after that block ends.

Before the first block, declare a module-level state object at the same scope as the
other variables at the top of that section:

```
const cleanNoiseState = { segId: null, components: [], totalComponents: 0,
                          restCount: 0, restVoxels: 0 };
```

### Block 1 — Populate the dropdown when the modal opens

Select `document.getElementById('cleanNoiseModal')` and attach an event listener for
the `'show.bs.modal'` event. Guard with an `if` null check.

Inside the listener:
1. Select `cleanNoiseMaskSelect` and set its `innerHTML` to `''`.
2. Iterate `viewState.segmentations`. For each entry, create an `<option>` element,
   set its `value` to `entry.id` and its `textContent` to `entry.name`. If
   `entry.id === viewState.activeSegmentationId`, set `option.selected = true`.
   Append the option to the select.
3. Reset the results section: set `cleanNoiseResults.style.display = 'none'`.
4. Set `cleanNoiseTotalCount.textContent = ''`.
5. Set `cleanNoiseTableBody.innerHTML = ''`.
6. Set `cleanNoiseThreshold.value = ''`.
7. Set `cleanNoiseFeedback.textContent = ''`.
8. Reset the state object: set all fields of `cleanNoiseState` back to their initial
   values (`null`, `[]`, `0`, `0`, `0`).

### Block 2 — Analyze button click

Select `analyzeComponentsBtn`. Guard with an `if` null check.

Attach a `click` event listener. Inside:
1. Read `segId = parseInt(cleanNoiseMaskSelect.value)`. Store it in
   `cleanNoiseState.segId`.
2. Disable the button and change its `textContent` to `'Analizando...'`.
3. Retrieve the CSRF token.
4. Call `fetch('/analyze_components')` with method `POST`, the CSRF header, and body
   `JSON.stringify({ seg_id: segId })`.
5. In the first `.then()`, parse JSON. If `response.ok` is `false`, throw a new
   `Error` with the JSON `message` field.
6. In the second `.then(data => { ... })`:
   a. If `data.total_components === 0`, call `alert('La máscara está vacía.')` and
      return.
   b. Store the analysis results in `cleanNoiseState`:
      `components`, `totalComponents`, `restCount`, `restVoxels`.
   c. Set `cleanNoiseTotalCount.textContent` to
      `${data.total_components} componentes encontrados`.
   d. Clear `cleanNoiseTableBody.innerHTML = ''`.
   e. For each entry in `data.top_components`: create a `<tr>`, set its `innerHTML`
      to three `<td>` cells containing `entry.rank`,
      `entry.voxels.toLocaleString()`, and `entry.mm3.toLocaleString()`.
      Append to `cleanNoiseTableBody`.
   f. If `data.rest_count > 0`: create one additional `<tr>` with class
      `text-muted`. Its three `<td>` cells must contain the text `'...'`,
      `${data.rest_voxels.toLocaleString()} vóx. (${data.rest_count} comp.)`,
      and `'—'`. Append it.
   g. Set `cleanNoiseResults.style.display = ''` to make the section visible.
7. In the `.catch()` handler, call `alert('Error: ' + err.message)`.
8. In the `.finally()` handler:
   a. Re-enable the button.
   b. Set the button's `innerHTML` back to
      `'<i class="bi bi-diagram-3"></i> Analizar componentes'`.

### Block 3 — Threshold input live feedback

Select `cleanNoiseThreshold`. Guard with an `if` null check.

Attach an `input` event listener. Inside:
1. Read `const threshold = parseInt(this.value) || 0`.
2. If `threshold <= 0` or `cleanNoiseState.components.length === 0`, set
   `cleanNoiseFeedback.textContent = ''` and return.
3. Count how many entries in `cleanNoiseState.components` have `entry.voxels <
   threshold`. Store as `toRemoveFromTop`.
4. Determine whether ALL rest components would also be removed: since all "rest"
   components are smaller than the smallest top-5 component, they are removed whenever
   the threshold is greater than 1. Add `cleanNoiseState.restCount` to the remove
   count if `threshold > 1`.
5. Compute `toKeep = cleanNoiseState.totalComponents - totalToRemove`.
6. Set `cleanNoiseFeedback.textContent` to a message of the form:
   `"Se eliminarán ~X componentes, quedarán ~Y."` Use approximate values since the
   rest components are not individually enumerated.

### Block 4 — "Mantener solo el mayor" button click

Select `keepLargestBtn`. Guard with an `if` null check.

Attach a `click` event listener. Inside:
1. If `cleanNoiseState.segId === null`, call `alert('Analiza primero una capa.')` and
   return.
2. Disable the button.
3. Retrieve the CSRF token.
4. Call `fetch('/clean_segmentation')` with method `POST`, the CSRF header, and body
   `JSON.stringify({ seg_id: cleanNoiseState.segId, mode: 'largest' })`.
5. In the first `.then()`, parse JSON. If `response.ok` is `false`, throw a new
   `Error` with the JSON `message` field.
6. In the second `.then()`:
   a. Close the modal: `bootstrap.Modal.getInstance(document.getElementById
      ('cleanNoiseModal')).hide()`.
   b. Refresh the 2D views: call `updateImage(view, slider.value, true, true)` for each
      view in `VIEWS`, reading the slider value from
      `document.getElementById('slider_' + view)`.
   c. Call `refresh3D()`.
7. In the `.catch()` handler, call `alert('Error: ' + err.message)`.
8. In the `.finally()` handler, re-enable the button.

### Block 5 — "Aplicar umbral" button click

Select `applyThresholdBtn`. Guard with an `if` null check.

Attach a `click` event listener. Inside:
1. If `cleanNoiseState.segId === null`, call `alert('Analiza primero una capa.')` and
   return.
2. Read `const threshold = parseInt(cleanNoiseThreshold.value) || 0`. If `threshold <
   1`, call `alert('Introduce un umbral mayor que cero.')` and return.
3. Disable the button.
4. Retrieve the CSRF token.
5. Call `fetch('/clean_segmentation')` with method `POST`, the CSRF header, and body
   `JSON.stringify({ seg_id: cleanNoiseState.segId, mode: 'threshold',
   threshold_voxels: threshold })`.
6. In the first `.then()`, parse JSON. If `response.ok` is `false`, throw a new
   `Error` with the JSON `message` field.
7. In the second `.then()`:
   a. Close the modal using `bootstrap.Modal.getInstance`.
   b. Refresh 2D views for all views (same pattern as Block 4, step 6b).
   c. Call `refresh3D()`.
8. In the `.catch()` handler, call `alert('Error: ' + err.message)`.
9. In the `.finally()` handler, re-enable the button.

---

## Step 7 — Manual Testing Checklist

### Happy path

- [ ] Load a DICOM series and run the AI segmentation to get a noisy mask.
- [ ] Open the segmentation tool panel. Verify "Limpiar ruido" button is present below
      the import button.
- [ ] Click "Limpiar ruido". Verify the modal opens with a dropdown listing all current
      segmentation layers, defaulting to the active one.
- [ ] Click "Analizar componentes". Verify a spinner appears briefly, then a table with
      up to 5 rows appears showing rank, voxel count, and mm³. Verify the total count
      label is correct.
- [ ] If there are more than 5 components, verify a "..." rest row appears with a
      combined voxel count and component count.
- [ ] Type a value into the threshold input. Verify the feedback label updates to show
      approximately how many components will be removed.
- [ ] Click "Mantener solo el mayor". Verify the modal closes, the 2D views refresh
      showing only the largest connected component, and the 3D view updates accordingly.
- [ ] Repeat with "Aplicar umbral" using a reasonable threshold. Verify components
      smaller than the threshold are removed.

### Mask selector

- [ ] Create three segmentation layers with painted voxels.
- [ ] Open the modal. Verify the dropdown lists all three layers by name.
- [ ] Select a different layer from the dropdown, click Analizar. Verify the analysis
      reflects the selected layer, not the active one.
- [ ] Apply cleanup to the non-active layer. Verify only that layer's mask changes.

### Edge cases

- [ ] Open the modal when no segmentations exist. Verify the dropdown is empty and
      "Analizar" produces a graceful empty-mask response.
- [ ] Open the modal and click "Mantener solo el mayor" without first clicking
      "Analizar". Verify the alert "Analiza primero una capa." appears.
- [ ] Click "Aplicar umbral" with the threshold field empty. Verify the validation
      alert appears.
- [ ] Analyze a mask that is already a single connected component. Verify
      `total_components: 1` is returned and "Mantener solo el mayor" keeps the mask
      unchanged.
- [ ] Close the modal without applying any action. Verify no masks are modified.

### Regression tests

- [ ] Verify all existing segmentation actions (hide, delete, create, import, export)
      still work correctly after this change.
- [ ] Verify the 3D multi-layer render still works after cleaning a mask.
- [ ] Verify the undo button state resets correctly for a cleaned mask (undo is not
      available after cleanup, since `last_polygon_operation` is set to `None`).
