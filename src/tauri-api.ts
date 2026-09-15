/**
 * Tauri adapter that exposes the `window.api` surface used by the React app.
 *
 * The React app talks to `window.api` (typed as DbApi). This module installs that surface
 * backed by Tauri commands and event listeners.
 */

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { recordSelfWrite } from "./utils/fileWatch";
import type { AppUpdateInfo, DbApi, FileStat, LinkPreviewMetadata, OverviewWindowContext, UpdateDownloadEvent } from "./types";

interface RegexPattern {
  id: string;
  title: string;
  pattern: string;
  description: string;
  category?: string;
  isBuiltin: boolean;
}

interface LoadOptions {
  csvDelimiter?: string;
  csvIgnoreErrors?: boolean;
  excelSheet?: string;
}

const filterMap: Record<string, { name: string; extensions: string[] }[]> = {
  csv: [{ name: "CSV Files", extensions: ["csv"] }],
  tsv: [{ name: "TSV Files", extensions: ["tsv"] }],
  json: [{ name: "JSON Files", extensions: ["json"] }],
  md: [{ name: "Markdown Files", extensions: ["md", "markdown"] }],
  markdown: [{ name: "Markdown Files", extensions: ["md", "markdown"] }],
  pdf: [{ name: "PDF Files", extensions: ["pdf"] }],
  png: [{ name: "PNG Images", extensions: ["png"] }],
  jpeg: [{ name: "JPEG Images", extensions: ["jpg", "jpeg"] }],
  webp: [{ name: "WebP Images", extensions: ["webp"] }],
  parquet: [{ name: "Parquet Files", extensions: ["parquet"] }],
  xlsx: [{ name: "Excel Files", extensions: ["xlsx"] }],
  xls: [{ name: "Excel Files", extensions: ["xls"] }],
};

const dataFileFilters = [
  { name: "Data Files", extensions: ["csv", "tsv", "json", "jsonl", "ndjson", "md", "markdown", "pdf", "parquet", "xlsx", "xls"] },
  { name: "CSV / TSV", extensions: ["csv", "tsv"] },
  { name: "JSON", extensions: ["json", "jsonl", "ndjson"] },
  { name: "Markdown", extensions: ["md", "markdown"] },
  { name: "PDF", extensions: ["pdf"] },
  { name: "Parquet", extensions: ["parquet"] },
  { name: "Excel", extensions: ["xlsx", "xls"] },
];

const pdfImageFilter = [{
  name: "Supported Images",
  extensions: ["apng", "avif", "bmp", "gif", "ico", "jpg", "jpeg", "png", "svg", "webp"],
}];

function installTauriApi() {
  const api: DbApi = {
    loadCSV: (filePath: string, tableName: string) =>
      invoke("load_file", { filePath, tableName, options: null }),

    loadFile: (filePath: string, tableName: string, options?: LoadOptions) =>
      invoke("load_file", { filePath, tableName, options: options ?? null }),

    getExcelSheets: (filePath: string) =>
      invoke("get_excel_sheets", { filePath }),

    query: (sql: string) => invoke("query", { sql }),

    exec: (sql: string) => invoke("exec", { sql }),

    describe: (tableName: string) =>
      invoke("describe", { tableName }),

    tables: () => invoke("tables"),

    exportCSV: (sql: string, filePath: string) =>
      invoke("export_file", { sql, filePath, format: "csv" }),

    exportFile: (sql: string, filePath: string, format: string) =>
      invoke("export_file", { sql, filePath, format }),

    exportExcelMulti: (
      sheets: { sheetName: string; sql: string }[],
      filePath: string
    ) => invoke("export_excel_multi", { sheets, filePath }),

    saveDialog: async () => {
      const result = await saveDialog({
        filters: [{ name: "CSV Files", extensions: ["csv"] }],
      });
      return result ?? null;
    },

    saveFileDialog: async (format: string) => {
      const filters = filterMap[format] ?? filterMap.csv;
      const result = await saveDialog({ filters });
      return result ?? null;
    },

    openDataFileDialog: async () => {
      const selected = await openDialog({
        multiple: true,
        filters: dataFileFilters,
      });
      if (!selected) return null;
      return (Array.isArray(selected) ? selected : [selected])
        .filter((path): path is string => typeof path === "string");
    },

    openPdfImageDialog: async () => {
      const selected = await openDialog({
        multiple: false,
        title: "Choose an image to insert",
        filters: pdfImageFilter,
      });
      const filePath = Array.isArray(selected) ? selected[0] : selected;
      if (!filePath) return null;
      const bytes = await invoke<number[]>("read_binary_file", { filePath });
      return { filePath, bytes: new Uint8Array(bytes) };
    },

    getFreeMemory: () => invoke("free_memory"),

    getRegexPatterns: () => invoke("get_regex_patterns"),

    saveUserPattern: (pattern: RegexPattern) =>
      invoke("save_user_pattern", { pattern }),

    deleteUserPattern: (patternId: string) =>
      invoke("delete_user_pattern", { patternId }),

    exportPatterns: async () => {
      const path = await saveDialog({
        filters: [{ name: "JSON Files", extensions: ["json"] }],
        defaultPath: "regex-patterns.json",
      });
      if (!path) return false;
      return invoke<boolean>("export_user_patterns", { filePath: path });
    },

    importPatterns: async () => {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "JSON Files", extensions: ["json"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return { imported: 0 };
      return invoke<{ imported: number; error?: string }>(
        "import_user_patterns",
        { filePath: path }
      );
    },

    openExternal: async (url: string) => {
      if (/^https?:\/\//i.test(url)) await openExternal(url);
    },

    fetchLinkPreview: (url: string) =>
      invoke<LinkPreviewMetadata>("fetch_link_preview", { url }),

    writeJsonFile: (filePath: string, data: unknown) =>
      invoke("write_json_file", { filePath, data }),

    readJsonFile: async () => {
      const selected = await openDialog({
        multiple: false,
        filters: [{ name: "JSON Files", extensions: ["json"] }],
      });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return null;
      try {
        return await invoke("read_json_file", { filePath: path });
      } catch (err) {
        return { error: String(err) };
      }
    },

    readTextFile: (filePath: string) =>
      invoke<string>("read_text_file", { filePath }),

    writeTextFile: async (filePath: string, contents: string) => {
      const written = await invoke<boolean>("write_text_file", { filePath, contents });
      recordSelfWrite(filePath);
      return written;
    },

    writeBinaryFile: async (filePath: string, contents: Uint8Array) => {
      const written = await invoke<boolean>("write_binary_file", { filePath, bytes: Array.from(contents) });
      recordSelfWrite(filePath);
      return written;
    },

    fileExists: (filePath: string) => invoke("file_exists", { filePath }),

    fileStat: (filePath: string) => invoke<FileStat>("file_stat", { filePath }),

    allowPdfAsset: (filePath: string) =>
      invoke<string>("allow_pdf_asset", { filePath }),

    openPdfExternally: (filePath: string) =>
      invoke<boolean>("open_pdf_externally", { filePath }),

    openOverviewWindow: (tableName: string, displayName: string) =>
      invoke<string>("open_overview_window", { tableName, displayName }),

    takeOverviewContext: () =>
      invoke<OverviewWindowContext | null>("take_overview_context"),

    onOpenFiles: (callback: (filePaths: string[]) => void) => {
      listen<string[]>("open-files", (e) => callback(e.payload));
      // Drain anything queued before the React app mounted.
      invoke<string[]>("take_pending_files")
        .then((files) => {
          if (files && files.length > 0) callback(files);
        })
        .catch(() => {});
    },

    onAddFiles: (callback: (filePaths: string[]) => void) => {
      listen<string[]>("add-files", (e) => callback(e.payload));
    },

    onExportCSV: (callback: () => void) => {
      listen("export-csv", () => callback());
    },

    onCheckForUpdates: (callback: () => void) => {
      listen("check-for-updates", () => callback());
    },

    onSetDarkMode: (callback: (isDark: boolean) => void) => {
      listen<boolean>("set-dark-mode", (e) => callback(e.payload));
    },

    onSetLinkPreviewsEnabled: (callback: (enabled: boolean) => void) => {
      listen<boolean>("set-link-previews-enabled", (e) => callback(e.payload));
    },

    onRequestQuit: (callback: () => void) => {
      listen("request-quit", () => callback());
    },

    setQcDirty: (dirty: boolean) => invoke("set_qc_dirty", { dirty }),

    requestAppQuit: () => invoke("request_app_quit"),

    syncTheme: (_isDark: boolean) => {
      // Native menu sync is not wired in this scaffold pass; intentionally no-op.
    },

    syncLinkPreviewsEnabled: (enabled: boolean) =>
      invoke<boolean>("sync_link_previews_enabled", { enabled }),

    getAppVersion: () => invoke("get_app_version"),

    checkForUpdate: () => invoke<AppUpdateInfo | null>("check_for_update"),

    claimUpdateNotice: (version: string) =>
      invoke<boolean>("claim_update_notice", { version }),

    releaseUpdateNotice: (version: string) =>
      invoke<boolean>("release_update_notice", { version }),

    installUpdate: async (onProgress: (event: UpdateDownloadEvent) => void) => {
      const onEvent = new Channel<UpdateDownloadEvent>((event) => onProgress(event));
      await invoke("install_update", { onEvent });
    },

    restartApp: () => invoke("restart_app"),
  };

  (window as any).api = api;
}

export function isTauri(): boolean {
  return typeof (window as any).__TAURI_INTERNALS__ !== "undefined"
    || typeof (window as any).__TAURI__ !== "undefined";
}

export function installIfTauri(): boolean {
  if (!isTauri()) return false;
  installTauriApi();
  return true;
}
