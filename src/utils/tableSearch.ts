import { FilterGroup, TableSearchRequest } from "../types";
import { buildFilterGroupClause } from "./sqlBuilder";

export const TABLE_SEARCH_LIMIT = 100;
export const TABLE_SEARCH_MAX_COLUMNS = 200;
export const TABLE_SEARCH_MAX_TERM = 2048;

export interface TableSearchScope {
  tableName: string;
  displayName: string;
  filters: FilterGroup;
  dataVersion: number;
  schemaVersion?: number;
}

/** Monotonic for the lifetime of this webview, including dialog close/reopen. */
let latestRequestId = Date.now();
export class SearchRequestGate {
  private active: number | null = null;

  begin(): number {
    latestRequestId = Math.max(Date.now(), latestRequestId + 1);
    this.active = latestRequestId;
    return this.active;
  }

  isCurrent(requestId: number): boolean { return this.active === requestId; }

  invalidate(): number | null {
    const previous = this.active;
    this.active = null;
    return previous;
  }
}

export function buildTableSearchRequest(
  requestId: number,
  scope: TableSearchScope,
  visibleColumns: string[],
  selectedColumn: string,
  term: string
): TableSearchRequest {
  // Whitespace and SQL wildcard/regex characters are literal search text.
  if (!term.length || Array.from(term).length > TABLE_SEARCH_MAX_TERM) {
    throw new Error("Enter between 1 and 2,048 characters to search.");
  }
  const columns = selectedColumn ? visibleColumns.filter(column => column === selectedColumn) : [...visibleColumns];
  if (!columns.length) throw new Error("Show a column before searching.");
  if (columns.length > TABLE_SEARCH_MAX_COLUMNS) throw new Error("Choose a specific column when searching more than 200 visible columns.");
  return { requestId, tableName: scope.tableName, columns, term, filterSql: buildFilterGroupClause(scope.filters) };
}

export function tableSearchContextKey(scope: TableSearchScope | undefined, columns: string[], viewGeneration: number, pivotMode: boolean): string {
  return JSON.stringify([scope?.tableName, scope?.filters, scope?.dataVersion, scope?.schemaVersion, columns, viewGeneration, pivotMode]);
}
