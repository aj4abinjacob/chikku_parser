declare global {
  interface Window {
    api: DbApi;
  }
}

export interface DbApi {
  loadCSV: (filePath: string, tableName: string) => Promise<any>;
  loadFile: (filePath: string, tableName: string, options?: ImportOptions) => Promise<any>;
  getExcelSheets: (filePath: string) => Promise<SheetInfo[]>;
  query: (sql: string) => Promise<any[]>;
  exec: (sql: string) => Promise<boolean>;
  describe: (tableName: string) => Promise<any[]>;
  tables: () => Promise<any[]>;
  exportCSV: (sql: string, filePath: string) => Promise<boolean>;
  exportFile: (sql: string, filePath: string, format: string) => Promise<boolean>;
  exportExcelMulti: (sheets: { sheetName: string; sql: string }[], filePath: string) => Promise<boolean>;
  saveDialog: () => Promise<string | null>;
  saveFileDialog: (format: string) => Promise<string | null>;
  openDataFileDialog: () => Promise<string[] | null>;
  openPdfImageDialog: () => Promise<{ filePath: string; bytes: Uint8Array } | null>;
  getFreeMemory: () => Promise<number>;
  getRegexPatterns: () => Promise<RegexPattern[]>;
  saveUserPattern: (pattern: RegexPattern) => Promise<boolean>;
  deleteUserPattern: (patternId: string) => Promise<boolean>;
  exportPatterns: () => Promise<boolean>;
  importPatterns: () => Promise<{ imported: number; error?: string }>;
  openExternal: (url: string) => Promise<void>;
  fetchLinkPreview: (url: string) => Promise<LinkPreviewMetadata>;
  writeJsonFile: (filePath: string, data: any) => Promise<boolean>;
  readJsonFile: () => Promise<any | null>;
  readTextFile: (filePath: string) => Promise<string>;
  writeTextFile: (filePath: string, contents: string) => Promise<boolean>;
  writeBinaryFile: (filePath: string, contents: Uint8Array) => Promise<boolean>;
  fileExists: (filePath: string) => Promise<boolean>;
  fileStat: (filePath: string) => Promise<FileStat>;
  allowPdfAsset: (filePath: string) => Promise<string>;
  openPdfExternally: (filePath: string) => Promise<boolean>;
  openOverviewWindow: (tableName: string, displayName: string) => Promise<string>;
  takeOverviewContext: () => Promise<OverviewWindowContext | null>;
  onOpenFiles: (callback: (filePaths: string[]) => void) => void;
  onAddFiles: (callback: (filePaths: string[]) => void) => void;
  onExportCSV: (callback: () => void) => void;
  onCheckForUpdates: (callback: () => void) => void;
  onSetDarkMode: (callback: (isDark: boolean) => void) => void;
  onSetLinkPreviewsEnabled: (callback: (enabled: boolean) => void) => void;
  onRequestQuit: (callback: () => void) => void;
  setQcDirty: (dirty: boolean) => Promise<void>;
  requestAppQuit: () => Promise<void>;
  syncTheme: (isDark: boolean) => void;
  syncLinkPreviewsEnabled: (enabled: boolean) => Promise<boolean>;
  getAppVersion: () => Promise<string>;
  checkForUpdate: () => Promise<AppUpdateInfo | null>;
  claimUpdateNotice: (version: string) => Promise<boolean>;
  releaseUpdateNotice: (version: string) => Promise<boolean>;
  installUpdate: (onProgress: (event: UpdateDownloadEvent) => void) => Promise<void>;
  restartApp: () => Promise<void>;
}

export interface FileStat {
  exists: boolean;
  modifiedMs: number | null;
  size: number | null;
}

export interface OverviewWindowContext {
  tableName: string;
  displayName: string;
}

export interface LinkPreviewMetadata {
  url: string;
  hostname: string;
  title: string;
  description?: string | null;
  imageDataUrl?: string | null;
  faviconDataUrl?: string | null;
}

export interface AppUpdateInfo {
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
}

export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number | null } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished"; data?: null };

export interface ColumnInfo {
  column_name: string;
  column_type: string;
  display_name?: string;
  null: string;
  key: string | null;
  default: string | null;
  extra: string | null;
}

export interface ColumnStatsTopValue {
  value: string;
  count: number;
}

export interface ColumnStatsUniqueValue {
  value: string;
  count: number;
}

export interface ColumnTextStats {
  minLength: number | null;
  maxLength: number | null;
  avgLength: number | null;
  emptyStringCount: number;
  leadingTrailingSpaceCount: number;
  caseVariantGroups: number;
  longValueCount: number;
}

export interface ColumnStats {
  column: string;
  columnType?: string;
  rowCount: number;
  totalRows: number;
  nullCount: number;
  uniqueCount: number;
  minValue: any;
  maxValue: any;
  avgValue?: number | null;
  medianValue?: number | null;
  textStats?: ColumnTextStats | null;
  topValues: ColumnStatsTopValue[];
}

export interface DatasetColumnOverview {
  column: string;
  columnType: string;
  missingCount: number;
  uniqueCount: number;
  minValue?: string | null;
  maxValue?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
}

export interface DatasetOverview {
  rowCount: number;
  totalRows: number;
  isFiltered: boolean;
  columns: DatasetColumnOverview[];
}

export const INTERNAL_ROW_ID_COLUMN = "__chikku_internal_rowid";
export const INTERNAL_ROW_ID_VALUE = Symbol("chikku-internal-rowid");

export type QcColumnMode = "boolean" | "options";
export type QcOptionSortMode = "alpha" | "numeric" | "entered";
export type QcValueType = "text" | "number";

export interface QcSession {
  columnName: string;
  mode: QcColumnMode;
  done: boolean;
  createdAt: number;
  valueType: QcValueType;
  trueValue: string;
  falseValue: string;
  options: string[];
  optionSortMode: QcOptionSortMode;
  valuesByRowId: Record<string, string>;
  notesColumnName: string | null;
  notesByRowId: Record<string, string>;
}

export interface QcCreateConfig {
  columnName: string;
  mode: QcColumnMode;
  trueValue: string;
  falseValue: string;
  options: string[];
  optionSortMode: QcOptionSortMode;
  notesEnabled: boolean;
  notesColumnName: string;
}

export interface LoadedTable {
  tableName: string;
  filePath: string;
  schema: ColumnInfo[];
  rowCount: number;
  importOptions?: ImportOptions;
  reloadVersion?: number;
}

export type DocumentWorkspaceKind = "json" | "markdown" | "pdf";

export interface DocumentWorkspaceFileActions {
  workspaceKind: DocumentWorkspaceKind;
  isDirty: boolean;
  isValid: boolean;
  isTableView?: boolean;
  saving: boolean;
  exporting?: boolean;
  exportingPdf?: boolean;
  exportingImages?: boolean;
  canExportCsv?: boolean;
  canExport?: boolean;
  canExportPdf?: boolean;
  canExportImages?: boolean;
  canCompare?: boolean;
  historyOpen?: boolean;
  onOpenFiles: () => void;
  onSave?: () => void | Promise<void>;
  onSaveAs?: () => void | Promise<void>;
  onRevert?: () => void;
  onToggleHistory?: () => void;
  onExportCsv?: () => void | Promise<void>;
  onExport?: () => void | Promise<void>;
  onExportPdf?: () => void | Promise<void>;
  onExportImages?: () => void | Promise<void>;
  onCompare?: () => void;
  saveLabel?: string;
  saveTitle?: string;
  exportLabel?: string;
  exportTitle?: string;
  exportDisabledReason?: string | null;
  exportPdfLabel?: string;
  exportPdfTitle?: string;
  exportPdfDisabledReason?: string | null;
  exportImagesLabel?: string;
  exportImagesTitle?: string;
  exportImagesDisabledReason?: string | null;
  compareTitle?: string;
  onToggleEdit?: () => void;
  editActive?: boolean;
  editLabel?: string;
}

export interface ColumnOperation {
  type: "regex_extract" | "replace_regex" | "substring" | "trim" | "upper" | "lower" | "custom_sql" | "create_column" | "delete_column" | "combine_columns" | "rename_column" | "sample_table" | "remove_duplicates";
  sourceColumn: string;
  targetColumn: string; // new column name, or same as source to replace
  params: Record<string, string>;
}

export type FilterOperator =
  | "="
  | "!="
  | ">"
  | "<"
  | ">="
  | "<="
  | "LIKE"
  | "NOT LIKE"
  | "IS NULL"
  | "IS NOT NULL"
  | "IS TRUE"
  | "IS FALSE"
  | "CONTAINS"
  | "DOES NOT CONTAIN"
  | "IN"
  | "NOT IN"
  | "STARTS WITH"
  | "NOT STARTS WITH"
  | "ENDS WITH"
  | "NOT ENDS WITH"
  | "EQUALS COLUMN"
  | "DOES NOT EQUAL COLUMN"
  | "EQUALS IGNORE CASE"
  | "DOES NOT EQUAL IGNORE CASE"
  | "IS SAME"
  | "IS DIFFERENT"
  | "IS MISSING"
  | "IS PRESENT";

export interface FilterCondition {
  column: string;
  operator: FilterOperator;
  value: string;
  values?: FilterListValue[];
  columnType?: string;
}

export interface FilterListValue {
  raw: string;
  label: string;
}

export interface FilterGroup {
  logic: "AND" | "OR";
  children: FilterNode[];
}

export type FilterNode = FilterCondition | FilterGroup;

export function isFilterGroup(node: FilterNode): node is FilterGroup {
  return "logic" in node && "children" in node;
}

export function hasActiveFilters(group: FilterGroup): boolean {
  return group.children.length > 0;
}

export function countConditions(group: FilterGroup): number {
  let count = 0;
  for (const child of group.children) {
    count += isFilterGroup(child) ? countConditions(child) : 1;
  }
  return count;
}

export function isColumnComparisonOperator(operator: FilterOperator): boolean {
  return operator === "EQUALS COLUMN" || operator === "DOES NOT EQUAL COLUMN";
}

export function extractFilterColumns(group: FilterGroup): Set<string> {
  const cols = new Set<string>();
  for (const child of group.children) {
    if (isFilterGroup(child)) {
      for (const c of extractFilterColumns(child)) cols.add(c);
    } else {
      if (child.column) cols.add(child.column);
      if (isColumnComparisonOperator(child.operator) && child.value) cols.add(child.value);
    }
  }
  return cols;
}

export interface ColumnMapping {
  id: string;
  outputColumn: string;
  inputColumns: string[];
}

export interface SortColumn {
  column: string;
  direction: "ASC" | "DESC";
}

export interface PivotGroupColumn {
  column: string;
  direction: "ASC" | "DESC";
}

export type PivotAggFunction = "LIST" | "SUM" | "COUNT" | "AVG" | "MIN" | "MAX" | "MEDIAN" | "COUNT_DISTINCT" | "COUNT_NULL";

export type PivotGroupSortMode = "alpha" | "count";

export interface PivotViewConfig {
  groupColumns: PivotGroupColumn[];
  showGrandTotal: boolean;
  defaultAggFunction: PivotAggFunction;
  groupSortMode?: PivotGroupSortMode | null;
  groupSortDirection?: "ASC" | "DESC";
}

export interface PivotFlatRow {
  key: string;
  type: "group" | "data";
  depth: number;
  groupColumn?: string;
  groupValue?: any;
  groupCount?: number;
  aggregates?: Record<string, any>;
  expanded?: boolean;
  data?: Record<string, any>;
  parentPath: { column: string; value: any }[];
}

export interface ViewState {
  visibleColumns: string[];
  columnOrder: string[];
  filters: FilterGroup;
  sortColumns: SortColumn[];
  pivotConfig: PivotViewConfig | null;
}

export type ComparisonViewMode = "all" | "pairs" | "differences";
export type ComparisonSaveNameMode = "suffix" | "prefix";

export interface ComparisonKeyPair {
  id: string;
  baseColumn: string;
  compareColumn: string;
}

export interface ComparisonColumnPair {
  id: string;
  baseColumn: string;
  compareColumn: string;
}

export interface ComparisonTableConfig {
  id: string;
  tableName: string;
  keyPairs: ComparisonKeyPair[];
  columnPairs: ComparisonColumnPair[];
}

export interface ComparisonViewConfig {
  baseTable: string;
  compareTables: ComparisonTableConfig[];
  viewMode: ComparisonViewMode;
  filters: FilterGroup;
  freezeKeys: boolean;
  includeCompareOnlyRows?: boolean;
  saveNameMode: ComparisonSaveNameMode;
  saveAffix: string;
}

export type FileFormat = "csv" | "tsv" | "json" | "parquet" | "xlsx" | "xls";

export interface ImportOptions {
  csvDelimiter?: string;
  csvIgnoreErrors?: boolean;
  excelSheet?: string;
}

export interface SheetInfo {
  name: string;
  rowCount: number;
}

export type ColOpType = "assign_value" | "find_replace" | "regex_extract"
  | "extract_numbers" | "trim" | "upper" | "lower" | "clear_null" | "prefix_suffix"
  | "empty_to_null" | "placeholder_to_null"
  | "rename_column" | "delete_column";

export type ColOpTargetMode = "replace" | "new_column" | "existing_column";

export type UndoStrategy = "per-step" | "snapshot";

export interface ColOpStep {
  id: number;
  opType: ColOpType;
  column: string;
  description: string;
  backupTable: string;   // only used in per-step mode
  timestamp: number;
}

export type RowOpType = "delete_filtered" | "keep_filtered" | "remove_empty" | "remove_duplicates";

export interface RowOpStep {
  id: number;
  opType: RowOpType;
  description: string;
  backupTable: string;   // only used in per-step mode
  timestamp: number;
}

export interface RegexPattern {
  id: string;
  title: string;
  pattern: string;
  description: string;
  category?: string;
  isBuiltin: boolean;
}

export interface SavedView {
  id: string;
  name: string;
  tableName: string;
  viewState: ViewState;
  createdAt: number;
  updatedAt: number;
}

export type HistoryOpSource = "col_op" | "row_op" | "data_op";

export interface HistoryEntry {
  id: number;
  source: HistoryOpSource;
  description: string;
  timestamp: number;
  sqlStatements: string[];
}

export interface TableSourceInfo {
  filePath: string;
  importOptions?: ImportOptions;
  isGenerated: boolean;
}

export interface TableHistory {
  tableName: string;
  sourceInfo: TableSourceInfo;
  initialSchema: ColumnInfo[];
  entries: HistoryEntry[];
  nextEntryId: number;
}

export interface HistoryExportData {
  version: 1;
  exportedAt: number;
  tables: TableHistory[];
}

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;
