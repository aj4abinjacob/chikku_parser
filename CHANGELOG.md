# Changelog

## Chikku Parser v0.3.51

### Cell inspection and editing

- Inspect full cell values and edit supported source cells with draft undo and redo, value comparison, and explicit NULL and empty-string controls.
- Track applied edits in cell and table history, with safeguards against stale rows and accidental loss of unexported changes.
- Improved table display controls, search placement, and in-app guidance for editing.

**Full changelog:** https://github.com/aj4abinjacob/chikku_parser/compare/v0.3.50...v0.3.51

## Chikku Parser v0.3.46

### PDF Viewer

- Fixed PDFs failing to open on WebViews that do not yet support `Map.prototype.getOrInsertComputed` by using PDF.js compatibility builds for both the viewer and worker.
- Fixed error-state action button text using muted colors, restoring readable labels in light and dark themes.

**Full changelog:** https://github.com/aj4abinjacob/chikku_parser/compare/v0.3.45...v0.3.46

## Chikku Parser v0.3.45

### PDF Workspace

- Added a dedicated PDF workspace with thumbnails, document outlines, page navigation, search, zoom, page rotation, password prompts, and secure external-link handling.
- Added permission-aware printing with a memory-safe system-viewer fallback for large documents.
- Added PDF file associations, in-app help, signature warnings, and optimized rendering that keeps long documents responsive.
- Moved PDF thumbnails and outlines into the main sidebar so document navigation stays consistent with the rest of the app.

### PDF Image Editing

- Added image insertion from APNG, AVIF, BMP, GIF, ICO, JPEG, PNG, SVG, and WebP files, with drag positioning, resizing, deletion, and Save As support.
- Added 90° rotation, mouse-driven 1° rotation with a live angle readout, Shift-assisted 15° snapping, and a right-click option to reset rotation to 0°.
- Added horizontal and vertical flipping, layer ordering, undo and redo support, and saved-PDF persistence for image transforms.
- Restricted the image picker to supported formats and preserved the original PDF by saving edits to a new copy.

### PDF Image Export

- Added PNG, JPEG, and WebP export for the current page or the entire document, with previews, progress, and numbered filenames for multi-page exports.
- Added original, A4, A3, Letter, Legal, and custom output sizes; portrait, landscape, and automatic orientation; and 96, 150, or 300 DPI output.
- Added custom dimensions in pixels, millimetres, or inches plus quality controls for lossy formats.

**Full changelog:** https://github.com/aj4abinjacob/chikku_parser/compare/v0.3.44...v0.3.45

## Chikku Parser v0.3.44

### Data Overview

- Added a prominent total-row count to the dataset health summary.
- Reworked the overview cards to use vertical space more efficiently and keep more of the column profile visible.
- Replaced the wide completeness bars with compact missing-value and uniqueness counts plus percentages.
- Split the combined range/top-value field into type-aware `Range / length` and `Most common` columns.
- Added numeric and date ranges, text-length ranges, most-common value frequencies, all-unique states, and constant-column signals.
- Limited most-common profiling to visible columns and cached the results until refresh to keep large datasets responsive.

### Link Previews

- Improved hover and focus transitions so live link-preview cards remain open while moving between a cell tooltip and its preview.

**Full changelog:** https://github.com/aj4abinjacob/chikku_parser/compare/v0.3.43...v0.3.44
