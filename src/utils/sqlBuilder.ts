import { FilterCondition, FilterGroup, ViewState, isFilterGroup } from "../types";

/**
 * Escape a SQL identifier by doubling any embedded double quotes.
 * e.g. column"name → "column""name"
 */
export function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Build a SELECT query from view state against a given table.
 */
export function buildSelectQuery(
  tableName: string,
  viewState: ViewState
): string {
  const columns =
    viewState.visibleColumns.length > 0
      ? viewState.visibleColumns.map((c) => escapeIdent(c)).join(", ")
      : "*";

  let sql = `SELECT ${columns} FROM ${escapeIdent(tableName)}`;

  // WHERE clause from filters
  const whereClause = buildFilterGroupClause(viewState.filters);
  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }

  // ORDER BY
  if (viewState.sortColumn) {
    sql += ` ORDER BY ${escapeIdent(viewState.sortColumn)} ${viewState.sortDirection}`;
  }

  return sql;
}

function buildFilterClause(filter: FilterCondition): string {
  const col = escapeIdent(filter.column);

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

  if (filter.operator === "STARTS WITH") {
    return `CAST(${col} AS VARCHAR) LIKE '${val}%'`;
  }

  if (filter.operator === "NOT STARTS WITH") {
    return `CAST(${col} AS VARCHAR) NOT LIKE '${val}%'`;
  }

  if (filter.operator === "ENDS WITH") {
    return `CAST(${col} AS VARCHAR) LIKE '%${val}'`;
  }

  if (filter.operator === "NOT ENDS WITH") {
    return `CAST(${col} AS VARCHAR) NOT LIKE '%${val}'`;
  }

  if (filter.operator === "LIKE" || filter.operator === "NOT LIKE") {
    return `${col} ${filter.operator} '${val}'`;
  }

  return `${col} ${filter.operator} '${val}'`;
}

/**
 * Recursively build a WHERE clause from a FilterGroup (AND/OR tree).
 */
export function buildFilterGroupClause(group: FilterGroup): string {
  if (group.children.length === 0) return "";

  const parts: string[] = [];
  for (const child of group.children) {
    if (isFilterGroup(child)) {
      const nested = buildFilterGroupClause(child);
      if (nested) parts.push(`(${nested})`);
    } else {
      const clause = buildFilterClause(child);
      if (clause) parts.push(clause);
    }
  }

  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  return parts.join(` ${group.logic} `);
}

/**
 * Build a UNION ALL query to combine multiple tables.
 */
export function buildCombineQuery(tableNames: string[]): string {
  if (tableNames.length === 0) return "";
  if (tableNames.length === 1) return `SELECT * FROM ${escapeIdent(tableNames[0])}`;

  return tableNames
    .map((t) => `SELECT * FROM ${escapeIdent(t)}`)
    .join("\nUNION ALL\n");
}

/**
 * Build a column-mapped UNION ALL query.
 * For each table, selects mapped input columns AS their output names.
 * Uses NULL for columns not present in a given table.
 */
export function buildMappedCombineQuery(
  tables: { tableName: string; columnNames: string[]; columnTypes?: Map<string, string> }[],
  mappings: { outputColumn: string; inputColumns: string[] }[]
): string {
  if (tables.length === 0 || mappings.length === 0) return "";

  // Trim output column names to avoid accidental whitespace in identifiers
  const trimmedMappings = mappings.map((m) => ({
    ...m,
    outputColumn: m.outputColumn.trim(),
  }));

  // Determine if a mapping has type mismatches across tables — if so, cast all to VARCHAR
  const needsCast = new Map<number, boolean>();
  for (let mi = 0; mi < trimmedMappings.length; mi++) {
    const mapping = trimmedMappings[mi];
    const typesFound = new Set<string>();
    for (const table of tables) {
      const matched = mapping.inputColumns.find((ic) =>
        table.columnNames.includes(ic)
      );
      if (matched && table.columnTypes) {
        const colType = table.columnTypes.get(matched);
        if (colType) typesFound.add(colType.toUpperCase());
      }
    }
    needsCast.set(mi, typesFound.size > 1);
  }

  const selects = tables.map((table) => {
    const columns = trimmedMappings.map((mapping, mi) => {
      const matchedInput = mapping.inputColumns.find((ic) =>
        table.columnNames.includes(ic)
      );
      const outIdent = escapeIdent(mapping.outputColumn);
      if (matchedInput) {
        const inIdent = escapeIdent(matchedInput);
        if (needsCast.get(mi)) {
          return `CAST(${inIdent} AS VARCHAR) AS ${outIdent}`;
        }
        return `${inIdent} AS ${outIdent}`;
      } else {
        return `NULL AS ${outIdent}`;
      }
    });
    return `SELECT ${columns.join(", ")} FROM ${escapeIdent(table.tableName)}`;
  });

  return selects.join("\nUNION ALL\n");
}

/**
 * Build a query for a specific chunk of data (used by virtual scroll).
 */
export function buildChunkQuery(
  tableName: string,
  visibleColumns: string[],
  filters: FilterGroup,
  sortColumn: string | null,
  sortDirection: "ASC" | "DESC",
  chunkSize: number,
  chunkIndex: number
): string {
  const columns =
    visibleColumns.length > 0
      ? visibleColumns.map((c) => escapeIdent(c)).join(", ")
      : "*";

  let sql = `SELECT ${columns} FROM ${escapeIdent(tableName)}`;

  const whereClause = buildFilterGroupClause(filters);
  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }

  if (sortColumn) {
    sql += ` ORDER BY ${escapeIdent(sortColumn)} ${sortDirection}`;
  }

  sql += ` LIMIT ${chunkSize} OFFSET ${chunkIndex * chunkSize}`;
  return sql;
}

/**
 * Build a query for count.
 */
export function buildCountQuery(
  tableName: string,
  filters: FilterGroup
): string {
  let sql = `SELECT COUNT(*) as total FROM ${escapeIdent(tableName)}`;
  const whereClause = buildFilterGroupClause(filters);
  if (whereClause) {
    sql += ` WHERE ${whereClause}`;
  }
  return sql;
}
