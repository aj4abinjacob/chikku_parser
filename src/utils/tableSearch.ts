import { FilterGroup, SortColumn, TableSearchMatch, TableSearchRequest } from "../types";
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
  sortColumns: SortColumn[],
  term: string,
  direction: "forward" | "backward" = "forward",
  cursorRow = 0
): TableSearchRequest {
  if (!term.length || Array.from(term).length > TABLE_SEARCH_MAX_TERM) throw new Error("Enter between 1 and 2,048 characters to find.");
  if (!visibleColumns.length) throw new Error("Show a column before searching.");
  if (visibleColumns.length > TABLE_SEARCH_MAX_COLUMNS) throw new Error("Find supports up to 200 visible columns. Hide some columns to continue.");
  if (!Number.isSafeInteger(cursorRow) || cursorRow < 0) throw new Error("Invalid find position.");
  return { requestId, tableName: scope.tableName, columns: [...visibleColumns], sortColumns, term, direction, cursorRow, filterSql: buildFilterGroupClause(scope.filters) };
}

export interface FindCell { row: number; col: string }
export function flattenFindMatches(matches: TableSearchMatch[]): FindCell[] {
  return matches.flatMap(match => match.columns.map(col => ({ row: match.rowIndex, col })));
}

/** DuckDB uses Unicode simple lowercase: no contextual final sigma or İ expansion. */
export function lowerFindText(text: string): string {
  return text.replace(/İ/g, "i").replace(/Σ/g, "σ").toLowerCase();
}

/** Bounded literal ranges. Simple lowercase retains original UTF-16 offsets. */
export function findTextRanges(text: string, term: string, limit = 100): Array<{ start: number; end: number }> {
  if (!term || limit <= 0) return [];
  const lowered = lowerFindText(text), needle = lowerFindText(term);
  const ranges: Array<{ start: number; end: number }> = [];
  let from = 0;
  while (ranges.length < limit && from <= lowered.length - needle.length) {
    const index = lowered.indexOf(needle, from);
    if (index < 0) break;
    ranges.push({ start: index, end: index + needle.length });
    from = index + needle.length;
  }
  return ranges;
}

export function findTextMatches(value: unknown, term: string): boolean {
  return value != null && !!term && lowerFindText(String(value)).includes(lowerFindText(term));
}

export function tableSearchContextKey(scope: TableSearchScope | undefined, columns: string[], viewGeneration: number, pivotMode: boolean): string {
  return JSON.stringify([scope?.tableName, scope?.filters, scope?.dataVersion, scope?.schemaVersion, columns, viewGeneration, pivotMode]);
}
