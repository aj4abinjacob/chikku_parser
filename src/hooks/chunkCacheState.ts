export type ChunkQueryStatus = "idle" | "loading" | "ready" | "error";

/** Reordering affects sorted ties only when a real rowid shadows DuckDB's key. */
export function chunkColumnsKey(visibleColumns: string[], hasSort: boolean, schemaColumns: Iterable<string> = visibleColumns): string {
  const orderMatters = hasSort && Array.from(schemaColumns).some(column => column.toLowerCase() === "rowid");
  return JSON.stringify(orderMatters ? visibleColumns : [...visibleColumns].sort());
}

export interface ChunkQueryError {
  scope: "count" | "chunk";
  message: string;
}

export interface ChunkQueryState {
  generation: number;
  totalRows: number;
  status: ChunkQueryStatus;
  error: ChunkQueryError | null;
}

export function beginQueryGeneration(generation: number, enabled: boolean): ChunkQueryState {
  return {
    generation,
    totalRows: 0,
    status: enabled ? "loading" : "idle",
    error: null,
  };
}

export function applyCountSuccess(
  state: ChunkQueryState,
  generation: number,
  totalRows: number
): ChunkQueryState {
  if (state.generation !== generation) return state;
  return {
    generation,
    totalRows,
    status: "ready",
    error: null,
  };
}

export function applyQueryFailure(
  state: ChunkQueryState,
  generation: number,
  scope: ChunkQueryError["scope"],
  message: string
): ChunkQueryState {
  if (state.generation !== generation) return state;
  return {
    generation,
    totalRows: scope === "count" ? 0 : state.totalRows,
    status: "error",
    error: { scope, message },
  };
}

export function settleChunkRequest(
  loadingChunks: Set<number>,
  currentGeneration: number,
  requestGeneration: number,
  chunkIndex: number
): boolean {
  if (currentGeneration !== requestGeneration) return false;
  loadingChunks.delete(chunkIndex);
  return true;
}
