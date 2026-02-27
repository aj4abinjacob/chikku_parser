import { RowOpType, FilterGroup, ColumnInfo } from "../types";
import { escapeIdent, buildFilterGroupClause } from "./sqlBuilder";

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
      return `DELETE FROM ${table} WHERE NOT (${filterClause})`;
    }

    case "remove_empty": {
      // Delete rows where all selected columns are NULL/empty
      const columns: string[] = params.columns ? JSON.parse(params.columns) : [];
      const cols = columns.length > 0
        ? columns.map((c) => schema.find((s) => s.column_name === c)).filter(Boolean) as ColumnInfo[]
        : schema;

      if (cols.length === 0) throw new Error("No columns selected");

      const conditions = cols.map((col) => {
        const ident = escapeIdent(col.column_name);
        const colType = col.column_type.toUpperCase();
        const isVarchar = colType.startsWith("VARCHAR") || colType === "TEXT" || colType === "STRING";
        if (isVarchar) {
          return `(${ident} IS NULL OR TRIM(CAST(${ident} AS VARCHAR)) = '')`;
        }
        return `${ident} IS NULL`;
      });

      let sql = `DELETE FROM ${table} WHERE ${conditions.join(" AND ")}`;

      // Scope by active filter if present
      if (filterClause) {
        sql = `DELETE FROM ${table} WHERE (${filterClause}) AND (${conditions.join(" AND ")})`;
      }

      return sql;
    }

    case "remove_duplicates": {
      // Deduplicate rows using QUALIFY row_number()
      const columns: string[] = params.columns ? JSON.parse(params.columns) : [];
      const cols = columns.length > 0 ? columns : schema.map((c) => c.column_name);

      if (cols.length === 0) throw new Error("No columns selected for deduplication");

      // Build cleaned CTE with NULLIF for VARCHAR columns
      const selectExprs = schema.map((col) => {
        const ident = escapeIdent(col.column_name);
        const colType = col.column_type.toUpperCase();
        const isVarchar = colType.startsWith("VARCHAR") || colType === "TEXT" || colType === "STRING";
        if (isVarchar) {
          return `NULLIF(TRIM(${ident}), '') AS ${ident}`;
        }
        return ident;
      });

      const partitionCols = cols.map((c) => escapeIdent(c)).join(", ");

      let whereClause = "";
      if (filterClause) {
        whereClause = `WHERE ${filterClause} `;
      }

      return `CREATE OR REPLACE TABLE ${table} AS WITH cleaned AS (SELECT ${selectExprs.join(", ")} FROM ${table} ${whereClause}) SELECT * FROM cleaned QUALIFY row_number() OVER (PARTITION BY ${partitionCols}) = 1`;
    }

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
      if (columns.length === 0) return "Removed empty rows (all columns)";
      if (columns.length <= 3) return `Removed empty rows (${columns.join(", ")})`;
      return `Removed empty rows (${columns.length} columns)`;
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
