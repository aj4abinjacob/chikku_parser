import { FilterCondition, ViewState } from "../types";

/**
 * Build a SELECT query from view state against a given table.
 */
export function buildSelectQuery(
  tableName: string,
  viewState: ViewState
): string {
  const columns =
    viewState.visibleColumns.length > 0
      ? viewState.visibleColumns.map((c) => `"${c}"`).join(", ")
      : "*";

  let sql = `SELECT ${columns} FROM "${tableName}"`;

  // WHERE clause from filters
  const whereClauses = viewState.filters
    .map((f) => buildFilterClause(f))
    .filter(Boolean);

  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(" AND ")}`;
  }

  // ORDER BY
  if (viewState.sortColumn) {
    sql += ` ORDER BY "${viewState.sortColumn}" ${viewState.sortDirection}`;
  }

  // LIMIT / OFFSET
  sql += ` LIMIT ${viewState.limit}`;
  if (viewState.offset > 0) {
    sql += ` OFFSET ${viewState.offset}`;
  }

  return sql;
}

function buildFilterClause(filter: FilterCondition): string {
  const col = `"${filter.column}"`;

  if (filter.operator === "IS NULL") return `${col} IS NULL`;
  if (filter.operator === "IS NOT NULL") return `${col} IS NOT NULL`;

  // Escape single quotes in value
  const val = filter.value.replace(/'/g, "''");

  if (filter.operator === "CONTAINS") {
    // Case-insensitive regex match — supports plain text and regex patterns
    return `regexp_matches(CAST(${col} AS VARCHAR), '${val}', 'i')`;
  }

  if (filter.operator === "IN") {
    // Comma-separated list of values
    const items = filter.value
      .split(",")
      .map((v) => v.trim().replace(/'/g, "''"))
      .filter((v) => v.length > 0)
      .map((v) => `'${v}'`);
    if (items.length === 0) return "1=0";
    return `${col} IN (${items.join(", ")})`;
  }

  if (filter.operator === "LIKE" || filter.operator === "NOT LIKE") {
    return `${col} ${filter.operator} '${val}'`;
  }

  return `${col} ${filter.operator} '${val}'`;
}

/**
 * Build a UNION ALL query to combine multiple tables.
 */
export function buildCombineQuery(tableNames: string[]): string {
  if (tableNames.length === 0) return "";
  if (tableNames.length === 1) return `SELECT * FROM "${tableNames[0]}"`;

  return tableNames
    .map((t) => `SELECT * FROM "${t}"`)
    .join("\nUNION ALL\n");
}

/**
 * Build a column-mapped UNION ALL query.
 * For each table, selects mapped input columns AS their output names.
 * Uses NULL for columns not present in a given table.
 */
export function buildMappedCombineQuery(
  tables: { tableName: string; columnNames: string[] }[],
  mappings: { outputColumn: string; inputColumns: string[] }[]
): string {
  if (tables.length === 0 || mappings.length === 0) return "";

  const selects = tables.map((table) => {
    const columns = mappings.map((mapping) => {
      const matchedInput = mapping.inputColumns.find((ic) =>
        table.columnNames.includes(ic)
      );
      if (matchedInput) {
        return `"${matchedInput}" AS "${mapping.outputColumn}"`;
      } else {
        return `NULL AS "${mapping.outputColumn}"`;
      }
    });
    return `SELECT ${columns.join(", ")} FROM "${table.tableName}"`;
  });

  return selects.join("\nUNION ALL\n");
}

/**
 * Build a query for count (used for pagination).
 */
export function buildCountQuery(
  tableName: string,
  filters: FilterCondition[]
): string {
  let sql = `SELECT COUNT(*) as total FROM "${tableName}"`;
  const whereClauses = filters.map((f) => buildFilterClause(f)).filter(Boolean);
  if (whereClauses.length > 0) {
    sql += ` WHERE ${whereClauses.join(" AND ")}`;
  }
  return sql;
}
