# CLAUDE.md

**Important:** Update this file after making changes. Keep sections accurate and in sync with the codebase.

**Important:** After completing any code change, always ask the user if they want to commit and push.

**Important:** When the user asks for a change or a new feature, always clarify any doubts or ambiguities before starting implementation. Ask questions first, code second.

## Project

Chikku Data Combiner v2 — an Electron desktop app for viewing, combining, and transforming data files. Supports CSV, TSV, JSON, Parquet, and Excel (.xlsx/.xls) formats.

## Commands

```bash
npm run dev          # Build (dev) + launch Electron
npm run build-dev    # Build in development mode only
npm run build-prod   # Build in production mode
npm run watch        # Webpack watch mode (dev)
npm run start        # Launch Electron (requires prior build)
npm run dist         # Package for distribution (electron-builder)
npm run dist:mac     # Package for macOS only
npm run clean        # Remove dist/
```

## Architecture

**Single-package Electron app** with three webpack bundles (`webpack.config.js`):

| Bundle | Entry | Output | Target |
|--------|-------|--------|--------|
| Main | `app/main.ts` | `dist/main.bundle.js` | `electron-main` |
| Preload | `app/preload.ts` | `dist/preload.bundle.js` | `electron-preload` |
| Renderer | `src/renderer.tsx` | `dist/renderer.bundle.js` | `electron-renderer` |

### Main Process (`app/main.ts`)
- Per-window DuckDB instances (`dbMap: Map<webContentsId, Database>`, in-memory `:memory:`)
- IPC handlers resolve DB via `event.sender.id`; promisified helpers `runPromise`/`allPromise`
- Excel import: sheet → temp CSV via SheetJS → `read_csv_auto()` → cleanup
- "Open With" support: `app.on("open-file")` (macOS), `process.argv` (CLI), single-instance lock
- Regex patterns: bundled `app/regex-patterns.json`, fetched from GitHub with fallback, user patterns in `userData`
- IPC channels: `db:load-file`, `db:query`, `db:exec`, `db:describe`, `db:tables`, `db:export-file`, `db:export-excel-multi`, `dialog:save-file`, `system:free-memory`, `file:get-excel-sheets`, `file:write-json`, `file:read-json`, `file:exists`, `patterns:*`

### Preload (`app/preload.ts`)
Context bridge exposing `window.api` (typed as `DbApi` in preload.ts). Key methods: `loadFile`, `query`, `exec`, `describe`, `tables`, `exportFile`, `exportExcelMulti`, `saveFileDialog`, `getFreeMemory`, `getExcelSheets`, `getRegexPatterns`, `saveUserPattern`, `deleteUserPattern`, `writeJsonFile`, `readJsonFile`, `fileExists`, `onOpenFiles`, `onAddFiles`, `onExportCSV`.

### Key Directories

- `app/` — Electron main process + preload
- `src/components/` — React components (24 files)
- `src/hooks/` — `useChunkCache`, `usePivotCache`
- `src/utils/` — `sqlBuilder.ts`, `colOpsSQL.ts`, `rowOpsSQL.ts`, `dateDetection.ts`
- `src/types.ts` — All TypeScript interfaces
- `src/styles/app.less` — All styles (imports BlueprintJS CSS)
- `html/` — HTML shell + favicon SVG (copied to dist)
- `res/` — Build resources, `icon.svg`

### Tech Stack
Electron 31, React 18, TypeScript 5 (strict, ES2020, CommonJS), DuckDB (in-memory), SheetJS (xlsx), BlueprintJS 4, chrono-node, @tanstack/react-virtual, Webpack 5, Less, lodash, electron-log.

## Components

### App.tsx — Main Orchestrator
- State: `tables[]`, `activeTable`, `viewState`, `schema`, `resetKey`, dialog states, `colOpsSteps`/`rowOpsSteps` with `undoStrategy`, `savedViews` (global flat array of SavedView), `tableHistories` (Map<string, TableHistory>), `historyDialogOpen`
- Hooks: `useChunkCache` (flat mode), `usePivotCache` (pivot mode, when `pivotConfig.groupColumns.length > 0`)
- Key handlers: `loadFiles`, `handleDeleteTable`, `handleCombineExecute`, `handleDataOperation`, `handleSampleTable`, `handleCreateAggregateTable`, `handleCreatePivotTable`, `handleLookupMerge`, `handleColOpApply`, `handleColOpUndo`, `handleRowOpApply`, `handleRowOpUndo`, `handleRevertToEntry`, `handleExportHistory`, `handleImportHistory`
- `handleColOpApply`: reads `params.targetMode` ("replace"|"new_column"|"existing_column") and `params.targetColumn`; "new_column" adds column via `ALTER TABLE ADD COLUMN`; promotes non-VARCHAR to VARCHAR for string ops; executes `UPDATE` scoped by filters; adaptive undo (per-step vs snapshot based on RAM)
- Layout: `Sidebar + PivotToolbar + DataGrid + FilterPanel + StatusBar + dialogs`

### Sidebar.tsx — Left Panel
Three sections: Tables (max 20%), Columns (flex), Operations (fixed bottom). Table management (delete, selective combine, search). Column visibility/search. Unified sort+group controls on column pills. Operation buttons: Data Operations, Aggregate, Pivot Table, Lookup Merge, Date Conversion, Export.

### DataGrid.tsx — Virtualized Data Grid
Virtual scrolling via `@tanstack/react-virtual`. Div-based layout. Dual-mode: flat (chunk cache) and pivot (tree with group/data rows). Cell selection, copy (TSV), multi-sort, column resize/reorder. `ROW_HEIGHT = 28`.

### FilterPanel.tsx — Bottom Panel (Filters + Column Ops + Row Ops)
Resizable (80-500px). Three tabs. Recursive AND/OR filter groups. Operators include CONTAINS (regex), IN (value picker). Draft state model with immutable updates. Filters tab has side-by-side layout: filter builder (left) + compact ViewsPanel (right, 260px fixed). Header bar includes Apply Filters, Clear, and Save View button (inline name input that toggles on click).

### ColumnOpsPanel.tsx — Column Ops Tab
Three-column layout: left config panel (~300px, scrollable) with stacked form fields, center preview panel (flex), right history panel (~240px). Operations grouped in `<optgroup>`: Text (Trim, UPPERCASE, lowercase), Search (Find & Replace, Regex Extract), Modify (Set Value, Prefix/Suffix, Extract Numbers, Clear to NULL). **Extract Numbers** has mode (First/All), type (Any/Integer/Float), separator (for All mode, default empty); Integer/Float use TRY_CAST for numeric output, "all" mode joins with separator as text. **Target mode** for all ops except clear_null: "Same column" (replace), "New column", "Existing column". **Live preview**: debounced (300ms) 5-sample Before/After table with empty state. **History panel**: always visible, shows "No steps yet" when empty, step list with undo/revert actions when populated. Adaptive undo (per-step/snapshot). Regex pattern picker integration.

### DataOperationsDialog.tsx — Data Operations Modal
17 operation types: regex_extract, trim, upper, lower, replace_regex, substring, custom_sql, create_column, delete_column, combine_columns, rename_column, sample_table, remove_duplicates, remove_empty_rows, conditional_column, replace_empty_null, replace_sentinel_null. **Remove Empty Rows** has All/Any mode (like pandas `dropna(how=...)`) with multi-column selection and row count preview. **Target mode selector** (extract ops only: regex_extract, substring, custom_sql): RadioGroup with "Replace source", "New column", "Existing column". All other ops replace source or use dedicated new-column input. Live preview. Generates `CREATE OR REPLACE TABLE ... AS SELECT` SQL.

### Other Components
- **ExportDialog.tsx**: Format selection (CSV/TSV/JSON/Excel/Parquet), table selection, view options, Excel row/col limit warnings
- **CombineDialog.tsx**: Column mapping modal for UNION ALL with auto VARCHAR cast
- **AggregateDialog.tsx**: Aggregate stats (SUM/MIN/MAX/AVG/COUNT/MEDIAN/STDDEV), optional Group By, materializes as `aggregate_N`
- **PivotDialog.tsx**: DuckDB native `PIVOT` syntax, materializes as `pivot_N`
- **PivotToolbar.tsx**: Controls above DataGrid when pivot active (expand/collapse, grand total, agg function). Default agg is LIST VALUES (unique values via `STRING_AGG(DISTINCT)`). Group row cells support selection, tooltip, and clipboard.
- **LookupMergeDialog.tsx**: LEFT/INNER JOIN with composite keys, duplicate/NULL key detection, column conflict resolution
- **DateConversionDialog.tsx**: Format detection (ISO/numeric/text-month), `TRY_STRPTIME`/`strftime` conversion
- **ExcelSheetPickerDialog.tsx**: Multi-sheet import picker
- **ImportRetryDialog.tsx**: CSV parse failure retry with delimiter/ignore options
- **PreviewTableDialog.tsx**: Reusable results table dialog
- **SearchableColumnSelect.tsx**: Popover2-based searchable column dropdown with keyboard nav
- **RegexPatternPicker.tsx**: Inline pattern picker grouped by category
- **RegexPatternManagerDialog.tsx**: Pattern CRUD + import/export
- **RowOpsPanel.tsx**: Row ops (delete_filtered, keep_filtered, remove_empty, remove_duplicates) with independent undo. **remove_empty** has All/Any mode toggle (like pandas `dropna(how=...)`).
- **ViewsPanel.tsx**: Compact views panel embedded in Filters tab right side — apply/update/rename/delete named ViewState snapshots globally (visible across all tables). In-memory only, no new tables created. Search input at top filters views by name. Scrollable view list with actions, inline rename via double-click. Compatibility checking: views with filter columns missing from current table schema are greyed out with disabled Apply button and tooltip showing missing columns. Origin badge shows source table name. Save View moved to FilterPanel header bar.
- **HistoryDialog.tsx**: Global operation history — two-panel modal (table list + timeline). Per-table history of all col ops, row ops, data ops with SQL replay-based revert. Save/load history as JSON. Generated tables viewable but non-revertible.
- **StatusBar.tsx**: Table name, row count, pivot status
- **Toolbar.tsx**: Sidebar toggle (largely superseded by Sidebar)

## Hooks

### useChunkCache — Lazy Data Loading
1000-row chunks, LRU eviction (max 20 chunks), generation counter for stale responses. Returns `{ totalRows, getRow, isRowLoaded, ensureRange }`.

### usePivotCache — Pivot View Data
Tree-based GroupNode cache. Lazy expand (sub-groups or data chunks). Returns `{ flatRows, grandTotals, loading, toggleExpand, expandAll, collapseAll, ensureRange }`.

## Types (`src/types.ts`)

Key types: `ColumnInfo`, `LoadedTable` (with optional `importOptions`), `ViewState`, `FilterGroup`/`FilterNode`/`FilterCondition` (recursive), `SortColumn`, `PivotGroupColumn`, `PivotViewConfig`, `PivotFlatRow`, `ColOpType`, `ColOpTargetMode` ("replace"|"new_column"|"existing_column"), `ColOpStep`, `RowOpType`, `RowOpStep`, `UndoStrategy`, `ColumnMapping`, `RegexPattern`, `SavedView`, `FileFormat`, `ImportOptions`, `SheetInfo`, `HistoryOpSource` ("col_op"|"row_op"|"data_op"), `HistoryEntry`, `TableSourceInfo`, `TableHistory`, `HistoryExportData`. Helper functions: `isFilterGroup()`, `hasActiveFilters()`, `countConditions()`, `extractFilterColumns()`. Constants: `EXCEL_MAX_ROWS`, `EXCEL_MAX_COLS`.

## Utils

### sqlBuilder.ts
`buildSelectQuery`, `buildFilterGroupClause`, `buildCombineQuery`, `buildMappedCombineQuery`, `buildChunkQuery`, `buildCountQuery`, `buildPivotGroupQuery`, `buildPivotGrandTotalQuery`, `buildPivotDataChunkQuery`, `escapeIdent`.

### colOpsSQL.ts
`buildColOpExpr(column, opType, params)` — returns SET expression string (used by both UPDATE and preview). `buildColOpUpdateSQL(tableName, column, opType, params, filters, targetColumn?)` — UPDATE with optional target column. `buildStepDescription(opType, column, params, targetColumn?)` — appends ` → "target"` when different. `buildAllMatchesExtractExpr`.

### rowOpsSQL.ts
`buildRowOpSQL(tableName, opType, params, filters, schema)` — DELETE or CREATE OR REPLACE TABLE. `buildRowOpStepDescription`.

### dateDetection.ts
`detectDateFormat(samples)` — classifies as ISO/numeric/text-month, max-value heuristic for DD/MM vs MM/DD. `OUTPUT_FORMATS` for dropdown.

## Key Patterns

- Generated tables use sequential names: `combined_N`, `sample_N`, `aggregate_N`, `pivot_N`, `merge_N`
- Backup tables: `__colops_backup_N_table` / `__colops_snapshot_table`, `__rowops_backup_N_table` / `__rowops_snapshot_table`
- Undo strategy chosen on first op: per-step (small tables, individual undo) vs snapshot (large tables, revert-all only)
- Column ops target modes (extract ops only): "replace" (UPDATE source), "new_column" (ALTER TABLE ADD + UPDATE), "existing_column" (UPDATE different col)
- Data operations use `CREATE OR REPLACE TABLE ... AS SELECT` pattern
- All filter/sort state lives in `ViewState`; chunk cache auto-resets on changes
- CSS namespaces: `.colops-*`, `.rowops-*`, `.views-*`, `.dg-*`, `.col-select-*`, `.regex-picker-*`, `.regex-manager-*`, `.pivot-toolbar-*`, `.filter-group-*`, `.date-conv-*`, `.merge-*`, `.ghist-*`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+O / Ctrl+O | Open files (replaces current) |
| Cmd+Shift+O / Ctrl+Shift+O | Add files (appends) |
| Cmd+E / Ctrl+E | Export (opens Export dialog) |
| Cmd+C / Ctrl+C | Copy selected cells |
