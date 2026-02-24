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
  type: "extract_number" | "replace_regex" | "substring" | "trim" | "upper" | "lower" | "custom_sql";
  sourceColumn: string;
  targetColumn: string; // new column name, or same as source to replace
  params: Record<string, string>;
}

export interface FilterCondition {
  column: string;
  operator: "=" | "!=" | ">" | "<" | ">=" | "<=" | "LIKE" | "NOT LIKE" | "IS NULL" | "IS NOT NULL" | "CONTAINS" | "IN";
  value: string;
}

export interface ColumnMapping {
  id: string;
  outputColumn: string;
  inputColumns: string[];
}

export interface ViewState {
  visibleColumns: string[];
  columnOrder: string[];
  filters: FilterCondition[];
  sortColumn: string | null;
  sortDirection: "ASC" | "DESC";
}
