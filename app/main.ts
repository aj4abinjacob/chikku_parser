import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage } from "electron";
import path from "path";
import fs from "fs";
import os from "os";
import log from "electron-log";
import { Database } from "duckdb";
import * as XLSX from "xlsx";

// Per-window DuckDB instances, keyed by webContents.id
const dbMap = new Map<number, Database>();

// ── "Open With" file queue ──
// Files passed via OS "Open With" or command-line args before the window is ready
const pendingOpenFiles: string[] = [];
const SUPPORTED_EXTENSIONS = new Set(["csv", "tsv", "json", "jsonl", "ndjson", "parquet", "xlsx", "xls"]);

// ── Promisified DuckDB helpers ──

function runPromise(db: Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => {
      if (err) return reject(err.message);
      resolve();
    });
  });
}

function allPromise(db: Database, sql: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, (err: Error | null, rows: any[]) => {
      if (err) return reject(err.message);
      resolve(rows);
    });
  });
}

function closeDb(wcId: number): Promise<void> {
  return new Promise((resolve) => {
    const db = dbMap.get(wcId);
    if (!db) return resolve();
    dbMap.delete(wcId);
    try {
      db.close((err: Error | null) => {
        if (err) log.warn(`DuckDB close error for window ${wcId}:`, err.message);
        else log.info(`DuckDB closed for window ${wcId}`);
        resolve();
      });
    } catch (e) {
      log.warn(`DuckDB close threw for window ${wcId}:`, e);
      resolve();
    }
  });
}

function getDb(event: Electron.IpcMainInvokeEvent): Database {
  const db = dbMap.get(event.sender.id);
  if (!db) throw new Error("No database for this window");
  return db;
}

function escapePath(filePath: string): string {
  return filePath.replace(/'/g, "''");
}

function createWindow(): void {
  const iconPath = path.join(__dirname, "..", "res", "icon.png");

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: "Chikku Data Combiner",
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.bundle.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Create a fresh in-memory DuckDB for this window
  const db = new Database(":memory:");
  dbMap.set(win.webContents.id, db);
  log.info(`DuckDB initialized for window ${win.webContents.id}`);

  win.loadFile(path.join(__dirname, "index.html"));

  // Once the renderer is ready, flush any files queued from "Open With" or CLI args
  win.webContents.on("did-finish-load", () => {
    flushPendingFiles(win);
  });

  if (process.env.NODE_ENV === "development") {
    win.webContents.openDevTools();
  }

  const wcId = win.webContents.id;
  win.on("close", () => {
    // Remove DB from map immediately so IPC handlers fail fast during shutdown
    dbMap.delete(wcId);
  });
  win.on("closed", () => {
    closeDb(wcId);
  });
}

// ── Supported file filter for open dialogs ──
const DATA_FILE_FILTER = [
  { name: "Data Files", extensions: ["csv", "tsv", "json", "jsonl", "ndjson", "parquet", "xlsx", "xls"] },
  { name: "CSV / TSV", extensions: ["csv", "tsv"] },
  { name: "JSON", extensions: ["json", "jsonl", "ndjson"] },
  { name: "Parquet", extensions: ["parquet"] },
  { name: "Excel", extensions: ["xlsx", "xls"] },
];

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: "File",
      submenu: [
        {
          label: "Open File...",
          accelerator: "CmdOrCtrl+O",
          click: () => handleOpenFile(),
        },
        {
          label: "Add File...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => handleAddFile(),
        },
        { type: "separator" },
        {
          label: "Export...",
          accelerator: "CmdOrCtrl+E",
          click: () => {
            const win = BrowserWindow.getFocusedWindow();
            if (win) win.webContents.send("export-csv");
          },
        },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { role: "resetZoom" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];

  // macOS app menu
  if (process.platform === "darwin") {
    template.unshift({
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function handleOpenFile(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: DATA_FILE_FILTER,
  });
  if (!result.canceled && result.filePaths.length > 0) {
    win.webContents.send("open-files", result.filePaths);
  }
}

async function handleAddFile(): Promise<void> {
  const win = BrowserWindow.getFocusedWindow();
  if (!win) return;
  const result = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: DATA_FILE_FILTER,
  });
  if (!result.canceled && result.filePaths.length > 0) {
    win.webContents.send("add-files", result.filePaths);
  }
}

// ── IPC Handlers ──

// Load a CSV file into DuckDB and return schema + preview rows (backward compat)
ipcMain.handle(
  "db:load-csv",
  async (event, filePath: string, tableName: string) => {
    const db = getDb(event);
    const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, "_");
    await runPromise(db, `CREATE OR REPLACE TABLE "${safeTable}" AS SELECT * FROM read_csv_auto('${escapePath(filePath)}')`);
    const schema = await allPromise(db, `DESCRIBE "${safeTable}"`);
    const countResult = await allPromise(db, `SELECT COUNT(*) as count FROM "${safeTable}"`);
    return {
      tableName: safeTable,
      schema,
      rowCount: Number(countResult[0].count),
    };
  }
);

// Generalized file loader — detects format by extension
ipcMain.handle(
  "db:load-file",
  async (event, filePath: string, tableName: string, options?: { csvDelimiter?: string; csvIgnoreErrors?: boolean; excelSheet?: string }) => {
    const db = getDb(event);
    const safeTable = tableName.replace(/[^a-zA-Z0-9_]/g, "_");
    const ext = path.extname(filePath).toLowerCase();
    const safePath = escapePath(filePath);

    try {
      if (ext === ".xlsx" || ext === ".xls") {
        // Excel: convert sheet to temp CSV, load into DuckDB
        const workbook = XLSX.readFile(filePath);
        const sheetName = options?.excelSheet || workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);

        const tmpFile = path.join(os.tmpdir(), `chikku_import_${Date.now()}_${Math.random().toString(36).slice(2)}.csv`);
        try {
          const csvContent = XLSX.utils.sheet_to_csv(sheet);
          fs.writeFileSync(tmpFile, csvContent, "utf-8");
          await runPromise(db, `CREATE OR REPLACE TABLE "${safeTable}" AS SELECT * FROM read_csv_auto('${escapePath(tmpFile)}')`);
        } finally {
          try { fs.unlinkSync(tmpFile); } catch (_) { /* ignore cleanup errors */ }
        }
      } else if (ext === ".json" || ext === ".jsonl" || ext === ".ndjson") {
        await runPromise(db, `CREATE OR REPLACE TABLE "${safeTable}" AS SELECT * FROM read_json_auto('${safePath}')`);
      } else if (ext === ".parquet") {
        await runPromise(db, `CREATE OR REPLACE TABLE "${safeTable}" AS SELECT * FROM read_parquet('${safePath}')`);
      } else {
        // CSV/TSV
        const params: string[] = [];
        if (options?.csvDelimiter) {
          params.push(`delim = '${escapePath(options.csvDelimiter)}'`);
        }
        if (options?.csvIgnoreErrors) {
          params.push("ignore_errors = true");
        }
        const paramStr = params.length > 0 ? `, ${params.join(", ")}` : "";
        await runPromise(db, `CREATE OR REPLACE TABLE "${safeTable}" AS SELECT * FROM read_csv_auto('${safePath}'${paramStr})`);
      }

      const schema = await allPromise(db, `DESCRIBE "${safeTable}"`);
      const countResult = await allPromise(db, `SELECT COUNT(*) as count FROM "${safeTable}"`);
      return {
        tableName: safeTable,
        schema,
        rowCount: Number(countResult[0].count),
      };
    } catch (err: any) {
      const message = typeof err === "string" ? err : err?.message || String(err);
      // Check if this is a CSV parse error that can be retried with different options
      const isCsvError = (ext === ".csv" || ext === ".tsv") && (
        message.includes("CSV") || message.includes("delimiter") || message.includes("columns") ||
        message.includes("expected") || message.includes("values") || message.includes("Error")
      );
      if (isCsvError) {
        return { error: message, canRetry: true };
      }
      throw err;
    }
  }
);

// Get Excel sheet info
ipcMain.handle("file:get-excel-sheets", async (_event, filePath: string) => {
  const workbook = XLSX.readFile(filePath);
  return workbook.SheetNames.map((name) => {
    const sheet = workbook.Sheets[name];
    const range = sheet ? XLSX.utils.decode_range(sheet["!ref"] || "A1") : { s: { r: 0 }, e: { r: 0 } };
    const rowCount = Math.max(0, range.e.r - range.s.r); // exclude header row
    return { name, rowCount };
  });
});

// Export a single query to a file in the specified format
ipcMain.handle(
  "db:export-file",
  async (event, sql: string, filePath: string, format: string) => {
    const db = getDb(event);
    const safePath = escapePath(filePath);

    if (format === "json") {
      await runPromise(db, `COPY (${sql}) TO '${safePath}' (FORMAT JSON, ARRAY true)`);
    } else if (format === "parquet") {
      await runPromise(db, `COPY (${sql}) TO '${safePath}' (FORMAT PARQUET)`);
    } else if (format === "tsv") {
      await runPromise(db, `COPY (${sql}) TO '${safePath}' (HEADER, DELIMITER '\t')`);
    } else if (format === "xlsx" || format === "xls") {
      // Query rows from DuckDB, write via xlsx
      const rows = await allPromise(db, sql);
      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
      XLSX.writeFile(wb, filePath);
    } else {
      // Default: CSV
      await runPromise(db, `COPY (${sql}) TO '${safePath}' (HEADER, DELIMITER ',')`);
    }
    return true;
  }
);

// Export multiple tables as sheets in a single Excel workbook
ipcMain.handle(
  "db:export-excel-multi",
  async (event, sheets: { sheetName: string; sql: string }[], filePath: string) => {
    const db = getDb(event);
    const wb = XLSX.utils.book_new();

    for (const sheet of sheets) {
      const rows = await allPromise(db, sheet.sql);
      const ws = XLSX.utils.json_to_sheet(rows);
      // Excel sheet names max 31 chars
      const name = sheet.sheetName.slice(0, 31);
      XLSX.utils.book_append_sheet(wb, ws, name);
    }

    XLSX.writeFile(wb, filePath);
    return true;
  }
);

// Run a SQL query and return results
ipcMain.handle("db:query", async (event, sql: string) => {
  const db = getDb(event);
  return allPromise(db, sql);
});

// Run a SQL statement (no results expected)
ipcMain.handle("db:exec", async (event, sql: string) => {
  const db = getDb(event);
  await runPromise(db, sql);
  return true;
});

// Get table schema
ipcMain.handle("db:describe", async (event, tableName: string) => {
  const db = getDb(event);
  return allPromise(db, `DESCRIBE "${tableName}"`);
});

// List all tables
ipcMain.handle("db:tables", async (event) => {
  const db = getDb(event);
  return allPromise(db, "SHOW TABLES");
});

// Save dialog for export (backward compat)
ipcMain.handle("dialog:save-csv", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, {
    filters: [{ name: "CSV Files", extensions: ["csv"] }],
  });
  return result.canceled ? null : result.filePath;
});

// Save dialog with format-specific filters
ipcMain.handle("dialog:save-file", async (event, format: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;

  const filterMap: Record<string, Electron.FileFilter[]> = {
    csv: [{ name: "CSV Files", extensions: ["csv"] }],
    tsv: [{ name: "TSV Files", extensions: ["tsv"] }],
    json: [{ name: "JSON Files", extensions: ["json"] }],
    parquet: [{ name: "Parquet Files", extensions: ["parquet"] }],
    xlsx: [{ name: "Excel Files", extensions: ["xlsx"] }],
    xls: [{ name: "Excel Files", extensions: ["xls"] }],
  };

  const result = await dialog.showSaveDialog(win, {
    filters: filterMap[format] || filterMap.csv,
  });
  return result.canceled ? null : result.filePath;
});

// Export query results to CSV via DuckDB (backward compat)
ipcMain.handle(
  "db:export-csv",
  async (event, sql: string, filePath: string) => {
    const db = getDb(event);
    await runPromise(db, `COPY (${sql}) TO '${escapePath(filePath)}' (HEADER, DELIMITER ',')`);
    return true;
  }
);

// Return free system memory in bytes
ipcMain.handle("system:free-memory", () => os.freemem());

// ── "Open With" support ──

// macOS: fires when files are opened via "Open With", drag-to-dock, or file associations.
// This event can fire before `ready`, so we queue files and flush once the window is ready.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  if (!SUPPORTED_EXTENSIONS.has(ext)) return;

  const win = BrowserWindow.getAllWindows()[0];
  if (win && win.webContents && !win.webContents.isLoading()) {
    // App is ready — send directly as "open" (replace current tables)
    win.webContents.send("open-files", [filePath]);
  } else {
    // App not ready yet — queue for later
    pendingOpenFiles.push(filePath);
  }
});

/** Flush any queued files (from open-file events or CLI args) to the window */
function flushPendingFiles(win: BrowserWindow): void {
  if (pendingOpenFiles.length === 0) return;
  const files = [...pendingOpenFiles];
  pendingOpenFiles.length = 0;
  win.webContents.send("open-files", files);
}

/** Extract supported file paths from process.argv (skipping Electron/app paths and flags) */
function getFilesFromArgv(): string[] {
  // In packaged app, argv[0] is the app itself. In dev, argv[0] is electron, argv[1] is the script.
  // File arguments come after the app/script paths.
  const args = app.isPackaged ? process.argv.slice(1) : process.argv.slice(2);
  return args.filter((arg) => {
    if (arg.startsWith("-")) return false;
    const ext = path.extname(arg).toLowerCase().replace(".", "");
    return SUPPORTED_EXTENSIONS.has(ext) && fs.existsSync(arg);
  }).map((arg) => path.resolve(arg));
}

// ── App Lifecycle ──

// Single-instance lock: when the user opens a second file while the app is already running,
// the OS launches a new instance. We catch that here and forward the files to the existing window.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // argv contains the new instance's command-line args — extract file paths
    const args = app.isPackaged ? argv.slice(1) : argv.slice(2);
    const files = args.filter((arg) => {
      if (arg.startsWith("-")) return false;
      const ext = path.extname(arg).toLowerCase().replace(".", "");
      return SUPPORTED_EXTENSIONS.has(ext) && fs.existsSync(arg);
    }).map((arg) => path.resolve(arg));

    if (files.length > 0) {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        if (win.isMinimized()) win.restore();
        win.focus();
        win.webContents.send("open-files", files);
      }
    }
  });
}

app.whenReady().then(() => {
  // Set dock icon on macOS (needed for dev mode; production uses .icns from app bundle)
  if (process.platform === "darwin" && app.dock) {
    const dockIcon = nativeImage.createFromPath(
      path.join(__dirname, "..", "res", "icon.png")
    );
    app.dock.setIcon(dockIcon);
  }

  // Collect file paths from command-line arguments (Windows/Linux "Open With")
  const cliFiles = getFilesFromArgv();
  pendingOpenFiles.push(...cliFiles);

  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("will-quit", (event) => {
  if (dbMap.size > 0) {
    event.preventDefault();
    Promise.all([...dbMap.keys()].map((id) => closeDb(id))).then(() => {
      app.quit();
    });
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
