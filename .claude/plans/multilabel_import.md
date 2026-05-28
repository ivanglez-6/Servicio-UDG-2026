# Multilabel Segmentation Import — Implementation Plan

## Context

This plan implements the import half of the multilabel segmentation round-trip. A user can
upload a `.seg.nrrd` file produced by this application (or by 3D Slicer following the same
convention), and the viewer will automatically restore all segmentation layers with their original
names and colors.

**Behavior on import**: replace all current segmentation layers entirely (no merging, no append).
The user is warned before the replacement happens via a browser `confirm()` dialog.

**Detection rule**: a `.nrrd` file is treated as a segmentation file if and only if its header
contains the key `Segment0_LabelValue`. Any `.nrrd` file without this key must be rejected with
an error message explaining that the RT struct upload button should be used instead.

**Important — pynrrd header parsing**: `nrrd.read()` places non-standard NRRD keys (our
`Segment*` fields, written with `:=` format) into a nested dict under `header['keyvaluepairs']`,
not at the top level of the header dict. Before looking up any `Segment{N}_*` key, always build
a single flat lookup dict by merging `header` with `header.get('keyvaluepairs', {})`. All key
lookups in this plan refer to this flat dict.

---

## Files to Modify

| File | Change |
|------|--------|
| `main.py` | Add one helper function; add one new route |
| `templates/render.html` | Add one import button and one hidden file input |
| `static/js/viewer.js` | Add two event listeners (button click and file change) |

---

## Step 1 — Add `_nrrd_color_to_hex()` helper in `main.py`

**Location**: insert immediately after the `_hex_to_nrrd_color()` function (currently at line 98).

**What it must do**:

1. Accept a single argument: a space-separated string of three RGB float values in the range
   0.0–1.0, e.g. `"0.682353 0.109804 0.156863"`.
2. Split the string on whitespace to get three float tokens.
3. Convert each token to a float, multiply by 255, and round to the nearest integer.
4. Format the three integers as a hex color string `#RRGGBB` using uppercase hex digits, e.g.
   `"#AE1C28"`.
5. Return that hex string.
6. If the input string is malformed (cannot be split into exactly three valid floats), return the
   fallback string `"#AAAAAA"` instead of raising an exception.

---

## Step 2 — Add `/import_segmentation` route in `main.py`

**Location**: insert the entire new route immediately after the closing `except` block of the
`export_segmentation` route (the `export_segmentation` route ends around line 1302). The new
route goes before the `@app.route('/anonimize')` line.

**Route declaration**:
- Decorator: `@app.route("/import_segmentation", methods=["POST"])`
- CSRF is already enforced globally via `CSRFProtect(app)` — no extra decoration needed.
- Content type: `multipart/form-data` (file upload). The field name for the file is `file`.

**What the route function must do, in order**:

### 2a. Validate the uploaded file

1. Call `get_user_data()` to retrieve the current user's session dict.
2. Retrieve the uploaded file from `request.files.get("file")`.
3. If no file was submitted or the filename is empty, return a JSON error response with HTTP 400
   and message `"No se seleccionó ningún archivo."`.
4. If the filename does not end with `.nrrd` (case-insensitive check), return a JSON error
   response with HTTP 400 and message `"Solo se aceptan archivos .nrrd"`.

### 2b. Read the NRRD file

5. Save the file to `UPLOAD_FOLDER_NRRD` using `os.path.join(UPLOAD_FOLDER_NRRD, file.filename)`
   as the destination path.
6. Read the saved file with `nrrd.read(filepath)`, which returns `(data_array, header_dict)`.
7. Build a flat lookup dict by starting with a copy of `header_dict` and then updating it with
   `header_dict.get('keyvaluepairs', {})`. Use this flat dict for all subsequent key lookups.

### 2c. Detect whether this is a segmentation NRRD

8. Check whether the key `"Segment0_LabelValue"` exists in the flat lookup dict.
9. If it does NOT exist, return a JSON error response with HTTP 400 and message
   `"Este archivo no es una segmentación exportada. Para RT Struct, usa el botón de carga correspondiente."`.

### 2d. Validate that a volume is loaded

10. Retrieve `user_data.get('dims')`. If it is `None`, return a JSON error response with HTTP 400
    and message `"Carga un estudio DICOM antes de importar una segmentación."`.

### 2e. Parse all segment entries from the header

11. Initialize an empty list called `parsed_segments`.
12. Iterate `N` from 0 upward (0, 1, 2, …) using a `while` loop. On each iteration:
    a. Check whether the key `f"Segment{N}_LabelValue"` exists in the flat lookup dict. If it
       does not, exit the loop.
    b. Read the value of `f"Segment{N}_LabelValue"` and cast it to `int`. This is the label value.
    c. Read the value of `f"Segment{N}_Name"` from the flat lookup dict. If the key is absent,
       use the fallback string `f"Segmentación {N + 1}"`.
    d. Read the value of `f"Segment{N}_Color"` from the flat lookup dict. If the key is absent,
       use the fallback string `"0.667 0.667 0.667"`. Pass the value (or fallback) to
       `_nrrd_color_to_hex()` to obtain a hex color string.
    e. Append a dict `{'label_value': label_value, 'name': name, 'color': hex_color}` to
       `parsed_segments`.
13. If `parsed_segments` is empty after the loop, return a JSON error response with HTTP 400 and
    message `"El archivo no contiene segmentaciones válidas."`.

### 2f. Extract and resize each binary mask

14. Retrieve the target volume shape from `user_data['dims']` as `(Z, Y, X)`.
15. For each entry in `parsed_segments`:
    a. Create a binary mask: select all voxels in `data_array` equal to the entry's `label_value`,
       convert the boolean result to `uint8`, and multiply by 255. The result has the same shape
       as `data_array`.
    b. If the mask's shape does not exactly match `(Z, Y, X)`, use `scipy.ndimage.zoom` with
       `order=0` (nearest-neighbor) to resize it. Compute the zoom factors as
       `(Z / mask.shape[0], Y / mask.shape[1], X / mask.shape[2])`.
    c. Store the final mask array back in the entry dict under the key `'mask'`.

### 2g. Replace all current segmentations

16. Set `user_data['segmentations']` to a new empty dict `{}`.
17. Set `user_data['active_segmentation_id']` to `None`.
18. Initialize a local variable `first_slot` to `None`.
19. For each entry in `parsed_segments`, in order:
    a. Find the next available slot id using `next(i for i in range(10000) if i not in segs)`
       where `segs` refers to `user_data['segmentations']`.
    b. Assign `user_data['segmentations'][slot]` a new dict with keys: `'name'` (entry's name
       string), `'mask'` (entry's mask array), `'color'` (entry's hex color string),
       `'visible'` set to `True`, and `'last_polygon_operation'` set to `None`.
    c. If `first_slot` is still `None`, set `first_slot` to this slot id.
20. Set `user_data['active_segmentation_id']` to `first_slot`.

### 2h. Return success

21. Return a JSON response `{"status": "success"}` with HTTP 200.
22. Wrap steps 2b through 2h in a single `try/except Exception as e` block. On any exception,
    return a JSON error response with HTTP 500 and message `f"Error al importar: {str(e)}"`.

---

## Step 3 — Add the import button and hidden file input in `render.html`

**Location**: open `templates/render.html` and find the `<button id="exportMultilabelSegBtn">` at
line 232. Insert the following two elements immediately after the closing `>` of that button
(i.e., after line 234, before `</div>` at line 235).

**What to add**:

1. A hidden `<input>` element:
   - `type="file"`
   - `id="importSegFileInput"`
   - `accept=".nrrd"`
   - `style="display:none;"`
   - No `name` attribute (it will be read by JS, not submitted as a traditional form).

2. A visible `<button>` element:
   - `id="importSegBtn"`
   - Same CSS classes as `exportMultilabelSegBtn`: `btn btn-sm btn-outline-primary w-100 mt-1`
   - Add a Bootstrap upload icon: `<i class="bi bi-upload"></i>`
   - Label text: "Importar .seg.nrrd"
   - No `type` attribute (defaults to `button`, which is correct — no form submission).

The button comes after the hidden input in the HTML source. Both elements sit at the same
indentation level as the other export buttons inside `segmentationToolContainer`.

---

## Step 4 — Add event listeners in `viewer.js`

**Location**: find the `exportMultilabelSegBtn` click handler block that was added in the export
PR (currently around line 1743). The two new blocks go immediately after that block ends.

### Block 1 — Connect the import button to the hidden file picker

Add a new `if` block that:
1. Selects the element with id `importSegBtn`. Guard with an `if` null check.
2. Attaches a `click` event listener.
3. Inside the listener, select the element with id `importSegFileInput` and call `.click()` on it.
   This opens the OS file picker dialog without any form submission.

### Block 2 — Handle the file selection and upload

Add a second new block that:
1. Selects the element with id `importSegFileInput`. Guard with an `if` null check.
2. Attaches a `change` event listener (fires when the user picks a file).
3. Inside the listener:
   a. Read `this.files[0]`. If it is falsy (no file selected), return immediately.
   b. Show a `confirm()` dialog with the message:
      `"Importar esta segmentación reemplazará TODAS las capas actuales. ¿Deseas continuar?"`
      If the user clicks Cancel (returns `false`), reset the file input value to `''` and return.
   c. Build a `FormData` object and append the file to it under the field name `"file"`.
   d. Retrieve the CSRF token from `document.querySelector('meta[name="csrf-token"]')` exactly
      as done in the `rtStructForm` handler in this file.
   e. Show the full-screen loader overlay (select element with id `loader-wrapper`, set its
      `display` to `'flex'` and `opacity` to `'1'`) — same pattern as the RT struct form handler.
   f. Select the import button by id `importSegBtn` and set its `disabled` property to `true`.
   g. Call `fetch('/import_segmentation')` with:
      - method: `'POST'`
      - headers: `{ 'X-CSRFToken': csrfToken }` (do NOT set `Content-Type` — the browser sets it
        automatically with the correct boundary when using `FormData`)
      - body: the `FormData` object
   h. In the first `.then()`, parse the response as JSON. If `response.ok` is `false`, throw a
      new `Error` using the `message` field from the JSON body.
   i. In the second `.then()` (data is the parsed JSON), do three things:
      - Call `loadSegmentations()` to refresh the layer list in the sidebar.
      - Call `updateImage(view, slider.value, true)` for each view in `VIEWS`, reading the
        current slider value from `document.getElementById('slider_' + view)` before calling.
      - Call `alert('Segmentación importada correctamente.')`.
   j. In the `.catch()` handler, call `alert()` with the error message (same pattern as other
      upload handlers in this file).
   k. In the `.finally()` handler:
      - Hide the loader: set its `opacity` to `'0'`, then after 500ms set its `display` to `'none'`.
      - Re-enable the import button: set `importSegBtn.disabled = false`.
      - Reset the file input: set `importSegFileInput.value = ''` so the same file can be
        re-selected if needed.

---

## Step 5 — Manual Testing Checklist

Perform all of these steps before marking the work as done.

**Round-trip test (main scenario)**:
- [ ] Load any DICOM series.
- [ ] Open the segmentation tool. Create two layers, name them "Tumor" and "Edema". Note their
      colors.
- [ ] Paint voxels in both layers across several slices.
- [ ] Click "Exportar multilabel (.seg.nrrd)" and save the file.
- [ ] Create a third segmentation layer named "Test". Verify it appears in the list.
- [ ] Click "Importar .seg.nrrd" and select the file just exported.
- [ ] Confirm the replacement dialog appears.
- [ ] After import: verify the layer list shows exactly "Tumor" and "Edema" (no "Test"), with the
      same colors as before export.
- [ ] Navigate through the slices and verify the painted regions appear correctly in all three
      views.

**Cancel behavior**:
- [ ] Click "Importar .seg.nrrd", select a file, then click Cancel in the confirmation dialog.
      Verify the current layers are unchanged.

**Error cases**:
- [ ] Try importing a plain binary `.nrrd` file (e.g., one exported via "Exportar Activa").
      Verify an error message appears saying to use the RT struct button.
- [ ] Try importing while no DICOM is loaded (go to home page and navigate directly to the import
      button). Verify the error message mentions loading a DICOM first.
- [ ] Try uploading a `.dcm` file renamed to `.nrrd`. Verify a readable error is shown without
      crashing the server.

**Regression tests**:
- [ ] Verify "Exportar Activa" still produces a single binary `.nrrd`.
- [ ] Verify "Exportar Todas" still produces a `.zip` of individual `.nrrd` files.
- [ ] Verify "Exportar multilabel" still produces a `.seg.nrrd`.
- [ ] Verify the RT struct upload form (the `rtStructPluginBtn` panel) still works independently.

---

## Appendix — Notes for the Next Engineer

### On pynrrd key-value pair behavior

When `nrrd.write()` receives header keys that are not part of the standard NRRD specification
(such as `Segment0_Name`), it writes them using the NRRD key-value pair syntax: `key:=value`.
When `nrrd.read()` encounters these lines, it stores them inside `header['keyvaluepairs']` as a
nested dict, NOT at the top level of the header dict. This is the correct behavior for pynrrd
1.1.3. Always build the flat lookup dict (step 2b in this plan) before searching for segment keys,
or custom keys will silently not be found.

### On 3D Slicer compatibility

3D Slicer stores colors as three floats in the range 0.0–1.0 separated by single spaces, which
is the same format written by `_hex_to_nrrd_color()`. The `_nrrd_color_to_hex()` helper written
in Step 1 handles this format correctly and therefore also handles files exported from 3D Slicer.
Slicer may include additional `Segment{N}_*` keys (e.g. `Segment0_Tags`, `Segment0_Extent`).
The parsing loop in step 2e only reads `_LabelValue`, `_Name`, and `_Color`, so unknown keys are
ignored automatically.

### On shape mismatches

If the imported NRRD was created from a different DICOM series than the one currently loaded,
the mask shape will not match and the `zoom` fallback in step 2f will resize it. This is
intentional and matches the behavior used for AI mask alignment. The results may be spatially
inaccurate in this scenario, but the operation will not crash.
