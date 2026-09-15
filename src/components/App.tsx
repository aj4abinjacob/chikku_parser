import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Button, Classes, Dialog, Icon, Intent, Tag } from "@blueprintjs/core";
import { getCurrentWindow, type DragDropEvent } from "@tauri-apps/api/window";
import { LoadedTable, ViewState, ColumnInfo, FilterGroup, FilterNode, SheetInfo, hasActiveFilters, countConditions, isFilterGroup, ColOpType, ColOpStep, RowOpType, RowOpStep, UndoStrategy, SortColumn, PivotAggFunction, PivotGroupColumn, SavedView, TableHistory, TableSourceInfo, HistoryEntry, HistoryOpSource, HistoryExportData, ImportOptions, ColumnStats, ColumnStatsUniqueValue, ComparisonViewConfig, DocumentWorkspaceFileActions, QcCreateConfig, QcOptionSortMode, QcSession, QcValueType, DatasetOverview, ColumnStatsTopValue } from "../types";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
import { ComparisonView, createDefaultComparisonConfig } from "./ComparisonView";
import { FilterPanel } from "./FilterPanel";
import { StatusBar } from "./StatusBar";
import { PivotToolbar } from "./PivotToolbar";
import { CombineDialog } from "./CombineDialog";
import { ExcelSheetPickerDialog } from "./ExcelSheetPickerDialog";
import { ImportRetryDialog } from "./ImportRetryDialog";
import { ExportDialog } from "./ExportDialog";
import { HistoryDialog } from "./HistoryDialog";
import { UpdateNotice } from "./UpdateNotice";
import { JsonWorkspace } from "./JsonWorkspace";
import { MarkdownWorkspace } from "./MarkdownWorkspace";
import { PdfWorkspace } from "./PdfWorkspace";
import { HelpCenter } from "./HelpCenter";
import { FileChangedBanner } from "./FileChangedBanner";
import { buildColumnStatsSummaryQuery, buildColumnTopValuesQuery, buildColumnUniqueValuesQuery, buildCombineQuery, buildDatasetOverviewQuery } from "../utils/sqlBuilder";
import { buildColOpUpdateSQL, buildStepDescription } from "../utils/colOpsSQL";
import { buildRowOpSQL, buildRowOpStepDescription } from "../utils/rowOpsSQL";
import { DEFAULT_PDF_PAGE_APPEARANCE, PdfPageAppearance } from "../utils/pdfPageAppearance";
import { useChunkCache } from "../hooks/useChunkCache";
import { usePivotCache } from "../hooks/usePivotCache";
import { useExternalFileChange } from "../hooks/useExternalFileChange";
import { isTauri } from "../tauri-api";

const FILTER_PANEL_EXIT_MS = 180;
const DEFAULT_DISPLAY_DECIMAL_PLACES = 4;
const MIN_DISPLAY_DECIMAL_PLACES = 0;
const MAX_DISPLAY_DECIMAL_PLACES = 10;
const DEFAULT_TABLE_FONT_SIZE = 13;
const MIN_TABLE_FONT_SIZE = 11;
const MAX_TABLE_FONT_SIZE = 24;
const SUPPORTED_DATA_EXTENSIONS = new Set(["csv", "tsv", "json", "jsonl", "ndjson", "md", "markdown", "pdf", "parquet", "xlsx", "xls"]);
const LINK_PREVIEWS_STORAGE_KEY = "linkPreviewsEnabled";

function makeTableName(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() || "table";
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.substring(0, dotIdx) : name;
  return base.replace(/[^a-zA-Z0-9_]/g, "_");
}

function getDisplayFileName(table: LoadedTable): string {
  if (table.filePath.startsWith("(")) return table.tableName;
  return table.filePath.split(/[/\\]/).pop() || table.filePath;
}

function makeUniqueTableName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    existingNames.add(baseName);
    return baseName;
  }

  let i = 2;
  let candidate = `${baseName}_${i}`;
  while (existingNames.has(candidate)) {
    i++;
    candidate = `${baseName}_${i}`;
  }
  existingNames.add(candidate);
  return candidate;
}

function getFileExtension(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() || "";
}

function isSupportedDataFilePath(filePath: string): boolean {
  return SUPPORTED_DATA_EXTENSIONS.has(getFileExtension(filePath));
}

function isJsonFilePath(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext === "json" || ext === "jsonl" || ext === "ndjson";
}

function isMarkdownFilePath(filePath: string): boolean {
  const ext = getFileExtension(filePath);
  return ext === "md" || ext === "markdown";
}

function isTextWorkspaceFilePath(filePath: string): boolean {
  return isJsonFilePath(filePath) || isMarkdownFilePath(filePath);
}

function isPdfFilePath(filePath: string): boolean {
  return getFileExtension(filePath) === "pdf";
}

function isDocumentWorkspaceFilePath(filePath: string): boolean {
  return isTextWorkspaceFilePath(filePath) || isPdfFilePath(filePath);
}

function isCombinableTable(table: LoadedTable): boolean {
  return !isDocumentWorkspaceFilePath(table.filePath);
}

function refreshedTable(previous: LoadedTable, next: LoadedTable): LoadedTable {
  return {
    ...next,
    importOptions: next.importOptions ?? previous.importOptions,
    reloadVersion: (previous.reloadVersion ?? 0) + 1,
  };
}

function uniqueSupportedFilePaths(filePaths: string[]): string[] {
  const seen = new Set<string>();
  const supported: string[] = [];
  for (const filePath of filePaths) {
    if (!isSupportedDataFilePath(filePath) || seen.has(filePath)) continue;
    seen.add(filePath);
    supported.push(filePath);
  }
  return supported;
}

function clampDisplayDecimalPlaces(value: number): number {
  return Math.min(
    MAX_DISPLAY_DECIMAL_PLACES,
    Math.max(MIN_DISPLAY_DECIMAL_PLACES, value)
  );
}

function clampTableFontSize(value: number): number {
  return Math.min(MAX_TABLE_FONT_SIZE, Math.max(MIN_TABLE_FONT_SIZE, value));
}

function toStatNumber(value: any): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableStatNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isTextColumnType(columnType?: string): boolean {
  return /^(VARCHAR|TEXT|CHAR|STRING|UUID)/i.test(columnType ?? "");
}

function estimateJsonRowCount(text: string, filePath: string): number {
  const ext = getFileExtension(filePath);
  if (ext === "jsonl" || ext === "ndjson") {
    return text.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0).length;
  }
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value.length : 1;
  } catch (_) {
    return 0;
  }
}

function estimateTextLineCount(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
}

/** Generate a unique "combined_N" table name that doesn't collide with existing tables */
function nextCombinedName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`combined_${i}`)) i++;
  return `combined_${i}`;
}

/** Generate a unique "sample_N" table name that doesn't collide with existing tables */
function nextSampleName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`sample_${i}`)) i++;
  return `sample_${i}`;
}

/** Generate a unique "aggregate_N" table name that doesn't collide with existing tables */
function nextAggregateName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`aggregate_${i}`)) i++;
  return `aggregate_${i}`;
}

/** Generate a unique "pivot_N" table name that doesn't collide with existing tables */
function nextPivotName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`pivot_${i}`)) i++;
  return `pivot_${i}`;
}

/** Generate a unique "merge_N" table name that doesn't collide with existing tables */
function nextMergeName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`merge_${i}`)) i++;
  return `merge_${i}`;
}

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function sqlLiteral(value: string | null, valueType: QcValueType): string {
  if (value === null) return "NULL";
  if (valueType === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? String(numeric) : "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function normalizeQcOptions(options: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const option of options) {
    const trimmed = option.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function sortQcOptions(options: string[], sortMode: QcOptionSortMode): string[] {
  const normalized = normalizeQcOptions(options);
  if (sortMode === "entered") return normalized;
  if (sortMode === "numeric") {
    return [...normalized].sort((a, b) => {
      const aNum = Number(a);
      const bNum = Number(b);
      const aValid = Number.isFinite(aNum);
      const bValid = Number.isFinite(bNum);
      if (aValid && bValid) return aNum - bNum;
      if (aValid) return -1;
      if (bValid) return 1;
      return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
    });
  }
  return [...normalized].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

function inferQcValueType(config: QcCreateConfig, options: string[]): QcValueType {
  if (config.mode !== "options" || config.optionSortMode !== "numeric") return "text";
  return options.length > 0 && options.every((option) => Number.isFinite(Number(option))) ? "number" : "text";
}

function removeColumnFilters(group: FilterGroup, column: string): FilterGroup {
  const children: FilterNode[] = [];
  for (const child of group.children) {
    if (isFilterGroup(child)) {
      const nested = removeColumnFilters(child, column);
      if (nested.children.length > 0) children.push(nested);
      continue;
    }
    if (child.column !== column) children.push(child);
  }
  return { ...group, children };
}

function filterReferencesColumn(group: FilterGroup, column: string): boolean {
  return group.children.some((child) => {
    if (isFilterGroup(child)) return filterReferencesColumn(child, column);
    return child.column === column;
  });
}

function addColumnFilter(group: FilterGroup, column: string, value: string | null, columnType?: string): FilterGroup {
  const withoutColumn = removeColumnFilters(group, column);
  if (value === "__all__") return withoutColumn;
  return {
    ...withoutColumn,
    logic: "AND",
    children: [
      ...withoutColumn.children,
      value === null
        ? { column, operator: "IS NULL", value: "", columnType }
        : { column, operator: "=", value, columnType },
    ],
  };
}

function buildQcBatchUpdateSql(tableName: string, session: QcSession): string | null {
  const entries = Object.entries(session.valuesByRowId)
    .map(([rowId, value]) => ({ rowId: Number(rowId), value }))
    .filter((entry) => Number.isFinite(entry.rowId) && entry.value !== "");
  if (entries.length === 0) return null;

  const cases = entries
    .map((entry) => `WHEN rowid = ${entry.rowId} THEN ${sqlLiteral(entry.value, session.valueType)}`)
    .join(" ");
  const rowIds = entries.map((entry) => String(entry.rowId)).join(", ");
  return `UPDATE ${escapeIdent(tableName)} SET ${escapeIdent(session.columnName)} = CASE ${cases} ELSE ${escapeIdent(session.columnName)} END WHERE rowid IN (${rowIds})`;
}

function buildQcNotesBatchUpdateSql(tableName: string, session: QcSession): string | null {
  const notesColumn = session.notesColumnName;
  if (!notesColumn) return null;
  const entries = Object.entries(session.notesByRowId)
    .map(([rowId, value]) => ({ rowId: Number(rowId), value }))
    .filter((entry) => Number.isFinite(entry.rowId) && entry.value !== "");
  if (entries.length === 0) return null;

  const cases = entries
    .map((entry) => `WHEN rowid = ${entry.rowId} THEN ${sqlLiteral(entry.value, "text")}`)
    .join(" ");
  const rowIds = entries.map((entry) => String(entry.rowId)).join(", ");
  return `UPDATE ${escapeIdent(tableName)} SET ${escapeIdent(notesColumn)} = CASE ${cases} ELSE ${escapeIdent(notesColumn)} END WHERE rowid IN (${rowIds})`;
}

function mapFilterColumns(
  group: FilterGroup,
  mapColumn: (column: string) => string | null
): FilterGroup {
  const children: FilterNode[] = [];

  for (const child of group.children) {
    if (isFilterGroup(child)) {
      const nested = mapFilterColumns(child, mapColumn);
      if (nested.children.length > 0) children.push(nested);
      continue;
    }

    const column = mapColumn(child.column);
    if (!column) continue;

    const next = { ...child, column };
    const operator = child.operator as string;
    if ((operator === "EQUALS COLUMN" || operator === "DOES NOT EQUAL COLUMN") && child.value) {
      const value = mapColumn(child.value);
      if (!value) continue;
      next.value = value;
    }
    children.push(next);
  }

  return { ...group, children };
}

function renameColumnInViewState(viewState: ViewState, from: string, to: string): ViewState {
  return {
    ...viewState,
    visibleColumns: viewState.visibleColumns.map((c) => c === from ? to : c),
    columnOrder: viewState.columnOrder.map((c) => c === from ? to : c),
    sortColumns: viewState.sortColumns.map((sc) => sc.column === from ? { ...sc, column: to } : sc),
    filters: mapFilterColumns(viewState.filters, (column) => column === from ? to : column),
    pivotConfig: viewState.pivotConfig
      ? {
        ...viewState.pivotConfig,
        groupColumns: viewState.pivotConfig.groupColumns.map((gc) => gc.column === from ? { ...gc, column: to } : gc),
      }
      : null,
  };
}

function deleteColumnFromViewState(viewState: ViewState, column: string): ViewState {
  const pivotConfig = viewState.pivotConfig
    ? {
      ...viewState.pivotConfig,
      groupColumns: viewState.pivotConfig.groupColumns.filter((gc) => gc.column !== column),
    }
    : null;

  return {
    ...viewState,
    visibleColumns: viewState.visibleColumns.filter((c) => c !== column),
    columnOrder: viewState.columnOrder.filter((c) => c !== column),
    sortColumns: viewState.sortColumns.filter((sc) => sc.column !== column),
    filters: mapFilterColumns(viewState.filters, (c) => c === column ? null : c),
    pivotConfig,
  };
}

function isSchemaColOp(opType: ColOpType): boolean {
  return opType === "rename_column" || opType === "delete_column";
}

interface PendingExcelImport {
  filePath: string;
  fileName: string;
  sheets: SheetInfo[];
  replace: boolean;
  otherFiles: LoadedTable[];
  remainingFiles: string[];
  refreshExisting: boolean;
}

interface PendingRetry {
  filePath: string;
  tableName: string;
  errorMessage: string;
  replace: boolean;
  otherFiles: LoadedTable[];
  remainingFiles: string[];
  refreshExisting: boolean;
  refreshTableName?: string;
}

function QcSessionBar({
  session,
  totalRows,
  onQuickFilter,
  onResetAll,
  onMarkDone,
  onResume,
  onStartNew,
}: {
  session: QcSession;
  totalRows: number;
  onQuickFilter: (value: string | null | "__all__") => void;
  onResetAll: () => Promise<void>;
  onMarkDone: () => Promise<void>;
  onResume: () => void;
  onStartNew: () => void;
}): React.ReactElement {
  const values = Object.values(session.valuesByRowId).filter((value) => value !== "");
  const markedCount = values.length;
  const progress = totalRows > 0 ? Math.round((markedCount / totalRows) * 100) : 0;
  const valueCounts = values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  const quickValues = session.mode === "boolean"
    ? [session.trueValue, session.falseValue]
    : session.options.slice(0, 6);

  return (
    <div className={`qc-session-bar${session.done ? " qc-session-done" : ""}`}>
      <div className="qc-session-main">
        <div className="qc-session-title">
          <Icon icon={session.done ? "tick-circle" : "manual"} size={15} />
          <span title={session.columnName}>{session.columnName}</span>
          <Tag minimal intent={session.done ? Intent.SUCCESS : Intent.PRIMARY}>
            {session.done ? "Done" : "QC"}
          </Tag>
        </div>
        <div className="qc-session-progress" title={`${markedCount.toLocaleString()} of ${totalRows.toLocaleString()} rows QC'd`}>
          <span className="qc-session-progress-track">
            <span style={{ width: `${Math.min(100, progress)}%` }} />
          </span>
          <strong>{progress}%</strong>
          <em>{markedCount.toLocaleString()} / {totalRows.toLocaleString()}</em>
        </div>
      </div>

      <div className="qc-session-filters" aria-label="QC quick filters">
        <Button small minimal text="All" onClick={() => onQuickFilter("__all__")} />
        <Button small minimal text="Not QC'd" onClick={() => onQuickFilter(null)} />
        {quickValues.map((value) => (
          <Button
            key={value}
            small
            minimal
            text={`${value}${valueCounts[value] ? ` (${valueCounts[value]})` : ""}`}
            onClick={() => onQuickFilter(value)}
          />
        ))}
      </div>

      <div className="qc-session-actions">
        {session.done ? (
          <>
            <Button small icon="edit" text="Resume QC" onClick={onResume} />
            <Button small intent={Intent.PRIMARY} icon="add" text="New QC" onClick={onStartNew} />
          </>
        ) : (
          <>
            <Button
              small
              icon="undo"
              text="Reset"
              disabled={markedCount === 0}
              onClick={() => { void onResetAll(); }}
            />
            <Button
              small
              intent={Intent.PRIMARY}
              icon="tick"
              text="Mark QC Done"
              onClick={() => { void onMarkDone(); }}
            />
          </>
        )}
      </div>
    </div>
  );
}

export function App(): React.ReactElement {
  const [tables, setTables] = useState<LoadedTable[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [pdfNavigationHost, setPdfNavigationHost] = useState<HTMLDivElement | null>(null);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [qcPanelRequestKey, setQcPanelRequestKey] = useState(0);
  const [combineDialogOpen, setCombineDialogOpen] = useState(false);
  const [combineTableNames, setCombineTableNames] = useState<string[]>([]);
  const [schema, setSchema] = useState<ColumnInfo[]>([]);
  const [resetKey, setResetKey] = useState(0);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [pendingExcelImport, setPendingExcelImport] = useState<PendingExcelImport | null>(null);
  const [pendingRetry, setPendingRetry] = useState<PendingRetry | null>(null);
  const [colOpsSteps, setColOpsSteps] = useState<ColOpStep[]>([]);
  const [undoStrategy, setUndoStrategy] = useState<UndoStrategy>("per-step");
  const [colOpsNextId, setColOpsNextId] = useState(1);
  const [rowOpsSteps, setRowOpsSteps] = useState<RowOpStep[]>([]);
  const [rowOpsUndoStrategy, setRowOpsUndoStrategy] = useState<UndoStrategy>("per-step");
  const [rowOpsNextId, setRowOpsNextId] = useState(1);
  const [dataVersion, setDataVersion] = useState(0);
  const [viewState, setViewState] = useState<ViewState>({
    visibleColumns: [],
    columnOrder: [],
    filters: { logic: "AND", children: [] },
    sortColumns: [],
    pivotConfig: null,
  });
  const [comparisonConfig, setComparisonConfig] = useState<ComparisonViewConfig | null>(null);
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewNextId, setSavedViewNextId] = useState(1);
  const [tableHistories, setTableHistories] = useState<Map<string, TableHistory>>(new Map());
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [helpCenterOpen, setHelpCenterOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("theme") === "dark");
  const [pdfPageAppearances, setPdfPageAppearances] = useState<Record<string, PdfPageAppearance>>({});
  const [linkPreviewsEnabled, setLinkPreviewsEnabled] = useState(
    () => localStorage.getItem(LINK_PREVIEWS_STORAGE_KEY) !== "false"
  );
  const [displayDecimalPlaces, setDisplayDecimalPlaces] = useState(() => {
    const storedValue = localStorage.getItem("displayDecimalPlaces");
    if (storedValue !== null) {
      const stored = Number(storedValue);
      if (Number.isInteger(stored)) {
        return clampDisplayDecimalPlaces(stored);
      }
    }
    return DEFAULT_DISPLAY_DECIMAL_PLACES;
  });
  const [tableFontSize, setTableFontSize] = useState(() => {
    const storedValue = localStorage.getItem("tableFontSize");
    if (storedValue !== null) {
      const stored = Number(storedValue);
      if (Number.isInteger(stored)) {
        return clampTableFontSize(stored);
      }
    }
    return DEFAULT_TABLE_FONT_SIZE;
  });
  const [filterPanelMounted, setFilterPanelMounted] = useState(false);
  const [fileDragState, setFileDragState] = useState<"idle" | "supported" | "unsupported">("idle");
  const [documentFileActions, setDocumentFileActions] = useState<DocumentWorkspaceFileActions | null>(null);
  const [qcSessions, setQcSessions] = useState<Record<string, QcSession>>({});
  const [qcDirtyTables, setQcDirtyTables] = useState<Set<string>>(() => new Set());
  const [qcQuitPromptOpen, setQcQuitPromptOpen] = useState(false);
  const [closeAfterQcExport, setCloseAfterQcExport] = useState(false);
  const filterPanelExitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Use refs so IPC callbacks always see latest state
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const activeTableRef = useRef(activeTable);
  activeTableRef.current = activeTable;
  const tableHistoriesRef = useRef(tableHistories);
  tableHistoriesRef.current = tableHistories;
  const colOpsStepsRef = useRef(colOpsSteps);
  colOpsStepsRef.current = colOpsSteps;
  const rowOpsStepsRef = useRef(rowOpsSteps);
  rowOpsStepsRef.current = rowOpsSteps;
  const qcDirtyTablesRef = useRef(qcDirtyTables);
  qcDirtyTablesRef.current = qcDirtyTables;
  const quitEntireAppRef = useRef(false);
  const allowWindowCloseRef = useRef(false);
  const closeAfterQcExportRef = useRef(closeAfterQcExport);
  closeAfterQcExportRef.current = closeAfterQcExport;

  const markQcTableDirty = useCallback((tableName: string) => {
    setQcDirtyTables((prev) => {
      if (prev.has(tableName)) return prev;
      const next = new Set(prev);
      next.add(tableName);
      qcDirtyTablesRef.current = next;
      return next;
    });
  }, []);

  const comparisonActive = !!comparisonConfig && comparisonConfig.baseTable === activeTable;

  // Determine if pivot mode is active
  const pivotActive = !comparisonActive && !!viewState.pivotConfig && viewState.pivotConfig.groupColumns.length > 0;

  // Numeric columns set for pivot aggregate display
  const numericColumns = useMemo(() => {
    const NUMERIC_RE = /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i;
    return new Set(schema.filter(c => NUMERIC_RE.test(c.column_type)).map(c => c.column_name));
  }, [schema]);

  const columnTypes = useMemo(() => {
    const types = new Map<string, string>();
    for (const col of schema) {
      types.set(col.column_name, col.column_type);
    }
    return types;
  }, [schema]);

  const activeLoadedTable = useMemo(
    () => activeTable ? tables.find((t) => t.tableName === activeTable) ?? null : null,
    [activeTable, tables]
  );
  const activeQcSession = activeTable ? qcSessions[activeTable] ?? null : null;
  const sqlBackedTables = useMemo(
    () => tables.filter((table) => table.filePath.startsWith("(") || !isDocumentWorkspaceFilePath(table.filePath)),
    [tables]
  );

  const jsonWorkspaceActive = !!activeLoadedTable
    && !activeLoadedTable.filePath.startsWith("(")
    && isJsonFilePath(activeLoadedTable.filePath);
  const markdownWorkspaceActive = !!activeLoadedTable
    && !activeLoadedTable.filePath.startsWith("(")
    && isMarkdownFilePath(activeLoadedTable.filePath);
  const pdfWorkspaceActive = !!activeLoadedTable
    && !activeLoadedTable.filePath.startsWith("(")
    && isPdfFilePath(activeLoadedTable.filePath);
  const documentWorkspaceActive = jsonWorkspaceActive || markdownWorkspaceActive || pdfWorkspaceActive;

  // Watch the active file for edits made outside the app (checked on window focus)
  const watchedFilePath = activeLoadedTable && !activeLoadedTable.filePath.startsWith("(")
    ? activeLoadedTable.filePath
    : null;
  const {
    changed: activeFileChanged,
    missing: activeFileMissing,
    resync: resyncActiveFileWatch,
  } = useExternalFileChange(watchedFilePath);
  const [reloadingActiveFile, setReloadingActiveFile] = useState(false);

  const handleGetColumnStats = useCallback(
    async (column: string): Promise<ColumnStats> => {
      if (!activeTable) throw new Error("No active table");

      const columnType = columnTypes.get(column);
      const includeNumericStats = numericColumns.has(column);
      const includeTextStats = isTextColumnType(columnType);
      const [summaryRows, topValueRows] = await Promise.all([
        window.api.query(
          buildColumnStatsSummaryQuery(
            activeTable,
            column,
            viewState.filters,
            includeNumericStats,
            includeTextStats
          )
        ),
        window.api.query(
          buildColumnTopValuesQuery(activeTable, column, viewState.filters)
        ),
      ]);
      const summary = summaryRows[0] ?? {};
      const sourceRowCount = tables.find((t) => t.tableName === activeTable)?.rowCount;

      return {
        column,
        columnType,
        rowCount: toStatNumber(summary.row_count),
        totalRows: sourceRowCount ?? toStatNumber(summary.row_count),
        nullCount: toStatNumber(summary.null_count),
        uniqueCount: toStatNumber(summary.unique_count),
        minValue: summary.min_value ?? null,
        maxValue: summary.max_value ?? null,
        avgValue: includeNumericStats && summary.avg_value != null ? toStatNumber(summary.avg_value) : null,
        medianValue: includeNumericStats && summary.median_value != null ? toStatNumber(summary.median_value) : null,
        textStats: includeTextStats
          ? {
              minLength: toNullableStatNumber(summary.min_length),
              maxLength: toNullableStatNumber(summary.max_length),
              avgLength: toNullableStatNumber(summary.avg_length),
              emptyStringCount: toStatNumber(summary.empty_string_count),
              leadingTrailingSpaceCount: toStatNumber(summary.leading_trailing_space_count),
              caseVariantGroups: toStatNumber(summary.case_variant_groups),
              longValueCount: toStatNumber(summary.long_value_count),
            }
          : null,
        topValues: topValueRows.map((row) => ({
          value: String(row.value ?? ""),
          count: toStatNumber(row.count),
        })),
      };
    },
    [activeTable, columnTypes, numericColumns, tables, viewState.filters, dataVersion]
  );

  const handleGetColumnUniques = useCallback(
    async (column: string): Promise<ColumnStatsUniqueValue[]> => {
      if (!activeTable) throw new Error("No active table");

      const rows = await window.api.query(
        buildColumnUniqueValuesQuery(
          activeTable,
          column,
          viewState.filters,
          numericColumns.has(column)
        )
      );

      return rows.map((row) => ({
        value: String(row.value ?? ""),
        count: toStatNumber(row.count),
      }));
    },
    [activeTable, numericColumns, viewState.filters, dataVersion]
  );

  const handleGetDatasetOverview = useCallback(async (): Promise<DatasetOverview> => {
    if (!activeTable) throw new Error("No active table");

    const rows = await window.api.query(
      buildDatasetOverviewQuery(activeTable, schema, viewState.filters)
    );
    const summary = rows[0] ?? {};
    const sourceRowCount = tables.find((table) => table.tableName === activeTable)?.rowCount;

    return {
      rowCount: toStatNumber(summary.row_count),
      totalRows: sourceRowCount ?? toStatNumber(summary.row_count),
      isFiltered: hasActiveFilters(viewState.filters),
      columns: schema.map((column, index) => ({
        column: column.column_name,
        columnType: column.column_type,
        missingCount: toStatNumber(summary[`missing_${index}`]),
        uniqueCount: toStatNumber(summary[`unique_${index}`]),
        minValue: summary[`min_${index}`] == null ? null : String(summary[`min_${index}`]),
        maxValue: summary[`max_${index}`] == null ? null : String(summary[`max_${index}`]),
        minLength: summary[`min_length_${index}`] == null ? null : toStatNumber(summary[`min_length_${index}`]),
        maxLength: summary[`max_length_${index}`] == null ? null : toStatNumber(summary[`max_length_${index}`]),
      })),
    };
  }, [activeTable, dataVersion, schema, tables, viewState.filters]);

  const handleGetOverviewTopValues = useCallback(async (column: string): Promise<ColumnStatsTopValue[]> => {
    if (!activeTable) throw new Error("No active table");
    const columnType = columnTypes.get(column);
    if (!columnType) throw new Error("Column not found");

    const rows = await window.api.query(
      buildColumnTopValuesQuery(
        activeTable,
        column,
        viewState.filters,
        5,
        isTextColumnType(columnType)
      )
    );
    return rows.map((row) => ({
      value: String(row.value ?? ""),
      count: toStatNumber(row.count),
    }));
  }, [activeTable, columnTypes, dataVersion, viewState.filters]);

  const handleOpenDatasetOverview = useCallback(() => {
    if (!activeTable || !activeLoadedTable) return;
    void window.api
      .openOverviewWindow(activeTable, getDisplayFileName(activeLoadedTable))
      .catch((err) => console.warn("Failed to open data overview", err));
  }, [activeLoadedTable, activeTable]);

  // Chunk cache for lazy-loaded virtual scrolling (flat mode)
  const {
    totalRows,
    getRow,
    ensureRange,
    status: chunkQueryStatus,
    error: chunkQueryError,
    retry: retryChunkQuery,
    cacheGeneration,
  } = useChunkCache({
    tableName: activeTable,
    viewState,
    enabled: viewState.visibleColumns.length > 0 && !pivotActive && !documentWorkspaceActive && !comparisonActive,
    dataVersion,
    columnTypes,
  });

  // Pivot cache (pivot mode)
  const {
    flatRows: pivotFlatRows,
    grandTotals: pivotGrandTotals,
    loading: pivotLoading,
    groupCount: pivotGroupCount,
    toggleExpand: pivotToggleExpand,
    expandAll: pivotExpandAll,
    collapseAll: pivotCollapseAll,
    ensureRange: pivotEnsureRange,
    error: pivotQueryError,
    retry: retryPivotQuery,
    cacheGeneration: pivotCacheGeneration,
  } = usePivotCache({
    tableName: activeTable,
    viewState,
    schema,
    enabled: viewState.visibleColumns.length > 0 && pivotActive && !documentWorkspaceActive,
    dataVersion,
  });

  // ── History helpers ──

  const getSourceInfoForTable = useCallback((table: LoadedTable): TableSourceInfo => {
    const isGenerated = table.filePath.startsWith("(");
    return {
      filePath: table.filePath,
      importOptions: table.importOptions,
      isGenerated,
    };
  }, []);

  const initializeTableHistory = useCallback((table: LoadedTable) => {
    const history: TableHistory = {
      tableName: table.tableName,
      sourceInfo: getSourceInfoForTable(table),
      initialSchema: [...table.schema],
      entries: [],
      nextEntryId: 1,
    };
    setTableHistories((prev) => {
      const next = new Map(prev);
      next.set(table.tableName, history);
      return next;
    });
  }, [getSourceInfoForTable]);

  const makeTableHistory = useCallback((table: LoadedTable): TableHistory => ({
    tableName: table.tableName,
    sourceInfo: getSourceInfoForTable(table),
    initialSchema: [...table.schema],
    entries: [],
    nextEntryId: 1,
  }), [getSourceInfoForTable]);

  const cleanupReplacedTables = useCallback(async (nextTables: LoadedTable[]) => {
    const nextNames = new Set(nextTables.map((t) => t.tableName));
    const oldTableNames = tablesRef.current
      .map((t) => t.tableName)
      .filter((name) => !nextNames.has(name));
    const operationTableNames = [
      ...colOpsStepsRef.current.map((step) => step.backupTable).filter(Boolean),
      ...rowOpsStepsRef.current.map((step) => step.backupTable).filter(Boolean),
    ] as string[];
    const currentTable = activeTableRef.current;
    if (currentTable) {
      operationTableNames.push(
        `__colops_snapshot_${currentTable}`,
        `__rowops_snapshot_${currentTable}`
      );
    }

    for (const tableName of Array.from(new Set([...oldTableNames, ...operationTableNames]))) {
      try {
        await window.api.exec(`DROP TABLE IF EXISTS ${escapeIdent(tableName)}`);
      } catch (err) {
        console.error(`Drop table error for ${tableName}:`, err);
      }
    }

    setColOpsSteps([]);
    setUndoStrategy("per-step");
    setColOpsNextId(1);
    setRowOpsSteps([]);
    setRowOpsUndoStrategy("per-step");
    setRowOpsNextId(1);
  }, []);

  const finalizeLoadedTables = useCallback(
    async (
      newTables: LoadedTable[],
      replace: boolean,
      nextActiveTable?: string,
      invalidateData = false
    ) => {
      if (replace) {
        await cleanupReplacedTables(newTables);
      }

      setTables(newTables);
      setQcDirtyTables((prev) => {
        const next = replace
          ? new Set<string>()
          : new Set(Array.from(prev).filter((tableName) => newTables.some((table) => table.tableName === tableName)));
        qcDirtyTablesRef.current = next;
        return next;
      });
      setQcSessions((prev) => {
        const nextTablesByName = new Map(newTables.map((table) => [table.tableName, table]));
        if (replace) return {};
        const next: Record<string, QcSession> = {};
        for (const [tableName, session] of Object.entries(prev)) {
          const table = nextTablesByName.get(tableName);
          if (table && table.schema.some((column) => column.column_name === session.columnName)) {
            const notesColumnPresent = session.notesColumnName
              ? table.schema.some((column) => column.column_name === session.notesColumnName)
              : false;
            next[tableName] = notesColumnPresent || !session.notesColumnName
              ? session
              : { ...session, notesColumnName: null, notesByRowId: {} };
          }
        }
        return next;
      });
      setTableHistories((prev) => {
        const next = replace ? new Map<string, TableHistory>() : new Map(prev);
        for (const table of newTables) {
          if (!next.has(table.tableName)) {
            next.set(table.tableName, makeTableHistory(table));
          }
        }
        return next;
      });

      if (newTables.length > 0) {
        setActiveTable(nextActiveTable ?? newTables[0].tableName);
        setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
        setResetKey((k) => k + 1);
        setFilterPanelOpen(false);
      } else if (replace) {
        setActiveTable(null);
        setViewState((prev) => ({
          ...prev,
          filters: { logic: "AND", children: [] },
          visibleColumns: [],
          columnOrder: [],
          sortColumns: [],
          pivotConfig: null,
        }));
        setResetKey((k) => k + 1);
        setFilterPanelOpen(false);
      }

      if (invalidateData) {
        setSchemaVersion((v) => v + 1);
        setDataVersion((v) => v + 1);
      }
    },
    [cleanupReplacedTables, makeTableHistory]
  );

  const recordHistoryEntry = useCallback(
    (tableName: string, source: HistoryOpSource, description: string, sqlStatements: string[]) => {
      setTableHistories((prev) => {
        const history = prev.get(tableName);
        if (!history) return prev;
        const entry: HistoryEntry = {
          id: history.nextEntryId,
          source,
          description,
          timestamp: Date.now(),
          sqlStatements,
        };
        const next = new Map(prev);
        next.set(tableName, {
          ...history,
          entries: [...history.entries, entry],
          nextEntryId: history.nextEntryId + 1,
        });
        return next;
      });
    },
    []
  );

  // Load a single file into DuckDB (handles all formats)
  const loadSingleFile = useCallback(
    async (
      fp: string,
      tableName: string,
      options?: { csvDelimiter?: string; csvIgnoreErrors?: boolean; excelSheet?: string }
    ): Promise<LoadedTable | { error: string; canRetry: boolean } | null> => {
      try {
        const result = await window.api.loadFile(fp, tableName, options);
        if (result.error) {
          return { error: result.error, canRetry: result.canRetry };
        }
        return {
          tableName: result.tableName,
          filePath: fp,
          schema: result.schema,
          rowCount: result.rowCount,
          importOptions: options,
        };
      } catch (err) {
        console.error(`Failed to load ${fp}:`, err);
        return null;
      }
    },
    []
  );

  const loadTextWorkspaceFile = useCallback(
    async (fp: string, tableName: string): Promise<LoadedTable | null> => {
      try {
        const text = await window.api.readTextFile(fp);
        return {
          tableName,
          filePath: fp,
          schema: [],
          rowCount: isJsonFilePath(fp) ? estimateJsonRowCount(text, fp) : estimateTextLineCount(text),
        };
      } catch (err) {
        console.error(`Failed to open text workspace file ${fp}:`, err);
        return null;
      }
    },
    []
  );

  const loadDocumentWorkspaceFile = useCallback(
    async (fp: string, tableName: string): Promise<LoadedTable | null> => {
      if (isPdfFilePath(fp)) {
        return { tableName, filePath: fp, schema: [], rowCount: 0 };
      }
      return loadTextWorkspaceFile(fp, tableName);
    },
    [loadTextWorkspaceFile]
  );

  // Load files into DuckDB (handles all formats)
  // accumulatedTables: when continuing after a dialog, pass the already-loaded tables
  const loadFiles = useCallback(
    async (
      filePaths: string[],
      replace: boolean,
      accumulatedTables?: LoadedTable[],
      replaceOriginal = replace,
      refreshExisting = false
    ) => {
      const supportedFilePaths = uniqueSupportedFilePaths(filePaths);
      if (supportedFilePaths.length === 0) return;

      const newTables: LoadedTable[] = accumulatedTables ?? (replace ? [] : [...tablesRef.current]);
      const tableNames = new Set(newTables.map((t) => t.tableName));
      let nextActiveTable: string | undefined;
      let loadedAny = accumulatedTables !== undefined;

      for (let i = 0; i < supportedFilePaths.length; i++) {
        const fp = supportedFilePaths[i];
        const ext = getFileExtension(fp);
        const remaining = supportedFilePaths.slice(i + 1);
        const existingIndexes = refreshExisting && !replace
          ? newTables
              .map((table, index) => table.filePath === fp ? index : -1)
              .filter((index) => index >= 0)
          : [];

        if (existingIndexes.length > 0) {
          for (const index of existingIndexes) {
            const existingTable = newTables[index];
            const result = isDocumentWorkspaceFilePath(existingTable.filePath)
              ? await loadDocumentWorkspaceFile(existingTable.filePath, existingTable.tableName)
              : await loadSingleFile(
                  existingTable.filePath,
                  existingTable.tableName,
                  existingTable.importOptions
                );

            if (result && "error" in result && result.canRetry) {
              setPendingRetry({
                filePath: existingTable.filePath,
                tableName: existingTable.tableName,
                errorMessage: result.error,
                replace,
                otherFiles: newTables,
                remainingFiles: remaining,
                refreshExisting,
                refreshTableName: existingTable.tableName,
              });
              return; // Wait for retry dialog, then continue with remaining
            }

            if (result && !("error" in result)) {
              newTables[index] = refreshedTable(existingTable, result);
              nextActiveTable = existingTable.tableName;
              loadedAny = true;
            }
          }
          continue;
        }

        if (isDocumentWorkspaceFilePath(fp)) {
          const tableName = makeUniqueTableName(makeTableName(fp), tableNames);
          const result = await loadDocumentWorkspaceFile(fp, tableName);
          if (result) {
            newTables.push(result);
            nextActiveTable = result.tableName;
            loadedAny = true;
          }
        } else if (ext === "xlsx" || ext === "xls") {
          // Excel: check for multiple sheets
          try {
            const sheets = await window.api.getExcelSheets(fp);
            if (sheets.length > 1) {
              // Show sheet picker dialog — remaining files will be continued after
              setPendingExcelImport({
                filePath: fp,
                fileName: fp.split(/[/\\]/).pop() || fp,
                sheets,
                replace,
                otherFiles: newTables,
                remainingFiles: remaining,
                refreshExisting,
              });
              return; // Wait for dialog result, then continue with remaining
            }
            // Single sheet — import directly
            const tableName = makeUniqueTableName(makeTableName(fp), tableNames);
            const result = await loadSingleFile(fp, tableName, { excelSheet: sheets[0].name });
            if (result && !("error" in result)) {
              newTables.push(result);
              nextActiveTable = result.tableName;
              loadedAny = true;
            }
          } catch (err) {
            console.error(`Failed to load Excel ${fp}:`, err);
          }
        } else if (ext === "csv" || ext === "tsv") {
          // CSV/TSV — try loading, show retry on failure
          const tableName = makeUniqueTableName(makeTableName(fp), tableNames);
          const result = await loadSingleFile(fp, tableName);
          if (result && "error" in result && result.canRetry) {
            setPendingRetry({
              filePath: fp,
              tableName,
              errorMessage: result.error,
              replace,
              otherFiles: newTables,
              remainingFiles: remaining,
              refreshExisting,
            });
            return; // Wait for retry dialog, then continue with remaining
          }
          if (result && !("error" in result)) {
            newTables.push(result);
            nextActiveTable = result.tableName;
            loadedAny = true;
          }
        } else {
          // Parquet and other supported tabular formats — straight load
          const tableName = makeUniqueTableName(makeTableName(fp), tableNames);
          const result = await loadSingleFile(fp, tableName);
          if (result && !("error" in result)) {
            newTables.push(result);
            nextActiveTable = result.tableName;
            loadedAny = true;
          }
        }
      }

      if (refreshExisting && !loadedAny) return;

      await finalizeLoadedTables(
        newTables,
        replaceOriginal,
        nextActiveTable ?? (refreshExisting ? activeTableRef.current ?? undefined : undefined),
        refreshExisting
      );
    },
    [loadSingleFile, loadDocumentWorkspaceFile, finalizeLoadedTables]
  );

  // Handle Excel sheet picker result
  const handleExcelSheetImport = useCallback(
    async (selectedSheets: string[]) => {
      if (!pendingExcelImport) return;
      const { filePath, otherFiles, replace, remainingFiles, refreshExisting } = pendingExcelImport;
      const newTables = [...otherFiles];
      const tableNames = new Set(newTables.map((t) => t.tableName));
      const baseName = makeTableName(filePath);

      for (const sheetName of selectedSheets) {
        const sheetBaseName = `${baseName}_${sheetName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const tableName = makeUniqueTableName(sheetBaseName, tableNames);
        const result = await loadSingleFile(filePath, tableName, { excelSheet: sheetName });
        if (result && !("error" in result)) {
          newTables.push(result);
        }
      }

      setPendingExcelImport(null);

      // Continue loading remaining files, or finalize
      if (remainingFiles.length > 0) {
        await loadFiles(remainingFiles, false, newTables, replace, refreshExisting);
      } else {
        const activeIndex = replace ? 0 : newTables.length - selectedSheets.length;
        await finalizeLoadedTables(newTables, replace, newTables[activeIndex]?.tableName, refreshExisting);
      }
    },
    [pendingExcelImport, loadSingleFile, loadFiles, finalizeLoadedTables]
  );

  // Handle CSV retry
  const handleRetryImport = useCallback(
    async (options: { csvDelimiter?: string; csvIgnoreErrors?: boolean }) => {
      if (!pendingRetry) return;
      const {
        filePath,
        tableName,
        otherFiles,
        replace,
        remainingFiles,
        refreshExisting,
        refreshTableName,
      } = pendingRetry;
      const newTables = [...otherFiles];

      const result = await loadSingleFile(filePath, tableName, options);
      if (result && !("error" in result)) {
        if (refreshTableName) {
          const index = newTables.findIndex((table) => table.tableName === refreshTableName);
          if (index >= 0) {
            newTables[index] = refreshedTable(newTables[index], result);
          } else {
            newTables.push(result);
          }
        } else {
          newTables.push(result);
        }
      } else if (result && "error" in result) {
        // Still failing — update the error message
        setPendingRetry((prev) => prev ? { ...prev, errorMessage: result.error } : null);
        return;
      }

      setPendingRetry(null);

      // Continue loading remaining files, or finalize
      if (remainingFiles.length > 0) {
        await loadFiles(remainingFiles, false, newTables, replace, refreshExisting);
      } else {
        await finalizeLoadedTables(
          newTables,
          replace,
          newTables[newTables.length - 1]?.tableName,
          refreshExisting
        );
      }
    },
    [pendingRetry, loadSingleFile, loadFiles, finalizeLoadedTables]
  );

  const handleChooseFiles = useCallback(async () => {
    const filePaths = await window.api.openDataFileDialog();
    if (!filePaths || filePaths.length === 0) return;
    await loadFiles(filePaths, false);
  }, [loadFiles]);

  const handleStartComparison = useCallback(() => {
    if (!activeTable || schema.length === 0) return;
    const compareTable = tablesRef.current.find((table) => table.tableName !== activeTable && table.schema.length > 0) ?? null;
    setComparisonConfig(createDefaultComparisonConfig(activeTable, schema, compareTable));
    setViewState((prev) => ({ ...prev, pivotConfig: null }));
    setFilterPanelOpen(false);
    setResetKey((k) => k + 1);
  }, [activeTable, schema]);

  // Drop op backups and QC state tied to a table that is about to be re-imported
  const clearTableOpsState = useCallback(async (tableName: string) => {
    const backupTables = [
      ...colOpsStepsRef.current.map((step) => step.backupTable),
      ...rowOpsStepsRef.current.map((step) => step.backupTable),
      `__colops_snapshot_${tableName}`,
      `__rowops_snapshot_${tableName}`,
    ].filter(Boolean) as string[];
    for (const backupTable of backupTables) {
      try { await window.api.exec(`DROP TABLE IF EXISTS "${backupTable}"`); } catch (_) { /* ignore */ }
    }
    setColOpsSteps([]);
    setUndoStrategy("per-step");
    setColOpsNextId(1);
    setRowOpsSteps([]);
    setRowOpsUndoStrategy("per-step");
    setRowOpsNextId(1);
    setQcSessions((prev) => {
      if (!(tableName in prev)) return prev;
      const { [tableName]: _removed, ...rest } = prev;
      return rest;
    });
    setQcDirtyTables((prev) => {
      if (!prev.has(tableName)) return prev;
      const next = new Set(prev);
      next.delete(tableName);
      qcDirtyTablesRef.current = next;
      return next;
    });
  }, []);

  const handleReloadActiveDocument = useCallback(async (fromDisk?: boolean) => {
    const currentTableName = activeTableRef.current;
    if (!currentTableName) return;
    const currentTable = tablesRef.current.find((t) => t.tableName === currentTableName);
    if (!currentTable) return;

    if (isPdfFilePath(currentTable.filePath)) {
      setTables((prev) => prev.map((table) =>
        table.tableName === currentTable.tableName
          ? { ...table, reloadVersion: (table.reloadVersion ?? 0) + 1 }
          : table
      ));
      return;
    }

    if (isTextWorkspaceFilePath(currentTable.filePath)) {
      try {
        const text = await window.api.readTextFile(currentTable.filePath);
        const rowCount = isJsonFilePath(currentTable.filePath)
          ? estimateJsonRowCount(text, currentTable.filePath)
          : estimateTextLineCount(text);
        setTables((prev) =>
          prev.map((table) =>
            table.tableName === currentTable.tableName
              ? fromDisk === true
                ? { ...table, rowCount, reloadVersion: (table.reloadVersion ?? 0) + 1 }
                : { ...table, rowCount }
              : table
          )
        );
        setDataVersion((v) => v + 1);
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error(`Failed to refresh text workspace file ${currentTable.filePath}:`, err);
      }
      return;
    }

    if (fromDisk === true) {
      // Re-importing replaces the table, so operations built on the old import no longer apply
      await clearTableOpsState(currentTable.tableName);
    }

    const result = await loadSingleFile(
      currentTable.filePath,
      currentTable.tableName,
      currentTable.importOptions
    );
    if (!result || "error" in result) return;

    setTables((prev) =>
      prev.map((table) =>
        table.tableName === currentTable.tableName
          ? { ...table, schema: result.schema, rowCount: result.rowCount }
          : table
      )
    );
    setSchema(result.schema);
    if (fromDisk === true) {
      setViewState((prev) => ({
        ...prev,
        filters: { logic: "AND", children: [] },
        visibleColumns: [],
        columnOrder: [],
        sortColumns: [],
        pivotConfig: null,
      }));
    }
    setSchemaVersion((v) => v + 1);
    setDataVersion((v) => v + 1);
    setResetKey((k) => k + 1);
  }, [clearTableOpsState, loadSingleFile]);

  const handleReloadChangedFile = useCallback(async () => {
    setReloadingActiveFile(true);
    try {
      await handleReloadActiveDocument(true);
    } catch (err) {
      console.error("Failed to reload the changed file:", err);
    } finally {
      setReloadingActiveFile(false);
      resyncActiveFileWatch();
    }
  }, [handleReloadActiveDocument, resyncActiveFileWatch]);

  const handleActivePdfPageCountChange = useCallback((pageCount: number) => {
    const currentTableName = activeTableRef.current;
    if (!currentTableName) return;
    setTables((prev) => prev.map((table) =>
      table.tableName === currentTableName
        && isPdfFilePath(table.filePath)
        && table.rowCount !== pageCount
        ? { ...table, rowCount: pageCount }
        : table
    ));
  }, []);

  const handlePdfPageAppearanceChange = useCallback((filePath: string, appearance: PdfPageAppearance) => {
    setPdfPageAppearances((prev) => prev[filePath] === appearance
      ? prev
      : { ...prev, [filePath]: appearance });
  }, []);

  // Register IPC listeners once on mount
  useEffect(() => {
    window.api.onOpenFiles((filePaths) => loadFiles(filePaths, false));
    window.api.onAddFiles((filePaths) => loadFiles(filePaths, false));
    window.api.onExportCSV(() => {
      const currentTableName = activeTableRef.current;
      const currentTable = currentTableName
        ? tablesRef.current.find((table) => table.tableName === currentTableName)
        : null;
      if (currentTable && isDocumentWorkspaceFilePath(currentTable.filePath)) return;
      setExportDialogOpen(true);
    });
    window.api.onSetDarkMode((isDark) => {
      setDarkMode(isDark);
      localStorage.setItem("theme", isDark ? "dark" : "light");
    });
    window.api.onSetLinkPreviewsEnabled((enabled) => {
      setLinkPreviewsEnabled(enabled);
      localStorage.setItem(LINK_PREVIEWS_STORAGE_KEY, String(enabled));
    });
    window.api.onRequestQuit(() => {
      quitEntireAppRef.current = true;
      if (qcDirtyTablesRef.current.size === 0) {
        void window.api.setQcDirty(false).then(() => window.api.requestAppQuit());
        return;
      }
      setQcQuitPromptOpen(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isTauri()) return;
    void window.api
      .setQcDirty(qcDirtyTables.size > 0)
      .catch((err) => console.warn("Failed to sync QC save state", err));
  }, [qcDirtyTables]);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;
    getCurrentWindow()
      .onCloseRequested((event) => {
        if (allowWindowCloseRef.current) {
          allowWindowCloseRef.current = false;
          return;
        }
        if (qcDirtyTablesRef.current.size === 0) return;
        event.preventDefault();
        quitEntireAppRef.current = false;
        setQcQuitPromptOpen(true);
      })
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((err) => console.warn("Failed to register close handler", err));

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;

    let disposed = false;
    let unlisten: (() => void) | null = null;

    const handleDragDrop = (payload: DragDropEvent) => {
      if (payload.type === "enter") {
        // Tauri can emit an enter event with no paths for HTML drag operations,
        // such as reordering columns. Only show the file overlay for OS file drags.
        if (payload.paths.length === 0) return;
        setFileDragState(uniqueSupportedFilePaths(payload.paths).length > 0 ? "supported" : "unsupported");
      } else if (payload.type === "drop") {
        setFileDragState("idle");
        const paths = uniqueSupportedFilePaths(payload.paths);
        if (paths.length > 0) {
          void loadFiles(paths, false, undefined, false, true);
        }
      } else if (payload.type === "leave") {
        setFileDragState("idle");
      }
    };

    getCurrentWindow()
      .onDragDropEvent((event) => handleDragDrop(event.payload))
      .then((cleanup) => {
        if (disposed) {
          cleanup();
        } else {
          unlisten = cleanup;
        }
      })
      .catch((err) => console.warn("Failed to register drag/drop handler", err));

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [loadFiles]);

  // Sync dark mode class to body (for BlueprintJS dialogs rendered in portals) and menu checkbox
  useEffect(() => {
    document.body.classList.toggle("bp4-dark", darkMode);
    document.body.classList.toggle("dark-theme", darkMode);
    document.documentElement.classList.toggle("dark-theme", darkMode);
    window.api.syncTheme(darkMode);
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem(LINK_PREVIEWS_STORAGE_KEY, String(linkPreviewsEnabled));
    if (!isTauri()) return;
    void window.api
      .syncLinkPreviewsEnabled(linkPreviewsEnabled)
      .catch((err) => console.warn("Failed to sync live link preview setting", err));
  }, [linkPreviewsEnabled]);

  useEffect(() => {
    localStorage.setItem("displayDecimalPlaces", String(displayDecimalPlaces));
  }, [displayDecimalPlaces]);

  useEffect(() => {
    localStorage.setItem("tableFontSize", String(tableFontSize));
  }, [tableFontSize]);

  useEffect(() => {
    if (filterPanelOpen) {
      if (filterPanelExitTimerRef.current) {
        clearTimeout(filterPanelExitTimerRef.current);
        filterPanelExitTimerRef.current = null;
      }
      setFilterPanelMounted(true);
      return;
    }

    if (!filterPanelMounted) return;

    filterPanelExitTimerRef.current = setTimeout(() => {
      setFilterPanelMounted(false);
      filterPanelExitTimerRef.current = null;
    }, FILTER_PANEL_EXIT_MS);

    return () => {
      if (filterPanelExitTimerRef.current) {
        clearTimeout(filterPanelExitTimerRef.current);
        filterPanelExitTimerRef.current = null;
      }
    };
  }, [filterPanelOpen, filterPanelMounted]);

  useEffect(() => {
    if (documentWorkspaceActive) setFilterPanelOpen(false);
  }, [documentWorkspaceActive]);

  // When active table changes, refresh schema and reset columns
  useEffect(() => {
    if (!activeTable) {
      setSchema([]);
      setViewState((prev) => ({ ...prev, visibleColumns: [], columnOrder: [] }));
      setComparisonConfig(null);
      setFilterPanelOpen(false);
      return;
    }

    const currentTable = tablesRef.current.find((table) => table.tableName === activeTable);
    if (currentTable && !currentTable.filePath.startsWith("(") && isDocumentWorkspaceFilePath(currentTable.filePath)) {
      setSchema([]);
      setComparisonConfig(null);
      setFilterPanelOpen(false);
      setViewState((prev) => ({
        ...prev,
        visibleColumns: [],
        columnOrder: [],
        sortColumns: [],
        pivotConfig: null,
      }));
      return;
    }

    const fetchSchema = async () => {
      try {
        const desc = await window.api.describe(activeTable);
        setSchema(desc);
        const allCols = desc.map((c: ColumnInfo) => c.column_name);
        setViewState((prev) => ({ ...prev, visibleColumns: allCols, columnOrder: allCols }));
      } catch (err) {
        console.error("Schema fetch error:", err);
      }
    };

    fetchSchema();
  }, [activeTable, schemaVersion]);

  useEffect(() => {
    if (!comparisonConfig) return;
    const tableNames = new Set(tables.map((table) => table.tableName));
    if (!activeTable || comparisonConfig.baseTable !== activeTable || !tableNames.has(comparisonConfig.baseTable)) {
      setComparisonConfig(null);
      setFilterPanelOpen(false);
    }
  }, [activeTable, comparisonConfig, tables]);

  // Clean up colOps and rowOps state when active table changes
  const prevActiveTableRef = useRef<string | null>(null);
  useEffect(() => {
    const prevTable = prevActiveTableRef.current;
    prevActiveTableRef.current = activeTable;

    if (prevTable && prevTable !== activeTable) {
      if (colOpsSteps.length > 0) {
        // Drop all colOps backup/snapshot tables for the previous table
        const dropColOpsBackups = async () => {
          for (const step of colOpsSteps) {
            if (step.backupTable) {
              try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
            }
          }
          try { await window.api.exec(`DROP TABLE IF EXISTS "__colops_snapshot_${prevTable}"`); } catch (_) { /* ignore */ }
        };
        dropColOpsBackups();
        setColOpsSteps([]);
        setUndoStrategy("per-step");
        setColOpsNextId(1);
      }

      if (rowOpsSteps.length > 0) {
        // Drop all rowOps backup/snapshot tables for the previous table
        const dropRowOpsBackups = async () => {
          for (const step of rowOpsSteps) {
            if (step.backupTable) {
              try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
            }
          }
          try { await window.api.exec(`DROP TABLE IF EXISTS "__rowops_snapshot_${prevTable}"`); } catch (_) { /* ignore */ }
        };
        dropRowOpsBackups();
        setRowOpsSteps([]);
        setRowOpsUndoStrategy("per-step");
        setRowOpsNextId(1);
      }
    }
  }, [activeTable]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delete a table from DuckDB and state
  const handleDeleteTable = useCallback(async (tableName: string) => {
    try {
      await window.api.exec(`DROP TABLE IF EXISTS "${tableName}"`);
    } catch (err) {
      console.error("Drop table error:", err);
    }
    // Note: views are global now — keep them even when the source table is deleted
    setTables((prev) => {
      const remaining = prev.filter((t) => t.tableName !== tableName);
      if (activeTableRef.current === tableName) {
        const next = remaining.length > 0 ? remaining[0].tableName : null;
        setActiveTable(next);
        setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
        setResetKey((k) => k + 1);
      }
      return remaining;
    });
    // Remove history for the deleted table
    setTableHistories((prev) => {
      const next = new Map(prev);
      next.delete(tableName);
      return next;
    });
    setQcSessions((prev) => {
      const { [tableName]: _removed, ...rest } = prev;
      return rest;
    });
    setQcDirtyTables((prev) => {
      if (!prev.has(tableName)) return prev;
      const next = new Set(prev);
      next.delete(tableName);
      qcDirtyTablesRef.current = next;
      return next;
    });
  }, []);

  // Open the column mapping dialog with selected tables
  const handleCombineOpen = useCallback((selectedNames: string[]) => {
    const selectedNameSet = new Set(selectedNames);
    const combinableNames = tablesRef.current
      .filter((table) => selectedNameSet.has(table.tableName) && isCombinableTable(table))
      .map((table) => table.tableName);
    if (combinableNames.length < 2) return;
    setCombineTableNames(combinableNames);
    setCombineDialogOpen(true);
  }, []);

  // Execute the combine SQL produced by CombineDialog
  const handleCombineExecute = useCallback(async (sql: string) => {
    try {
      const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
      const combinedName = nextCombinedName(existingNames);

      await window.api.exec(
        `CREATE OR REPLACE TABLE "${combinedName}" AS ${sql}`
      );
      const desc = await window.api.describe(combinedName);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${combinedName}"`
      );
      const combinedTable: LoadedTable = {
        tableName: combinedName,
        filePath: "(combined)",
        schema: desc,
        rowCount: Number(countResult[0].count),
      };

      setTables((prev) => [...prev, combinedTable]);
      initializeTableHistory(combinedTable);
      setActiveTable(combinedName);
      setViewState((prev) => ({
        ...prev,
        filters: { logic: "AND", children: [] },
        visibleColumns: [],
        columnOrder: [],
        sortColumns: [],
      }));
      setResetKey((k) => k + 1);
      setCombineDialogOpen(false);
    } catch (err) {
      console.error("Combine error:", err);
    }
  }, [initializeTableHistory]);

  // Column visibility toggle
  const toggleColumn = useCallback(
    (colName: string) => {
      setViewState((prev) => {
        if (prev.visibleColumns.includes(colName)) {
          return { ...prev, visibleColumns: prev.visibleColumns.filter((c) => c !== colName) };
        }
        // Re-show at its position in columnOrder, not appended at the end.
        // Fall back to schema order when columnOrder is empty (matches sidebar fallback).
        const nextVisible = new Set([...prev.visibleColumns, colName]);
        const orderSource = prev.columnOrder.length > 0
          ? prev.columnOrder
          : schema.map((c) => c.column_name);
        const visible = orderSource.filter((c) => nextVisible.has(c));
        // Keep any visible column missing from orderSource (defensive)
        const placed = new Set(visible);
        for (const c of prev.visibleColumns) {
          if (!placed.has(c)) visible.push(c);
        }
        if (!placed.has(colName) && !visible.includes(colName)) visible.push(colName);
        return { ...prev, visibleColumns: visible };
      });
      setResetKey((k) => k + 1);
    },
    [schema]
  );

  // Column reorder from sidebar drag (reorders all columns)
  const reorderColumns = useCallback(
    (newOrder: string[]) => {
      setViewState((prev) => {
        const visibleSet = new Set(prev.visibleColumns);
        const newVisible = newOrder.filter((col) => visibleSet.has(col));
        return { ...prev, columnOrder: newOrder, visibleColumns: newVisible };
      });
    },
    []
  );

  // Column reorder from grid header drag (reorders visible columns only)
  const reorderVisibleColumns = useCallback(
    (newVisible: string[]) => {
      setViewState((prev) => {
        const visibleSet = new Set(newVisible);
        const newColumnOrder: string[] = [];
        let vi = 0;
        for (const col of prev.columnOrder) {
          if (visibleSet.has(col)) {
            newColumnOrder.push(newVisible[vi++]);
          } else {
            newColumnOrder.push(col);
          }
        }
        return { ...prev, columnOrder: newColumnOrder, visibleColumns: newVisible };
      });
    },
    []
  );

  // Sort handler
  const handleSort = useCallback((column: string, addLevel: boolean) => {
    setViewState((prev) => {
      const existing = prev.sortColumns.findIndex((sc) => sc.column === column);

      if (addLevel) {
        // Shift+click: add/toggle/remove sort level
        if (existing >= 0) {
          const current = prev.sortColumns[existing];
          if (current.direction === "ASC") {
            // Toggle to DESC
            const next = [...prev.sortColumns];
            next[existing] = { column, direction: "DESC" };
            return { ...prev, sortColumns: next };
          } else {
            // Remove from sort
            return { ...prev, sortColumns: prev.sortColumns.filter((_, i) => i !== existing) };
          }
        } else {
          // Add new sort level
          return { ...prev, sortColumns: [...prev.sortColumns, { column, direction: "ASC" }] };
        }
      } else {
        // Normal click: single-column sort
        if (prev.sortColumns.length === 1 && prev.sortColumns[0].column === column) {
          // Toggle direction or remove
          if (prev.sortColumns[0].direction === "ASC") {
            return { ...prev, sortColumns: [{ column, direction: "DESC" }] };
          } else {
            return { ...prev, sortColumns: [] };
          }
        }
        return { ...prev, sortColumns: [{ column, direction: "ASC" }] };
      }
    });
    setResetKey((k) => k + 1);
  }, []);

  // Clear all sorts
  const handleClearSort = useCallback(() => {
    setViewState((prev) => ({ ...prev, sortColumns: [] }));
    setResetKey((k) => k + 1);
  }, []);

  const handleDisplayDecimalPlacesChange = useCallback((places: number) => {
    setDisplayDecimalPlaces(clampDisplayDecimalPlaces(places));
  }, []);

  const handleTableFontSizeChange = useCallback((fontSize: number) => {
    setTableFontSize(clampTableFontSize(fontSize));
  }, []);

  // ── Pivot View handlers ──

  const handlePivotGroup = useCallback((column: string, addLevel: boolean) => {
    setViewState((prev) => {
      // Auto-create pivotConfig if it doesn't exist
      const config = prev.pivotConfig ?? { groupColumns: [] as { column: string; direction: "ASC" | "DESC" }[], showGrandTotal: true, defaultAggFunction: "COUNT" as const };

      const existing = config.groupColumns.findIndex((gc) => gc.column === column);

      if (addLevel) {
        if (existing >= 0) {
          const current = config.groupColumns[existing];
          if (current.direction === "ASC") {
            const next = [...config.groupColumns];
            next[existing] = { column, direction: "DESC" };
            return { ...prev, pivotConfig: { ...config, groupColumns: next } };
          } else {
            return {
              ...prev,
              pivotConfig: {
                ...config,
                groupColumns: config.groupColumns.filter((_, i) => i !== existing),
              },
            };
          }
        } else {
          return {
            ...prev,
            pivotConfig: {
              ...config,
              groupColumns: [...config.groupColumns, { column, direction: "ASC" }],
            },
          };
        }
      } else {
        if (config.groupColumns.length === 1 && config.groupColumns[0].column === column) {
          if (config.groupColumns[0].direction === "ASC") {
            return {
              ...prev,
              pivotConfig: { ...config, groupColumns: [{ column, direction: "DESC" }] },
            };
          } else {
            return { ...prev, pivotConfig: { ...config, groupColumns: [] } };
          }
        }
        return {
          ...prev,
          pivotConfig: { ...config, groupColumns: [{ column, direction: "ASC" }] },
        };
      }
    });
    setResetKey((k) => k + 1);
  }, []);

  const handleClearPivotGroups = useCallback(() => {
    setViewState((prev) => ({ ...prev, pivotConfig: null }));
    setResetKey((k) => k + 1);
  }, []);

  const handleGroupSort = useCallback((mode: "alpha" | "count", direction: "ASC" | "DESC" | null) => {
    setViewState((prev) => {
      if (!prev.pivotConfig) return prev;
      return {
        ...prev,
        pivotConfig: {
          ...prev.pivotConfig,
          groupSortMode: direction ? mode : null,
          groupSortDirection: direction ?? undefined,
        },
      };
    });
    setResetKey((k) => k + 1);
  }, []);

  const handleToggleGrandTotal = useCallback(() => {
    setViewState((prev) => {
      if (!prev.pivotConfig) return prev;
      return {
        ...prev,
        pivotConfig: { ...prev.pivotConfig, showGrandTotal: !prev.pivotConfig.showGrandTotal },
      };
    });
  }, []);

  const handleDefaultAggChange = useCallback((fn: PivotAggFunction) => {
    setViewState((prev) => {
      if (!prev.pivotConfig) return prev;
      return { ...prev, pivotConfig: { ...prev.pivotConfig, defaultAggFunction: fn } };
    });
    setResetKey((k) => k + 1);
  }, []);

  // Filters
  const handleFiltersChange = useCallback((filters: FilterGroup) => {
    setViewState((prev) => ({ ...prev, filters }));
    setResetKey((k) => k + 1);
  }, []);

  const handleQcFocusHandled = useCallback(() => {
    setQcPanelRequestKey(0);
  }, []);

  // ── QC handlers ──

  const handleQcCreate = useCallback(
    async (config: QcCreateConfig) => {
      if (!activeTable) throw new Error("No active table");
      const columnName = config.columnName.trim();
      if (!columnName) throw new Error("Enter a QC column name");
      if (schema.some((col) => col.column_name === columnName)) {
        throw new Error(`Column "${columnName}" already exists`);
      }

      const trueValue = config.trueValue.trim() || "Accepted";
      const falseValue = config.falseValue.trim() || "Rejected";
      if (config.mode === "boolean" && trueValue === falseValue) {
        throw new Error("Tick and X values must be different");
      }

      const options = config.mode === "options"
        ? sortQcOptions(config.options, config.optionSortMode)
        : [];
      if (config.mode === "options" && options.length === 0) {
        throw new Error("Add at least one QC option");
      }

      const notesColumnName = config.notesEnabled ? config.notesColumnName.trim() : "";
      if (config.notesEnabled) {
        if (!notesColumnName) throw new Error("Enter a notes column name");
        if (notesColumnName === columnName) {
          throw new Error("Notes column name must differ from the QC column name");
        }
        if (schema.some((col) => col.column_name === notesColumnName)) {
          throw new Error(`Column "${notesColumnName}" already exists`);
        }
      }

      const valueType = inferQcValueType(config, options);
      const columnType = valueType === "number" ? "DOUBLE" : "VARCHAR";
      const sql = `ALTER TABLE ${escapeIdent(activeTable)} ADD COLUMN ${escapeIdent(columnName)} ${columnType}`;

      await window.api.exec(sql);

      const sqlStatements = [sql];
      if (notesColumnName) {
        const notesSql = `ALTER TABLE ${escapeIdent(activeTable)} ADD COLUMN ${escapeIdent(notesColumnName)} VARCHAR`;
        try {
          await window.api.exec(notesSql);
          sqlStatements.push(notesSql);
        } catch (err) {
          // Roll the QC column back so the panel stays in a consistent state
          await window.api.exec(`ALTER TABLE ${escapeIdent(activeTable)} DROP COLUMN ${escapeIdent(columnName)}`).catch(() => {});
          throw err;
        }
      }

      const session: QcSession = {
        columnName,
        mode: config.mode,
        done: false,
        createdAt: Date.now(),
        valueType,
        trueValue,
        falseValue,
        options,
        optionSortMode: config.optionSortMode,
        valuesByRowId: {},
        notesColumnName: notesColumnName || null,
        notesByRowId: {},
      };

      setQcSessions((prev) => ({ ...prev, [activeTable]: session }));
      markQcTableDirty(activeTable);
      recordHistoryEntry(
        activeTable,
        "data_op",
        notesColumnName
          ? `Create QC column "${columnName}" with notes "${notesColumnName}"`
          : `Create QC column "${columnName}"`,
        sqlStatements
      );

      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      setTables((prev) =>
        prev.map((table) =>
          table.tableName === activeTable
            ? { ...table, schema: newSchema }
            : table
        )
      );
      const addedColumns = notesColumnName ? [columnName, notesColumnName] : [columnName];
      setViewState((prev) => ({
        ...prev,
        visibleColumns: addedColumns.reduce(
          (acc, col) => (acc.includes(col) ? acc : [...acc, col]),
          prev.visibleColumns
        ),
        columnOrder: addedColumns.reduce(
          (acc, col) => (acc.includes(col) ? acc : [...acc, col]),
          prev.columnOrder
        ),
      }));
      setSchemaVersion((v) => v + 1);
      setDataVersion((v) => v + 1);
      setResetKey((k) => k + 1);
    },
    [activeTable, markQcTableDirty, recordHistoryEntry, schema]
  );

  const handleQcCellChange = useCallback(
    async (rowId: number, value: string | null) => {
      if (!activeTable || !activeQcSession || activeQcSession.done) return;
      const nextValue = value === "" ? null : value;
      const tableName = activeTable;
      const sessionAtClick = activeQcSession;
      const previousValue = sessionAtClick.valuesByRowId[String(rowId)];
      const hadPreviousValue = previousValue !== undefined;
      const qcFilterActive = filterReferencesColumn(viewState.filters, sessionAtClick.columnName);

      setQcSessions((prev) => {
        const session = prev[tableName];
        if (!session || session.done) return prev;
        const valuesByRowId = { ...session.valuesByRowId };
        if (nextValue === null) {
          delete valuesByRowId[String(rowId)];
        } else {
          valuesByRowId[String(rowId)] = nextValue;
        }
        return {
          ...prev,
          [tableName]: { ...session, valuesByRowId },
        };
      });

      const sql = `UPDATE ${escapeIdent(tableName)} SET ${escapeIdent(sessionAtClick.columnName)} = ${sqlLiteral(nextValue, sessionAtClick.valueType)} WHERE rowid = ${rowId}`;
      try {
        await window.api.exec(sql);
        markQcTableDirty(tableName);
      } catch (err) {
        console.error("QC cell update failed:", err);
        setQcSessions((prev) => {
          const session = prev[tableName];
          if (!session || session.done) return prev;
          const valuesByRowId = { ...session.valuesByRowId };
          if (hadPreviousValue) {
            valuesByRowId[String(rowId)] = previousValue;
          } else {
            delete valuesByRowId[String(rowId)];
          }
          return {
            ...prev,
            [tableName]: { ...session, valuesByRowId },
          };
        });
        return;
      }

      if (qcFilterActive) {
        setDataVersion((v) => v + 1);
      }
    },
    [activeTable, activeQcSession, markQcTableDirty, viewState.filters]
  );

  const handleQcNoteChange = useCallback(
    async (rowId: number, value: string | null) => {
      if (!activeTable || !activeQcSession || activeQcSession.done) return;
      const notesColumn = activeQcSession.notesColumnName;
      if (!notesColumn) return;
      const nextValue = value === null || value === "" ? null : value;
      const tableName = activeTable;
      const previousValue = activeQcSession.notesByRowId[String(rowId)];
      const hadPreviousValue = previousValue !== undefined;
      const notesFilterActive = filterReferencesColumn(viewState.filters, notesColumn);

      setQcSessions((prev) => {
        const session = prev[tableName];
        if (!session || session.done) return prev;
        // Keep cleared notes staged as "" so the grid does not fall back to the cached row value
        const notesByRowId = { ...session.notesByRowId, [String(rowId)]: nextValue ?? "" };
        return {
          ...prev,
          [tableName]: { ...session, notesByRowId },
        };
      });

      const sql = `UPDATE ${escapeIdent(tableName)} SET ${escapeIdent(notesColumn)} = ${sqlLiteral(nextValue, "text")} WHERE rowid = ${rowId}`;
      try {
        await window.api.exec(sql);
        markQcTableDirty(tableName);
      } catch (err) {
        console.error("QC note update failed:", err);
        setQcSessions((prev) => {
          const session = prev[tableName];
          if (!session || session.done) return prev;
          const notesByRowId = { ...session.notesByRowId };
          if (hadPreviousValue) {
            notesByRowId[String(rowId)] = previousValue;
          } else {
            delete notesByRowId[String(rowId)];
          }
          return {
            ...prev,
            [tableName]: { ...session, notesByRowId },
          };
        });
        return;
      }

      if (notesFilterActive) {
        setDataVersion((v) => v + 1);
      }
    },
    [activeTable, activeQcSession, markQcTableDirty, viewState.filters]
  );

  const handleQcResetAll = useCallback(
    async () => {
      if (!activeTable || !activeQcSession || activeQcSession.done) return;
      const setParts = [`${escapeIdent(activeQcSession.columnName)} = NULL`];
      if (activeQcSession.notesColumnName) {
        setParts.push(`${escapeIdent(activeQcSession.notesColumnName)} = NULL`);
      }
      const sql = `UPDATE ${escapeIdent(activeTable)} SET ${setParts.join(", ")}`;
      await window.api.exec(sql);
      markQcTableDirty(activeTable);
      setQcSessions((prev) => {
        const session = prev[activeTable];
        if (!session || session.done) return prev;
        return {
          ...prev,
          [activeTable]: { ...session, valuesByRowId: {}, notesByRowId: {} },
        };
      });
      setDataVersion((v) => v + 1);
    },
    [activeTable, activeQcSession, markQcTableDirty]
  );

  const handleQcMarkDone = useCallback(
    async () => {
      if (!activeTable || !activeQcSession || activeQcSession.done) return;
      const batchSql = buildQcBatchUpdateSql(activeTable, activeQcSession);
      const notesBatchSql = buildQcNotesBatchUpdateSql(activeTable, activeQcSession);
      setQcSessions((prev) => {
        const session = prev[activeTable];
        if (!session || session.done) return prev;
        return {
          ...prev,
          [activeTable]: { ...session, done: true },
        };
      });
      const batchStatements = [batchSql, notesBatchSql].filter((sql): sql is string => !!sql);
      if (batchStatements.length > 0) {
        recordHistoryEntry(activeTable, "data_op", `Complete QC for "${activeQcSession.columnName}"`, batchStatements);
      }
      setDataVersion((v) => v + 1);
    },
    [activeTable, activeQcSession, recordHistoryEntry]
  );

  const handleQcResume = useCallback(() => {
    if (!activeTable || !activeQcSession?.done) return;
    setQcSessions((prev) => {
      const session = prev[activeTable];
      if (!session?.done) return prev;
      return {
        ...prev,
        [activeTable]: { ...session, done: false },
      };
    });
  }, [activeTable, activeQcSession]);

  const handleQcStartNew = useCallback(() => {
    if (!activeTable || !activeQcSession?.done) return;
    const completedColumn = activeQcSession.columnName;
    setQcSessions((prev) => {
      const session = prev[activeTable];
      if (!session?.done) return prev;
      const { [activeTable]: _completed, ...rest } = prev;
      return rest;
    });
    setViewState((prev) => ({
      ...prev,
      filters: removeColumnFilters(prev.filters, completedColumn),
    }));
    setQcPanelRequestKey((key) => key + 1);
    setFilterPanelOpen(true);
    setResetKey((key) => key + 1);
  }, [activeTable, activeQcSession]);

  const handleQcQuickFilter = useCallback(
    (value: string | null | "__all__") => {
      if (!activeQcSession) return;
      setViewState((prev) => ({
        ...prev,
        filters: addColumnFilter(
          prev.filters,
          activeQcSession.columnName,
          value,
          schema.find((column) => column.column_name === activeQcSession.columnName)?.column_type
        ),
      }));
      setResetKey((k) => k + 1);
    },
    [activeQcSession, schema]
  );

  // ── Saved Views callbacks ──

  const handleSaveView = useCallback((name: string) => {
    if (!activeTable) return;
    const id = `view_${savedViewNextId}`;
    setSavedViewNextId((n) => n + 1);
    const now = Date.now();
    const newView: SavedView = {
      id,
      name,
      tableName: activeTable,
      viewState: JSON.parse(JSON.stringify(viewState)),
      createdAt: now,
      updatedAt: now,
    };
    setSavedViews((prev) => [...prev, newView]);
  }, [activeTable, viewState, savedViewNextId]);

  const handleApplyView = useCallback((view: SavedView) => {
    const vs: ViewState = JSON.parse(JSON.stringify(view.viewState));
    // Silently filter visible columns and column order to what exists in current schema
    const currentCols = new Set(schema.map((c) => c.column_name));
    vs.columnOrder = vs.columnOrder.filter((c) => currentCols.has(c));
    vs.visibleColumns = vs.visibleColumns.filter((c) => currentCols.has(c));
    // If columnOrder is empty after filtering, fall back to current schema order
    if (vs.columnOrder.length === 0) {
      vs.columnOrder = schema.map((c) => c.column_name);
      vs.visibleColumns = [...vs.columnOrder];
    }
    setViewState(vs);
    setResetKey((k) => k + 1);
  }, [schema]);

  const handleUpdateView = useCallback((viewId: string) => {
    setSavedViews((prev) =>
      prev.map((v) =>
        v.id === viewId
          ? { ...v, viewState: JSON.parse(JSON.stringify(viewState)), updatedAt: Date.now() }
          : v
      )
    );
  }, [viewState]);

  const handleDeleteView = useCallback((viewId: string) => {
    setSavedViews((prev) => prev.filter((v) => v.id !== viewId));
  }, []);

  const handleRenameView = useCallback((viewId: string, newName: string) => {
    setSavedViews((prev) =>
      prev.map((v) =>
        v.id === viewId ? { ...v, name: newName, updatedAt: Date.now() } : v
      )
    );
  }, []);

  // Data operation: run SQL to transform columns/rows
  const handleDataOperation = useCallback(
    async (sql: string, description?: string) => {
      if (!activeTable) return;
      try {
        await window.api.exec(sql);
        recordHistoryEntry(activeTable, "data_op", description || "Data operation", [sql]);
        setSchemaVersion((v) => v + 1);
        setDataVersion((v) => v + 1);
        setResetKey((k) => k + 1);

        // Refresh schema (operations like remove_duplicates use CREATE OR REPLACE)
        const newSchema = await window.api.describe(activeTable);
        setSchema(newSchema);

        // Update row count in tables state
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${activeTable}"`
        );
        setTables((prev) =>
          prev.map((t) =>
            t.tableName === activeTable
              ? { ...t, rowCount: Number(countResult[0].count) }
              : t
          )
        );
      } catch (err) {
        console.error("Data operation error:", err);
      }
    },
    [activeTable, recordHistoryEntry]
  );

  // Sample table: create a new table with a random sample of rows
  const handleSampleTable = useCallback(
    async (n: number, isPercent: boolean) => {
      if (!activeTable) return;
      try {
        const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
        const sampleName = nextSampleName(existingNames);
        const sampleClause = isPercent ? `${n} PERCENT (reservoir)` : `${n} ROWS`;
        await window.api.exec(
          `CREATE TABLE "${sampleName}" AS SELECT * FROM "${activeTable}" USING SAMPLE ${sampleClause}`
        );
        const desc = await window.api.describe(sampleName);
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${sampleName}"`
        );
        const sampleTable: LoadedTable = {
          tableName: sampleName,
        filePath: "(sample)",
          schema: desc,
          rowCount: Number(countResult[0].count),
        };

        setTables((prev) => [...prev, sampleTable]);
        initializeTableHistory(sampleTable);
        setActiveTable(sampleName);
        setViewState((prev) => ({
          ...prev,
          filters: { logic: "AND", children: [] },
          visibleColumns: [],
          columnOrder: [],
          sortColumns: [],
        }));
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error("Sample table error:", err);
      }
    },
    [activeTable, initializeTableHistory]
  );

  // Create aggregate table from a SELECT SQL
  const handleCreateAggregateTable = useCallback(
    async (sql: string) => {
      try {
        const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
        const aggName = nextAggregateName(existingNames);

        await window.api.exec(
          `CREATE TABLE "${aggName}" AS ${sql}`
        );
        const desc = await window.api.describe(aggName);
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${aggName}"`
        );
        const aggTable: LoadedTable = {
          tableName: aggName,
          filePath: "(aggregate)",
          schema: desc,
          rowCount: Number(countResult[0].count),
        };

        setTables((prev) => [...prev, aggTable]);
        initializeTableHistory(aggTable);
        setActiveTable(aggName);
        setViewState((prev) => ({
          ...prev,
          filters: { logic: "AND", children: [] },
          visibleColumns: [],
          columnOrder: [],
          sortColumns: [],
        }));
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error("Aggregate table error:", err);
      }
    },
    [initializeTableHistory]
  );

  // Create pivot table from a PIVOT SQL
  const handleCreatePivotTable = useCallback(
    async (sql: string) => {
      try {
        const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
        const pivotName = nextPivotName(existingNames);

        await window.api.exec(
          `CREATE TABLE "${pivotName}" AS (${sql})`
        );
        const desc = await window.api.describe(pivotName);
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${pivotName}"`
        );
        const pivotTable: LoadedTable = {
          tableName: pivotName,
          filePath: "(pivot)",
          schema: desc,
          rowCount: Number(countResult[0].count),
        };

        setTables((prev) => [...prev, pivotTable]);
        initializeTableHistory(pivotTable);
        setActiveTable(pivotName);
        setViewState((prev) => ({
          ...prev,
          filters: { logic: "AND", children: [] },
          visibleColumns: [],
          columnOrder: [],
          sortColumns: [],
        }));
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error("Pivot table error:", err);
      }
    },
    [initializeTableHistory]
  );

  // Lookup merge: join data from another table into the active table
  const handleLookupMerge = useCallback(
    async (sql: string, options: { replaceActive: boolean }) => {
      if (!activeTable) return;
      try {
        if (options.replaceActive) {
          const execSql = `CREATE OR REPLACE TABLE ${escapeIdent(activeTable)} AS (${sql})`;
          await window.api.exec(execSql);
          recordHistoryEntry(activeTable, "data_op", "Lookup merge (replace active)", [execSql]);
          const countResult = await window.api.query(
            `SELECT COUNT(*) as count FROM ${escapeIdent(activeTable)}`
          );
          setTables((prev) =>
            prev.map((t) =>
              t.tableName === activeTable
                ? { ...t, rowCount: Number(countResult[0].count) }
                : t
            )
          );
          setSchemaVersion((v) => v + 1);
          setResetKey((k) => k + 1);
        } else {
          const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
          const mergeName = nextMergeName(existingNames);
          await window.api.exec(
            `CREATE TABLE ${escapeIdent(mergeName)} AS (${sql})`
          );
          const desc = await window.api.describe(mergeName);
          const countResult = await window.api.query(
            `SELECT COUNT(*) as count FROM ${escapeIdent(mergeName)}`
          );
          const mergeTable: LoadedTable = {
            tableName: mergeName,
            filePath: "(merge)",
            schema: desc,
            rowCount: Number(countResult[0].count),
          };
          setTables((prev) => [...prev, mergeTable]);
          initializeTableHistory(mergeTable);
          setActiveTable(mergeName);
          setViewState((prev) => ({
            ...prev,
            filters: { logic: "AND", children: [] },
            visibleColumns: [],
            columnOrder: [],
            sortColumns: [],
          }));
          setResetKey((k) => k + 1);
        }
      } catch (err) {
        console.error("Lookup merge error:", err);
        throw err;
      }
    },
    [activeTable, initializeTableHistory, recordHistoryEntry]
  );

  // ── Column Ops handlers ──

  const chooseUndoStrategy = useCallback(
    async (rowCount: number, numColumns: number): Promise<UndoStrategy> => {
      try {
        const freeMemBytes = await window.api.getFreeMemory();
        const estimatedTableSize = rowCount * numColumns * 100;
        if (estimatedTableSize > freeMemBytes * 0.15) return "snapshot";
      } catch (_) { /* fallback to per-step */ }
      return "per-step";
    },
    []
  );

  const handleColOpApply = useCallback(
    async (opType: ColOpType, column: string, params: Record<string, string>) => {
      if (!activeTable) return;

      const currentTable = activeTable;
      const isFirstOp = colOpsSteps.length === 0;

      // Determine strategy on first op
      let strategy = undoStrategy;
      if (isFirstOp) {
        const tableInfo = tables.find((t) => t.tableName === currentTable);
        const rowCount = tableInfo?.rowCount ?? 0;
        const numCols = schema.length;
        strategy = await chooseUndoStrategy(rowCount, numCols);
        setUndoStrategy(strategy);
      }

      const stepId = colOpsNextId;
      let backupName = "";
      const renameTarget = opType === "rename_column" ? params.newName?.trim() : undefined;

      if (opType === "rename_column") {
        if (!renameTarget || renameTarget === column || schema.some((c) => c.column_name === renameTarget && c.column_name !== column)) return;
      }
      if (opType === "delete_column" && schema.length <= 1) return;

      try {
        if (strategy === "per-step") {
          backupName = `__colops_backup_${stepId}_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${backupName}" AS SELECT * FROM "${currentTable}"`
          );
        } else if (strategy === "snapshot" && isFirstOp) {
          const snapshotName = `__colops_snapshot_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${snapshotName}" AS SELECT * FROM "${currentTable}"`
          );
        }

        // Collect SQL statements for history
        const executedSql: string[] = [];
        let targetMode: "replace" | "new_column" | "existing_column" = "replace";
        let targetColumn: string | undefined;
        let description: string;

        if (opType === "rename_column") {
          const cols = schema
            .map((c) => c.column_name === column ? `${escapeIdent(c.column_name)} AS ${escapeIdent(renameTarget!)}` : escapeIdent(c.column_name))
            .join(", ");
          const sql = `CREATE OR REPLACE TABLE ${escapeIdent(currentTable)} AS SELECT ${cols} FROM ${escapeIdent(currentTable)}`;
          await window.api.exec(sql);
          executedSql.push(sql);
          description = buildStepDescription(opType, column, params, renameTarget);
        } else if (opType === "delete_column") {
          const otherCols = schema
            .filter((c) => c.column_name !== column)
            .map((c) => escapeIdent(c.column_name))
            .join(", ");
          const sql = `CREATE OR REPLACE TABLE ${escapeIdent(currentTable)} AS SELECT ${otherCols} FROM ${escapeIdent(currentTable)}`;
          await window.api.exec(sql);
          executedSql.push(sql);
          description = buildStepDescription(opType, column, params);
        } else {
          // Determine target column from params (backward compatible)
          targetMode = (params.targetMode as "replace" | "new_column" | "existing_column") || "replace";
          targetColumn = targetMode === "replace" ? undefined : params.targetColumn;

          // Determine column type for new_column mode
          // extract_numbers with integer/float in "first" mode produces numeric types
          const extractNumType = opType === "extract_numbers" && params.mode !== "all"
            ? params.numberType ?? "any"
            : null;
          const newColType = extractNumType === "integer" ? "BIGINT"
            : extractNumType === "float" ? "DOUBLE"
            : "VARCHAR";

          // For "new_column" mode, add the column first
          if (targetMode === "new_column" && targetColumn) {
            const addColSql = `ALTER TABLE "${currentTable}" ADD COLUMN "${targetColumn}" ${newColType}`;
            await window.api.exec(addColSql);
            executedSql.push(addColSql);
          }

          // If the operation produces string output, ensure the target column is VARCHAR
          const STRING_OPS: Set<ColOpType> = new Set([
            "prefix_suffix", "find_replace", "regex_extract", "upper", "lower", "trim", "assign_value",
            "empty_to_null", "placeholder_to_null",
          ]);
          // extract_numbers in "all" mode or "any" type also produces string output
          const isStringOp = STRING_OPS.has(opType)
            || (opType === "extract_numbers" && (params.mode === "all" || (params.numberType ?? "any") === "any"));
          if (isStringOp) {
            // For "existing_column" mode, promote the target column; otherwise promote the source column
            const colToPromote = (targetMode === "existing_column" && targetColumn) ? targetColumn : column;
            const colInfo = schema.find((c) => c.column_name === colToPromote);
            const colType = colInfo?.column_type?.toUpperCase() ?? "";
            // Skip promotion for new_column (already set to correct type)
            if (targetMode !== "new_column" && colType && !colType.startsWith("VARCHAR") && colType !== "TEXT" && colType !== "STRING") {
              const alterSql = `ALTER TABLE "${currentTable}" ALTER COLUMN "${colToPromote}" TYPE VARCHAR`;
              await window.api.exec(alterSql);
              executedSql.push(alterSql);
            }
          }

          // Execute the UPDATE
          const sql = buildColOpUpdateSQL(currentTable, column, opType, params, viewState.filters, targetColumn);
          await window.api.exec(sql);
          executedSql.push(sql);
          description = buildStepDescription(opType, column, params, targetColumn);
        }

        // Record step
        const step: ColOpStep = {
          id: stepId,
          opType,
          column,
          description,
          backupTable: backupName,
          timestamp: Date.now(),
        };

        setColOpsSteps((prev) => [...prev, step]);
        setColOpsNextId((prev) => prev + 1);
        setDataVersion((v) => v + 1);
        setResetKey((k) => k + 1);

        // Record in global history
        recordHistoryEntry(currentTable, "col_op", description, executedSql);

        // Refresh schema (column type may have changed from ALTER)
        const newSchema = await window.api.describe(currentTable);
        setSchema(newSchema);
        setTables((prev) =>
          prev.map((t) =>
            t.tableName === currentTable
              ? { ...t, schema: newSchema }
              : t
          )
        );

        if (opType === "rename_column" && renameTarget) {
          setViewState((prev) => renameColumnInViewState(prev, column, renameTarget));
        } else if (opType === "delete_column") {
          setViewState((prev) => deleteColumnFromViewState(prev, column));
        } else if (targetMode === "new_column" && targetColumn) {
          setViewState((prev) => ({
            ...prev,
            visibleColumns: prev.visibleColumns.includes(targetColumn) ? prev.visibleColumns : [...prev.visibleColumns, targetColumn],
            columnOrder: prev.columnOrder.includes(targetColumn) ? prev.columnOrder : [...prev.columnOrder, targetColumn],
          }));
        }

      } catch (err) {
        // If backup was created but UPDATE failed, drop the backup
        if (backupName) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${backupName}"`); } catch (_) { /* ignore */ }
        }
        throw err;
      }
    },
    [activeTable, colOpsSteps, undoStrategy, colOpsNextId, viewState.filters, tables, schema, chooseUndoStrategy, recordHistoryEntry]
  );

  const handleColOpUndo = useCallback(
    async () => {
      if (!activeTable || colOpsSteps.length === 0) return;
      const lastStep = colOpsSteps[colOpsSteps.length - 1];
      if (!lastStep.backupTable) return;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${lastStep.backupTable}" RENAME TO "${activeTable}"`);

      setColOpsSteps((prev) => prev.slice(0, -1));
      setDataVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, schema: newSchema }
            : t
        )
      );
      const allCols = newSchema.map((c: ColumnInfo) => c.column_name);
      setViewState((prev) => ({
        ...prev,
        filters: isSchemaColOp(lastStep.opType) ? { logic: "AND", children: [] } : prev.filters,
        visibleColumns: allCols,
        columnOrder: allCols,
        sortColumns: isSchemaColOp(lastStep.opType) ? [] : prev.sortColumns,
        pivotConfig: isSchemaColOp(lastStep.opType) ? null : prev.pivotConfig,
      }));
    },
    [activeTable, colOpsSteps]
  );

  const handleColOpRevertAll = useCallback(
    async () => {
      if (!activeTable || colOpsSteps.length === 0) return;
      const snapshotName = `__colops_snapshot_${activeTable}`;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${snapshotName}" RENAME TO "${activeTable}"`);

      setColOpsSteps([]);
      setColOpsNextId(1);
      setUndoStrategy("per-step");
      setDataVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, schema: newSchema }
            : t
        )
      );
      const allCols = newSchema.map((c: ColumnInfo) => c.column_name);
      const hadSchemaOps = colOpsSteps.some((step) => isSchemaColOp(step.opType));
      setViewState((prev) => ({
        ...prev,
        filters: hadSchemaOps ? { logic: "AND", children: [] } : prev.filters,
        visibleColumns: allCols,
        columnOrder: allCols,
        sortColumns: hadSchemaOps ? [] : prev.sortColumns,
        pivotConfig: hadSchemaOps ? null : prev.pivotConfig,
      }));
    },
    [activeTable, colOpsSteps]
  );

  const handleColOpClearAll = useCallback(
    async () => {
      if (!activeTable) return;

      // Drop all backup tables
      for (const step of colOpsSteps) {
        if (step.backupTable) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
        }
      }
      // Drop snapshot if exists
      try { await window.api.exec(`DROP TABLE IF EXISTS "__colops_snapshot_${activeTable}"`); } catch (_) { /* ignore */ }

      setColOpsSteps([]);
      setColOpsNextId(1);
      setUndoStrategy("per-step");
    },
    [activeTable, colOpsSteps]
  );

  // ── Row Ops handlers ──

  const handleRowOpApply = useCallback(
    async (opType: RowOpType, params: Record<string, string>) => {
      if (!activeTable) return;

      const currentTable = activeTable;
      const isFirstOp = rowOpsSteps.length === 0;

      // Determine strategy on first op
      let strategy = rowOpsUndoStrategy;
      if (isFirstOp) {
        const tableInfo = tables.find((t) => t.tableName === currentTable);
        const rowCount = tableInfo?.rowCount ?? 0;
        const numCols = schema.length;
        strategy = await chooseUndoStrategy(rowCount, numCols);
        setRowOpsUndoStrategy(strategy);
      }

      const stepId = rowOpsNextId;
      let backupName = "";

      try {
        if (strategy === "per-step") {
          backupName = `__rowops_backup_${stepId}_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${backupName}" AS SELECT * FROM "${currentTable}"`
          );
        } else if (strategy === "snapshot" && isFirstOp) {
          const snapshotName = `__rowops_snapshot_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${snapshotName}" AS SELECT * FROM "${currentTable}"`
          );
        }

        // Execute the row operation SQL
        const sql = buildRowOpSQL(currentTable, opType, params, viewState.filters, schema);
        await window.api.exec(sql);

        // Record step
        const description = buildRowOpStepDescription(opType, params);
        const step: RowOpStep = {
          id: stepId,
          opType,
          description,
          backupTable: backupName,
          timestamp: Date.now(),
        };

        setRowOpsSteps((prev) => [...prev, step]);
        setRowOpsNextId((prev) => prev + 1);
        setDataVersion((v) => v + 1);
        setResetKey((k) => k + 1);

        // Record in global history
        recordHistoryEntry(currentTable, "row_op", description, [sql]);

        // Refresh schema (remove_duplicates uses CREATE OR REPLACE)
        const newSchema = await window.api.describe(currentTable);
        setSchema(newSchema);

        // Update row count in tables state
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${currentTable}"`
        );
        setTables((prev) =>
          prev.map((t) =>
            t.tableName === currentTable
              ? { ...t, rowCount: Number(countResult[0].count) }
              : t
          )
        );
      } catch (err) {
        // If backup was created but operation failed, drop the backup
        if (backupName) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${backupName}"`); } catch (_) { /* ignore */ }
        }
        throw err;
      }
    },
    [activeTable, rowOpsSteps, rowOpsUndoStrategy, rowOpsNextId, viewState.filters, tables, schema, chooseUndoStrategy, recordHistoryEntry]
  );

  const handleRowOpUndo = useCallback(
    async () => {
      if (!activeTable || rowOpsSteps.length === 0) return;
      const lastStep = rowOpsSteps[rowOpsSteps.length - 1];
      if (!lastStep.backupTable) return;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${lastStep.backupTable}" RENAME TO "${activeTable}"`);

      setRowOpsSteps((prev) => prev.slice(0, -1));
      setDataVersion((v) => v + 1);
      setSchemaVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${activeTable}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    [activeTable, rowOpsSteps]
  );

  const handleRowOpRevertAll = useCallback(
    async () => {
      if (!activeTable || rowOpsSteps.length === 0) return;
      const snapshotName = `__rowops_snapshot_${activeTable}`;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${snapshotName}" RENAME TO "${activeTable}"`);

      setRowOpsSteps([]);
      setRowOpsNextId(1);
      setRowOpsUndoStrategy("per-step");
      setDataVersion((v) => v + 1);
      setSchemaVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${activeTable}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    [activeTable, rowOpsSteps]
  );

  const handleRowOpClearAll = useCallback(
    async () => {
      if (!activeTable) return;

      // Drop all backup tables
      for (const step of rowOpsSteps) {
        if (step.backupTable) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
        }
      }
      // Drop snapshot if exists
      try { await window.api.exec(`DROP TABLE IF EXISTS "__rowops_snapshot_${activeTable}"`); } catch (_) { /* ignore */ }

      setRowOpsSteps([]);
      setRowOpsNextId(1);
      setRowOpsUndoStrategy("per-step");
    },
    [activeTable, rowOpsSteps]
  );

  // ── History revert / export / import ──

  const handleRevertToEntry = useCallback(
    async (tableName: string, entryId: number, onProgress?: (step: number, total: number, description: string) => void) => {
      const history = tableHistoriesRef.current.get(tableName);
      if (!history) throw new Error("No history for this table");
      if (history.sourceInfo.isGenerated) throw new Error("Cannot revert generated tables");

      const { filePath, importOptions } = history.sourceInfo;

      // Check file exists
      const exists = await window.api.fileExists(filePath);
      if (!exists) throw new Error(`Source file not found at "${filePath}"`);

      onProgress?.(0, 0, "Re-reading source file...");

      // Drop current table
      await window.api.exec(`DROP TABLE IF EXISTS "${tableName}"`);

      // Re-read the file
      const result = await window.api.loadFile(filePath, tableName, importOptions);
      if (result.error) throw new Error(`Failed to re-load file: ${result.error}`);

      // Validate schema: check that all initial columns are present
      const loadedColNames = new Set((result.schema as ColumnInfo[]).map((c: ColumnInfo) => c.column_name));
      const missingCols = history.initialSchema
        .map((c) => c.column_name)
        .filter((name) => !loadedColNames.has(name));
      if (missingCols.length > 0) {
        throw new Error(`Source file schema changed. Missing columns: ${missingCols.join(", ")}`);
      }

      // Determine which entries to replay
      const entriesToReplay = entryId === -1
        ? [] // revert to original = no replay
        : history.entries.filter((e) => e.id <= entryId);

      // Replay SQL statements in order
      for (let i = 0; i < entriesToReplay.length; i++) {
        const entry = entriesToReplay[i];
        onProgress?.(i + 1, entriesToReplay.length, entry.description);
        for (const sql of entry.sqlStatements) {
          try {
            await window.api.exec(sql);
          } catch (err) {
            throw new Error(`Replay failed at step ${i + 1} ("${entry.description}"): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Trim history entries after the revert point, update timestamps to now
      const now = Date.now();
      setTableHistories((prev) => {
        const h = prev.get(tableName);
        if (!h) return prev;
        const next = new Map(prev);
        const kept = entryId === -1
          ? []
          : h.entries
              .filter((e) => e.id <= entryId)
              .map((e) => ({ ...e, timestamp: now }));
        next.set(tableName, {
          ...h,
          entries: kept,
          nextEntryId: entryId === -1 ? 1 : entryId + 1,
        });
        return next;
      });

      // Clear existing undo state (backup tables are gone)
      setColOpsSteps([]);
      setColOpsNextId(1);
      setUndoStrategy("per-step");
      setRowOpsSteps([]);
      setRowOpsNextId(1);
      setRowOpsUndoStrategy("per-step");

      // Refresh schema and data
      setSchemaVersion((v) => v + 1);
      setDataVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(tableName);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === tableName
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    []
  );

  const handleExportHistory = useCallback(async () => {
    const filePath = await window.api.saveFileDialog("json");
    if (!filePath) return;
    const exportData: HistoryExportData = {
      version: 1,
      exportedAt: Date.now(),
      tables: Array.from(tableHistoriesRef.current.values()),
    };
    await window.api.writeJsonFile(filePath, exportData);
  }, []);

  const handleImportHistory = useCallback(async () => {
    const data = await window.api.readJsonFile();
    if (!data || data.error) return;
    const imported = data as HistoryExportData;
    if (imported.version !== 1 || !Array.isArray(imported.tables)) return;

    const currentTableNames = new Set(tablesRef.current.map((t) => t.tableName));
    let merged = 0;
    let skipped = 0;

    setTableHistories((prev) => {
      const next = new Map(prev);
      for (const th of imported.tables) {
        if (currentTableNames.has(th.tableName)) {
          next.set(th.tableName, th);
          merged++;
        } else {
          skipped++;
        }
      }
      return next;
    });

    console.log(`History import: ${merged} table(s) merged, ${skipped} skipped (tables not found)`);
  }, []);

  const finishQcClose = useCallback(async () => {
    if (quitEntireAppRef.current) {
      await window.api.requestAppQuit();
      return;
    }
    allowWindowCloseRef.current = true;
    await getCurrentWindow().close();
  }, []);

  const handleDiscardQcAndClose = useCallback(async () => {
    const cleared = new Set<string>();
    qcDirtyTablesRef.current = cleared;
    setQcDirtyTables(cleared);
    setQcQuitPromptOpen(false);
    await window.api.setQcDirty(false);
    await finishQcClose();
  }, [finishQcClose]);

  const handleSaveQcBeforeClose = useCallback(() => {
    const nextTable = Array.from(qcDirtyTablesRef.current)[0];
    if (!nextTable) {
      setQcQuitPromptOpen(false);
      void finishQcClose();
      return;
    }

    if (activeTableRef.current !== nextTable) {
      setActiveTable(nextTable);
      setComparisonConfig(null);
      setFilterPanelOpen(false);
      setViewState((prev) => ({
        ...prev,
        filters: { logic: "AND", children: [] },
        visibleColumns: [],
        columnOrder: [],
        sortColumns: [],
        pivotConfig: null,
      }));
      setResetKey((key) => key + 1);
    }

    closeAfterQcExportRef.current = true;
    setCloseAfterQcExport(true);
    setQcQuitPromptOpen(false);
    setExportDialogOpen(true);
  }, [finishQcClose]);

  const handleQcExported = useCallback(async (tableNames: string[], fullData: boolean) => {
    if (!fullData) return;

    const remaining = new Set(qcDirtyTablesRef.current);
    for (const tableName of tableNames) remaining.delete(tableName);
    qcDirtyTablesRef.current = remaining;
    setQcDirtyTables(remaining);

    if (!closeAfterQcExportRef.current) return;
    closeAfterQcExportRef.current = false;
    setCloseAfterQcExport(false);

    if (remaining.size > 0) {
      setQcQuitPromptOpen(true);
      return;
    }

    await window.api.setQcDirty(false);
    await finishQcClose();
  }, [finishQcClose]);

  const handleExportDialogClose = useCallback(() => {
    setExportDialogOpen(false);
    if (!closeAfterQcExportRef.current) return;
    closeAfterQcExportRef.current = false;
    setCloseAfterQcExport(false);
    quitEntireAppRef.current = false;
  }, []);

  const handleCancelQcQuit = useCallback(() => {
    setQcQuitPromptOpen(false);
    quitEntireAppRef.current = false;
  }, []);

  const hasData = tables.length > 0;
  const dirtyQcFileNames = Array.from(qcDirtyTables)
    .map((tableName) => tables.find((table) => table.tableName === tableName))
    .filter((table): table is LoadedTable => !!table)
    .map(getDisplayFileName);
  const activeDisplayFileName = activeLoadedTable ? getDisplayFileName(activeLoadedTable) : null;
  const activeFileReloadWarning = documentWorkspaceActive
    ? (documentFileActions?.isDirty ? "Your unsaved edits will be replaced." : null)
    : (colOpsSteps.length > 0 || rowOpsSteps.length > 0 || (activeTable ? qcDirtyTables.has(activeTable) : false)
      ? "Re-importing discards column ops, row ops, and QC values on this table."
      : null);
  const fileDragClass = fileDragState === "idle" ? "" : ` file-drag-${fileDragState}`;
  const usesMacTitlebarOverlay = isTauri()
    && typeof navigator !== "undefined"
    && /Mac/i.test(navigator.platform);

  useEffect(() => {
    const nextTitle = activeDisplayFileName
      ? `Chikku Parser - ${activeDisplayFileName}`
      : "Chikku Parser";
    document.title = nextTitle;
    if (!isTauri()) return;

    getCurrentWindow()
      .setTitle(nextTitle)
      .catch((err) => console.warn("Failed to set window title", err));
  }, [activeDisplayFileName]);

  useEffect(() => {
    const handleHelpShortcut = (event: KeyboardEvent) => {
      if (event.key !== "F1") return;
      event.preventDefault();
      setHelpCenterOpen(true);
    };
    window.addEventListener("keydown", handleHelpShortcut);
    return () => window.removeEventListener("keydown", handleHelpShortcut);
  }, []);

  return (
    <div className={`app-container${darkMode ? " bp4-dark dark-theme" : ""}${fileDragClass}`}>
      {fileDragState !== "idle" && (
        <div className="file-drop-overlay" aria-hidden="true">
          <div className="file-drop-target">
            <Icon
              icon={fileDragState === "supported" ? "document-open" : "warning-sign"}
              size={26}
            />
            <span>
              {fileDragState === "supported" ? "Import or refresh" : "Unsupported file type"}
            </span>
          </div>
        </div>
      )}
      {usesMacTitlebarOverlay && (
        <div className="app-window-titlebar" data-tauri-drag-region="">
          <div className="app-window-titlebar-name" data-tauri-drag-region="">
            Chikku Parser
          </div>
          <div
            className="app-window-titlebar-file"
            data-tauri-drag-region=""
            title={activeDisplayFileName ?? undefined}
          >
            {activeDisplayFileName ?? ""}
          </div>
        </div>
      )}
      <div className="main-layout">
        <div className={`sidebar-shell${sidebarVisible ? " sidebar-shell-open" : " sidebar-shell-collapsed"}${documentWorkspaceActive ? " sidebar-shell-document" : ""}${jsonWorkspaceActive ? " sidebar-shell-json" : ""}${pdfWorkspaceActive ? " sidebar-shell-pdf" : ""}`}>
          <div className="sidebar-shell-panel" aria-hidden={!sidebarVisible}>
            <Sidebar
              tables={tables}
              activeTable={activeTable}
              schema={schema}
              visibleColumns={viewState.visibleColumns}
              columnOrder={viewState.columnOrder}
              sortColumns={viewState.sortColumns}
              onSort={handleSort}
              onClearSort={handleClearSort}
              pivotConfig={viewState.pivotConfig}
              onPivotGroup={handlePivotGroup}
              onClearPivotGroups={handleClearPivotGroups}
              onSelectTable={(name) => {
                setActiveTable(name);
                setComparisonConfig(null);
                setFilterPanelOpen(false);
                setViewState((prev) => ({
                  ...prev,
                  filters: { logic: "AND", children: [] },
                  visibleColumns: [],
                  columnOrder: [],
                  sortColumns: [],
                  pivotConfig: null,
                }));
                setResetKey((k) => k + 1);
              }}
              onToggleColumn={toggleColumn}
              onSetVisibleColumns={(cols: string[]) => {
                setViewState((prev) => ({ ...prev, visibleColumns: cols }));
                setResetKey((k) => k + 1);
              }}
              onReorderColumns={reorderColumns}
              onDataOperation={handleDataOperation}
              onSampleTable={handleSampleTable}
              onDeleteTable={handleDeleteTable}
              onCombine={handleCombineOpen}
              onCreateAggregateTable={handleCreateAggregateTable}
              onCreatePivotTable={handleCreatePivotTable}
              onLookupMerge={handleLookupMerge}
              onCompareTables={handleStartComparison}
              onExport={() => setExportDialogOpen(true)}
              onOpenHistory={() => setHistoryDialogOpen(true)}
              onOpenFiles={handleChooseFiles}
              onOpenHelp={() => setHelpCenterOpen(true)}
              onHide={() => setSidebarVisible(false)}
              onOpenOverview={handleOpenDatasetOverview}
              onGetDatasetOverview={handleGetDatasetOverview}
              onGetOverviewTopValues={handleGetOverviewTopValues}
              jsonWorkspaceActive={jsonWorkspaceActive}
              markdownWorkspaceActive={markdownWorkspaceActive}
              pdfWorkspaceActive={pdfWorkspaceActive}
              documentFileActions={documentFileActions}
              onPdfNavigationHostChange={setPdfNavigationHost}
            />
          </div>
          <div className="sidebar-shell-strip" aria-hidden={sidebarVisible}>
            <div className="sidebar-collapsed">
              <Button
                icon="chevron-right"
                minimal
                small
                onClick={() => setSidebarVisible(true)}
                title="Show sidebar"
              />
              <Button
                icon="help"
                minimal
                small
                onClick={() => setHelpCenterOpen(true)}
                title="Open Help Center (F1)"
                aria-label="Open Help Center"
              />
            </div>
          </div>
        </div>
        <div className="data-area">
          {hasData ? (
            <>
              {watchedFilePath && (activeFileChanged || activeFileMissing) ? (
                <FileChangedBanner
                  fileName={activeDisplayFileName ?? watchedFilePath}
                  missing={activeFileMissing}
                  reloading={reloadingActiveFile}
                  warning={activeFileReloadWarning}
                  onReload={handleReloadChangedFile}
                  onDismiss={resyncActiveFileWatch}
                />
              ) : null}
              {jsonWorkspaceActive && activeLoadedTable ? (
                <JsonWorkspace
                  table={activeLoadedTable}
                  sourceTables={tables.filter((loadedTable) => !loadedTable.filePath.startsWith("(") && !isDocumentWorkspaceFilePath(loadedTable.filePath))}
                  jsonTables={tables.filter((loadedTable) => !loadedTable.filePath.startsWith("(") && isJsonFilePath(loadedTable.filePath))}
                  onOpenFiles={handleChooseFiles}
                  onReloadTable={handleReloadActiveDocument}
                  onFileActionsChange={setDocumentFileActions}
                />
              ) : markdownWorkspaceActive && activeLoadedTable ? (
                <MarkdownWorkspace
                  table={activeLoadedTable}
                  onOpenFiles={handleChooseFiles}
                  onReloadTable={handleReloadActiveDocument}
                  onFileActionsChange={setDocumentFileActions}
                />
              ) : pdfWorkspaceActive && activeLoadedTable ? (
                <PdfWorkspace
                  table={activeLoadedTable}
                  pageAppearance={pdfPageAppearances[activeLoadedTable.filePath] ?? DEFAULT_PDF_PAGE_APPEARANCE}
                  onPageAppearanceChange={(appearance) => handlePdfPageAppearanceChange(activeLoadedTable.filePath, appearance)}
                  onOpenFiles={handleChooseFiles}
                  onPageCountChange={handleActivePdfPageCountChange}
                  onFileActionsChange={setDocumentFileActions}
                  navigationHost={pdfNavigationHost}
                />
              ) : comparisonActive && comparisonConfig && activeTable ? (
                <ComparisonView
                  tables={tables}
                  baseTableName={activeTable}
                  baseSchema={schema}
                  config={comparisonConfig}
                  dataVersion={dataVersion}
                  filterPanelOpen={filterPanelOpen}
                  filterPanelMounted={filterPanelMounted}
                  onConfigChange={setComparisonConfig}
                  onFilterPanelOpenChange={setFilterPanelOpen}
                  onExit={() => {
                    setComparisonConfig(null);
                    setFilterPanelOpen(false);
                  }}
                  onOpenFiles={handleChooseFiles}
                />
              ) : (
                <>
                  {pivotActive && viewState.pivotConfig && (
                    <PivotToolbar
                      pivotConfig={viewState.pivotConfig}
                      onExpandAll={pivotExpandAll}
                      onCollapseAll={pivotCollapseAll}
                      onToggleGrandTotal={handleToggleGrandTotal}
                      onDefaultAggChange={handleDefaultAggChange}
                      onExitPivot={handleClearPivotGroups}
                    />
                  )}
                  {activeQcSession && !comparisonActive && !documentWorkspaceActive && (
                    <QcSessionBar
                      session={activeQcSession}
                      totalRows={activeLoadedTable?.rowCount ?? 0}
                      onQuickFilter={handleQcQuickFilter}
                      onResetAll={handleQcResetAll}
                      onMarkDone={handleQcMarkDone}
                      onResume={handleQcResume}
                      onStartNew={handleQcStartNew}
                    />
                  )}
                  <DataGrid
                    totalRows={pivotActive ? pivotFlatRows.length : totalRows}
                    getRow={pivotActive ? () => null : getRow}
                    ensureRange={pivotActive ? pivotEnsureRange : ensureRange}
                    columns={viewState.visibleColumns}
                    sortColumns={viewState.sortColumns}
                    onSort={handleSort}
                    onReorderColumns={pivotActive ? undefined : reorderVisibleColumns}
                    resetKey={resetKey}
                    pivotMode={pivotActive}
                    pivotFlatRows={pivotActive ? pivotFlatRows : undefined}
                    pivotGroupColumns={pivotActive ? viewState.pivotConfig?.groupColumns : undefined}
                    onToggleExpand={pivotActive ? pivotToggleExpand : undefined}
                    grandTotals={pivotActive ? pivotGrandTotals : undefined}
                    showGrandTotal={pivotActive ? viewState.pivotConfig?.showGrandTotal : undefined}
                    pivotAggFunction={pivotActive ? viewState.pivotConfig?.defaultAggFunction : undefined}
                    numericColumns={pivotActive ? numericColumns : undefined}
                    columnTypes={columnTypes}
                    onGetColumnStats={pivotActive ? undefined : handleGetColumnStats}
                    onGetColumnUniques={pivotActive ? undefined : handleGetColumnUniques}
                    colOpsSteps={colOpsSteps}
                    undoStrategy={undoStrategy}
                    onColOpApply={handleColOpApply}
                    onColOpUndo={handleColOpUndo}
                    groupSortMode={pivotActive ? viewState.pivotConfig?.groupSortMode : undefined}
                    groupSortDirection={pivotActive ? viewState.pivotConfig?.groupSortDirection : undefined}
                    onGroupSort={pivotActive ? handleGroupSort : undefined}
                    displayDecimalPlaces={displayDecimalPlaces}
                    minDisplayDecimalPlaces={MIN_DISPLAY_DECIMAL_PLACES}
                    maxDisplayDecimalPlaces={MAX_DISPLAY_DECIMAL_PLACES}
                    onDisplayDecimalPlacesChange={handleDisplayDecimalPlacesChange}
                    tableFontSize={tableFontSize}
                    minTableFontSize={MIN_TABLE_FONT_SIZE}
                    maxTableFontSize={MAX_TABLE_FONT_SIZE}
                    defaultTableFontSize={DEFAULT_TABLE_FONT_SIZE}
                    onTableFontSizeChange={handleTableFontSizeChange}
                    qcSession={pivotActive ? null : activeQcSession}
                    onQcCellChange={handleQcCellChange}
                    onQcNoteChange={handleQcNoteChange}
                    rangeRefreshKey={pivotActive ? pivotCacheGeneration : cacheGeneration}
                    queryStatus={pivotActive ? (pivotLoading ? "loading" : "ready") : chunkQueryStatus}
                    queryError={pivotActive
                      ? (pivotQueryError ? { scope: "pivot", message: pivotQueryError } : null)
                      : chunkQueryError}
                    onQueryRetry={pivotActive ? retryPivotQuery : retryChunkQuery}
                    linkPreviewsEnabled={linkPreviewsEnabled}
                  />
                  {filterPanelMounted && (
                    <FilterPanel
                      columns={schema}
                      activeFilters={viewState.filters}
                      activeTable={activeTable}
                      onApplyFilters={handleFiltersChange}
                      colOpsSteps={colOpsSteps}
                      undoStrategy={undoStrategy}
                      onColOpApply={handleColOpApply}
                      onColOpUndo={handleColOpUndo}
                      onColOpRevertAll={handleColOpRevertAll}
                      onColOpClearAll={handleColOpClearAll}
                      rowOpsSteps={rowOpsSteps}
                      rowOpsUndoStrategy={rowOpsUndoStrategy}
                      onRowOpApply={handleRowOpApply}
                      onRowOpUndo={handleRowOpUndo}
                      onRowOpRevertAll={handleRowOpRevertAll}
                      onRowOpClearAll={handleRowOpClearAll}
                      totalRows={totalRows}
                      unfilteredRows={
                        hasActiveFilters(viewState.filters)
                          ? tables.find((t) => t.tableName === activeTable)?.rowCount ?? null
                          : null
                      }
                      savedViews={savedViews}
                      currentViewState={viewState}
                      onSaveView={handleSaveView}
                      onApplyView={handleApplyView}
                      onUpdateView={handleUpdateView}
                      onDeleteView={handleDeleteView}
                      onRenameView={handleRenameView}
                      onClose={() => setFilterPanelOpen(false)}
                      motionState={filterPanelOpen ? "open" : "closing"}
                      qcSession={activeQcSession}
                      qcFocusRequest={qcPanelRequestKey}
                      onQcFocusHandled={handleQcFocusHandled}
                      onQcCreate={handleQcCreate}
                      onQcResetAll={handleQcResetAll}
                      onQcMarkDone={handleQcMarkDone}
                      onQcResume={handleQcResume}
                      onQcStartNew={handleQcStartNew}
                      onQcQuickFilter={handleQcQuickFilter}
                    />
                  )}
                </>
              )}
            </>
          ) : (
            <div className="welcome">
              <div className="welcome-content">
                <div className="welcome-mark" aria-hidden="true">
                  <Icon icon="th" size={22} />
                </div>
                <div className="welcome-copy">
                  <span className="welcome-kicker">No files loaded</span>
                  <h2>Open a data file</h2>
                  <p>CSV, TSV, Excel, JSON, Markdown, PDF, and Parquet files are ready to load.</p>
                </div>
                <div className="welcome-actions">
                  <Button
                    intent={Intent.PRIMARY}
                    icon="folder-open"
                    text="Open data files"
                    large
                    onClick={handleChooseFiles}
                  />
                  <Button
                    icon="add"
                    text="Add multiple files"
                    large
                    onClick={handleChooseFiles}
                  />
                  <Button
                    icon="help"
                    text="How Chikku works"
                    large
                    minimal
                    onClick={() => setHelpCenterOpen(true)}
                  />
                </div>
                <div className="welcome-path">
                  <div className="welcome-path-item">
                    <Icon icon="document-open" size={13} />
                    <span>Import</span>
                  </div>
                  <div className="welcome-path-line" />
                  <div className="welcome-path-item">
                    <Icon icon="column-layout" size={13} />
                    <span>Clean</span>
                  </div>
                  <div className="welcome-path-line" />
                  <div className="welcome-path-item">
                    <Icon icon="export" size={13} />
                    <span>Export</span>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {!documentWorkspaceActive && (
        <StatusBar
          totalRows={
            comparisonActive
              ? activeLoadedTable?.rowCount ?? 0
              : pivotActive
                ? (tables.find((t) => t.tableName === activeTable)?.rowCount ?? 0)
                : totalRows
          }
          unfilteredRows={
            !comparisonActive && hasActiveFilters(viewState.filters)
              ? tables.find((t) => t.tableName === activeTable)?.rowCount ?? null
              : null
          }
          activeTable={activeTable}
          pivotConfig={comparisonActive ? null : viewState.pivotConfig}
          groupCount={pivotActive ? pivotGroupCount : 0}
          filterPanelOpen={filterPanelOpen}
          onToggleFilterPanel={() => setFilterPanelOpen((v) => !v)}
          activeFilterCount={
            comparisonActive && comparisonConfig
              ? countConditions(comparisonConfig.filters)
              : countConditions(viewState.filters)
          }
          sidebarVisible={sidebarVisible}
          updateNotice={<UpdateNotice />}
        />
      )}
      <CombineDialog
        isOpen={combineDialogOpen}
        tables={tables.filter(
          (t) => combineTableNames.includes(t.tableName)
        )}
        onClose={() => setCombineDialogOpen(false)}
        onCombine={handleCombineExecute}
      />
      <HelpCenter
        isOpen={helpCenterOpen}
        onClose={() => setHelpCenterOpen(false)}
      />
      <ExportDialog
        isOpen={exportDialogOpen}
        onClose={handleExportDialogClose}
        onExported={handleQcExported}
        tables={sqlBackedTables}
        activeTable={sqlBackedTables.some((table) => table.tableName === activeTable) ? activeTable : null}
        viewState={viewState}
        schema={schema}
        forceFullData={closeAfterQcExport}
      />
      <Dialog
        isOpen={qcQuitPromptOpen}
        onClose={handleCancelQcQuit}
        title="Save QC changes?"
        style={{ width: 460 }}
      >
        <div className={Classes.DIALOG_BODY}>
          <p>
            {dirtyQcFileNames.length === 1
              ? `Your QC changes to “${dirtyQcFileNames[0]}” have not been saved to a file.`
              : `${dirtyQcFileNames.length} files have QC changes that have not been saved.`}
          </p>
          <p>Save before {quitEntireAppRef.current ? "quitting" : "closing this window"}?</p>
        </div>
        <div className={Classes.DIALOG_FOOTER}>
          <div className={Classes.DIALOG_FOOTER_ACTIONS}>
            <Button text="Cancel" onClick={handleCancelQcQuit} />
            <Button text="Don’t Save" intent={Intent.DANGER} onClick={() => { void handleDiscardQcAndClose(); }} />
            <Button text="Save File…" intent={Intent.PRIMARY} icon="floppy-disk" onClick={handleSaveQcBeforeClose} />
          </div>
        </div>
      </Dialog>
      <HistoryDialog
        isOpen={historyDialogOpen}
        onClose={() => setHistoryDialogOpen(false)}
        tables={tables}
        activeTable={activeTable}
        histories={tableHistories}
        onRevertToEntry={handleRevertToEntry}
        onExportHistory={handleExportHistory}
        onImportHistory={handleImportHistory}
      />
      {pendingExcelImport && (
        <ExcelSheetPickerDialog
          isOpen={true}
          fileName={pendingExcelImport.fileName}
          sheets={pendingExcelImport.sheets}
          onClose={() => {
            const { otherFiles, replace, remainingFiles, refreshExisting } = pendingExcelImport;
            setPendingExcelImport(null);
            // Skip this Excel file, continue with remaining files or finalize already-loaded tables
            if (remainingFiles.length > 0) {
              void loadFiles(remainingFiles, false, otherFiles, replace, refreshExisting);
            } else if (otherFiles.length > 0) {
              void finalizeLoadedTables(otherFiles, replace, otherFiles[0].tableName, refreshExisting);
            }
          }}
          onImport={handleExcelSheetImport}
        />
      )}
      {pendingRetry && (
        <ImportRetryDialog
          isOpen={true}
          filePath={pendingRetry.filePath}
          errorMessage={pendingRetry.errorMessage}
          onClose={() => {
            const { otherFiles, replace, remainingFiles, refreshExisting } = pendingRetry;
            setPendingRetry(null);
            // Skip this file, continue with remaining files or finalize already-loaded tables
            if (remainingFiles.length > 0) {
              void loadFiles(remainingFiles, false, otherFiles, replace, refreshExisting);
            } else if (otherFiles.length > 0) {
              void finalizeLoadedTables(otherFiles, replace, otherFiles[0].tableName, refreshExisting);
            }
          }}
          onRetry={handleRetryImport}
        />
      )}
    </div>
  );
}
