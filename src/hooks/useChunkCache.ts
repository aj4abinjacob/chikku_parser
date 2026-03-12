import { useCallback, useEffect, useRef, useState } from "react";
import { ViewState } from "../types";
import { buildChunkQuery, buildCountQuery } from "../utils/sqlBuilder";

const CHUNK_SIZE = 1000;
const MAX_CACHED_CHUNKS = 20;

interface UseChunkCacheArgs {
  tableName: string | null;
  viewState: ViewState;
  enabled: boolean;
  dataVersion?: number;
}

interface UseChunkCacheReturn {
  totalRows: number;
  getRow: (absoluteIndex: number) => any | null;
  isRowLoaded: (absoluteIndex: number) => boolean;
  ensureRange: (startIndex: number, endIndex: number) => void;
}

export function useChunkCache({
  tableName,
  viewState,
  enabled,
  dataVersion = 0,
}: UseChunkCacheArgs): UseChunkCacheReturn {
  const [totalRows, setTotalRows] = useState(0);

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

  // Stable key for visible columns — sorted so reordering doesn't trigger reset
  const visibleColumnsKey = [...viewState.visibleColumns].sort().join(",");

  // Build a key from all deps that should trigger cache invalidation
  const filtersKey = JSON.stringify(viewState.filters);
  const sortKey = JSON.stringify(viewState.sortColumns);
  const cacheKey = `${tableName}|${enabled}|${visibleColumnsKey}|${filtersKey}|${sortKey}|${dataVersion}`;
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

  // Fetch row count asynchronously when cache deps change
  useEffect(() => {
    if (!tableName || !enabled) {
      setTotalRows(0);
      return;
    }

    const gen = generationRef.current;

    const fetchCount = async () => {
      try {
        const sql = buildCountQuery(tableName, viewState.filters);
        const result = await window.api.query(sql);
        if (generationRef.current !== gen) return; // stale
        setTotalRows(Number(result[0]?.total ?? 0));
      } catch (err) {
        console.error("Count query error:", err);
      }
    };

    fetchCount();
  }, [
    tableName,
    enabled,
    filtersKey,
    sortKey,
    visibleColumnsKey,
    dataVersion,
  ]);

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
        chunkIndex
      );

      try {
        const rows = await window.api.query(sql);
        if (generationRef.current !== gen) return; // stale

        cacheRef.current.set(chunkIndex, rows);
        loadingRef.current.delete(chunkIndex);

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
        console.error(`Chunk ${chunkIndex} fetch error:`, err);
        loadingRef.current.delete(chunkIndex);
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

      for (let ci = startChunk; ci <= endChunk; ci++) {
        if (cacheRef.current.has(ci) || loadingRef.current.has(ci)) continue;
        loadingRef.current.add(ci);
        fetchChunk(ci, gen);
      }
    },
    [fetchChunk]
  );

  return { totalRows, getRow, isRowLoaded, ensureRange };
}
