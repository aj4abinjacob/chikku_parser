# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Important:** Always update this file after making any changes, adding new features, modifying architecture, updating components, or altering the data flow. Keep all sections accurate and in sync with the current state of the codebase.

**Important:** After completing any code change, always ask the user if they want to commit and push. If they agree, create a commit with an adequate message and push to the remote.

## Project

Chikku Data Combiner v2 — an Electron desktop app for viewing, combining, and transforming CSV data. Built with React, DuckDB, and BlueprintJS.

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

- Creates BrowserWindow with context isolation + preload
- **Per-window DuckDB instances** — each window gets its own in-memory `Database(":memory:")` stored in `dbMap: Map<webContentsId, Database>`. Cleaned up with `db.close()` on window close. No shared state between windows.
- Native menu: File (Open CSV, Add CSV, Export CSV, Quit), Edit, View
- Menu actions use `BrowserWindow.getFocusedWindow()` to target the active window
- IPC handlers resolve the correct DB via `event.sender.id`

### IPC Handlers

| Channel | Purpose |
|---------|---------|
| `db:load-csv` | `CREATE OR REPLACE TABLE ... AS SELECT * FROM read_csv_auto(...)`, returns `{tableName, schema, rowCount}` |
| `db:query` | Execute SELECT, return rows |
| `db:exec` | Execute DDL/DML (CREATE, ALTER, etc.), return boolean |
| `db:describe` | `DESCRIBE "tableName"`, return schema |
| `db:tables` | `SHOW TABLES`, return table list |
| `db:export-csv` | `COPY (sql) TO 'path' (HEADER, DELIMITER ',')` |
| `dialog:save-csv` | Native save dialog, returns file path or null |

### Preload (`app/preload.ts`)

Context bridge exposing `window.api` (typed as `DbApi`):

```typescript
interface DbApi {
  loadCSV(filePath: string, tableName: string): Promise<{tableName, schema, rowCount}>
  query(sql: string): Promise<any[]>
  exec(sql: string): Promise<boolean>
  describe(tableName: string): Promise<ColumnInfo[]>
  tables(): Promise<any[]>
  exportCSV(sql: string, filePath: string): Promise<boolean>
  saveDialog(): Promise<string | null>
  onOpenFiles(callback: (paths: string[]) => void): void   // Cmd+O
  onAddFiles(callback: (paths: string[]) => void): void    // Cmd+Shift+O
  onExportCSV(callback: () => void): void                   // Cmd+E
}
```

### Renderer (`src/renderer.tsx`)

React 18 entry point. Mounts `<App />` to `#root`. Imports `./styles/app.less`.

### Key Directories

- `app/` — Electron main process + preload (Node.js context)
- `src/components/` — React components (8 files)
- `src/hooks/` — Custom React hooks (`useChunkCache`)
- `src/utils/` — SQL query builder utilities
- `src/types.ts` — All TypeScript interfaces
- `src/styles/` — Less stylesheets (imports BlueprintJS CSS)
- `html/` — HTML shell (copied to dist at build time, has CSP policy)

### Tech Stack

- **Electron 31** — desktop shell
- **React 18** — UI framework
- **TypeScript 5** — all source files (strict mode, target ES2020, module CommonJS)
- **DuckDB** — in-memory analytical database for CSV loading, querying, combining, and data operations
- **BlueprintJS 4** — UI component library (`@blueprintjs/core`, `@blueprintjs/icons`, `@blueprintjs/popover2`)
- **@tanstack/react-virtual** — virtual scrolling for the DataGrid (renders only visible rows)
- **Webpack 5** — bundles 3 targets with ts-loader, less/css loaders, file-loader for fonts
- **Less** — stylesheet preprocessor
- **lodash** — utility library (available as dependency)
- **electron-log** — logging in main process

## Components

### App.tsx — Main Orchestrator
- State: `tables[]`, `activeTable`, `viewState`, `schema`, `resetKey`, `combineDialogOpen`, `combineTableNames`
- Uses `useChunkCache` hook for lazy data loading (no `rows`/`totalRows` state — provided by the hook)
- Registers IPC listeners on mount: `onOpenFiles` (replace), `onAddFiles` (append), `onExportCSV`
- `loadFiles(filePaths, replace)` — loads CSVs into DuckDB, updates table list
- `handleDeleteTable(tableName)` — drops table from DuckDB via `DROP TABLE IF EXISTS`, removes from state, switches active table if needed
- `handleCombineOpen(selectedNames)` — stores selected table names, opens CombineDialog with only those tables
- `handleCombineExecute(sql)` — executes combine SQL from dialog, creates a uniquely named table (`combined_1`, `combined_2`, etc.) via `nextCombinedName()` — never overwrites user-loaded tables
- `handleDataOperation(sql)` — executes arbitrary SQL for data transforms (column/row operations)
- Schema fetching effect: re-fetches schema on `activeTable` change, auto-populates `visibleColumns`
- `resetKey` counter: increments on table/filter/sort/column changes to trigger DataGrid scroll-to-top
- Layout: `Sidebar + DataGrid + FilterPanel + StatusBar + CombineDialog`

### Sidebar.tsx — Left Panel
- Lists loaded tables with row counts (click to switch active table)
- **Delete table**: hover-reveal `x` button on each table row; opens BlueprintJS `Alert` confirmation before calling `onDeleteTable`
- **Selective combine**: checkboxes next to each table (visible when 2+ tables loaded, including combined tables) to select which tables to combine; `selectedForCombine: Set<string>` state cleaned up when tables change
- "Combine N Selected" button (enabled when 2+ tables selected, passes selected names to `onCombine`)
- Column visibility checkboxes
- "Data Operations" button opens `DataOperationsDialog`
- Filter panel toggle button

### DataOperationsDialog.tsx — Data Operations Modal
- Extracted from Sidebar; self-contained dialog for column/row transforms
- Props: `isOpen`, `onClose`, `activeTable`, `schema`, `onApply(sql)`
- 11 operation types:
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
- Live preview: fetches 3 sample rows and shows before/after for most operations
- Builds complete SQL internally and passes to `onApply`

### DataGrid.tsx — Virtualized Scrollable Data Grid
- **Virtual scrolling** via `@tanstack/react-virtual` `useVirtualizer` — only renders visible rows (~30-50) plus 20 overscan rows
- Div-based layout (flexbox rows, not `<table>`) with CSS classes `.dg-header`, `.dg-row`, `.dg-cell`
- Props: `totalRows`, `getRow(index)`, `ensureRange(start, end)` from chunk cache — no `rows[]` array
- Fixed `ROW_HEIGHT = 28` for virtualizer sizing
- Sticky header inside scroll container for automatic horizontal scroll sync
- Cell selection: click, Shift+click (range), Cmd/Ctrl+click (toggle) — uses absolute row indices
- Copy: Cmd/Ctrl+C copies selected cells as TSV via `getRow()` lookup
- Sort: click column header to toggle ASC/DESC
- Column resize: drag handle on header right edge
- Column reorder: drag-and-drop header cells
- Row numbering: absolute 1-based index in first column
- Number formatting: integers as-is, floats to 4 decimal places
- Unloaded rows show "..." placeholder (`.loading-cell` style)
- `resetKey` prop: scrolls to top and clears selection when it changes
- Monospace font (`SF Mono`, `Menlo`, `Monaco`)

### FilterPanel.tsx — Resizable Bottom Panel
- Resizable via drag handle (min 80px, max 500px, default 260px)
- Add/remove filter rows, Clear All, Apply Filters
- Filter operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `NOT LIKE`, `IS NULL`, `IS NOT NULL`, `CONTAINS`, `IN`, `STARTS WITH`, `NOT STARTS WITH`, `ENDS WITH`, `NOT ENDS WITH`
- `CONTAINS` uses `regexp_matches()` (case-insensitive)
- `IN` operator uses InValuePicker sub-component:
  - Fetches up to 1000 distinct values from the column
  - Searchable dropdown with Select All / Select None
- Tracks dirty state (unsaved changes indicator)

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
ColumnMapping     // { id, outputColumn, inputColumns: string[] }
ViewState         // { visibleColumns[], columnOrder[], filters[], sortColumn, sortDirection }
```

## SQL Builder (`src/utils/sqlBuilder.ts`)

| Function | Purpose |
|----------|---------|
| `buildSelectQuery(tableName, viewState)` | SELECT with columns, WHERE, ORDER BY (no LIMIT/OFFSET — used for export) |
| `buildFilterClause(filter)` | Single FilterCondition → SQL WHERE clause (internal) |
| `buildCombineQuery(tableNames[])` | Simple `SELECT * ... UNION ALL` (used by export) |
| `escapeIdent(name)` | Escape a SQL identifier by doubling embedded double quotes |
| `buildMappedCombineQuery(tables[], mappings[])` | Column-mapped UNION ALL with aliases, NULL for missing columns, auto VARCHAR cast on type mismatch, trimmed output names |
| `buildChunkQuery(tableName, columns, filters, sort, direction, chunkSize, chunkIndex)` | SELECT with LIMIT/OFFSET for chunk-based virtual scroll loading |
| `buildCountQuery(tableName, filters[])` | `SELECT COUNT(*) ... WHERE` for total row count |

## Styling (`src/styles/app.less`)

- Imports: `blueprint.css`, `blueprint-icons.css`, `blueprint-popover2.css`
- CSS variables: `--sidebar-width: 280px`, `--statusbar-height: 28px`
- Color palette: `#f5f8fa` (bg), `#394b59` (text), `#5c7080` (secondary), `#137cbd` (accent blue), `#d8e1e8` (borders)
- Layout: flexbox throughout — `.app-container` (column) → `.main-layout` (row) → `.sidebar` (fixed 280px) + `.data-area` (flex: 1)
- DataGrid uses div-based layout: `.data-grid-container` → `.data-grid-scroll` → `.dg-header` (sticky) + virtual `.dg-row` elements
- Cell classes: `.dg-cell`, `.dg-row-num-cell`, `.dg-header-cell`, `.cell-selected`, `.loading-cell`, `.column-dragging`
- Filter inputs match HTMLSelect appearance: `height: 30px`, border styling
- Combine dialog inputs also use `height: 30px` to match

## Data Flow

1. User opens CSV files via native file dialog (Cmd+O to replace, Cmd+Shift+O to add)
2. Main process loads CSVs into the window's DuckDB instance via `read_csv_auto()`
3. Renderer fetches schema via IPC; `useChunkCache` hook manages data loading
4. As the user scrolls, `@tanstack/react-virtual` computes visible row indices
5. `useChunkCache.ensureRange()` fetches missing 1000-row chunks from DuckDB via `buildChunkQuery()`
6. Chunks far from the viewport are evicted (LRU, max 20 chunks = ~20K rows in memory)
7. `getRow(index)` returns cached row data synchronously; unloaded rows show "..." placeholder
8. **Delete**: User hovers table row → clicks `x` → confirms in Alert → `DROP TABLE IF EXISTS` via IPC, removed from state
9. **Combine**: User selects tables via checkboxes (combined tables excluded) → clicks "Combine N Selected" → CombineDialog opens with only selected tables → maps output←input columns → generates mapped UNION ALL SQL (with auto VARCHAR cast for type mismatches) → creates uniquely named `combined_N` table
10. Data operations rebuild tables with `CREATE OR REPLACE TABLE ... AS SELECT`
11. Export: `COPY (query) TO 'path' (HEADER, DELIMITER ',')` — combined tables are excluded from the export UNION ALL to prevent row duplication

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+O / Ctrl+O | Open CSV files (replaces current) |
| Cmd+Shift+O / Ctrl+Shift+O | Add CSV files (appends) |
| Cmd+E / Ctrl+E | Export CSV |
| Cmd+C / Ctrl+C | Copy selected cells |
