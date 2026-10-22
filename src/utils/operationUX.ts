import { ColumnInfo } from "../types";
import { escapeIdent } from "./sqlBuilder";

/** A synchronous lock also catches repeated clicks before React renders pending state. */
export class AsyncActionGate {
  pending = false;

  async run(action: () => Promise<void>): Promise<void> {
    if (this.pending) return;
    this.pending = true;
    try {
      await action();
    } finally {
      this.pending = false;
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function columnNameExists(names: string[], candidate: string): boolean {
  const normalized = candidate.trim().toLowerCase();
  return names.some((name) => name.toLowerCase() === normalized);
}

/** DuckDB identifiers are case insensitive, including quoted column names. */
export function suggestColumnName(names: string[], base: string): string {
  let candidate = base;
  let suffix = 2;
  while (columnNameExists(names, candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

export function rowScopeLabel(filtered: boolean, rows: number, allRows: number | null): string {
  if (!filtered) return `Entire file · ${rows.toLocaleString()} rows`;
  return `Filtered rows · ${rows.toLocaleString()}${allRows === null ? "" : ` of ${allRows.toLocaleString()}`} rows`;
}
interface TableMutationApi {
  exec: (sql: string) => Promise<unknown>;
  describe: (table: string) => Promise<ColumnInfo[]>;
  query: (sql: string) => Promise<Record<string, unknown>[]>;
}

/** Publish state only once the mutation and its metadata reads have all succeeded. */
export async function applyTableMutation(api: TableMutationApi, tableName: string, sql: string): Promise<{ schema: ColumnInfo[]; rowCount: number }> {
  await api.exec("BEGIN TRANSACTION");
  try {
    await api.exec(sql);
    const schema = await api.describe(tableName);
    const rows = await api.query(`SELECT COUNT(*) AS count FROM ${escapeIdent(tableName)}`);
    const rowCount = Number(rows[0]?.count);
    if (!Number.isFinite(rowCount) || rowCount < 0) throw new Error("Could not read the updated row count.");
    await api.exec("COMMIT");
    return { schema, rowCount };
  } catch (error) {
    try { await api.exec("ROLLBACK"); } catch { /* Preserve the operation's original error. */ }
    throw error;
  }
}
