import { ApplyCellEditRequest, TableHistory } from "../types";

export const CELL_MUTATION_EVENT = "chikku-table-mutation";
export const DRAFT_MAX_STATES = 100;
export const DRAFT_MAX_BYTES = 8 * 1024 * 1024;
export const RECENT_MAX_RECORDS = 200;
export const RECENT_MAX_BYTES = 8 * 1024 * 1024;
export const CELL_HISTORY_MAX_ENTRIES = 2000;
export const CELL_HISTORY_MAX_BYTES = 20 * 1024 * 1024;
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) { const code = character.codePointAt(0)!; bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  return bytes;
}
export function storedValueBytes(value: string | null): number { return value === null ? 0 : Math.max(utf8Bytes(value), value.length * 2); }
export function valueBytes(value: string | null): number { return value === null ? 0 : utf8Bytes(value); }
export function cellValueMetrics(value: string | null) {
  let characters = 0, bytes = 0, lines = value === null || value === "" ? 0 : 1, previousCR = false;
  if (value !== null) for (const character of value) {
    characters++; const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (character === "\r" || (character === "\n" && !previousCR)) lines++;
    previousCR = character === "\r";
  }
  return { characters, bytes, lines };
}
export function visibleWhitespace(value: string): string {
  return value.replace(/ |\t|\r\n|\r|\n/g, (token) => token === " " ? "·" : token === "\t" ? "⇥" : token === "\r\n" ? "␍↵\n" : token === "\r" ? "␍\n" : "↵\n");
}
export function cellValueLabel(value: string | null): string { return value === null ? "NULL" : value === "" ? "Empty string" : value; }
export interface DraftSnapshot { value: string | null; start: number; end: number; }
export interface DraftHistory { states: DraftSnapshot[]; index: number; costs: number[]; bytes: number; }
export function createDraft(value: string | null): DraftHistory { const cost = storedValueBytes(value); return { states: [{ value, start: 0, end: 0 }], index: 0, costs: [cost], bytes: cost }; }
export function pushDraft(history: DraftHistory, snapshot: DraftSnapshot, maxStates = DRAFT_MAX_STATES, maxBytes = DRAFT_MAX_BYTES): DraftHistory {
  if (history.states[history.index].value === snapshot.value) return history;
  const states = [...history.states.slice(0, history.index + 1), snapshot];
  const costs = [...history.costs.slice(0, history.index + 1), storedValueBytes(snapshot.value)];
  let bytes = costs.reduce((sum, cost) => sum + cost, 0);
  while (states.length > 1 && (states.length > maxStates || bytes > maxBytes)) { states.shift(); bytes -= costs.shift()!; }
  return { states, index: states.length - 1, costs, bytes };
}
export function moveDraft(history: DraftHistory, delta: number): DraftHistory {
  return { ...history, index: Math.max(0, Math.min(history.states.length - 1, history.index + delta)) };
}
export interface CellInspection {
  tableName: string; columnName: string; rowId: string | null; row: number;
  cachedValue: string | null; columnType: string; reason: string | null; context: number;
}
export interface RecentCellEdit {
  id: number; tableName: string; columnName: string; rowId: string;
  timestamp: number; before: string | null; after: string | null; context: number; restorable: boolean;
}
export function appendRecentEdit(records: RecentCellEdit[], record: RecentCellEdit, maxRecords = RECENT_MAX_RECORDS, maxBytes = RECENT_MAX_BYTES): RecentCellEdit[] {
  const next = [...records, record];
  let bytes = next.reduce((sum, item) => sum + storedValueBytes(item.before) + storedValueBytes(item.after), 0);
  while (next.length && (next.length > maxRecords || bytes > maxBytes)) { const removed = next.shift()!; bytes -= storedValueBytes(removed.before) + storedValueBytes(removed.after); }
  return next;
}
export function sameCell(a: Pick<RecentCellEdit, "tableName" | "columnName" | "rowId">, b: Pick<CellInspection, "tableName" | "columnName" | "rowId">): boolean {
  return a.tableName === b.tableName && a.columnName === b.columnName && a.rowId === b.rowId;
}
export function canRestoreCell(record: RecentCellEdit, target: CellInspection, context: number): boolean {
  return record.restorable && record.context === context && target.context === context && sameCell(record, target);
}
export function sessionHistoryUsage(histories: Iterable<TableHistory>): { entries: number; bytes: number } {
  let entries = 0, bytes = 0;
  for (const history of histories) for (const entry of history.entries) { if (entry.source !== "cell_edit") continue; entries++; for (const sql of entry.sqlStatements) bytes += storedValueBytes(sql); }
  return { entries, bytes };
}
/** Native SQL may double quotes or hex-encode NUL. Reserve canonical type expansion and identifiers as well. */
export function cellEditSqlUpperBound(request: ApplyCellEditRequest, columnType: string): number {
  return 2 * (8192 + utf8Bytes(request.tableName) * 16 + utf8Bytes(request.columnName) * 12 + utf8Bytes(columnType) * 8 + utf8Bytes(request.rowId) * 4 + valueBytes(request.expectedValue) * 2 + (valueBytes(request.value) + 1024) * 2);
}
export function assertCellHistoryBudget(histories: Iterable<TableHistory>, request: ApplyCellEditRequest, columnType: string): void {
  const usage = sessionHistoryUsage(histories);
  if (usage.entries + 1 > CELL_HISTORY_MAX_ENTRIES || usage.bytes + cellEditSqlUpperBound(request, columnType) > CELL_HISTORY_MAX_BYTES) {
    throw new Error("Session cell history is full (2,000 entries / 20 MiB of SQL text). Export your table and history, then reopen the exported table before making more cell edits. Your draft has been kept.");
  }
}

/** Browsers normalize textarea newlines to LF; keep an untouched draft exact and preserve uniform source conventions on edits. */
export function textareaDraftValue(previous: string | null, input: string, original: string | null = previous): string {
  if (previous !== null && previous.replace(/\r\n|\r/g, "\n") === input) return previous;
  const reference = previous !== null && /[\r\n]/.test(previous) ? previous : original;
  if (reference !== null && reference.includes("\r\n") && !reference.replace(/\r\n/g, "").match(/[\r\n]/)) return input.replace(/\r\n|\r|\n/g, "\r\n");
  if (reference !== null && reference.includes("\r") && !reference.includes("\n")) return input.replace(/\r\n|\r|\n/g, "\r");
  return input;
}
