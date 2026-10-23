import { useCallback, useEffect, useRef, useState } from "react";
import { INTERNAL_ROW_ID_VALUE, ViewState } from "../types";
import { buildChunkQuery, buildCountQuery, getInternalRowIdAlias } from "../utils/sqlBuilder";
import {
  ChunkQueryError,
  ChunkQueryStatus,
  applyCountSuccess,
  applyQueryFailure,
  beginQueryGeneration,
  chunkColumnsKey,
  settleChunkRequest,
} from "./chunkCacheState";

const CHUNK_SIZE = 1000;
const MAX_CACHED_CHUNKS = 20;
const PREFETCH_CHUNKS = 1;

interface UseChunkCacheArgs {
  tableName: string | null;
  viewState: ViewState;
  enabled: boolean;
  dataVersion?: number;
  columnTypes?: Map<string, string>;
}

interface UseChunkCacheReturn {
  totalRows: number;
  getRow: (absoluteIndex: number) => any | null;
  isRowLoaded: (absoluteIndex: number) => boolean;
  ensureRange: (startIndex: number, endIndex: number) => void;
  status: ChunkQueryStatus;
  error: ChunkQueryError | null;
  retry: () => void;
  cacheGeneration: number;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function useChunkCache({
  tableName,
  viewState,
  enabled,
  dataVersion = 0,
  columnTypes,
}: UseChunkCacheArgs): UseChunkCacheReturn {
  const [queryState, setQueryState] = useState(() => beginQueryGeneration(0, false));
  const [retryVersion, setRetryVersion] = useState(0);

  // Use refs for the mutable cache state to avoid re-renders on every chunk load
  const cacheRef = useRef<Map<number, any[]>>(new Map());
  const loadingRef = useRef<Set<number>>(new Set());
  const generationRef = useRef(0);
  const lruRef = useRef<number[]>([]); // track access order for eviction

  // Force re-render trigger after chunks load
  const [, setTick] = useState(0);
  const tick = useCallback(() => setTick((t) => t + 1), []);

  // Stable references for viewState fields used in queries
  const viewStateRef = useRef(viewState);
  viewStateRef.current = viewState;
  const tableNameRef = useRef(tableName);
  tableNameRef.current = tableName;
  const columnTypesRef = useRef(columnTypes);
  columnTypesRef.current = columnTypes;

  // Most reorders retain cached rows. A shadowed rowid uses visible order for
  // sorted ties, so it must invalidate chunks along with Find's positions.
  const visibleColumnsKey = chunkColumnsKey(viewState.visibleColumns, viewState.sortColumns.length > 0, columnTypes?.keys());
  const columnTypesKey = JSON.stringify(
    Array.from(columnTypes?.entries() ?? []).sort(([left], [right]) => left.localeCompare(right))
  );

  // Build a key from all deps that should trigger cache invalidation
  const filtersKey = JSON.stringify(viewState.filters);
  const sortKey = JSON.stringify(viewState.sortColumns);
  const cacheKey = JSON.stringify([
    tableName,
    enabled,
    visibleColumnsKey,
    columnTypesKey,
    filtersKey,
    sortKey,
    dataVersion,
    retryVersion,
  ]);
  const prevCacheKeyRef = useRef<string>("");

  // Reset cache synchronously during render (before effects run)
  // so that child component effects see the updated generation
  if (cacheKey !== prevCacheKeyRef.current) {
    prevCacheKeyRef.current = cacheKey;
    cacheRef.current = new Map();
    loadingRef.current = new Set();
    lruRef.current = [];
    generationRef.current += 1;
  }
  const currentGeneration = generationRef.current;
  const effectiveQueryState = queryState.generation === currentGeneration
    ? queryState
    : beginQueryGeneration(currentGeneration, !!tableName && enabled);

  // Fetch row count asynchronously when cache deps change
  useEffect(() => {
    const gen = generationRef.current;
    if (!tableName || !enabled) {
      setQueryState(beginQueryGeneration(gen, false));
      return;
    }

    setQueryState(beginQueryGeneration(gen, true));

    const fetchCount = async () => {
      try {
        const sql = buildCountQuery(tableName, viewState.filters);
        const result = await window.api.query(sql);
        if (generationRef.current !== gen) return; // stale
        const total = Number(result[0]?.total ?? 0);
        if (!Number.isFinite(total) || total < 0) {
          throw new Error("Count query returned an invalid row count");
        }
        setQueryState((state) => applyCountSuccess(state, gen, total));
      } catch (err) {
        if (generationRef.current !== gen) return;
        console.error("Count query error:", err);
        setQueryState((state) => applyQueryFailure(state, gen, "count", errorMessage(err)));
      }
    };

    fetchCount();
  }, [cacheKey]);

  const fetchChunk = useCallback(
    async (chunkIndex: number, gen: number) => {
      const table = tableNameRef.current;
      const vs = viewStateRef.current;
      if (!table) return;

      const sql = buildChunkQuery(
        table,
        vs.visibleColumns,
        vs.filters,
        vs.sortColumns,
        CHUNK_SIZE,
        chunkIndex,
        true,
        columnTypesRef.current
      );
      const internalRowIdAlias = getInternalRowIdAlias(vs.visibleColumns);

      try {
        const rows = await window.api.query(sql);
        if (!settleChunkRequest(loadingRef.current, generationRef.current, gen, chunkIndex)) return;
        for (const row of rows) {
          const internalRowId = row[internalRowIdAlias];
          delete row[internalRowIdAlias];
          Object.defineProperty(row, INTERNAL_ROW_ID_VALUE, {
            value: internalRowId,
            configurable: false,
            enumerable: false,
          });
        }

        cacheRef.current.set(chunkIndex, rows);

        // Update LRU
        lruRef.current = lruRef.current.filter((i) => i !== chunkIndex);
        lruRef.current.push(chunkIndex);

        // Evict if over limit
        while (cacheRef.current.size > MAX_CACHED_CHUNKS && lruRef.current.length > 0) {
          const evict = lruRef.current.shift()!;
          cacheRef.current.delete(evict);
        }

        tick();
      } catch (err) {
        if (!settleChunkRequest(loadingRef.current, generationRef.current, gen, chunkIndex)) return;
        console.error(`Chunk ${chunkIndex} fetch error:`, err);
        setQueryState((state) => applyQueryFailure(state, gen, "chunk", errorMessage(err)));
        tick();
      }
    },
    [tick]
  );

  const getRow = useCallback((absoluteIndex: number): any | null => {
    const chunkIndex = Math.floor(absoluteIndex / CHUNK_SIZE);
    const chunk = cacheRef.current.get(chunkIndex);
    if (!chunk) return null;

    // Update LRU on access
    const lru = lruRef.current;
    const idx = lru.indexOf(chunkIndex);
    if (idx !== -1 && idx !== lru.length - 1) {
      lru.splice(idx, 1);
      lru.push(chunkIndex);
    }

    const rowInChunk = absoluteIndex % CHUNK_SIZE;
    return chunk[rowInChunk] ?? null;
  }, []);

  const isRowLoaded = useCallback((absoluteIndex: number): boolean => {
    const chunkIndex = Math.floor(absoluteIndex / CHUNK_SIZE);
    return cacheRef.current.has(chunkIndex);
  }, []);

  const ensureRange = useCallback(
    (startIndex: number, endIndex: number) => {
      const gen = generationRef.current;
      const startChunk = Math.floor(startIndex / CHUNK_SIZE);
      const endChunk = Math.floor(endIndex / CHUNK_SIZE);
      const firstChunk = Math.max(0, startChunk - PREFETCH_CHUNKS);
      const lastChunk = endChunk + PREFETCH_CHUNKS;

      for (let ci = firstChunk; ci <= lastChunk; ci++) {
        if (cacheRef.current.has(ci) || loadingRef.current.has(ci)) continue;
        loadingRef.current.add(ci);
        fetchChunk(ci, gen);
      }
    },
    [fetchChunk]
  );

  const retry = useCallback(() => {
    setRetryVersion((version) => version + 1);
  }, []);

  return {
    totalRows: effectiveQueryState.totalRows,
    getRow,
    isRowLoaded,
    ensureRange,
    status: effectiveQueryState.status,
    error: effectiveQueryState.error,
    retry,
    cacheGeneration: currentGeneration,
  };
}
