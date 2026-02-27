import { contextBridge, ipcRenderer } from "electron";

interface RegexPattern {
  id: string;
  title: string;
  pattern: string;
  description: string;
  category?: string;
  isBuiltin: boolean;
}

export interface DbApi {
  loadCSV: (filePath: string, tableName: string) => Promise<any>;
  loadFile: (filePath: string, tableName: string, options?: { csvDelimiter?: string; csvIgnoreErrors?: boolean; excelSheet?: string }) => Promise<any>;
  getExcelSheets: (filePath: string) => Promise<{ name: string; rowCount: number }[]>;
  query: (sql: string) => Promise<any[]>;
  exec: (sql: string) => Promise<boolean>;
  describe: (tableName: string) => Promise<any[]>;
  tables: () => Promise<any[]>;
  exportCSV: (sql: string, filePath: string) => Promise<boolean>;
  exportFile: (sql: string, filePath: string, format: string) => Promise<boolean>;
  exportExcelMulti: (sheets: { sheetName: string; sql: string }[], filePath: string) => Promise<boolean>;
  saveDialog: () => Promise<string | null>;
  saveFileDialog: (format: string) => Promise<string | null>;
  getFreeMemory: () => Promise<number>;
  getRegexPatterns: () => Promise<RegexPattern[]>;
  saveUserPattern: (pattern: RegexPattern) => Promise<boolean>;
  deleteUserPattern: (patternId: string) => Promise<boolean>;
  exportPatterns: () => Promise<boolean>;
  importPatterns: () => Promise<{ imported: number; error?: string }>;
  onOpenFiles: (callback: (filePaths: string[]) => void) => void;
  onAddFiles: (callback: (filePaths: string[]) => void) => void;
  onExportCSV: (callback: () => void) => void;
}

contextBridge.exposeInMainWorld("api", {
  // Database operations
  loadCSV: (filePath: string, tableName: string) =>
    ipcRenderer.invoke("db:load-csv", filePath, tableName),
  loadFile: (filePath: string, tableName: string, options?: { csvDelimiter?: string; csvIgnoreErrors?: boolean; excelSheet?: string }) =>
    ipcRenderer.invoke("db:load-file", filePath, tableName, options),
  getExcelSheets: (filePath: string) =>
    ipcRenderer.invoke("file:get-excel-sheets", filePath),
  query: (sql: string) => ipcRenderer.invoke("db:query", sql),
  exec: (sql: string) => ipcRenderer.invoke("db:exec", sql),
  describe: (tableName: string) => ipcRenderer.invoke("db:describe", tableName),
  tables: () => ipcRenderer.invoke("db:tables"),
  exportCSV: (sql: string, filePath: string) =>
    ipcRenderer.invoke("db:export-csv", sql, filePath),
  exportFile: (sql: string, filePath: string, format: string) =>
    ipcRenderer.invoke("db:export-file", sql, filePath, format),
  exportExcelMulti: (sheets: { sheetName: string; sql: string }[], filePath: string) =>
    ipcRenderer.invoke("db:export-excel-multi", sheets, filePath),

  // Dialogs
  saveDialog: () => ipcRenderer.invoke("dialog:save-csv"),
  saveFileDialog: (format: string) => ipcRenderer.invoke("dialog:save-file", format),

  // System
  getFreeMemory: () => ipcRenderer.invoke("system:free-memory"),

  // Regex patterns
  getRegexPatterns: () => ipcRenderer.invoke("patterns:get-all"),
  saveUserPattern: (pattern: RegexPattern) => ipcRenderer.invoke("patterns:save-user", pattern),
  deleteUserPattern: (patternId: string) => ipcRenderer.invoke("patterns:delete-user", patternId),
  exportPatterns: () => ipcRenderer.invoke("patterns:export"),
  importPatterns: () => ipcRenderer.invoke("patterns:import"),

  // Menu events from main process
  onOpenFiles: (callback: (filePaths: string[]) => void) => {
    ipcRenderer.on("open-files", (_event, filePaths) => callback(filePaths));
  },
  onAddFiles: (callback: (filePaths: string[]) => void) => {
    ipcRenderer.on("add-files", (_event, filePaths) => callback(filePaths));
  },
  onExportCSV: (callback: () => void) => {
    ipcRenderer.on("export-csv", () => callback());
  },
} satisfies DbApi);
