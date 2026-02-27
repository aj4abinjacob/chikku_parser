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

export interface ColumnMapping {
  id: string;
  outputColumn: string;
  inputColumns: string[];
}

export interface ViewState {
  visibleColumns: string[];
  columnOrder: string[];
  filters: FilterGroup;
  sortColumn: string | null;
  sortDirection: "ASC" | "DESC";
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

export type UndoStrategy = "per-step" | "snapshot";

export interface ColOpStep {
  id: number;
  opType: ColOpType;
  column: string;
  description: string;
  backupTable: string;   // only used in per-step mode
  timestamp: number;
}

export const EXCEL_MAX_ROWS = 1_048_576;
export const EXCEL_MAX_COLS = 16_384;
