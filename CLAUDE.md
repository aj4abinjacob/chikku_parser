# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important:** Always update this file after making any changes, adding new features, modifying architecture, updating components, or altering the data flow. Keep all sections accurate and in sync with the current state of the codebase.

**Important:** After completing any code change, always ask the user if they want to commit and push. If they agree, create a commit with an adequate message and push to the remote.

**Important:** When the user asks for a change or a new feature, always clarify any doubts or ambiguities before starting implementation. Ask questions first, code second.

## Project

Chikku Data Combiner v2 — an Electron desktop app for viewing, combining, and transforming data files. Supports CSV, TSV, JSON, Parquet, and Excel (.xlsx/.xls) formats. Built with React, DuckDB, BlueprintJS, and SheetJS (xlsx).

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

- Creates BrowserWindow with context isolation + preload, app icon set from `res/icon.svg`
- **Per-window DuckDB instances** — each window gets its own in-memory `Database(":memory:")` stored in `dbMap: Map<webContentsId, Database>`. Cleaned up with `db.close()` on window close. No shared state between windows.
- Promisified helpers: `runPromise(db, sql)` and `allPromise(db, sql)` wrap DuckDB callbacks
- Native menu: File (Open File, Add File, Export, Quit), Edit, View
- Open/Add dialogs accept: `.csv`, `.tsv`, `.json`, `.jsonl`, `.ndjson`, `.parquet`, `.xlsx`, `.xls`
- Menu actions use `BrowserWindow.getFocusedWindow()` to target the active window
- IPC handlers resolve the correct DB via `event.sender.id`
- **Excel import strategy**: converts sheet to temp CSV via `xlsx.utils.sheet_to_csv()`, loads into DuckDB with `read_csv_auto()`, cleans up temp file in `finally` block
- **"Open With" / file association support**: handles files opened via OS "Open With" context menu, drag-to-dock (macOS), and CLI arguments (Windows/Linux). Uses `app.on("open-file")` for macOS, `process.argv` parsing for CLI args, and single-instance lock (`requestSingleInstanceLock`) to forward files to the existing window. Files received before the renderer is ready are queued in `pendingOpenFiles[]` and flushed via `did-finish-load`. Supported extensions defined in `SUPPORTED_EXTENSIONS` Set. File associations registered in `package.json` `build.fileAssociations`.

### IPC Handlers

| Channel | Purpose |
|---------|---------|
| `db:load-csv` | (Legacy) `CREATE OR REPLACE TABLE ... AS SELECT * FROM read_csv_auto(...)`, returns `{tableName, schema, rowCount}` |
| `db:load-file` | Generalized loader: detects format by extension — CSV/TSV → `read_csv_auto()` with optional delimiter/ignore_errors; JSON → `read_json_auto()`; Parquet → `read_parquet()`; Excel → xlsx→temp CSV→DuckDB. Returns `{tableName, schema, rowCount}` or `{error, canRetry}` on CSV parse failure. |
| `file:get-excel-sheets` | Reads `.xlsx`/`.xls` via SheetJS, returns `{name, rowCount}[]` for sheet picker |
| `db:query` | Execute SELECT, return rows |
| `db:exec` | Execute DDL/DML (CREATE, ALTER, etc.), return boolean |
| `db:describe` | `DESCRIBE "tableName"`, return schema |
| `db:tables` | `SHOW TABLES`, return table list |
| `db:export-csv` | (Legacy) `COPY (sql) TO 'path' (HEADER, DELIMITER ',')` |
| `db:export-file` | Export query to file: CSV/TSV → `COPY ... (HEADER, DELIMITER)`, JSON → `COPY ... (FORMAT JSON, ARRAY true)`, Parquet → `COPY ... (FORMAT PARQUET)`, Excel → query rows + `xlsx.writeFile()` |
| `db:export-excel-multi` | Takes `{sheetName, sql}[]`, queries each, builds multi-sheet workbook via SheetJS |
| `dialog:save-csv` | (Legacy) Native save dialog for CSV |
| `dialog:save-file` | Save dialog with format-specific filters |
| `system:free-memory` | Returns `os.freemem()` — used by Column Ops to choose undo strategy |

### Preload (`app/preload.ts`)

Context bridge exposing `window.api` (typed as `DbApi`):

```typescript
interface DbApi {
  loadCSV(filePath: string, tableName: string): Promise<{tableName, schema, rowCount}>
  loadFile(filePath: string, tableName: string, options?: ImportOptions): Promise<any>
  getExcelSheets(filePath: string): Promise<SheetInfo[]>
  query(sql: string): Promise<any[]>
  exec(sql: string): Promise<boolean>
  describe(tableName: string): Promise<ColumnInfo[]>
  tables(): Promise<any[]>
  exportCSV(sql: string, filePath: string): Promise<boolean>
  exportFile(sql: string, filePath: string, format: string): Promise<boolean>
  exportExcelMulti(sheets: {sheetName, sql}[], filePath: string): Promise<boolean>
  saveDialog(): Promise<string | null>
  saveFileDialog(format: string): Promise<string | null>
  getFreeMemory(): Promise<number>                           // os.freemem()
  onOpenFiles(callback: (paths: string[]) => void): void   // Cmd+O
  onAddFiles(callback: (paths: string[]) => void): void    // Cmd+Shift+O
  onExportCSV(callback: () => void): void                   // Cmd+E
}
```

### Renderer (`src/renderer.tsx`)

React 18 entry point. Mounts `<App />` to `#root`. Imports `./styles/app.less`.

### Key Directories

- `app/` — Electron main process + preload (Node.js context)
- `src/components/` — React components (17 files)
- `src/hooks/` — Custom React hooks (`useChunkCache`)
- `src/utils/` — SQL query builder, date detection, and column ops SQL utilities
- `src/types.ts` — All TypeScript interfaces
- `src/styles/` — Less stylesheets (imports BlueprintJS CSS)
- `html/` — HTML shell + favicon SVG (copied to dist at build time, has CSP policy)
- `res/` — Build resources for electron-builder; contains `icon.svg` (app icon source)

### Tech Stack

- **Electron 31** — desktop shell
- **React 18** — UI framework
- **TypeScript 5** — all source files (strict mode, target ES2020, module CommonJS)
- **DuckDB** — in-memory analytical database for loading, querying, combining, and data operations (handles CSV, TSV, JSON, Parquet natively)
- **SheetJS (xlsx)** — reading/writing Excel `.xlsx`/`.xls` files in the main process
- **BlueprintJS 4** — UI component library (`@blueprintjs/core`, `@blueprintjs/icons`, `@blueprintjs/popover2`)
- **chrono-node** — natural language date parsing for text-month format detection
- **@tanstack/react-virtual** — virtual scrolling for the DataGrid (renders only visible rows)
- **Webpack 5** — bundles 3 targets with ts-loader, less/css loaders, file-loader for fonts
- **Less** — stylesheet preprocessor
- **lodash** — utility library (available as dependency)
- **electron-log** — logging in main process

## Components

### App.tsx — Main Orchestrator
- State: `tables[]`, `activeTable`, `viewState`, `schema`, `resetKey`, `combineDialogOpen`, `combineTableNames`, `exportDialogOpen`, `pendingExcelImport`, `pendingRetry`, `colOpsSteps`, `undoStrategy`, `colOpsNextId`
- Uses `useChunkCache` hook for lazy data loading (no `rows`/`totalRows` state — provided by the hook)
- Registers IPC listeners on mount: `onOpenFiles` (replace), `onAddFiles` (append), `onExportCSV` (opens ExportDialog)
- `loadFiles(filePaths, replace)` — detects format by extension: Excel → `getExcelSheets()`, if >1 sheet opens `ExcelSheetPickerDialog`, else imports directly; CSV/TSV → tries `loadFile()`, on failure opens `ImportRetryDialog`; JSON/Parquet → straight `loadFile()` call
- `handleExcelSheetImport(selectedSheets)` — imports selected sheets from the pending Excel file, each as a separate table named `{fileName}_{sheetName}`
- `handleRetryImport(options)` — retries failed CSV import with user-specified delimiter/ignore_errors options
- `handleDeleteTable(tableName)` — drops table from DuckDB via `DROP TABLE IF EXISTS`, removes from state, switches active table if needed
- `handleCombineOpen(selectedNames)` — stores selected table names, opens CombineDialog with only those tables
- `handleCombineExecute(sql)` — executes combine SQL from dialog, creates a uniquely named table (`combined_1`, `combined_2`, etc.) via `nextCombinedName()` — never overwrites user-loaded tables
- `handleDataOperation(sql)` — executes arbitrary SQL for data transforms (column/row operations)
- `handleSampleTable(n, isPercent)` — creates a new `sample_N` table with a random sample of rows from active table using DuckDB `USING SAMPLE`; adds to tables state with `filePath: "(sample)"`
- `handleCreateAggregateTable(sql)` — takes a SELECT SQL, generates unique `aggregate_N` name, executes `CREATE TABLE ... AS`, adds to tables state with `filePath: "(aggregate)"`
- `handleCreatePivotTable(sql)` — takes a PIVOT SQL, generates unique `pivot_N` name, executes `CREATE TABLE ... AS (sql)`, adds to tables state with `filePath: "(pivot)"`
- `handleLookupMerge(sql, options)` — executes a JOIN SQL for the Lookup Merge feature; if `options.replaceActive` is true, replaces the active table via `CREATE OR REPLACE TABLE`; otherwise creates a new `merge_N` table with `filePath: "(merge)"`
- `handleColOpApply(opType, column, params)` — determines undo strategy on first op (per-step vs snapshot based on free RAM), creates backup, auto-promotes non-VARCHAR columns to VARCHAR for string-producing ops (prefix/suffix, find/replace, regex, upper/lower, trim, assign), executes UPDATE SQL scoped by active filters, refreshes schema, records step
- `handleColOpUndo()` — per-step mode: restores last backup via `ALTER TABLE RENAME`, removes step
- `handleColOpRevertAll()` — snapshot mode: restores from `__colops_snapshot_*`, drops it, clears all steps
- `handleColOpClearAll()` — drops all backup/snapshot tables, clears steps (confirmation in ColumnOpsPanel)
- ColOps cleanup effect: on `activeTable` change, drops all backup/snapshot tables for previous table, resets colOpsSteps and undoStrategy
- Schema fetching effect: re-fetches schema on `activeTable` change, auto-populates `visibleColumns`
- `resetKey` counter: increments on table/filter/sort/column changes to trigger DataGrid scroll-to-top
- Layout: `Sidebar + DataGrid + FilterPanel (with Filters/Column Ops tabs) + StatusBar + CombineDialog + ExportDialog + ExcelSheetPickerDialog + ImportRetryDialog`

### Sidebar.tsx — Left Panel
- **Three-section flex layout**: Tables (max 20%, scrollable), Columns (flex remaining, scrollable), Operations (fixed at bottom); each section scrolls independently with sticky headers
- Lists loaded tables with row counts (click to switch active table)
- **Delete table**: hover-reveal `x` button on each table row; opens BlueprintJS `Alert` confirmation before calling `onDeleteTable`
- **Selective combine**: checkboxes next to each table (visible when 2+ tables loaded, including combined tables) to select which tables to combine; `selectedForCombine: Set<string>` state cleaned up when tables change
- "Combine N Selected" button (enabled when 2+ tables selected, passes selected names to `onCombine`)
- Column visibility checkboxes
- "Data Operations" button opens `DataOperationsDialog`
- "Aggregate" button opens `AggregateDialog`
- "Pivot Table" button opens `PivotDialog`
- "Lookup Merge" button opens `LookupMergeDialog` (visible when 2+ tables loaded)
- "Date Conversion" button opens `DateConversionDialog`
- "Export" button opens `ExportDialog`
- Filter panel toggle button

### ExportDialog.tsx — Export Data Modal
- Full export dialog (Cmd+E opens it instead of auto-exporting)
- Props: `isOpen`, `onClose`, `tables`, `activeTable`, `viewState`, `schema`
- **Format**: radio group — CSV, TSV, JSON, Excel (.xlsx), Parquet
- **Tables**: radio toggle — "Active table only" (default) vs "Select tables" (checkbox list); for Excel multi-table exports, each becomes a sheet
- **View Options**: shown when active table has filters/sort/hidden/reordered columns — "Export current view" vs "Export full data"
- **Warnings**: yellow Callout when any table exceeds Excel's 1,048,576 row or 16,384 column limits
- Export flow: opens native save dialog → single table non-Excel uses `exportFile()`, single table Excel uses `exportFile()`, multi-table Excel uses `exportExcelMulti()`, multi-table non-Excel builds UNION ALL

### ExcelSheetPickerDialog.tsx — Excel Sheet Picker Modal
- Shown when opening an `.xlsx`/`.xls` file with multiple sheets
- Checkbox list of sheets (name + row count), Select All / Deselect All
- "Import N Sheets" button — each selected sheet becomes a separate DuckDB table named `{fileName}_{sheetName}`
- If only 1 sheet → skipped, imported directly

### ImportRetryDialog.tsx — CSV Import Retry Modal
- Shown when CSV auto-detect fails (parse error)
- Red Callout showing the error message
- Delimiter dropdown: Auto, Comma, Tab, Semicolon, Pipe, Custom
- Checkbox: "Skip malformed rows"
- "Retry" button calls `loadFile()` again with specified options

### DataOperationsDialog.tsx — Data Operations Modal
- Extracted from Sidebar; self-contained dialog for column/row transforms
- Props: `isOpen`, `onClose`, `activeTable`, `schema`, `onApply(sql)`, `onSampleTable(n, isPercent)`
- 14 operation types:
  - `regex_extract` — regexp_extract() with user-provided pattern + capture group index; casts source to VARCHAR first so it works on any data type
  - `trim` — TRIM()
  - `upper` / `lower` — UPPER() / LOWER()
  - `replace_regex` — regexp_replace() with pattern + replacement params
  - `substring` — SUBSTRING() with start + length params
  - `custom_sql` — arbitrary SQL expression
  - `create_column` — adds a new column with a user-defined value (literal or SQL expression); no source column needed
  - `delete_column` — removes a column from the table; prevents deleting the last column; red "Delete" button with warning callout
  - `combine_columns` — concatenates 2+ selected columns with an optional separator; all columns cast to VARCHAR; multi-select checkboxes with numbered order badges
  - `rename_column` — renames a column using `ALTER TABLE ... RENAME COLUMN`; requires source column and new name; no preview
  - `sample_table` — creates a new table with a random sample of rows; supports "Number of rows" or "Percentage" mode via DuckDB `USING SAMPLE`; delegates to `onSampleTable` callback (creates `sample_N` table like combine creates `combined_N`); no preview
  - `remove_duplicates` — deduplicates rows based on user-selected columns; converts empty strings to NULL via `NULLIF()` on all VARCHAR columns in a CTE, then uses `QUALIFY row_number() OVER (PARTITION BY ...)` for dedup; multi-select checkboxes with Select All/Deselect All and search; preview shows row count before/after
  - `conditional_column` — creates a new column using a CASE WHEN expression; multi-row condition builder with column, operator (=, !=, >, <, >=, <=, LIKE, NOT LIKE, IS NULL, IS NOT NULL, CONTAINS, STARTS WITH, ENDS WITH), value, and result; supports default ELSE value; live preview shows 5 sample rows; conditions evaluated in order (first match wins)
- Live preview: fetches 3 sample rows and shows before/after for most operations
- Builds complete SQL internally and passes to `onApply` (or `onSampleTable` for sample_table)

### AggregateDialog.tsx — Aggregate Summary Modal
- Computes aggregate statistics (SUM, MIN, MAX, AVG, COUNT, COUNT DISTINCT, MEDIAN, STDDEV) on table columns
- Props: `isOpen`, `onClose`, `activeTable`, `schema`, `onCreateTable(sql, filePath)`
- **Group By** (optional): multi-select checkboxes from all columns
- **Function selection**: checkboxes for each aggregate function
- **Column selection**: checkboxes per column; numeric columns get all functions, non-numeric get COUNT/COUNT DISTINCT/MIN/MAX only
- "Select All Numeric" / "Deselect All" quick buttons
- "Run" button executes the aggregate query and shows results in an HTML table (up to 200 rows)
- "Create as Table" button materializes result as `aggregate_N` table via `onCreateTable`; appears in sidebar with `filePath: "(aggregate)"`
- Numeric type detection via regex: `/^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i`

### PivotDialog.tsx — Pivot Table Modal
- Rotates row values into column headers using DuckDB's native `PIVOT` syntax
- Props: `isOpen`, `onClose`, `activeTable`, `schema`, `onCreateTable(sql, filePath)`
- **Row Fields** (optional): multi-select checkboxes — become GROUP BY in the PIVOT
- **Pivot Column** (required): single-select dropdown — values become column headers; auto-excludes row fields
- **Value Fields** (required): multi-select checkboxes with type hints; non-numeric columns show "(count/min/max/first only)"; "Select All Numeric" / "Deselect All" quick buttons
- **Aggregate Function** (required): single-select dropdown — SUM, COUNT, AVG, MIN, MAX, MEDIAN, STDDEV, FIRST; defaults to SUM
- Distinct value preview: on pivot column change (300ms debounce), fetches distinct count + up to 50 sample values
- Cardinality warnings: yellow Callout for >50 distinct values, red Callout for >200
- "Run" button executes `PIVOT` query and shows results in HTML table (up to 200 rows, shows row + column count)
- "Create as Table" button materializes result as `pivot_N` table via `onCreateTable`; appears in sidebar with `filePath: "(pivot)"`
- Reuses `aggregate-*` CSS classes; only new class: `.pivot-distinct-preview`
- Numeric type detection via same regex as AggregateDialog

### LookupMergeDialog.tsx — Lookup Merge (JOIN) Modal
- Joins data from a right table into the active (left) table using DuckDB LEFT/INNER JOIN
- Props: `isOpen`, `onClose`, `activeTable`, `schema`, `tables` (all loaded), `onExecute(sql, { replaceActive })`
- **Right Table**: dropdown to select from loaded tables (excluding active)
- **Key Columns**: composite key support — multiple `[left dropdown] ↔ [right dropdown]` pairs with add/remove
- **Columns to Merge**: checkbox list of right-table columns (excludes key columns); Select All / Deselect All
- **Duplicate key detection**: queries right table for duplicate keys before merge; shows warning Callout with count; checkbox to "Remove duplicates before merging" (uses `QUALIFY row_number() OVER (PARTITION BY ... ORDER BY rowid) = 1`)
- **NULL key detection**: queries both tables for NULL keys; shows warning Callout; radio toggle for "Standard join (NULLs don't match)" vs "Match NULLs" (uses `IS NOT DISTINCT FROM`)
- **Join Type**: radio toggle — Left Join (keep all left rows) vs Inner Join (matched only)
- **Result Mode**: radio toggle — "Create new table" (`merge_N`) vs "Replace active table" (`CREATE OR REPLACE TABLE`)
- **Column name conflict detection**: when right-table columns share names with the left table (excluding keys), a warning Callout appears with editable rename inputs pre-filled with `col_rightTableName` suffix; renames are applied as SQL `AS` aliases; validates for empty/duplicate output names
- "Preview" button runs the JOIN SQL with `LIMIT 200` and shows results in a separate `PreviewTableDialog`
- "Merge" button executes via `onExecute` callback; merge tables appear in sidebar with `filePath: "(merge)"`
- Reuses `aggregate-*` CSS classes; new CSS namespace: `merge-key-pairs`, `merge-key-row`, `merge-options-grid`, `merge-rename-*`

### DateConversionDialog.tsx — Date Conversion Modal
- Converts date columns between formats using DuckDB `TRY_STRPTIME` / `strftime`
- Props: `isOpen`, `onClose`, `activeTable`, `schema`, `tables`, `onApply(sql)` — reuses existing `onDataOperation` callback
- **Date Column**: HTMLSelect to pick the column containing date values
- **Group By** (optional): HTMLSelect for per-group format detection — useful when the same numeric format (e.g. `1/12/20`) means `DD/MM/YY` in one source vs `MM/DD/YY` in another
- **Detection**: auto-runs on column/group selection (400ms debounce); uses `dateDetection.ts` utility; classifies as ISO / numeric / text-month; max-value heuristic for numeric dates (if max > 12 in a position → that's the day)
- **Detection results table**: columns = Group | Sample Values | Format | Confidence; green tag for high confidence (format displayed as code), yellow for ambiguous (HTMLSelect dropdown with alternatives), red for unknown (InputGroup for manual entry)
- **Output Format**: HTMLSelect with common presets (YYYY-MM-DD, DD/MM/YYYY, etc.) + "Custom..." option; shows example using current date
- **Result Mode**: RadioGroup — "Replace column" (rebuilds SELECT at original position) vs "Create new column" (appends with alias)
- **SQL generation**: single format → `strftime(TRY_STRPTIME(CAST("col" AS VARCHAR), 'fmt'), 'out_fmt')`; per-group → CASE WHEN with per-group format; already-DATE column → `strftime` directly; wrapped in `CREATE OR REPLACE TABLE ... AS SELECT`
- **Preview**: extracts SELECT from generated SQL, runs with LIMIT 200, counts NULL results for parse-failure warning
- **Edge cases**: already DATE/TIMESTAMP columns skip strptime; NULL values pass through; 50+ groups limited with default format for overflow
- CSS namespace: `.date-conv-*`; reuses `aggregate-dialog-content`, `aggregate-section`, `merge-options-grid` classes

### PreviewTableDialog.tsx — Reusable Preview Table Dialog
- Standalone dialog for displaying tabular query results in a separate overlay
- Props: `isOpen`, `onClose`, `title`, `rows`, `columns`, `maxRows` (default 200)
- Exports shared `formatValue()` function (NULL display, number formatting)
- Used by: LookupMergeDialog ("Merge Preview"), AggregateDialog ("Aggregate Results"), PivotDialog ("Pivot Results"), DateConversionDialog ("Date Conversion Preview")
- Reuses `aggregate-results-wrapper` / `aggregate-results-table` / `aggregate-results-truncated` CSS classes

### DataGrid.tsx — Virtualized Scrollable Data Grid
- **Virtual scrolling** via `@tanstack/react-virtual` `useVirtualizer` — only renders visible rows (~30-50) plus 20 overscan rows
- Div-based layout (flexbox rows, not `<table>`) with CSS classes `.dg-header`, `.dg-row`, `.dg-cell`
- Props: `totalRows`, `getRow(index)`, `ensureRange(start, end)` from chunk cache — no `rows[]` array
- Fixed `ROW_HEIGHT = 28` for virtualizer sizing
- Sticky header inside scroll container for automatic horizontal scroll sync
- Cell selection: click, click-drag (rectangular range), Shift+click (range), Cmd/Ctrl+click (toggle), Cmd/Ctrl+drag (add to selection) — uses absolute row indices
- Copy: Cmd/Ctrl+C copies selected cells as TSV via `getRow()` lookup
- Sort: click column header to toggle ASC/DESC
- Column resize: drag handle on header right edge
- Column reorder: drag-and-drop header cells
- Row numbering: absolute 1-based index in first column
- Number formatting: integers as-is, floats to 4 decimal places
- Unloaded rows show "..." placeholder (`.loading-cell` style)
- `resetKey` prop: scrolls to top and clears selection when it changes
- Monospace font (`SF Mono`, `Menlo`, `Monaco`)

### FilterPanel.tsx — Resizable Bottom Panel with Tabs (Filters + Column Ops)
- Resizable via drag handle (min 80px, max 500px, default 260px)
- **Two tabs**: "Filters" and "Column Ops" — tab buttons in header, local `activeTab` state
- Filter count badge shown on Filters tab when not active; step count badge on Column Ops tab when not active
- When Filters tab active: shows Clear All / Apply Filters buttons in header
- When Column Ops tab active: renders ColumnOpsPanel component
- **Recursive filter groups**: supports nested AND/OR grouping (e.g. `AND(cond, OR(cond, AND(cond, cond)))`)
- Root group is always present; user can toggle its logic (AND/OR) and add conditions or sub-groups
- **FilterGroupRenderer** — recursive component rendering logic toggle, children, "+ Condition" / "+ Sub-group" buttons, and delete button for non-root groups
- **FilterConditionRow** — leaf component for individual filter conditions (column select, operator select, value input)
- **Draft state model**: `DraftFilterGroup`/`DraftFilterCondition` with unique `id` fields for React keys and immutable path-based updates
- Conversion helpers: `convertToDraft(FilterGroup)` adds ids, `convertFromDraft(DraftFilterGroup)` strips ids and removes empty conditions
- Recursive update helpers: `updateNodeById`, `addChildToGroup`, `removeNodeById` for deep immutable updates
- Filter operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `NOT LIKE`, `IS NULL`, `IS NOT NULL`, `CONTAINS`, `IN`, `STARTS WITH`, `NOT STARTS WITH`, `ENDS WITH`, `NOT ENDS WITH`
- `CONTAINS` uses `regexp_matches()` (case-insensitive)
- `IN` operator uses InValuePicker sub-component:
  - Fetches up to 1000 distinct values from the column
  - Searchable dropdown with Select All / Select None
- Tracks dirty state (unsaved changes indicator)
- Depth-based visual nesting: colored left borders cycling blue → purple → orange → green via `data-depth` attribute
- CSS classes: `.filter-group`, `.filter-group-root`, `.filter-group-nested`, `.filter-group-header`, `.filter-group-children`, `.filter-group-actions`, `.filter-group-delete`

### ColumnOpsPanel.tsx — Column Ops Tab Body
- In-place column operations that apply to filtered rows via UPDATE statements
- Props: `columns`, `activeTable`, `activeFilters`, `colOpsSteps`, `undoStrategy`, `onApply`, `onUndo`, `onRevertAll`, `onClearAll`, `totalRows`, `unfilteredRows`
- **Filtered rows banner**: blue when filter active (shows filtered/total count), orange when no filter (all rows)
- **Operation form**: Column (HTMLSelect), Operation (HTMLSelect with 9 types), dynamic params per op type, Apply button
- **9 operation types**: assign_value, find_replace, regex_extract, extract_numbers, trim, upper, lower, clear_null, prefix_suffix
- **Step history**: shows chronological list (newest first) with step number and description
- **Adaptive undo strategy**:
  - Per-step mode (small tables): backup before each op, undo button on latest step
  - Snapshot mode (large tables, >15% of free RAM): single backup before first op, only "Revert All" available
  - Strategy chosen on first op based on `rowCount * numColumns * 100` vs `os.freemem() * 0.15`
- **Backup naming**: `__colops_backup_N_tableName` (per-step) or `__colops_snapshot_tableName` (snapshot) — never added to `tables` state
- Clear confirmation (Alert) drops all backups; Revert All confirmation restores snapshot
- CSS namespace: `.colops-*`

### CombineDialog.tsx — Column Mapping Modal
- Large dialog (90vw, max 1100px) with two-panel layout
- **Left panel**: Column mapping rows — each has Output field, ← arrow, Input field, Remove button
  - Output = final column name in combined result
  - Input = comma-separated source column names
  - Focus tracking: clicking right-panel buttons appends to the focused field
- **Right panel**: All unique columns across tables as clickable buttons
  - Color-coded: outlined (unused), green/SUCCESS (used once), red/DANGER (used 2+)
  - Tooltip on hover shows which tables contain the column
- "Fill Common" button: auto-maps columns present in ALL loaded tables
- "Add Row" button: manual mapping
- One-column-per-table constraint: only one input column per source table per mapping (explained in UI hint)
- Validation: empty outputs, duplicate outputs, empty inputs, duplicate input usage, input columns must exist in at least one table
- Warnings (non-blocking): empty tables (0 rows), all-NULL output columns
- Type safety: passes column type info to SQL builder; mismatched types across tables are auto-cast to VARCHAR
- Generates SQL via `buildMappedCombineQuery()`

### StatusBar.tsx — Bottom Info Bar
- Shows: `{activeTable} | {totalRows} rows | {tableCount} table(s) loaded`
- Info-only display (no pagination controls)

### Toolbar.tsx — Minimal Toolbar
- Sidebar toggle button and Combine button (largely superseded by Sidebar)

## Hooks

### useChunkCache (`src/hooks/useChunkCache.ts`) — Lazy Data Loading
- Fetches data from DuckDB in 1000-row chunks on demand
- `CHUNK_SIZE = 1000`, `MAX_CACHED_CHUNKS = 20` (~20K rows max in memory)
- LRU eviction: evicts least-recently-used chunks when cache exceeds limit
- Generation counter: discards stale responses after cache resets (table/filter/sort changes)
- Tracks in-flight requests to prevent duplicate fetches
- Auto-resets on `tableName`, `filters`, `sortColumn`, `sortDirection`, or `visibleColumns` change
- Returns: `{ totalRows, getRow(index), isRowLoaded(index), ensureRange(start, end) }`
- Uses `buildChunkQuery()` for per-chunk SQL and `buildCountQuery()` for total count

## Types (`src/types.ts`)

```typescript
ColumnInfo        // { column_name, column_type, null, key, default, extra }
LoadedTable       // { tableName, filePath, schema: ColumnInfo[], rowCount }
ColumnOperation   // { type, sourceColumn, targetColumn, params: Record<string,string> }
FilterCondition   // { column, operator, value }
FilterGroup       // { logic: "AND" | "OR", children: FilterNode[] }
FilterNode        // FilterCondition | FilterGroup (recursive union)
isFilterGroup()   // type guard: node is FilterGroup
hasActiveFilters() // checks if group has any children
countConditions() // recursively counts leaf conditions in a group
ColumnMapping     // { id, outputColumn, inputColumns: string[] }
ViewState         // { visibleColumns[], columnOrder[], filters: FilterGroup, sortColumn, sortDirection }
FileFormat        // "csv" | "tsv" | "json" | "parquet" | "xlsx" | "xls"
ImportOptions     // { csvDelimiter?, csvIgnoreErrors?, excelSheet? }
SheetInfo         // { name, rowCount }
ColOpType         // "assign_value" | "find_replace" | "regex_extract" | "extract_numbers" | "trim" | "upper" | "lower" | "clear_null" | "prefix_suffix"
UndoStrategy      // "per-step" | "snapshot"
ColOpStep         // { id, opType, column, description, backupTable, timestamp }
EXCEL_MAX_ROWS    // 1,048,576
EXCEL_MAX_COLS    // 16,384
```

## SQL Builder (`src/utils/sqlBuilder.ts`)

| Function | Purpose |
|----------|---------|
| `buildSelectQuery(tableName, viewState)` | SELECT with columns, WHERE, ORDER BY (no LIMIT/OFFSET — used for export) |
| `buildFilterClause(filter)` | Single FilterCondition → SQL WHERE clause (internal) |
| `buildFilterGroupClause(group)` | Recursive FilterGroup → SQL WHERE clause with AND/OR nesting |
| `buildCombineQuery(tableNames[])` | Simple `SELECT * ... UNION ALL` (used by export) |
| `escapeIdent(name)` | Escape a SQL identifier by doubling embedded double quotes |
| `buildMappedCombineQuery(tables[], mappings[])` | Column-mapped UNION ALL with aliases, NULL for missing columns, auto VARCHAR cast on type mismatch, trimmed output names |
| `buildChunkQuery(tableName, columns, filters: FilterGroup, sort, direction, chunkSize, chunkIndex)` | SELECT with LIMIT/OFFSET for chunk-based virtual scroll loading |
| `buildCountQuery(tableName, filters: FilterGroup)` | `SELECT COUNT(*) ... WHERE` for total row count |

## Column Ops SQL (`src/utils/colOpsSQL.ts`)

| Function | Purpose |
|----------|---------|
| `buildColOpUpdateSQL(tableName, column, opType, params, filters)` | Builds `UPDATE ... SET ... WHERE` for in-place column operations scoped by active filters |
| `buildStepDescription(opType, column, params)` | Human-readable label for step history display |

## Date Detection (`src/utils/dateDetection.ts`)

| Function | Purpose |
|----------|---------|
| `detectDateFormat(samples)` | Main entry: classifies samples, returns `{ format, confidence, alternatives }` |
| `classifyPattern(value)` | Categorizes a single value as `iso` / `numeric` / `text-month` / `other` |
| `analyzeNumericDates(samples, separator)` | Max-value heuristic per position for numeric `DD/MM/YY` vs `MM/DD/YY` disambiguation |
| `OUTPUT_FORMATS` | Array of `[label, duckdbFormat]` tuples for the output format dropdown |

**Detection algorithm:**
1. Classify each sample by regex: ISO (`YYYY-MM-DD`), numeric (`D/M/Y`), text-month (alphabetic), other
2. For numeric dates: split by separator, find max value per position; `max > 12` → that position is day; both ≤ 12 → ambiguous (return both alternatives)
3. For text-month: use `chrono-node` to parse, detect month-first vs day-first ordering
4. Confidence levels: `high` (unambiguous), `ambiguous` (both alternatives returned), `unknown` (cannot detect)

## Styling (`src/styles/app.less`)

- Imports: `blueprint.css`, `blueprint-icons.css`, `blueprint-popover2.css`
- CSS variables: `--sidebar-width: 280px`, `--statusbar-height: 28px`
- Color palette: `#f5f8fa` (bg), `#394b59` (text), `#5c7080` (secondary), `#137cbd` (accent blue), `#d8e1e8` (borders)
- Layout: flexbox throughout — `.app-container` (column) → `.main-layout` (row) → `.sidebar` (fixed 280px) + `.data-area` (flex: 1)
- DataGrid uses div-based layout: `.data-grid-container` → `.data-grid-scroll` → `.dg-header` (sticky) + virtual `.dg-row` elements
- Cell classes: `.dg-cell`, `.dg-row-num-cell`, `.dg-header-cell`, `.cell-selected`, `.loading-cell`, `.column-dragging`
- Filter inputs match HTMLSelect appearance: `height: 30px`, border styling
- Combine dialog inputs also use `height: 30px` to match
- Filter panel tabs: `.filter-panel-tabs`, `.filter-panel-tab`, `.filter-panel-tab-badge`
- Column ops: `.colops-body`, `.colops-filter-banner` / `.colops-filter-banner-all`, `.colops-form` / `.colops-form-row` / `.colops-form-label`, `.colops-steps` / `.colops-step-item` / `.colops-step-number` / `.colops-step-desc`, `.colops-error`, `.colops-empty`
- Export dialog: `.export-format-row`, `.export-table-grid`
- Import retry: `.import-retry-form`

## Data Flow

1. User opens data files via native file dialog (Cmd+O to replace, Cmd+Shift+O to add) — supports CSV, TSV, JSON, Parquet, Excel
2. **Import routing by format**: CSV/TSV → `read_csv_auto()` (with retry dialog on parse failure); JSON → `read_json_auto()`; Parquet → `read_parquet()`; Excel → SheetJS reads workbook, if multiple sheets shows `ExcelSheetPickerDialog`, converts selected sheets to temp CSV for DuckDB loading
3. Renderer fetches schema via IPC; `useChunkCache` hook manages data loading
4. As the user scrolls, `@tanstack/react-virtual` computes visible row indices
5. `useChunkCache.ensureRange()` fetches missing 1000-row chunks from DuckDB via `buildChunkQuery()`
6. Chunks far from the viewport are evicted (LRU, max 20 chunks = ~20K rows in memory)
7. `getRow(index)` returns cached row data synchronously; unloaded rows show "..." placeholder
8. **Delete**: User hovers table row → clicks `x` → confirms in Alert → `DROP TABLE IF EXISTS` via IPC, removed from state
9. **Combine**: User selects tables via checkboxes (combined tables excluded) → clicks "Combine N Selected" → CombineDialog opens with only selected tables → maps output←input columns → generates mapped UNION ALL SQL (with auto VARCHAR cast for type mismatches) → creates uniquely named `combined_N` table
10. Data operations rebuild tables with `CREATE OR REPLACE TABLE ... AS SELECT`
11. **Sample Table**: User selects "Sample Table" in Data Operations → chooses row count or percentage → creates a new `sample_N` table via `CREATE TABLE ... AS SELECT * FROM ... USING SAMPLE`; appears in sidebar with `filePath: "(sample)"`
12. **Remove Duplicates**: User selects columns to dedup → empty strings converted to NULL via `NULLIF()` on all VARCHAR columns in a CTE → deduped via `QUALIFY row_number() OVER (PARTITION BY ...) = 1`
13. **Aggregate**: User opens Aggregate dialog → selects columns and aggregate functions (optionally with Group By) → clicks Run to preview results → optionally clicks "Create as Table" to materialize as `aggregate_N` table with `filePath: "(aggregate)"`
14. **Pivot Table**: User opens Pivot dialog → selects row fields, pivot column, value fields, and aggregate function → clicks Run to preview cross-tabulation → optionally clicks "Create as Table" to materialize as `pivot_N` table with `filePath: "(pivot)"`; uses DuckDB native `PIVOT ... ON ... USING ... GROUP BY` syntax
15. **Lookup Merge**: User opens Lookup Merge dialog → selects right table → maps key column pairs (composite keys supported) → selects columns to merge → system checks for duplicate/NULL keys and shows warnings with options → user chooses Left/Inner Join and result mode → "Preview" shows first 10 rows → "Merge" executes the JOIN SQL; creates `merge_N` table with `filePath: "(merge)"` or replaces active table in-place
16. **Date Conversion**: User opens Date Conversion dialog → selects date column (and optionally a group-by column) → format auto-detected per group using max-value heuristic → user resolves ambiguous formats via dropdown → selects output format → preview shows converted values + NULL parse count → apply executes `CREATE OR REPLACE TABLE ... AS SELECT` with `strftime(TRY_STRPTIME(...))` expressions (CASE WHEN for per-group formats)
17. **Column Ops**: User opens FilterPanel → switches to "Column Ops" tab → selects column and operation → filtered-rows banner shows scope → Apply executes `UPDATE ... SET ... WHERE` scoped by active filters → adaptive undo: per-step mode creates `__colops_backup_N_table` before each op (undo restores via `ALTER TABLE RENAME`), snapshot mode creates single `__colops_snapshot_table` before first op (only "Revert All" available) → strategy chosen based on estimated table size vs 15% of free RAM → backups cleaned up on table switch
18. **Export**: Cmd+E or sidebar Export button opens `ExportDialog` → user picks format (CSV/TSV/JSON/Excel/Parquet), tables, and view options → exports via `exportFile()` or `exportExcelMulti()` for multi-sheet Excel

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+O / Ctrl+O | Open files (replaces current) |
| Cmd+Shift+O / Ctrl+Shift+O | Add files (appends) |
| Cmd+E / Ctrl+E | Export (opens Export dialog) |
| Cmd+C / Ctrl+C | Copy selected cells |
