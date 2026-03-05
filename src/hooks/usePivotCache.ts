import { useCallback, useEffect, useRef, useState } from "react";
import { ColumnInfo, PivotFlatRow, PivotViewConfig, ViewState } from "../types";
import {
  buildPivotGroupQuery,
  buildPivotGrandTotalQuery,
  buildPivotDataChunkQuery,
} from "../utils/sqlBuilder";

const CHUNK_SIZE = 1000;
const NUMERIC_RE = /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i;

interface GroupNode {
  key: string;
  column: string;
  value: any;
  count: number;
  aggregates: Record<string, any>;
  expanded: boolean;
  children: GroupNode[] | null; // null = not loaded yet (sub-groups)
  dataRows: Map<number, any[]>; // chunk index -> rows (leaf data)
  dataTotalRows: number;
  dataLoading: Set<number>; // chunks currently loading
}

interface UsePivotCacheArgs {
  tableName: string | null;
  viewState: ViewState;
  schema: ColumnInfo[];
  enabled: boolean;
  dataVersion?: number;
}

interface UsePivotCacheReturn {
  flatRows: PivotFlatRow[];
  grandTotals: Record<string, any> | null;
  loading: boolean;
  toggleExpand: (rowKey: string) => void;
  expandAll: () => void;
  collapseAll: () => void;
  ensureRange: (start: number, end: number) => void;
}

function makeGroupKey(parentPath: { column: string; value: any }[], column: string, value: any): string {
  const parts = parentPath.map((p) => `${p.column}=${p.value}`);
  parts.push(`${column}=${value}`);
  return parts.join("|");
}

export function usePivotCache({
  tableName,
  viewState,
  schema,
  enabled,
  dataVersion = 0,
}: UsePivotCacheArgs): UsePivotCacheReturn {
  const [rootNodes, setRootNodes] = useState<GroupNode[]>([]);
  const [grandTotals, setGrandTotals] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(false);
  const [, setTick] = useState(0);
  const tick = useCallback(() => setTick((t) => t + 1), []);

  const generationRef = useRef(0);
  const rootNodesRef = useRef<GroupNode[]>([]);
  rootNodesRef.current = rootNodes;

  const pivotConfig = viewState.pivotConfig;
  const groupColumns = pivotConfig?.groupColumns ?? [];
  const defaultAggFn = pivotConfig?.defaultAggFunction ?? "SUM";

  // Build aggregate configs from schema
  // Numeric columns use the selected agg function; non-numeric columns
  // fall back to COUNT_DISTINCT (or COUNT/MIN/MAX which work on any type)
  const getAggConfigs = useCallback(
    (aggFn: string) => {
      const UNIVERSAL_FNS = new Set(["COUNT", "COUNT_DISTINCT", "COUNT_NULL", "MIN", "MAX"]);
      const configs: { column: string; fn: string }[] = [];
      for (const col of schema) {
        if (NUMERIC_RE.test(col.column_type) || UNIVERSAL_FNS.has(aggFn)) {
          // Numeric columns support all agg functions; all columns support COUNT/MIN/MAX
          configs.push({ column: col.column_name, fn: aggFn });
        } else {
          // Non-numeric columns fall back to COUNT_DISTINCT for numeric-only aggs
          configs.push({ column: col.column_name, fn: "COUNT_DISTINCT" });
        }
      }
      return configs;
    },
    [schema]
  );

  // Helper: get effective direction for a group column (sort overrides group direction)
  const getEffectiveGroupDir = (gc: { column: string; direction: "ASC" | "DESC" }) => {
    const se = viewState.sortColumns.find((sc) => sc.column === gc.column);
    return se ? se.direction : gc.direction;
  };

  // Structural cache key (excludes sort — sort changes are handled separately)
  const filtersKey = JSON.stringify(viewState.filters);
  const groupColumnsKey = JSON.stringify(groupColumns);
  const visibleColumnsKey = [...viewState.visibleColumns].sort().join(",");
  const cacheKey = `${tableName}|${enabled}|${groupColumnsKey}|${filtersKey}|${visibleColumnsKey}|${defaultAggFn}|${dataVersion}`;
  const prevCacheKeyRef = useRef("");

  // Reset on structural cache key change
  if (cacheKey !== prevCacheKeyRef.current) {
    prevCacheKeyRef.current = cacheKey;
    rootNodesRef.current = [];
    setRootNodes([]);
    setGrandTotals(null);
    generationRef.current += 1;
  }

  // Handle sort changes without full tree reset — preserve expand state
  const sortColumnsKey = JSON.stringify(viewState.sortColumns);
  const prevSortKeyRef = useRef(sortColumnsKey);

  if (sortColumnsKey !== prevSortKeyRef.current) {
    prevSortKeyRef.current = sortColumnsKey;

    if (rootNodesRef.current.length > 0) {
      generationRef.current += 1;

      const clearAndSort = (nodes: GroupNode[], depth: number) => {
        // Re-sort this level if the group column has a sort entry
        if (depth < groupColumns.length) {
          const dir = getEffectiveGroupDir(groupColumns[depth]);
          nodes.sort((a, b) => {
            const va = a.value;
            const vb = b.value;
            if (va == null && vb == null) return 0;
            if (va == null) return 1;
            if (vb == null) return -1;
            const cmp = typeof va === "number" && typeof vb === "number"
              ? va - vb
              : String(va).localeCompare(String(vb));
            return dir === "ASC" ? cmp : -cmp;
          });
        }

        for (const node of nodes) {
          // Clear cached data rows (they need refetching with new ORDER BY)
          node.dataRows = new Map();
          node.dataLoading = new Set();
          if (node.children && node.children.length > 0) {
            clearAndSort(node.children, depth + 1);
          }
        }
      };

      clearAndSort(rootNodesRef.current, 0);
      setRootNodes([...rootNodesRef.current]);
    }
  }

  // Fetch top-level groups and grand totals
  useEffect(() => {
    if (!tableName || !enabled || groupColumns.length === 0) {
      setRootNodes([]);
      setGrandTotals(null);
      setLoading(false);
      return;
    }

    const gen = generationRef.current;
    const aggConfigs = getAggConfigs(defaultAggFn);

    const fetchRoot = async () => {
      setLoading(true);
      try {
        const firstGroup = groupColumns[0];
        const effectiveDir = getEffectiveGroupDir(firstGroup);
        const sql = buildPivotGroupQuery(
          tableName,
          firstGroup.column,
          [],
          aggConfigs,
          viewState.filters,
          effectiveDir
        );
        const rows = await window.api.query(sql);
        if (generationRef.current !== gen) return;

        const nodes: GroupNode[] = rows.map((row: any) => {
          const value = row[firstGroup.column];
          const aggregates: Record<string, any> = {};
          for (const key of Object.keys(row)) {
            if (key !== firstGroup.column && key !== "__count") {
              aggregates[key] = row[key];
            }
          }
          return {
            key: makeGroupKey([], firstGroup.column, value),
            column: firstGroup.column,
            value,
            count: Number(row.__count),
            aggregates,
            expanded: false,
            children: null,
            dataRows: new Map(),
            dataTotalRows: 0,
            dataLoading: new Set(),
          };
        });

        rootNodesRef.current = nodes;
        setRootNodes(nodes);

        // Fetch grand totals
        const totalSql = buildPivotGrandTotalQuery(tableName, aggConfigs, viewState.filters);
        const totalRows = await window.api.query(totalSql);
        if (generationRef.current !== gen) return;
        if (totalRows.length > 0) {
          setGrandTotals(totalRows[0]);
        }
      } catch (err) {
        console.error("Pivot root fetch error:", err);
      } finally {
        if (generationRef.current === gen) setLoading(false);
      }
    };

    fetchRoot();
  }, [cacheKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Find a node by key in the tree
  const findNode = useCallback(
    (key: string, nodes: GroupNode[] = rootNodesRef.current): GroupNode | null => {
      for (const node of nodes) {
        if (node.key === key) return node;
        if (node.children) {
          const found = findNode(key, node.children);
          if (found) return found;
        }
      }
      return null;
    },
    []
  );

  // Load children for a group node
  const loadChildren = useCallback(
    async (node: GroupNode) => {
      if (!tableName || groupColumns.length === 0) return;

      const gen = generationRef.current;
      const depthIndex = groupColumns.findIndex((gc) => gc.column === node.column);
      const parentPath = [
        ...node.key.split("|").map((part) => {
          const eqIdx = part.indexOf("=");
          return {
            column: part.substring(0, eqIdx),
            value: part.substring(eqIdx + 1) === "null" || part.substring(eqIdx + 1) === "undefined"
              ? null
              : part.substring(eqIdx + 1),
          };
        }),
      ];

      const aggConfigs = getAggConfigs(defaultAggFn);

      if (depthIndex < groupColumns.length - 1) {
        // Load sub-groups
        const nextGroup = groupColumns[depthIndex + 1];
        const effectiveDir = getEffectiveGroupDir(nextGroup);
        const sql = buildPivotGroupQuery(
          tableName,
          nextGroup.column,
          parentPath,
          aggConfigs,
          viewState.filters,
          effectiveDir
        );
        try {
          const rows = await window.api.query(sql);
          if (generationRef.current !== gen) return;

          const children: GroupNode[] = rows.map((row: any) => {
            const value = row[nextGroup.column];
            const aggregates: Record<string, any> = {};
            for (const key of Object.keys(row)) {
              if (key !== nextGroup.column && key !== "__count") {
                aggregates[key] = row[key];
              }
            }
            return {
              key: makeGroupKey(parentPath, nextGroup.column, value),
              column: nextGroup.column,
              value,
              count: Number(row.__count),
              aggregates,
              expanded: false,
              children: null,
              dataRows: new Map(),
              dataTotalRows: 0,
              dataLoading: new Set(),
            };
          });

          node.children = children;
          setRootNodes([...rootNodesRef.current]);
        } catch (err) {
          console.error("Pivot sub-group fetch error:", err);
        }
      } else {
        // Leaf level — load data rows count
        node.dataTotalRows = node.count;
        node.children = []; // mark as loaded (leaf)
        setRootNodes([...rootNodesRef.current]);
      }
    },
    [tableName, groupColumns, viewState.filters, viewState.sortColumns, defaultAggFn, getAggConfigs]
  );

  // Load a data chunk for a leaf group
  const loadDataChunk = useCallback(
    async (node: GroupNode, chunkIndex: number) => {
      if (!tableName || node.dataLoading.has(chunkIndex) || node.dataRows.has(chunkIndex)) return;

      const gen = generationRef.current;
      node.dataLoading.add(chunkIndex);

      const parentPath = node.key.split("|").map((part) => {
        const eqIdx = part.indexOf("=");
        return {
          column: part.substring(0, eqIdx),
          value: part.substring(eqIdx + 1) === "null" || part.substring(eqIdx + 1) === "undefined"
            ? null
            : part.substring(eqIdx + 1),
        };
      });

      try {
        const sql = buildPivotDataChunkQuery(
          tableName,
          viewState.visibleColumns,
          parentPath,
          viewState.filters,
          viewState.sortColumns,
          CHUNK_SIZE,
          chunkIndex
        );
        const rows = await window.api.query(sql);
        if (generationRef.current !== gen) return;

        node.dataRows.set(chunkIndex, rows);
        node.dataLoading.delete(chunkIndex);
        tick();
      } catch (err) {
        console.error("Pivot data chunk fetch error:", err);
        node.dataLoading.delete(chunkIndex);
      }
    },
    [tableName, viewState.visibleColumns, viewState.filters, viewState.sortColumns, tick]
  );

  // Toggle expand/collapse a group
  const toggleExpand = useCallback(
    (rowKey: string) => {
      const node = findNode(rowKey);
      if (!node) return;

      if (node.expanded) {
        node.expanded = false;
        setRootNodes([...rootNodesRef.current]);
      } else {
        node.expanded = true;
        if (node.children === null) {
          // Need to load children
          loadChildren(node);
        }
        setRootNodes([...rootNodesRef.current]);
      }
    },
    [findNode, loadChildren]
  );

  // Expand all (one level at a time — expands already-loaded nodes)
  const expandAll = useCallback(() => {
    const expandNodes = async (nodes: GroupNode[]) => {
      for (const node of nodes) {
        node.expanded = true;
        if (node.children === null) {
          await loadChildren(node);
        }
        if (node.children && node.children.length > 0) {
          await expandNodes(node.children);
        }
      }
    };
    expandNodes(rootNodesRef.current).then(() => {
      setRootNodes([...rootNodesRef.current]);
    });
  }, [loadChildren]);

  // Collapse all
  const collapseAll = useCallback(() => {
    const collapseNodes = (nodes: GroupNode[]) => {
      for (const node of nodes) {
        node.expanded = false;
        if (node.children) collapseNodes(node.children);
      }
    };
    collapseNodes(rootNodesRef.current);
    setRootNodes([...rootNodesRef.current]);
  }, []);

  // Flatten tree into PivotFlatRow[]
  const flatRows: PivotFlatRow[] = [];

  const flattenNodes = (nodes: GroupNode[], depth: number, parentPath: { column: string; value: any }[]) => {
    const isLeafLevel = depth >= groupColumns.length - 1;

    for (const node of nodes) {
      const currentPath = [...parentPath, { column: node.column, value: node.value }];

      flatRows.push({
        key: node.key,
        type: "group",
        depth,
        groupColumn: node.column,
        groupValue: node.value,
        groupCount: node.count,
        aggregates: node.aggregates,
        expanded: node.expanded,
        parentPath: parentPath,
      });

      if (node.expanded) {
        if (!isLeafLevel && node.children && node.children.length > 0) {
          flattenNodes(node.children, depth + 1, currentPath);
        } else if (isLeafLevel) {
          // Render data rows
          for (let i = 0; i < node.dataTotalRows; i++) {
            const chunkIndex = Math.floor(i / CHUNK_SIZE);
            const rowInChunk = i % CHUNK_SIZE;
            const chunk = node.dataRows.get(chunkIndex);
            const rowData = chunk?.[rowInChunk] ?? null;

            flatRows.push({
              key: `${node.key}|data:${i}`,
              type: "data",
              depth: depth + 1,
              data: rowData,
              parentPath: currentPath,
            });
          }
        }
      }
    }
  };

  if (rootNodes.length > 0) {
    flattenNodes(rootNodes, 0, []);
  }

  // Ensure range — for data rows, trigger chunk loading
  const ensureRange = useCallback(
    (start: number, end: number) => {
      // Find data rows in range that need loading
      for (let i = start; i <= end && i < flatRows.length; i++) {
        const row = flatRows[i];
        if (row.type === "data" && row.data === null) {
          // Find the parent group node
          const parentKey = row.parentPath.map((p) => `${p.column}=${p.value}`).join("|");
          const node = findNode(parentKey);
          if (node) {
            // Determine which chunk this data row belongs to
            // We need to figure out the index within the group's data
            const dataIndex = parseInt(row.key.split("|data:")[1], 10);
            const chunkIndex = Math.floor(dataIndex / CHUNK_SIZE);
            loadDataChunk(node, chunkIndex);
          }
        }
      }
    },
    [flatRows, findNode, loadDataChunk]
  );

  return {
    flatRows,
    grandTotals,
    loading,
    toggleExpand,
    expandAll,
    collapseAll,
    ensureRange,
  };
}
