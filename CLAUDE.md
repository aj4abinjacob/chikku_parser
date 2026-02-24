# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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
- `src/components/` — React components (7 files)
- `src/utils/` — SQL query builder utilities
- `src/types.ts` — All TypeScript interfaces
- `src/styles/` — Less stylesheets (imports BlueprintJS CSS)
- `html/` — HTML shell (copied to dist at build time, has CSP policy)

### Tech Stack

- **Electron 31** — desktop shell
- **React 18** — UI framework
- **TypeScript 5** — all source files (strict mode, target ES2020, module CommonJS)
- **DuckDB** — in-memory analytical database for CSV loading, querying, combining, and column operations
- **BlueprintJS 4** — UI component library (`@blueprintjs/core`, `@blueprintjs/icons`, `@blueprintjs/popover2`)
- **Webpack 5** — bundles 3 targets with ts-loader, less/css loaders, file-loader for fonts
- **Less** — stylesheet preprocessor
- **lodash** — utility library (available as dependency)
- **electron-log** — logging in main process

## Components

### App.tsx — Main Orchestrator
- State: `tables[]`, `activeTable`, `viewState`, `schema`, `rows`, `totalRows`, `combineDialogOpen`
- Registers IPC listeners on mount: `onOpenFiles` (replace), `onAddFiles` (append), `onExportCSV`
- `loadFiles(filePaths, replace)` — loads CSVs into DuckDB, updates table list
- `handleCombineOpen()` — opens CombineDialog (replaces old instant UNION ALL)
- `handleCombineExecute(sql)` — executes combine SQL from dialog, creates "combined" table
- `handleColumnOperation(sql)` — executes arbitrary SQL for column transforms
- Data fetching effect: re-queries on `activeTable` or `viewState` change
- `DEFAULT_PAGE_SIZE = 500`
- Layout: `Sidebar + DataGrid + FilterPanel + StatusBar + CombineDialog`

### Sidebar.tsx — Left Panel
- Lists loaded tables with row counts (click to switch active table)
- "Combine N Tables" button (visible when 2+ tables loaded)
- Column visibility checkboxes
- Column Operation dialog with 7 operation types:
  - `extract_number` — regex extract + cast to DOUBLE
  - `trim` — TRIM()
  - `upper` / `lower` — UPPER() / LOWER()
  - `replace_regex` — regexp_replace() with pattern + replacement params
  - `substring` — SUBSTRING() with start + length params
  - `custom_sql` — arbitrary SQL expression
- Filter panel toggle button

### DataGrid.tsx — Scrollable Data Table
- `table-layout: fixed` with resizable columns (drag handle on header)
- Cell selection: click, Shift+click (range), Cmd/Ctrl+click (toggle)
- Copy: Cmd/Ctrl+C copies selected cells as TSV to clipboard
- Sort: click column header to toggle ASC/DESC
- Row numbering in first column
- Number formatting: integers as-is, floats to 4 decimal places
- Monospace font (`SF Mono`, `Menlo`, `Monaco`)

### FilterPanel.tsx — Resizable Bottom Panel
- Resizable via drag handle (min 80px, max 500px, default 260px)
- Add/remove filter rows, Clear All, Apply Filters
- Filter operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, `NOT LIKE`, `IS NULL`, `IS NOT NULL`, `CONTAINS`, `IN`
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
- "Fill Similar" button: auto-maps columns present in ALL loaded tables
- "Add Row" button: manual mapping
- Validation: empty outputs, duplicate outputs, empty inputs, duplicate input usage
- Generates SQL via `buildMappedCombineQuery()`

### StatusBar.tsx — Bottom Info Bar
- Shows: `{activeTable} | {totalRows} rows | {tableCount} table(s) loaded`
- Pagination: prev/next buttons, page N of M display

### Toolbar.tsx — Minimal Toolbar
- Sidebar toggle button and Combine button (largely superseded by Sidebar)

## Types (`src/types.ts`)

```typescript
ColumnInfo        // { column_name, column_type, null, key, default, extra }
LoadedTable       // { tableName, filePath, schema: ColumnInfo[], rowCount }
ColumnOperation   // { type, sourceColumn, targetColumn, params: Record<string,string> }
FilterCondition   // { column, operator, value }
ColumnMapping     // { id, outputColumn, inputColumns: string[] }
ViewState         // { visibleColumns[], filters[], sortColumn, sortDirection, limit, offset }
```

## SQL Builder (`src/utils/sqlBuilder.ts`)

| Function | Purpose |
|----------|---------|
| `buildSelectQuery(tableName, viewState)` | SELECT with columns, WHERE, ORDER BY, LIMIT/OFFSET |
| `buildFilterClause(filter)` | Single FilterCondition → SQL WHERE clause (internal) |
| `buildCombineQuery(tableNames[])` | Simple `SELECT * ... UNION ALL` (used by export) |
| `buildMappedCombineQuery(tables[], mappings[])` | Column-mapped UNION ALL with aliases and NULL for missing columns |
| `buildCountQuery(tableName, filters[])` | `SELECT COUNT(*) ... WHERE` for pagination |

## Styling (`src/styles/app.less`)

- Imports: `blueprint.css`, `blueprint-icons.css`, `blueprint-popover2.css`
- CSS variables: `--sidebar-width: 280px`, `--statusbar-height: 28px`
- Color palette: `#f5f8fa` (bg), `#394b59` (text), `#5c7080` (secondary), `#137cbd` (accent blue), `#d8e1e8` (borders)
- Layout: flexbox throughout — `.app-container` (column) → `.main-layout` (row) → `.sidebar` (fixed 280px) + `.data-area` (flex: 1)
- Filter inputs match HTMLSelect appearance: `height: 30px`, border styling
- Combine dialog inputs also use `height: 30px` to match

## Data Flow

1. User opens CSV files via native file dialog (Cmd+O to replace, Cmd+Shift+O to add)
2. Main process loads CSVs into the window's DuckDB instance via `read_csv_auto()`
3. Renderer queries DuckDB through IPC for schema, data pages, and counts
4. `sqlBuilder.ts` constructs SELECT/WHERE/ORDER BY/LIMIT queries from ViewState
5. **Combine**: User opens CombineDialog → maps output←input columns → generates mapped UNION ALL SQL → creates "combined" table
6. Column operations rebuild tables with `CREATE OR REPLACE TABLE ... AS SELECT`
7. Export: `COPY (query) TO 'path' (HEADER, DELIMITER ',')`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+O / Ctrl+O | Open CSV files (replaces current) |
| Cmd+Shift+O / Ctrl+Shift+O | Add CSV files (appends) |
| Cmd+E / Ctrl+E | Export CSV |
| Cmd+C / Ctrl+C | Copy selected cells |
