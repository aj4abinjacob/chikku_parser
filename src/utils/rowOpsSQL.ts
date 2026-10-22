import { RowOpType, FilterGroup, ColumnInfo } from "../types";
import { escapeIdent, buildFilterGroupClause } from "./sqlBuilder";

function emptyRowPredicate(params: Record<string, string>, schema: ColumnInfo[]): string {
  const selected: string[] = params.columns ? JSON.parse(params.columns) : [];
  const columns = selected.length > 0 ? schema.filter((column) => selected.includes(column.column_name)) : schema;
  if (columns.length === 0) throw new Error("No columns selected");
  const conditions = columns.map((column) => {
    const ident = escapeIdent(column.column_name);
    return /^(VARCHAR|TEXT|STRING)/i.test(column.column_type)
      ? `(${ident} IS NULL OR TRIM(CAST(${ident} AS VARCHAR)) = '')` : `${ident} IS NULL`;
  });
  return `(${conditions.join(params.emptyMode === "any" ? " OR " : " AND ")})`;
}

/** The same result query drives deduplication and its removal-count preview. */
export function buildDeduplicatedRowsQuery(tableName: string, params: Record<string, string>, filters: FilterGroup, schema: ColumnInfo[]): string {
  const table = escapeIdent(tableName);
  const filter = buildFilterGroupClause(filters);
  const selected: string[] = params.columns ? JSON.parse(params.columns) : [];
  const columns = selected.length > 0 ? selected : schema.map((column) => column.column_name);
  if (columns.length === 0) throw new Error("No columns selected for deduplication");
  const selectColumns = schema.map((column) => escapeIdent(column.column_name)).join(", ");
  const cleanedColumns = schema.map((column) => {
    const ident = escapeIdent(column.column_name);
    return /^(VARCHAR|TEXT|STRING)/i.test(column.column_type) ? `NULLIF(TRIM(${ident}), '') AS ${ident}` : ident;
  }).join(", ");
  let rankName = "__chikku_dedup_rank";
  while (schema.some((column) => column.column_name.toLowerCase() === rankName.toLowerCase())) rankName += "_";
  const rank = escapeIdent(rankName);
  const cleaned = escapeIdent(tableName.toLowerCase() === "__chikku_cleaned_rows" ? "__chikku_cleaned_rows_2" : "__chikku_cleaned_rows");
  const ranked = escapeIdent(tableName.toLowerCase() === "__chikku_ranked_rows" ? "__chikku_ranked_rows_2" : "__chikku_ranked_rows");
  return `WITH ${cleaned} AS (SELECT ${cleanedColumns} FROM ${table}${filter ? ` WHERE ${filter}` : ""}), ${ranked} AS (SELECT *, row_number() OVER (PARTITION BY ${columns.map(escapeIdent).join(", ")}) AS ${rank} FROM ${cleaned}) SELECT ${selectColumns} FROM ${ranked} WHERE ${rank} = 1${filter ? ` UNION ALL SELECT ${selectColumns} FROM ${table} WHERE (${filter}) IS NOT TRUE` : ""}`;
}

export function buildRowOpPreviewQuery(tableName: string, opType: RowOpType, params: Record<string, string>, filters: FilterGroup, schema: ColumnInfo[]): string {
  const table = escapeIdent(tableName);
  const filter = buildFilterGroupClause(filters);
  if (opType === "remove_duplicates") {
    return `SELECT (SELECT COUNT(*) FROM ${table}) - COUNT(*) AS cnt FROM (${buildDeduplicatedRowsQuery(tableName, params, filters, schema)}) AS result`;
  }
  if ((opType === "delete_filtered" || opType === "keep_filtered") && !filter) throw new Error("Apply a filter first");
  const predicate = opType === "keep_filtered" ? `(${filter}) IS NOT TRUE`
    : opType === "delete_filtered" ? filter
    : `${filter ? `(${filter}) AND ` : ""}${emptyRowPredicate(params, schema)}`;
  return `SELECT COUNT(*) AS cnt FROM ${table} WHERE ${predicate}`;
}

/**
 * Build SQL for a row operation, optionally scoped by filters.
 */
export function buildRowOpSQL(
  tableName: string,
  opType: RowOpType,
  params: Record<string, string>,
  filters: FilterGroup,
  schema: ColumnInfo[]
): string {
  const table = escapeIdent(tableName);
  const filterClause = buildFilterGroupClause(filters);

  switch (opType) {
    case "delete_filtered": {
      // Delete rows matching the active filter
      if (!filterClause) throw new Error("No active filter — nothing to delete");
      return `DELETE FROM ${table} WHERE ${filterClause}`;
    }

    case "keep_filtered": {
      // Delete rows NOT matching the active filter
      if (!filterClause) throw new Error("No active filter — nothing to keep");
      return `DELETE FROM ${table} WHERE (${filterClause}) IS NOT TRUE`;
    }

    case "remove_empty": {
      const predicate = emptyRowPredicate(params, schema);
      return `DELETE FROM ${table} WHERE ${filterClause ? `(${filterClause}) AND ` : ""}${predicate}`;
    }

    case "remove_duplicates":
      return `CREATE OR REPLACE TABLE ${table} AS ${buildDeduplicatedRowsQuery(tableName, params, filters, schema)}`;

    default:
      throw new Error(`Unknown row operation type: ${opType}`);
  }
}

/**
 * Build a human-readable description for a row operation step.
 */
export function buildRowOpStepDescription(
  opType: RowOpType,
  params: Record<string, string>
): string {
  switch (opType) {
    case "delete_filtered":
      return "Deleted filtered rows";
    case "keep_filtered":
      return "Kept only filtered rows";
    case "remove_empty": {
      const columns: string[] = params.columns ? JSON.parse(params.columns) : [];
      const mode = params.emptyMode === "any" ? "any" : "all";
      const modeLabel = mode === "any" ? "any" : "all";
      if (columns.length === 0) return `Removed empty rows (${modeLabel} columns)`;
      if (columns.length <= 3) return `Removed empty rows [${modeLabel}] (${columns.join(", ")})`;
      return `Removed empty rows [${modeLabel}] (${columns.length} columns)`;
    }
    case "remove_duplicates": {
      const columns: string[] = params.columns ? JSON.parse(params.columns) : [];
      if (columns.length === 0) return "Removed duplicates (all columns)";
      if (columns.length <= 3) return `Removed duplicates (${columns.join(", ")})`;
      return `Removed duplicates (${columns.length} columns)`;
    }
    default:
      return `${opType}`;
  }
}
