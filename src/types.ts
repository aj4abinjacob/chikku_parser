import type { DbApi } from "../app/preload";

declare global {
  interface Window {
    api: DbApi;
  }
}

export interface ColumnInfo {
  column_name: string;
  column_type: string;
  null: string;
  key: string | null;
  default: string | null;
  extra: string | null;
}

export interface LoadedTable {
  tableName: string;
  filePath: string;
  schema: ColumnInfo[];
  rowCount: number;
  importOptions?: ImportOptions;
}

export interface ColumnOperation {
  type: "regex_extract" | "replace_regex" | "substring" | "trim" | "upper" | "lower" | "custom_sql" | "create_column" | "delete_column" | "combine_columns" | "rename_column" | "sample_table" | "remove_duplicates";
  sourceColumn: string;
  targetColumn: string; // new column name, or same as source to replace
  params: Record<string, string>;
}

export interface FilterCondition {
  column: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "NOT LIKE" | "IS NULL" | "IS NOT NULL" | "CONTAINS" | "IN" | "STARTS WITH" | "NOT STARTS WITH" | "ENDS WITH" | "NOT ENDS WITH";
  value: string;
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

export function extractFilterColumns(group: FilterGroup): Set<string> {
  const cols = new Set<string>();
  for (const child of group.children) {
    if (isFilterGroup(child)) {
      for (const c of extractFilterColumns(child)) cols.add(c);
    } else {
      if (child.column) cols.add(child.column);
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

export type PivotAggFunction = "SUM" | "COUNT" | "AVG" | "MIN" | "MAX" | "MEDIAN" | "COUNT_DISTINCT" | "COUNT_NULL";

export interface PivotViewConfig {
  groupColumns: PivotGroupColumn[];
  showGrandTotal: boolean;
  defaultAggFunction: PivotAggFunction;
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
  | "extract_numbers" | "trim" | "upper" | "lower" | "clear_null" | "prefix_suffix";

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
