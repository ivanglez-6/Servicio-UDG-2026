# Multilabel Segmentation Export — Implementation Plan

## Context

The app currently stores each segmentation as a separate binary mask in memory (values 0 or 255).
When exporting, each mask is written to its own `.nrrd` file. This PR adds a third export option:
a single multilabel `.seg.nrrd` file where each voxel holds an integer label (0 = background,
1 = first segment, 2 = second segment, etc.), with segment names and colors embedded in the file
header. This follows the 3D Slicer `.seg.nrrd` convention, making the output compatible with
external tools like 3D Slicer and ITK-SNAP.

**Internal storage does not change.** The merge from separate binary masks into a multilabel
array happens only at export time.

**Overlap rule**: if two masks paint the same voxel, the segment with the higher `seg_id` key
wins (last-created overwrites earlier ones in the merged output).

---

## Files to Modify

| File | Change |
|------|--------|
| `main.py` | Add two helper functions; extend `export_segmentation` route |
| `templates/render.html` | Add one new button to the export UI |
| `static/js/viewer.js` | Add one new event listener for the new button |

---

## Step 1 — Add `_hex_to_nrrd_color()` helper in `main.py`

**Location**: insert immediately after the `_make_seg_color()` function (around line 96).

**What it must do**:

1. Accept a single argument: a hex color string in the format `#RRGGBB` (e.g. `#AE1C28`).
2. Parse the red, green, and blue components as integers (0–255).
3. Convert each component to a float in the range 0.0–1.0 (divide by 255, round to 6 decimal places).
4. Return a single space-separated string of the three floats, e.g. `"0.682353 0.109804 0.156863"`.

This format is required by the `.seg.nrrd` convention and is what 3D Slicer writes and reads.

---

## Step 2 — Add `_merge_to_multilabel()` helper in `main.py`

**Location**: insert immediately after the `_hex_to_nrrd_color()` function added in Step 1.

**What it must do**:

1. Accept two arguments: `segs` (the `user_data['segmentations']` dict) and `dims` (the volume
   shape tuple `(Z, Y, X)`).
2. Create a NumPy array of zeros with shape `dims` and dtype `uint8`.
3. Sort the keys of `segs` in ascending integer order — this determines label assignment order.
4. Iterate through the sorted keys. For each key, assign the next sequential integer label
   starting at 1 (first key → label 1, second key → label 2, etc.).
5. For each segment, set every voxel in the output array to the current label integer wherever
   that segment's binary mask has a value greater than zero. Use NumPy boolean indexing. This
   naturally implements last-write-wins for any overlapping voxels.
6. Build a list of dicts, one per segment, in the same sorted order used above. Each dict must
   contain three keys: `label_value` (the integer assigned, starting at 1), `name` (the segment's
   name string), and `color_hex` (the segment's hex color string).
7. Return a tuple of `(multilabel_array, segment_info_list)`.

---

## Step 3 — Extend `export_segmentation` in `main.py`

**Location**: find the `export_segmentation` route (around line 1222). Inside it, there is already
an `if mode == 'all':` branch and an `else:` branch for active. Add a new `elif mode == 'multilabel':` 
branch. Place it **before** the existing `else:` block.

**What the new branch must do**:

1. Check that `segs` is not empty. If it is, return a JSON error response with HTTP 400 and the
   message `"No hay segmentaciones para exportar"`.
2. Call `_merge_to_multilabel(segs, dims)` where `dims` comes from `user_data.get('dims')`. Store
   the returned multilabel array and segment info list in local variables.
3. Retrieve spatial metadata exactly the same way the existing `make_header()` local function does:
   call `_extract_spacing_for_series()` for `dx`, `dy`, `dz` and read `grid_full.origin`.
4. Build an NRRD header dict. Start with the same spatial fields as the existing `make_header()`
   local function: `space`, `kinds`, `space directions`, and `space origin`. Do not reuse the local
   `make_header()` function — build a new dict directly.
5. For each entry in the segment info list, add three fields to the header dict using the index `N`
   (0-based) to name the keys:
   - Key `f"Segment{N}_Name"` with value equal to the segment's name string.
   - Key `f"Segment{N}_Color"` with value equal to `_hex_to_nrrd_color(color_hex)` for that segment.
   - Key `f"Segment{N}_LabelValue"` with value equal to the `label_value` integer cast to a string.
6. Determine the output file path inside `ANONIMIZADO_FOLDER` with the filename
   `segmentaciones_multilabel.seg.nrrd`.
7. Write the multilabel array and header to that path using `nrrd.write()`.
8. Return the file as a download using `send_file()` with `as_attachment=True` and
   `download_name='segmentaciones_multilabel.seg.nrrd'`.
9. Wrap everything in a `try/except Exception` block. On exception, return a JSON error response
   with HTTP 500 and a message that includes `str(e)`.

---

## Step 4 — Add the new button in `render.html`

**Location**: open `templates/render.html` and search for the element with id `exportAllSegBtn`.
This is the "Export all (individual)" button. The new button goes immediately below it.

**What to add**:

- A single `<button>` element.
- Set its `id` attribute to `exportMultilabelSegBtn`.
- Give it the same CSS classes as the `exportAllSegBtn` button so the visual style is consistent.
- Set its visible label text to "Exportar multilabel (.seg.nrrd)".
- Do not add any inline JavaScript or `onclick` attributes.

---

## Step 5 — Add the event listener in `viewer.js`

**Location**: open `static/js/viewer.js` and search for the block that handles `exportAllSegBtn`
(around line 1716). The new block goes immediately after that block ends.

**What to add**:

1. Select the element with id `exportMultilabelSegBtn`. Guard with an `if` check, identical in
   structure to the guards used for `exportAllSegBtn` and `exportActiveSegBtn`.
2. Attach a `click` event listener.
3. Inside the listener, retrieve the CSRF token from the `<meta name="csrf-token">` element,
   exactly as done in the existing export handlers.
4. Call `fetch('/export_segmentation')` with method `POST`, the appropriate headers including
   `X-CSRFToken`, and a JSON body of `{ mode: 'multilabel' }`.
5. If the response is not OK, throw an error (same pattern as the existing handlers).
6. Convert the response to a Blob.
7. Create a temporary anchor element, set its `href` to `URL.createObjectURL(blob)`, set its
   `download` attribute to `'segmentaciones_multilabel.seg.nrrd'`, append it to `document.body`,
   call `.click()` on it, then remove it from `document.body`.
8. In the `.catch()` handler, call `alert()` with an error message (same pattern as existing handlers).

---

## Step 6 — Manual Testing Checklist

Perform all of these steps in the running application before marking the work as done.

- [ ] Load any DICOM series successfully.
- [ ] Open the segmentation tool and create at least two layers with distinct names (e.g. "Tumor" and "Edema").
- [ ] Paint at least a few voxels in each layer. Paint some in the same region so there is deliberate overlap.
- [ ] Click "Exportar multilabel (.seg.nrrd)" and confirm the browser downloads a file named
      `segmentaciones_multilabel.seg.nrrd`.
- [ ] Open the downloaded file in a plain text editor. Confirm the header (the top of the file before
      the binary data) contains `Segment0_Name`, `Segment0_Color`, `Segment0_LabelValue`,
      `Segment1_Name`, etc., and that the names and colors match what was created in the viewer.
- [ ] Confirm that the existing "Export all (individual)" button still produces a `.zip` file of
      separate `.nrrd` files without regression.
- [ ] Confirm that the existing "Export active layer" button still produces a single binary `.nrrd`
      without regression.
- [ ] If 3D Slicer is available: open the `.seg.nrrd` file in it. Verify that it loads both segments
      with the correct names and colors.

---

---

# Import Implementation — Future Reference

> This section is NOT part of this PR. It is provided so the next engineer assigned to import
> can understand the full design without re-deriving it.

## Goal

Allow a user to upload a `.seg.nrrd` file produced by this tool (or by 3D Slicer following the
same convention) and have it automatically populate the segmentation layers in the viewer, with
the original names and colors restored. Uploading a segmentation file replaces all current
segmentation layers (replace-all, not append).

## New Backend Endpoint: `/import_segmentation`

- Method: `POST`
- Content-Type: `multipart/form-data`
- Accepts: a single `.nrrd` file field (name the form field `file`)
- Requires CSRF token as with all POST endpoints

**Processing steps the endpoint must perform**:

1. Validate that a file was submitted and that its filename ends with `.nrrd`.
2. Save the file to the `UPLOAD_FOLDER_NRRD` directory.
3. Read the file with `nrrd.read()`, which returns `(data_array, header_dict)`.
4. Inspect the header to determine whether this is a segmentation NRRD or an RT struct NRRD.
   The detection rule: if the header contains the key `Segment0_LabelValue`, it is a segmentation
   NRRD. Otherwise it is an RT struct and should be rejected with a 400 error and the message
   `"Use the RT Struct upload for non-segmentation NRRD files"`.
5. Parse all `SegmentN_*` keys from the header. Do this by iterating N from 0 upward until no
   `SegmentN_LabelValue` key is found. For each N, extract `name` from `SegmentN_Name`, `color`
   from `SegmentN_Color` (a space-separated RGB float string, convert back to hex), and
   `label_value` from `SegmentN_LabelValue` (cast to int).
6. Retrieve the current volume dimensions from `user_data.get('dims')`. If no volume is loaded,
   return a 400 error with message `"Carga un estudio DICOM antes de importar una segmentación"`.
7. For each parsed segment, extract its binary mask from the multilabel array by selecting all
   voxels equal to `label_value`, converting True/False to 255/0, and casting to `uint8`. The
   resulting array has the same shape as the volume.
8. **If the imported mask shape does not match the current volume shape**, use
   `scipy.ndimage.zoom` with `order=0` (nearest neighbor) to resize it, exactly as done in the
   AI mask normalization path (`normalize_ai_mask`).
9. Clear `user_data['segmentations']` entirely.
10. For each parsed segment (in label order), create a new entry in `user_data['segmentations']`
    using `next(i for i in range(10000) if i not in segs)` to assign a slot id, and populate
    `name`, `mask`, `color`, `visible=True`, and `last_polygon_operation=None`.
11. Set `user_data['active_segmentation_id']` to the slot id of the first imported segment.
12. Return a JSON success response.

## RGB Float → Hex Conversion

The inverse of `_hex_to_nrrd_color()`. Split the stored string on spaces, parse three floats,
multiply each by 255 and round to int, format as `#RRGGBB`. Add a helper `_nrrd_color_to_hex()`
alongside the existing color helpers.

## New Frontend UI

- A new button or upload form in the segmentation tool sidebar, separate from the RT struct
  upload form (they serve different purposes).
- Before sending the file, show a confirmation dialog warning the user that importing will replace
  all current segmentation layers.
- On success, reload all three 2D views with `updateImage()` and call `loadSegmentations()` to
  refresh the layer list in the sidebar.
- On error, display the error message from the JSON response.

## CSRF

The import form must include the CSRF token exactly as the RT struct upload form does in
`viewer.js` (fetch with `X-CSRFToken` header, form submitted via `FormData`).

## Compatibility Note

Files produced by 3D Slicer may contain additional `SegmentN_*` keys not listed here (e.g.
`Segment0_Tags`, `Segment0_Extent`). The parser must ignore unknown keys gracefully — only read
the three keys it knows about (`_Name`, `_Color`, `_LabelValue`) and skip everything else.