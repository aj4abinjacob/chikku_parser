# Chikku Parser

A Tauri desktop app for viewing documents and exploring, combining, and transforming data files. Built with React, DuckDB, Rust, and BlueprintJS.

## Features

- **Data Viewer** — Open and browse large CSV, TSV, JSON, Parquet, and Excel files with virtualized scrolling
- **PDF Viewer, Image Placement & Export** — Search, thumbnails, outlines, zoom, rotation, a clearly labeled PDF theme menu with Light · Original, Dark · Keep colors, and Dark · High contrast choices, permission-aware printing, drag-and-resize image insertion, and PNG/JPEG/WebP page export at standard paper sizes such as A4 or custom pixel/physical dimensions
- **Combine Tables** — Load multiple files and combine them with flexible column mapping
- **Column Operations** — Transform columns with regex extract, trim, upper/lower case, find/replace, assignment, and more
- **Filter & Sort** — Filter data with 16+ operators and sort by any column
- **Pivot & Aggregate** — Build grouped, aggregate, pivot, lookup, and row-operation workflows
- **Export** — Export filtered or combined results to CSV, TSV, JSON, Excel, or Parquet
- **Cell Selection & Copy** — Select cells and copy as TSV
- **Find in Table** — Highlight matching text directly in cells and move between matches with a compact Find bar
- **Live Link Previews** — Hover public HTTPS URLs for safe metadata cards, or disable them from View → Live Link Previews
- **In-App Help** — Searchable guidance for tabular, JSON, Markdown, PDF, multi-file, review, and export workflows

## Finding your tools

Open files from the **Files** heading in the left sidebar. The sidebar keeps file and column navigation together; **Summary** shows a quick overview of the selected table.

Use the toolbar above a table to **Filter**, **Transform → Columns / Rows / Table transformations / Convert dates**, or **Analyze → Aggregate / Pivot table / Lookup and merge / Compare files / Open data profile**. **Review / QC**, **History**, **Reset view**, and **Export** are also available there. Document and comparison workspaces keep their own tools.

Filters open in a compact workbench that grows as conditions are added. Select **Apply** beside the draft status to update the table. Drag the top edge to resize, or focus it and use **Arrow Up / Arrow Down**; **Home / End** select the smallest or largest available size. Each workbench tab remembers its manual height during the session. To reorder columns by keyboard, focus a column's drag handle and use **Arrow Up / Arrow Down**. Sort and group controls support **Shift** to add levels.

**Fit columns**, **Compact**, and **Wrap text** show when they are active. Click the active control again to undo it; Fit and Compact restore the widths you had before using either preset. **Inspect value** uses an eye icon to open a selected cell's full value. **Search** opens the compact Find bar above the grid.

Open Find with **Search** or **Cmd/Ctrl+F** while browsing a flat table. Type to highlight literal, case-insensitive matches in the current filters and visible columns. **Enter / Shift+Enter** or the arrows move forward and back, bringing the active matching cell into view. **Escape** closes Find and clears the highlights. A **+** in the match counter means more matches remain to be found.

Large-file searches use bounded batches of cell positions, with cancellation and a 15-second timeout per scan. Navigation continues beyond the first batch without loading the whole table into the interface. Broad text searches can still take time; filters can narrow the scope.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Desktop Shell | Tauri 2 |
| Backend | Rust |
| UI Framework | React 18 |
| Language | TypeScript 5 |
| Database | DuckDB (in-memory, per window) |
| UI Components | BlueprintJS 4 |
| Virtual Scrolling | @tanstack/react-virtual |
| Bundler | Webpack 5 |
| Styles | Less |

## Getting Started

### Prerequisites

- Node.js (v22.13+)
- npm
- Rust toolchain via [rustup](https://rustup.rs)
- macOS: Xcode Command Line Tools (`xcode-select --install`)

### Install

```bash
git clone https://github.com/aj4abinjacob/chikku_parser.git
cd chikku_parser
npm install
```

### Run

```bash
npm run dev
```

This starts the webpack dev server for the renderer on port 5181, then launches the Tauri shell.

### Package

```bash
npm run build
```

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Launch Tauri in development mode |
| `npm run build` | Build/package the Tauri app |
| `npm run clean` | Remove renderer build output |
| `npm run tauri:renderer:build` | Build the renderer only |
| `npm run tauri:renderer:watch` | Run the renderer dev server |
| `npm run tauri:dev` | Launch Tauri in development mode |
| `npm run tauri:build` | Build/package the Tauri app |

## Architecture

- `src-tauri/` — Rust/Tauri app, DuckDB sessions, commands, window management, Excel and pattern helpers
- `src/tauri-api.ts` — Frontend adapter that installs the Tauri-backed `window.api`
- `src/components/` — React UI components
- `src/hooks/` — Virtual scrolling and pivot cache hooks
- `src/utils/` — SQL builders and data-operation helpers
- `src/styles/app.less` — App styles
- `html/index.html` — Renderer HTML shell
- `dist-tauri/` — Renderer output consumed by Tauri

Each Tauri window owns its own in-memory DuckDB session. Files opened through the OS while the app is already running are routed into the running process and spawn new app windows.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd+O / Ctrl+O | Open files |
| Cmd+Shift+O / Ctrl+Shift+O | Add files to existing session |
| Cmd+E / Ctrl+E | Export |
| Cmd+C / Ctrl+C | Copy selected cells |
| F1 | Open the in-app Help Center |

## Live Link Previews

Chikku can show a rich metadata card when you hover over a public HTTPS URL in the data grid. The preview fetches page metadata without running page scripts or using browser cookies.

Use **View → Live Link Previews** to turn this behavior on or off. The setting is enabled by default and remembered across app launches. When disabled, URLs remain visible, copyable, and clickable, but Chikku does not request rich preview metadata.

## License

MIT
