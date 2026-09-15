# CLAUDE.md

**Important:** Update this file after making changes. Keep sections accurate and in sync with the codebase.

**Important:** After completing any code change, always ask the user if they want to commit and push.

**Important:** When the user asks for a change or a new feature, always clarify any doubts or ambiguities before starting implementation. Ask questions first, code second.

## Project

Chikku Parser is a Tauri desktop app for viewing, combining, and transforming data files. Supports CSV, TSV, JSON, Parquet, and Excel (.xlsx/.xls) formats.

## Commands

```bash
npm run dev                   # Launch Tauri shell with webpack-dev-server
npm run build                 # Package Tauri app
npm run clean                 # Remove dist-tauri/
npm run tauri:renderer:build  # Build renderer only
npm run tauri:renderer:watch  # Run renderer dev server
npm run tauri:dev             # Launch Tauri shell with webpack-dev-server
npm run tauri:build           # Package Tauri app
npm run test:regressions      # Compile TS and run focused Node regression tests
npm run release:check -- vX.Y.Z # Validate a release tag before creating it
```

Development renderer builds use fast transpilation, lightweight source maps, and a persistent Webpack cache so repeated `npm run dev` launches do not rebuild and type-check the full renderer. Regression tests and production renderer builds continue to run full TypeScript checking.

## Release Process

Follow `RELEASE.md` whenever the user asks to publish a new tag. Always bump all app version files before tagging, run `npm run release:check -- vX.Y.Z` from the clean release commit, push the branch and tag, wait for the GitHub release workflow, and verify `latest.json` reports the new version, non-empty notes, and all supported platforms.

## Tauri Backend

`src-tauri/` hosts the Rust/Tauri app and runs the React renderer on top of a Rust process.

| Layer | File |
|-------|------|
| Cargo manifest | `src-tauri/Cargo.toml` |
| Tauri config | `src-tauri/tauri.conf.json` |
| Capabilities | `src-tauri/capabilities/default.json` |
| App entry | `src-tauri/src/main.rs` -> `lib.rs::run()` |
| DuckDB session map | `src-tauri/src/db.rs` (per-window, keyed by Tauri window label) |
| Tauri commands | `src-tauri/src/commands.rs` (load_file, query, exec, describe, tables, export_file, export_excel_multi, get_excel_sheets, free_memory, pattern CRUD, JSON/text/binary read/write, file_exists, file_stat, open_new_window, close_db, take_pending_files) |
| Excel | `src-tauri/src/excel.rs` (calamine reader -> temp CSV; rust_xlsxwriter writer) |
| Regex patterns | `src-tauri/src/patterns.rs` (GitHub fetch with bundled fallback from `src-tauri/assets/regex-patterns.json`; user patterns in `dirs::data_dir()/chikku-parser/`) |
| Multi-window | `src-tauri/src/window_mgr.rs` (per-window pending-files queue; spawn new window per opened file) |
| Frontend adapter | `src/tauri-api.ts` (installs `window.api` using Tauri invoke + event listen) |
| HTML shell | `html/index.html` |

Renderer detection: `src/renderer.tsx` calls `installIfTauri()` before mounting React. Detection uses `window.__TAURI_INTERNALS__` / `window.__TAURI__`.

Multi-window model:
- One Rust process, multiple Tauri webview windows.
- Each window owns an in-memory DuckDB session, closed on `WindowEvent::Destroyed`.
- File-open events (`RunEvent::Opened` on macOS, `tauri-plugin-single-instance` argv callback on Linux/Windows) spawn a new app window and queue the paths via `PendingFiles`.
- Renderer drains the queue on mount by calling `take_pending_files`.
- `db.rs` serializes DuckDB values into JSON-safe canonical values: temporal values use ISO text, integers outside JavaScript's safe range and exact decimals use strings, and nested/list/map values stay structured. Grid SQL casts transport types such as wide DECIMAL and TIME WITH TIME ZONE to text where the Rust adapter cannot preserve them directly.

External file changes:
- `useExternalFileChange` (`src/hooks/useExternalFileChange.ts`) baselines the active file's mtime and size through the `file_stat` command and re-checks on window focus and visibility change — no watcher thread, no polling.
- In-app writes call `recordSelfWrite` from `src/utils/fileWatch.ts` (wired into `writeTextFile`/`writeBinaryFile` in `src/tauri-api.ts`), so saves never look like external edits.
- App.tsx renders `FileChangedBanner` above the workspace; reload runs `handleReloadActiveDocument(true)`, which bumps `reloadVersion` for document workspaces and re-imports tabular files after clearing their column/row op backups and QC state. Nothing is auto-reloaded.

Webpack builds a web-target renderer to `dist-tauri/`. Tauri dev runs webpack-dev-server on port 5181.

## Architecture

### Key Directories

- `src-tauri/` — Rust/Tauri backend, commands, window management, assets
- `src/components/` — React components
- `src/hooks/` — `useChunkCache`, `usePivotCache`, `useExternalFileChange`
- `src/utils/` — `sqlBuilder.ts`, `colOpsSQL.ts`, `rowOpsSQL.ts`, `dateDetection.ts`
- `src/types.ts` — TypeScript interfaces, including `DbApi`
- `src/styles/app.less` — All styles (imports BlueprintJS CSS)
- `html/` — Renderer HTML shell + favicon SVG
- `dist-tauri/` — Renderer output consumed by Tauri

### Tech Stack

Tauri 2, Rust, React 18, TypeScript 5 (strict, ES2020, CommonJS), DuckDB (in-memory), calamine, rust_xlsxwriter, BlueprintJS 4, chrono-node, @tanstack/react-virtual, Webpack 5, Less, lodash.

## Components

### App.tsx — Main Orchestrator
- State: `tables[]`, `activeTable`, `viewState`, `schema`, `resetKey`, dialog states, `colOpsSteps`/`rowOpsSteps` with `undoStrategy`, `savedViews`, `tableHistories`, `historyDialogOpen`
- Hooks: `useChunkCache` (flat mode), `usePivotCache` (pivot mode, when `pivotConfig.groupColumns.length > 0`)
- Key handlers: `loadFiles`, `handleDeleteTable`, `handleCombineExecute`, `handleDataOperation`, `handleSampleTable`, `handleCreateAggregateTable`, `handleCreatePivotTable`, `handleLookupMerge`, `handleColOpApply`, `handleColOpUndo`, `handleRowOpApply`, `handleRowOpUndo`, `handleRevertToEntry`, `handleExportHistory`, `handleImportHistory`
- `handleColOpApply`: reads `params.targetMode` ("replace"|"new_column"|"existing_column") and `params.targetColumn`; "new_column" adds column via `ALTER TABLE ADD COLUMN`; promotes non-VARCHAR to VARCHAR for string ops; executes `UPDATE` scoped by filters; adaptive undo (per-step vs snapshot based on RAM)
- Layout: `Sidebar + PivotToolbar + DataGrid + FilterPanel + StatusBar + dialogs`

### Sidebar.tsx — Left Panel
Tables and Operations stay available while the center section switches between Columns and Overview. Columns provides visibility/search and sort/group controls. Overview profiles the current filtered table with row/column totals, completeness, type mix, missing-value signals, and a selectable top-values chart. Operation buttons cover data operations, aggregate, pivot table, lookup merge, comparison, date conversion, and export.

### DataGrid.tsx — Virtualized Data Grid
Virtual scrolling via `@tanstack/react-virtual`. Div-based layout. Dual-mode: flat (chunk cache) and pivot (tree with group/data rows). Chunk generations reject stale responses, clear stale counts/loading markers on query changes, and expose failed count/chunk/pivot queries in the grid with a retry action. Cell selection, copy (TSV), multi-sort, column resize/reorder. Native text selection is disabled on grid cells (including the WebKit-prefixed rule) so clipboard copying stays cell-based. `ROW_HEIGHT = 28`.

### FilterPanel.tsx — Bottom Panel
Resizable (80-500px). Tabs: Filters, Column Ops, Row Ops, QC. The QC tab creates a review column (boolean or dropdown) plus an optional free-text notes column (`<qc_column>_notes` by default); notes are edited inline in the grid and cleared by Reset all. Mark done locks the QC values and notes until the session is resumed, while Start New QC keeps the completed columns and opens a fresh QC setup. Unsaved QC triggers a save/discard/cancel prompt when its window closes or the app quits. Recursive AND/OR filter groups. Operators include CONTAINS (regex) and type-aware IN/NOT IN value pickers. Picker state stores raw values separately from labels, supports server-side search beyond the first 1,000 values, and builds typed DuckDB literals. Draft state model with immutable updates. Filters tab has side-by-side filter builder and compact views panel.

### ColumnOpsPanel.tsx — Column Ops Tab
Three-column layout: config, preview, history. Operations include trim, uppercase, lowercase, find/replace, regex extract, set value, prefix/suffix, extract numbers, clear to NULL. Target modes support replacing, writing to a new column, or writing to an existing column. Live preview is debounced.

### DataOperationsDialog.tsx — Data Operations Modal
Includes substring, custom SQL, create/delete/combine/rename columns, sampling, duplicate removal, empty-row removal, conditional column, and NULL/sentinel replacement operations. Generates `CREATE OR REPLACE TABLE ... AS SELECT` SQL.

### JsonWorkspace.tsx — JSON/JSONL/NDJSON Editor
Shown instead of the data grid when the active file is json/jsonl/ndjson. Layout: toolbar (filename + dirty dot, Open/Save/Save As/Revert, Undo/Redo, Format/Minify, History toggle, validity tag) + resizable JSON tree panel + raw textarea editor (synced line numbers) + optional History panel + collapsible Flatten Preview. Full snapshot undo/redo via `useReducer` (`jsonHistoryReducer`, 100-entry cap, debounced typing pushes, immediate Format/Minify/Revert pushes); history list supports jump-to-any-point. Save writes in place via `writeTextFile`; Save As writes a copy (stays on current file). Cmd/Ctrl+S save, Cmd+Z/Cmd+Shift+Z undo/redo.

### MarkdownWorkspace.tsx — Markdown Reader and Editor
Rendered Markdown reader with outline navigation, search, zoom, source editing, synchronized preview scrolling, history, and Markdown/PDF export. The reader stores a compact path-hashed normalized scroll position in local app storage and restores it when the same file is reopened.

### PdfWorkspace.tsx — PDF Viewer, Image Placement, and Image Export
PDF.js viewer with thumbnails, outline navigation, search, zoom, rotation, password prompts, signature notices, full-screen viewing, and permission-aware printing. Its wider PDF navigation rail uses segmented Pages/Outline navigation, proportionally fitted thumbnail cards with explicit page labels, and a full-width final file action so labels do not clip. The toolbar reports overall reading completion beside page navigation, while a compact path-hashed page and document-coordinate record restores the last reading position when the same PDF is reopened. A visibly labeled PDF theme selector offers Light · Original, Dark · Keep colors, and PDF.js Dark · High contrast modes; choices are remembered per PDF for the current app session and never alter Save As, print, or image-export output. When PDF content permissions allow changes, the Image action uses a native image-only file dialog and inserts a supported raster or SVG stamp annotation on the current page using PDF.js's drag, resize, delete, and undo behavior. Save As serializes annotations with `PDFDocumentProxy.saveDocument()` and writes a new PDF through `writeBinaryFile`, preserving the source file. The left-sidebar Export Images action opens a compact preview dialog that exports the current page or all pages as PNG/JPEG/WebP at original, A4, A3, Letter, Legal, or custom pixel/millimetre/inch sizes and 96/150/300 DPI; multi-page exports use numbered filenames.

### Other Components
- **HelpCenter.tsx**: Searchable in-app documentation covering first-run guidance, tabular workflows, multi-file tools, QC/history, JSON, Markdown, PDF, export, and shortcuts; available from the sidebar, welcome screen, collapsed sidebar, or F1
- **ExportDialog.tsx**: Format selection (CSV/TSV/JSON/Excel/Parquet), table selection, view options, Excel row/col limit warnings
- **CombineDialog.tsx**: Column mapping modal for UNION ALL with auto VARCHAR cast
- **AggregateDialog.tsx**: Aggregate stats, optional Group By, materializes as `aggregate_N`
- **PivotDialog.tsx**: DuckDB native `PIVOT` syntax, materializes as `pivot_N`
- **PivotToolbar.tsx**: Controls above DataGrid when pivot active
- **LookupMergeDialog.tsx**: LEFT/INNER JOIN with composite keys, duplicate/NULL key detection, column conflict resolution
- **DateConversionDialog.tsx**: Format detection, `TRY_STRPTIME`/`strftime` conversion
- **ExcelSheetPickerDialog.tsx**: Multi-sheet import picker
- **ImportRetryDialog.tsx**: CSV parse failure retry with delimiter/ignore options
- **PreviewTableDialog.tsx**: Reusable results table dialog
- **FileChangedBanner.tsx**: Inline strip above the workspace when the active file changed or disappeared on disk, with Reload / Keep mine (Reload asks for confirmation when unsaved edits or table operations would be lost)
- **SearchableColumnSelect.tsx**: Popover2-based searchable column dropdown with keyboard nav
- **RegexPatternPicker.tsx**: Inline pattern picker grouped by category
- **RegexPatternManagerDialog.tsx**: Pattern CRUD + import/export
