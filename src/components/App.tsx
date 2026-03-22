import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Button } from "@blueprintjs/core";
import { LoadedTable, ViewState, ColumnInfo, FilterGroup, SheetInfo, hasActiveFilters, countConditions, ColOpType, ColOpStep, RowOpType, RowOpStep, UndoStrategy, SortColumn, PivotAggFunction, PivotGroupColumn, SavedView, TableHistory, TableSourceInfo, HistoryEntry, HistoryOpSource, HistoryExportData, ImportOptions } from "../types";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
import { FilterPanel } from "./FilterPanel";
import { StatusBar } from "./StatusBar";
import { PivotToolbar } from "./PivotToolbar";
import { CombineDialog } from "./CombineDialog";
import { ExcelSheetPickerDialog } from "./ExcelSheetPickerDialog";
import { ImportRetryDialog } from "./ImportRetryDialog";
import { ExportDialog } from "./ExportDialog";
import { HistoryDialog } from "./HistoryDialog";
import { buildCombineQuery } from "../utils/sqlBuilder";
import { buildColOpUpdateSQL, buildStepDescription } from "../utils/colOpsSQL";
import { buildRowOpSQL, buildRowOpStepDescription } from "../utils/rowOpsSQL";
import { useChunkCache } from "../hooks/useChunkCache";
import { usePivotCache } from "../hooks/usePivotCache";

function makeTableName(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() || "table";
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.substring(0, dotIdx) : name;
  return base.replace(/[^a-zA-Z0-9_]/g, "_");
}

function getFileExtension(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() || "";
}

/** Generate a unique "combined_N" table name that doesn't collide with existing tables */
function nextCombinedName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`combined_${i}`)) i++;
  return `combined_${i}`;
}

/** Generate a unique "sample_N" table name that doesn't collide with existing tables */
function nextSampleName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`sample_${i}`)) i++;
  return `sample_${i}`;
}

/** Generate a unique "aggregate_N" table name that doesn't collide with existing tables */
function nextAggregateName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`aggregate_${i}`)) i++;
  return `aggregate_${i}`;
}

/** Generate a unique "pivot_N" table name that doesn't collide with existing tables */
function nextPivotName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`pivot_${i}`)) i++;
  return `pivot_${i}`;
}

/** Generate a unique "merge_N" table name that doesn't collide with existing tables */
function nextMergeName(existingNames: Set<string>): string {
  let i = 1;
  while (existingNames.has(`merge_${i}`)) i++;
  return `merge_${i}`;
}

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface PendingExcelImport {
  filePath: string;
  fileName: string;
  sheets: SheetInfo[];
  replace: boolean;
  otherFiles: LoadedTable[];
  remainingFiles: string[];
}

interface PendingRetry {
  filePath: string;
  tableName: string;
  errorMessage: string;
  replace: boolean;
  otherFiles: LoadedTable[];
  remainingFiles: string[];
}

export function App(): React.ReactElement {
  const [tables, setTables] = useState<LoadedTable[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [combineDialogOpen, setCombineDialogOpen] = useState(false);
  const [combineTableNames, setCombineTableNames] = useState<string[]>([]);
  const [schema, setSchema] = useState<ColumnInfo[]>([]);
  const [resetKey, setResetKey] = useState(0);
  const [schemaVersion, setSchemaVersion] = useState(0);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [pendingExcelImport, setPendingExcelImport] = useState<PendingExcelImport | null>(null);
  const [pendingRetry, setPendingRetry] = useState<PendingRetry | null>(null);
  const [colOpsSteps, setColOpsSteps] = useState<ColOpStep[]>([]);
  const [undoStrategy, setUndoStrategy] = useState<UndoStrategy>("per-step");
  const [colOpsNextId, setColOpsNextId] = useState(1);
  const [rowOpsSteps, setRowOpsSteps] = useState<RowOpStep[]>([]);
  const [rowOpsUndoStrategy, setRowOpsUndoStrategy] = useState<UndoStrategy>("per-step");
  const [rowOpsNextId, setRowOpsNextId] = useState(1);
  const [dataVersion, setDataVersion] = useState(0);
  const [viewState, setViewState] = useState<ViewState>({
    visibleColumns: [],
    columnOrder: [],
    filters: { logic: "AND", children: [] },
    sortColumns: [],
    pivotConfig: null,
  });
  const [savedViews, setSavedViews] = useState<SavedView[]>([]);
  const [savedViewNextId, setSavedViewNextId] = useState(1);
  const [tableHistories, setTableHistories] = useState<Map<string, TableHistory>>(new Map());
  const [historyDialogOpen, setHistoryDialogOpen] = useState(false);
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem("theme") === "dark");

  // Use refs so IPC callbacks always see latest state
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const activeTableRef = useRef(activeTable);
  activeTableRef.current = activeTable;
  const tableHistoriesRef = useRef(tableHistories);
  tableHistoriesRef.current = tableHistories;

  // Determine if pivot mode is active
  const pivotActive = !!viewState.pivotConfig && viewState.pivotConfig.groupColumns.length > 0;

  // Numeric columns set for pivot aggregate display
  const numericColumns = useMemo(() => {
    const NUMERIC_RE = /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i;
    return new Set(schema.filter(c => NUMERIC_RE.test(c.column_type)).map(c => c.column_name));
  }, [schema]);

  // Chunk cache for lazy-loaded virtual scrolling (flat mode)
  const { totalRows, getRow, ensureRange } = useChunkCache({
    tableName: activeTable,
    viewState,
    enabled: viewState.visibleColumns.length > 0 && !pivotActive,
    dataVersion,
  });

  // Pivot cache (pivot mode)
  const {
    flatRows: pivotFlatRows,
    grandTotals: pivotGrandTotals,
    loading: pivotLoading,
    groupCount: pivotGroupCount,
    toggleExpand: pivotToggleExpand,
    expandAll: pivotExpandAll,
    collapseAll: pivotCollapseAll,
    ensureRange: pivotEnsureRange,
  } = usePivotCache({
    tableName: activeTable,
    viewState,
    schema,
    enabled: viewState.visibleColumns.length > 0 && pivotActive,
    dataVersion,
  });

  // ── History helpers ──

  const getSourceInfoForTable = useCallback((table: LoadedTable): TableSourceInfo => {
    const isGenerated = table.filePath.startsWith("(");
    return {
      filePath: table.filePath,
      importOptions: table.importOptions,
      isGenerated,
    };
  }, []);

  const initializeTableHistory = useCallback((table: LoadedTable) => {
    const history: TableHistory = {
      tableName: table.tableName,
      sourceInfo: getSourceInfoForTable(table),
      initialSchema: [...table.schema],
      entries: [],
      nextEntryId: 1,
    };
    setTableHistories((prev) => {
      const next = new Map(prev);
      next.set(table.tableName, history);
      return next;
    });
  }, [getSourceInfoForTable]);

  const recordHistoryEntry = useCallback(
    (tableName: string, source: HistoryOpSource, description: string, sqlStatements: string[]) => {
      setTableHistories((prev) => {
        const history = prev.get(tableName);
        if (!history) return prev;
        const entry: HistoryEntry = {
          id: history.nextEntryId,
          source,
          description,
          timestamp: Date.now(),
          sqlStatements,
        };
        const next = new Map(prev);
        next.set(tableName, {
          ...history,
          entries: [...history.entries, entry],
          nextEntryId: history.nextEntryId + 1,
        });
        return next;
      });
    },
    []
  );

  // Load a single file into DuckDB (handles all formats)
  const loadSingleFile = useCallback(
    async (
      fp: string,
      tableName: string,
      options?: { csvDelimiter?: string; csvIgnoreErrors?: boolean; excelSheet?: string }
    ): Promise<LoadedTable | { error: string; canRetry: boolean } | null> => {
      try {
        const result = await window.api.loadFile(fp, tableName, options);
        if (result.error) {
          return { error: result.error, canRetry: result.canRetry };
        }
        return {
          tableName: result.tableName,
          filePath: fp,
          schema: result.schema,
          rowCount: result.rowCount,
          importOptions: options,
        };
      } catch (err) {
        console.error(`Failed to load ${fp}:`, err);
        return null;
      }
    },
    []
  );

  // Load files into DuckDB (handles all formats)
  // accumulatedTables: when continuing after a dialog, pass the already-loaded tables
  const loadFiles = useCallback(
    async (filePaths: string[], replace: boolean, accumulatedTables?: LoadedTable[]) => {
      const newTables: LoadedTable[] = accumulatedTables ?? (replace ? [] : [...tablesRef.current]);

      for (let i = 0; i < filePaths.length; i++) {
        const fp = filePaths[i];
        const ext = getFileExtension(fp);
        const remaining = filePaths.slice(i + 1);

        if (ext === "xlsx" || ext === "xls") {
          // Excel: check for multiple sheets
          try {
            const sheets = await window.api.getExcelSheets(fp);
            if (sheets.length > 1) {
              // Show sheet picker dialog — remaining files will be continued after
              setPendingExcelImport({
                filePath: fp,
                fileName: fp.split(/[/\\]/).pop() || fp,
                sheets,
                replace,
                otherFiles: newTables,
                remainingFiles: remaining,
              });
              return; // Wait for dialog result, then continue with remaining
            }
            // Single sheet — import directly
            const tableName = makeTableName(fp);
            const result = await loadSingleFile(fp, tableName, { excelSheet: sheets[0].name });
            if (result && !("error" in result)) {
              newTables.push(result);
            }
          } catch (err) {
            console.error(`Failed to load Excel ${fp}:`, err);
          }
        } else if (ext === "csv" || ext === "tsv") {
          // CSV/TSV — try loading, show retry on failure
          const tableName = makeTableName(fp);
          const result = await loadSingleFile(fp, tableName);
          if (result && "error" in result && result.canRetry) {
            setPendingRetry({
              filePath: fp,
              tableName,
              errorMessage: result.error,
              replace,
              otherFiles: newTables,
              remainingFiles: remaining,
            });
            return; // Wait for retry dialog, then continue with remaining
          }
          if (result && !("error" in result)) {
            newTables.push(result);
          }
        } else {
          // JSON, Parquet — straight load
          const tableName = makeTableName(fp);
          const result = await loadSingleFile(fp, tableName);
          if (result && !("error" in result)) {
            newTables.push(result);
          }
        }
      }

      setTables(newTables);

      // Initialize history for newly loaded tables
      for (const t of newTables) {
        if (!tableHistoriesRef.current.has(t.tableName)) {
          initializeTableHistory(t);
        }
      }

      if (newTables.length > 0) {
        setActiveTable(newTables[0].tableName);
        setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
        setResetKey((k) => k + 1);
        setFilterPanelOpen(false);
      }
    },
    [loadSingleFile, initializeTableHistory]
  );

  // Handle Excel sheet picker result
  const handleExcelSheetImport = useCallback(
    async (selectedSheets: string[]) => {
      if (!pendingExcelImport) return;
      const { filePath, otherFiles, replace, remainingFiles } = pendingExcelImport;
      const newTables = [...otherFiles];
      const baseName = makeTableName(filePath);

      for (const sheetName of selectedSheets) {
        const tableName = `${baseName}_${sheetName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const result = await loadSingleFile(filePath, tableName, { excelSheet: sheetName });
        if (result && !("error" in result)) {
          newTables.push(result);
        }
      }

      setPendingExcelImport(null);

      // Continue loading remaining files, or finalize
      if (remainingFiles.length > 0) {
        await loadFiles(remainingFiles, false, newTables);
      } else {
        setTables(newTables);
        // Initialize history for newly loaded tables
        for (const t of newTables) {
          if (!tableHistoriesRef.current.has(t.tableName)) {
            initializeTableHistory(t);
          }
        }
        if (newTables.length > 0) {
          setActiveTable(newTables[replace ? 0 : newTables.length - selectedSheets.length].tableName);
          setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
          setResetKey((k) => k + 1);
          setFilterPanelOpen(false);
        }
      }
    },
    [pendingExcelImport, loadSingleFile, loadFiles, initializeTableHistory]
  );

  // Handle CSV retry
  const handleRetryImport = useCallback(
    async (options: { csvDelimiter?: string; csvIgnoreErrors?: boolean }) => {
      if (!pendingRetry) return;
      const { filePath, tableName, otherFiles, remainingFiles } = pendingRetry;
      const newTables = [...otherFiles];

      const result = await loadSingleFile(filePath, tableName, options);
      if (result && !("error" in result)) {
        newTables.push(result);
      } else if (result && "error" in result) {
        // Still failing — update the error message
        setPendingRetry((prev) => prev ? { ...prev, errorMessage: result.error } : null);
        return;
      }

      setPendingRetry(null);

      // Continue loading remaining files, or finalize
      if (remainingFiles.length > 0) {
        await loadFiles(remainingFiles, false, newTables);
      } else {
        setTables(newTables);
        // Initialize history for newly loaded tables
        for (const t of newTables) {
          if (!tableHistoriesRef.current.has(t.tableName)) {
            initializeTableHistory(t);
          }
        }
        if (newTables.length > 0) {
          setActiveTable(newTables[newTables.length - 1].tableName);
          setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
          setResetKey((k) => k + 1);
          setFilterPanelOpen(false);
        }
      }
    },
    [pendingRetry, loadSingleFile, loadFiles, initializeTableHistory]
  );

  // Register IPC listeners once on mount
  useEffect(() => {
    window.api.onOpenFiles((filePaths) => loadFiles(filePaths, true));
    window.api.onAddFiles((filePaths) => loadFiles(filePaths, false));
    window.api.onExportCSV(() => {
      setExportDialogOpen(true);
    });
    window.api.onSetDarkMode((isDark) => {
      setDarkMode(isDark);
      localStorage.setItem("theme", isDark ? "dark" : "light");
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync dark mode class to body (for BlueprintJS dialogs rendered in portals) and menu checkbox
  useEffect(() => {
    document.body.classList.toggle("bp4-dark", darkMode);
    document.body.classList.toggle("dark-theme", darkMode);
    document.documentElement.classList.toggle("dark-theme", darkMode);
    window.api.syncTheme(darkMode);
  }, [darkMode]);

  // When active table changes, refresh schema and reset columns
  useEffect(() => {
    if (!activeTable) {
      setSchema([]);
      setViewState((prev) => ({ ...prev, visibleColumns: [], columnOrder: [] }));
      return;
    }

    const fetchSchema = async () => {
      try {
        const desc = await window.api.describe(activeTable);
        setSchema(desc);
        const allCols = desc.map((c: ColumnInfo) => c.column_name);
        setViewState((prev) => ({ ...prev, visibleColumns: allCols, columnOrder: allCols }));
      } catch (err) {
        console.error("Schema fetch error:", err);
      }
    };

    fetchSchema();
  }, [activeTable, schemaVersion]);

  // Clean up colOps and rowOps state when active table changes
  const prevActiveTableRef = useRef<string | null>(null);
  useEffect(() => {
    const prevTable = prevActiveTableRef.current;
    prevActiveTableRef.current = activeTable;

    if (prevTable && prevTable !== activeTable) {
      if (colOpsSteps.length > 0) {
        // Drop all colOps backup/snapshot tables for the previous table
        const dropColOpsBackups = async () => {
          for (const step of colOpsSteps) {
            if (step.backupTable) {
              try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
            }
          }
          try { await window.api.exec(`DROP TABLE IF EXISTS "__colops_snapshot_${prevTable}"`); } catch (_) { /* ignore */ }
        };
        dropColOpsBackups();
        setColOpsSteps([]);
        setUndoStrategy("per-step");
        setColOpsNextId(1);
      }

      if (rowOpsSteps.length > 0) {
        // Drop all rowOps backup/snapshot tables for the previous table
        const dropRowOpsBackups = async () => {
          for (const step of rowOpsSteps) {
            if (step.backupTable) {
              try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
            }
          }
          try { await window.api.exec(`DROP TABLE IF EXISTS "__rowops_snapshot_${prevTable}"`); } catch (_) { /* ignore */ }
        };
        dropRowOpsBackups();
        setRowOpsSteps([]);
        setRowOpsUndoStrategy("per-step");
        setRowOpsNextId(1);
      }
    }
  }, [activeTable]); // eslint-disable-line react-hooks/exhaustive-deps

  // Delete a table from DuckDB and state
  const handleDeleteTable = useCallback(async (tableName: string) => {
    try {
      await window.api.exec(`DROP TABLE IF EXISTS "${tableName}"`);
    } catch (err) {
      console.error("Drop table error:", err);
    }
    // Note: views are global now — keep them even when the source table is deleted
    setTables((prev) => {
      const remaining = prev.filter((t) => t.tableName !== tableName);
      if (activeTableRef.current === tableName) {
        const next = remaining.length > 0 ? remaining[0].tableName : null;
        setActiveTable(next);
        setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
        setResetKey((k) => k + 1);
      }
      return remaining;
    });
    // Remove history for the deleted table
    setTableHistories((prev) => {
      const next = new Map(prev);
      next.delete(tableName);
      return next;
    });
  }, []);

  // Open the column mapping dialog with selected tables
  const handleCombineOpen = useCallback((selectedNames: string[]) => {
    if (selectedNames.length < 2) return;
    setCombineTableNames(selectedNames);
    setCombineDialogOpen(true);
  }, []);

  // Execute the combine SQL produced by CombineDialog
  const handleCombineExecute = useCallback(async (sql: string) => {
    try {
      const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
      const combinedName = nextCombinedName(existingNames);

      await window.api.exec(
        `CREATE OR REPLACE TABLE "${combinedName}" AS ${sql}`
      );
      const desc = await window.api.describe(combinedName);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${combinedName}"`
      );
      const combinedTable: LoadedTable = {
        tableName: combinedName,
        filePath: "(combined)",
        schema: desc,
        rowCount: Number(countResult[0].count),
      };

      setTables((prev) => [...prev, combinedTable]);
      initializeTableHistory(combinedTable);
      setActiveTable(combinedName);
      setViewState((prev) => ({
        ...prev,
        filters: { logic: "AND", children: [] },
        visibleColumns: [],
        columnOrder: [],
        sortColumns: [],
      }));
      setResetKey((k) => k + 1);
      setCombineDialogOpen(false);
    } catch (err) {
      console.error("Combine error:", err);
    }
  }, [initializeTableHistory]);

  // Column visibility toggle
  const toggleColumn = useCallback(
    (colName: string) => {
      setViewState((prev) => {
        const visible = prev.visibleColumns.includes(colName)
          ? prev.visibleColumns.filter((c) => c !== colName)
          : [...prev.visibleColumns, colName];
        return { ...prev, visibleColumns: visible };
      });
      setResetKey((k) => k + 1);
    },
    []
  );

  // Column reorder from sidebar drag (reorders all columns)
  const reorderColumns = useCallback(
    (newOrder: string[]) => {
      setViewState((prev) => {
        const visibleSet = new Set(prev.visibleColumns);
        const newVisible = newOrder.filter((col) => visibleSet.has(col));
        return { ...prev, columnOrder: newOrder, visibleColumns: newVisible };
      });
    },
    []
  );

  // Column reorder from grid header drag (reorders visible columns only)
  const reorderVisibleColumns = useCallback(
    (newVisible: string[]) => {
      setViewState((prev) => {
        const visibleSet = new Set(newVisible);
        const newColumnOrder: string[] = [];
        let vi = 0;
        for (const col of prev.columnOrder) {
          if (visibleSet.has(col)) {
            newColumnOrder.push(newVisible[vi++]);
          } else {
            newColumnOrder.push(col);
          }
        }
        return { ...prev, columnOrder: newColumnOrder, visibleColumns: newVisible };
      });
    },
    []
  );

  // Sort handler
  const handleSort = useCallback((column: string, addLevel: boolean) => {
    setViewState((prev) => {
      const existing = prev.sortColumns.findIndex((sc) => sc.column === column);

      if (addLevel) {
        // Shift+click: add/toggle/remove sort level
        if (existing >= 0) {
          const current = prev.sortColumns[existing];
          if (current.direction === "ASC") {
            // Toggle to DESC
            const next = [...prev.sortColumns];
            next[existing] = { column, direction: "DESC" };
            return { ...prev, sortColumns: next };
          } else {
            // Remove from sort
            return { ...prev, sortColumns: prev.sortColumns.filter((_, i) => i !== existing) };
          }
        } else {
          // Add new sort level
          return { ...prev, sortColumns: [...prev.sortColumns, { column, direction: "ASC" }] };
        }
      } else {
        // Normal click: single-column sort
        if (prev.sortColumns.length === 1 && prev.sortColumns[0].column === column) {
          // Toggle direction or remove
          if (prev.sortColumns[0].direction === "ASC") {
            return { ...prev, sortColumns: [{ column, direction: "DESC" }] };
          } else {
            return { ...prev, sortColumns: [] };
          }
        }
        return { ...prev, sortColumns: [{ column, direction: "ASC" }] };
      }
    });
    setResetKey((k) => k + 1);
  }, []);

  // Clear all sorts
  const handleClearSort = useCallback(() => {
    setViewState((prev) => ({ ...prev, sortColumns: [] }));
    setResetKey((k) => k + 1);
  }, []);

  // ── Pivot View handlers ──

  const handlePivotGroup = useCallback((column: string, addLevel: boolean) => {
    setViewState((prev) => {
      // Auto-create pivotConfig if it doesn't exist
      const config = prev.pivotConfig ?? { groupColumns: [] as { column: string; direction: "ASC" | "DESC" }[], showGrandTotal: true, defaultAggFunction: "LIST" as const };

      const existing = config.groupColumns.findIndex((gc) => gc.column === column);

      if (addLevel) {
        if (existing >= 0) {
          const current = config.groupColumns[existing];
          if (current.direction === "ASC") {
            const next = [...config.groupColumns];
            next[existing] = { column, direction: "DESC" };
            return { ...prev, pivotConfig: { ...config, groupColumns: next } };
          } else {
            return {
              ...prev,
              pivotConfig: {
                ...config,
                groupColumns: config.groupColumns.filter((_, i) => i !== existing),
              },
            };
          }
        } else {
          return {
            ...prev,
            pivotConfig: {
              ...config,
              groupColumns: [...config.groupColumns, { column, direction: "ASC" }],
            },
          };
        }
      } else {
        if (config.groupColumns.length === 1 && config.groupColumns[0].column === column) {
          if (config.groupColumns[0].direction === "ASC") {
            return {
              ...prev,
              pivotConfig: { ...config, groupColumns: [{ column, direction: "DESC" }] },
            };
          } else {
            return { ...prev, pivotConfig: { ...config, groupColumns: [] } };
          }
        }
        return {
          ...prev,
          pivotConfig: { ...config, groupColumns: [{ column, direction: "ASC" }] },
        };
      }
    });
    setResetKey((k) => k + 1);
  }, []);

  const handleClearPivotGroups = useCallback(() => {
    setViewState((prev) => ({ ...prev, pivotConfig: null }));
    setResetKey((k) => k + 1);
  }, []);

  const handleGroupSort = useCallback((mode: "alpha" | "count", direction: "ASC" | "DESC" | null) => {
    setViewState((prev) => {
      if (!prev.pivotConfig) return prev;
      return {
        ...prev,
        pivotConfig: {
          ...prev.pivotConfig,
          groupSortMode: direction ? mode : null,
          groupSortDirection: direction ?? undefined,
        },
      };
    });
    setResetKey((k) => k + 1);
  }, []);

  const handleToggleGrandTotal = useCallback(() => {
    setViewState((prev) => {
      if (!prev.pivotConfig) return prev;
      return {
        ...prev,
        pivotConfig: { ...prev.pivotConfig, showGrandTotal: !prev.pivotConfig.showGrandTotal },
      };
    });
  }, []);

  const handleDefaultAggChange = useCallback((fn: PivotAggFunction) => {
    setViewState((prev) => {
      if (!prev.pivotConfig) return prev;
      return { ...prev, pivotConfig: { ...prev.pivotConfig, defaultAggFunction: fn } };
    });
    setResetKey((k) => k + 1);
  }, []);

  // Filters
  const handleFiltersChange = useCallback((filters: FilterGroup) => {
    setViewState((prev) => ({ ...prev, filters }));
    setResetKey((k) => k + 1);
  }, []);

  // ── Saved Views callbacks ──

  const handleSaveView = useCallback((name: string) => {
    if (!activeTable) return;
    const id = `view_${savedViewNextId}`;
    setSavedViewNextId((n) => n + 1);
    const now = Date.now();
    const newView: SavedView = {
      id,
      name,
      tableName: activeTable,
      viewState: JSON.parse(JSON.stringify(viewState)),
      createdAt: now,
      updatedAt: now,
    };
    setSavedViews((prev) => [...prev, newView]);
  }, [activeTable, viewState, savedViewNextId]);

  const handleApplyView = useCallback((view: SavedView) => {
    const vs: ViewState = JSON.parse(JSON.stringify(view.viewState));
    // Silently filter visible columns and column order to what exists in current schema
    const currentCols = new Set(schema.map((c) => c.column_name));
    vs.columnOrder = vs.columnOrder.filter((c) => currentCols.has(c));
    vs.visibleColumns = vs.visibleColumns.filter((c) => currentCols.has(c));
    // If columnOrder is empty after filtering, fall back to current schema order
    if (vs.columnOrder.length === 0) {
      vs.columnOrder = schema.map((c) => c.column_name);
      vs.visibleColumns = [...vs.columnOrder];
    }
    setViewState(vs);
    setResetKey((k) => k + 1);
  }, [schema]);

  const handleUpdateView = useCallback((viewId: string) => {
    setSavedViews((prev) =>
      prev.map((v) =>
        v.id === viewId
          ? { ...v, viewState: JSON.parse(JSON.stringify(viewState)), updatedAt: Date.now() }
          : v
      )
    );
  }, [viewState]);

  const handleDeleteView = useCallback((viewId: string) => {
    setSavedViews((prev) => prev.filter((v) => v.id !== viewId));
  }, []);

  const handleRenameView = useCallback((viewId: string, newName: string) => {
    setSavedViews((prev) =>
      prev.map((v) =>
        v.id === viewId ? { ...v, name: newName, updatedAt: Date.now() } : v
      )
    );
  }, []);

  // Data operation: run SQL to transform columns/rows
  const handleDataOperation = useCallback(
    async (sql: string, description?: string) => {
      if (!activeTable) return;
      try {
        await window.api.exec(sql);
        recordHistoryEntry(activeTable, "data_op", description || "Data operation", [sql]);
        setSchemaVersion((v) => v + 1);
        setDataVersion((v) => v + 1);
        setResetKey((k) => k + 1);

        // Refresh schema (operations like remove_duplicates use CREATE OR REPLACE)
        const newSchema = await window.api.describe(activeTable);
        setSchema(newSchema);

        // Update row count in tables state
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${activeTable}"`
        );
        setTables((prev) =>
          prev.map((t) =>
            t.tableName === activeTable
              ? { ...t, rowCount: Number(countResult[0].count) }
              : t
          )
        );
      } catch (err) {
        console.error("Data operation error:", err);
      }
    },
    [activeTable, recordHistoryEntry]
  );

  // Sample table: create a new table with a random sample of rows
  const handleSampleTable = useCallback(
    async (n: number, isPercent: boolean) => {
      if (!activeTable) return;
      try {
        const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
        const sampleName = nextSampleName(existingNames);
        const sampleClause = isPercent ? `${n} PERCENT` : `${n} ROWS`;
        await window.api.exec(
          `CREATE TABLE "${sampleName}" AS SELECT * FROM "${activeTable}" USING SAMPLE ${sampleClause}`
        );
        const desc = await window.api.describe(sampleName);
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${sampleName}"`
        );
        const sampleTable: LoadedTable = {
          tableName: sampleName,
          filePath: "(sample)",
          schema: desc,
          rowCount: Number(countResult[0].count),
        };

        setTables((prev) => [...prev, sampleTable]);
        initializeTableHistory(sampleTable);
        setActiveTable(sampleName);
        setViewState((prev) => ({
          ...prev,
          filters: { logic: "AND", children: [] },
          visibleColumns: [],
          columnOrder: [],
          sortColumns: [],
        }));
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error("Sample table error:", err);
      }
    },
    [activeTable, initializeTableHistory]
  );

  // Create aggregate table from a SELECT SQL
  const handleCreateAggregateTable = useCallback(
    async (sql: string) => {
      try {
        const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
        const aggName = nextAggregateName(existingNames);

        await window.api.exec(
          `CREATE TABLE "${aggName}" AS ${sql}`
        );
        const desc = await window.api.describe(aggName);
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${aggName}"`
        );
        const aggTable: LoadedTable = {
          tableName: aggName,
          filePath: "(aggregate)",
          schema: desc,
          rowCount: Number(countResult[0].count),
        };

        setTables((prev) => [...prev, aggTable]);
        initializeTableHistory(aggTable);
        setActiveTable(aggName);
        setViewState((prev) => ({
          ...prev,
          filters: { logic: "AND", children: [] },
          visibleColumns: [],
          columnOrder: [],
          sortColumns: [],
        }));
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error("Aggregate table error:", err);
      }
    },
    [initializeTableHistory]
  );

  // Create pivot table from a PIVOT SQL
  const handleCreatePivotTable = useCallback(
    async (sql: string) => {
      try {
        const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
        const pivotName = nextPivotName(existingNames);

        await window.api.exec(
          `CREATE TABLE "${pivotName}" AS (${sql})`
        );
        const desc = await window.api.describe(pivotName);
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${pivotName}"`
        );
        const pivotTable: LoadedTable = {
          tableName: pivotName,
          filePath: "(pivot)",
          schema: desc,
          rowCount: Number(countResult[0].count),
        };

        setTables((prev) => [...prev, pivotTable]);
        initializeTableHistory(pivotTable);
        setActiveTable(pivotName);
        setViewState((prev) => ({
          ...prev,
          filters: { logic: "AND", children: [] },
          visibleColumns: [],
          columnOrder: [],
          sortColumns: [],
        }));
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error("Pivot table error:", err);
      }
    },
    [initializeTableHistory]
  );

  // Lookup merge: join data from another table into the active table
  const handleLookupMerge = useCallback(
    async (sql: string, options: { replaceActive: boolean }) => {
      if (!activeTable) return;
      try {
        if (options.replaceActive) {
          const execSql = `CREATE OR REPLACE TABLE ${escapeIdent(activeTable)} AS (${sql})`;
          await window.api.exec(execSql);
          recordHistoryEntry(activeTable, "data_op", "Lookup merge (replace active)", [execSql]);
          const countResult = await window.api.query(
            `SELECT COUNT(*) as count FROM ${escapeIdent(activeTable)}`
          );
          setTables((prev) =>
            prev.map((t) =>
              t.tableName === activeTable
                ? { ...t, rowCount: Number(countResult[0].count) }
                : t
            )
          );
          setSchemaVersion((v) => v + 1);
          setResetKey((k) => k + 1);
        } else {
          const existingNames = new Set(tablesRef.current.map((t) => t.tableName));
          const mergeName = nextMergeName(existingNames);
          await window.api.exec(
            `CREATE TABLE ${escapeIdent(mergeName)} AS (${sql})`
          );
          const desc = await window.api.describe(mergeName);
          const countResult = await window.api.query(
            `SELECT COUNT(*) as count FROM ${escapeIdent(mergeName)}`
          );
          const mergeTable: LoadedTable = {
            tableName: mergeName,
            filePath: "(merge)",
            schema: desc,
            rowCount: Number(countResult[0].count),
          };
          setTables((prev) => [...prev, mergeTable]);
          initializeTableHistory(mergeTable);
          setActiveTable(mergeName);
          setViewState((prev) => ({
            ...prev,
            filters: { logic: "AND", children: [] },
            visibleColumns: [],
            columnOrder: [],
            sortColumns: [],
          }));
          setResetKey((k) => k + 1);
        }
      } catch (err) {
        console.error("Lookup merge error:", err);
        throw err;
      }
    },
    [activeTable, initializeTableHistory, recordHistoryEntry]
  );

  // ── Column Ops handlers ──

  const chooseUndoStrategy = useCallback(
    async (rowCount: number, numColumns: number): Promise<UndoStrategy> => {
      try {
        const freeMemBytes = await window.api.getFreeMemory();
        const estimatedTableSize = rowCount * numColumns * 100;
        if (estimatedTableSize > freeMemBytes * 0.15) return "snapshot";
      } catch (_) { /* fallback to per-step */ }
      return "per-step";
    },
    []
  );

  const handleColOpApply = useCallback(
    async (opType: ColOpType, column: string, params: Record<string, string>) => {
      if (!activeTable) return;

      const currentTable = activeTable;
      const isFirstOp = colOpsSteps.length === 0;

      // Determine strategy on first op
      let strategy = undoStrategy;
      if (isFirstOp) {
        const tableInfo = tables.find((t) => t.tableName === currentTable);
        const rowCount = tableInfo?.rowCount ?? 0;
        const numCols = schema.length;
        strategy = await chooseUndoStrategy(rowCount, numCols);
        setUndoStrategy(strategy);
      }

      const stepId = colOpsNextId;
      let backupName = "";

      try {
        if (strategy === "per-step") {
          backupName = `__colops_backup_${stepId}_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${backupName}" AS SELECT * FROM "${currentTable}"`
          );
        } else if (strategy === "snapshot" && isFirstOp) {
          const snapshotName = `__colops_snapshot_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${snapshotName}" AS SELECT * FROM "${currentTable}"`
          );
        }

        // Determine target column from params (backward compatible)
        const targetMode = (params.targetMode as "replace" | "new_column" | "existing_column") || "replace";
        const targetColumn = targetMode === "replace" ? undefined : params.targetColumn;

        // Collect SQL statements for history
        const executedSql: string[] = [];

        // Determine column type for new_column mode
        // extract_numbers with integer/float in "first" mode produces numeric types
        const extractNumType = opType === "extract_numbers" && params.mode !== "all"
          ? params.numberType ?? "any"
          : null;
        const newColType = extractNumType === "integer" ? "BIGINT"
          : extractNumType === "float" ? "DOUBLE"
          : "VARCHAR";

        // For "new_column" mode, add the column first
        if (targetMode === "new_column" && targetColumn) {
          const addColSql = `ALTER TABLE "${currentTable}" ADD COLUMN "${targetColumn}" ${newColType}`;
          await window.api.exec(addColSql);
          executedSql.push(addColSql);
        }

        // If the operation produces string output, ensure the target column is VARCHAR
        const STRING_OPS: Set<ColOpType> = new Set([
          "prefix_suffix", "find_replace", "regex_extract", "upper", "lower", "trim", "assign_value",
        ]);
        // extract_numbers in "all" mode or "any" type also produces string output
        const isStringOp = STRING_OPS.has(opType)
          || (opType === "extract_numbers" && (params.mode === "all" || (params.numberType ?? "any") === "any"));
        if (isStringOp) {
          // For "existing_column" mode, promote the target column; otherwise promote the source column
          const colToPromote = (targetMode === "existing_column" && targetColumn) ? targetColumn : column;
          const colInfo = schema.find((c) => c.column_name === colToPromote);
          const colType = colInfo?.column_type?.toUpperCase() ?? "";
          // Skip promotion for new_column (already set to correct type)
          if (targetMode !== "new_column" && colType && !colType.startsWith("VARCHAR") && colType !== "TEXT" && colType !== "STRING") {
            const alterSql = `ALTER TABLE "${currentTable}" ALTER COLUMN "${colToPromote}" TYPE VARCHAR`;
            await window.api.exec(alterSql);
            executedSql.push(alterSql);
          }
        }

        // Execute the UPDATE
        const sql = buildColOpUpdateSQL(currentTable, column, opType, params, viewState.filters, targetColumn);
        await window.api.exec(sql);
        executedSql.push(sql);

        // Record step
        const description = buildStepDescription(opType, column, params, targetColumn);
        const step: ColOpStep = {
          id: stepId,
          opType,
          column,
          description,
          backupTable: backupName,
          timestamp: Date.now(),
        };

        setColOpsSteps((prev) => [...prev, step]);
        setColOpsNextId((prev) => prev + 1);
        setDataVersion((v) => v + 1);
        setResetKey((k) => k + 1);

        // Record in global history
        recordHistoryEntry(currentTable, "col_op", description, executedSql);

        // Refresh schema (column type may have changed from ALTER)
        const newSchema = await window.api.describe(currentTable);
        setSchema(newSchema);

        // If a new column was added, include it in visibleColumns and columnOrder
        if (targetMode === "new_column" && targetColumn) {
          setViewState((prev) => ({
            ...prev,
            visibleColumns: prev.visibleColumns.includes(targetColumn) ? prev.visibleColumns : [...prev.visibleColumns, targetColumn],
            columnOrder: prev.columnOrder.includes(targetColumn) ? prev.columnOrder : [...prev.columnOrder, targetColumn],
          }));
        }

        // Update row count in tables state
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${currentTable}"`
        );
        setTables((prev) =>
          prev.map((t) =>
            t.tableName === currentTable
              ? { ...t, rowCount: Number(countResult[0].count) }
              : t
          )
        );
      } catch (err) {
        // If backup was created but UPDATE failed, drop the backup
        if (backupName) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${backupName}"`); } catch (_) { /* ignore */ }
        }
        throw err;
      }
    },
    [activeTable, colOpsSteps, undoStrategy, colOpsNextId, viewState.filters, tables, schema, chooseUndoStrategy, recordHistoryEntry]
  );

  const handleColOpUndo = useCallback(
    async () => {
      if (!activeTable || colOpsSteps.length === 0) return;
      const lastStep = colOpsSteps[colOpsSteps.length - 1];
      if (!lastStep.backupTable) return;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${lastStep.backupTable}" RENAME TO "${activeTable}"`);

      setColOpsSteps((prev) => prev.slice(0, -1));
      setDataVersion((v) => v + 1);
      setSchemaVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${activeTable}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    [activeTable, colOpsSteps]
  );

  const handleColOpRevertAll = useCallback(
    async () => {
      if (!activeTable || colOpsSteps.length === 0) return;
      const snapshotName = `__colops_snapshot_${activeTable}`;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${snapshotName}" RENAME TO "${activeTable}"`);

      setColOpsSteps([]);
      setColOpsNextId(1);
      setUndoStrategy("per-step");
      setDataVersion((v) => v + 1);
      setSchemaVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${activeTable}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    [activeTable, colOpsSteps]
  );

  const handleColOpClearAll = useCallback(
    async () => {
      if (!activeTable) return;

      // Drop all backup tables
      for (const step of colOpsSteps) {
        if (step.backupTable) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
        }
      }
      // Drop snapshot if exists
      try { await window.api.exec(`DROP TABLE IF EXISTS "__colops_snapshot_${activeTable}"`); } catch (_) { /* ignore */ }

      setColOpsSteps([]);
      setColOpsNextId(1);
      setUndoStrategy("per-step");
    },
    [activeTable, colOpsSteps]
  );

  // ── Row Ops handlers ──

  const handleRowOpApply = useCallback(
    async (opType: RowOpType, params: Record<string, string>) => {
      if (!activeTable) return;

      const currentTable = activeTable;
      const isFirstOp = rowOpsSteps.length === 0;

      // Determine strategy on first op
      let strategy = rowOpsUndoStrategy;
      if (isFirstOp) {
        const tableInfo = tables.find((t) => t.tableName === currentTable);
        const rowCount = tableInfo?.rowCount ?? 0;
        const numCols = schema.length;
        strategy = await chooseUndoStrategy(rowCount, numCols);
        setRowOpsUndoStrategy(strategy);
      }

      const stepId = rowOpsNextId;
      let backupName = "";

      try {
        if (strategy === "per-step") {
          backupName = `__rowops_backup_${stepId}_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${backupName}" AS SELECT * FROM "${currentTable}"`
          );
        } else if (strategy === "snapshot" && isFirstOp) {
          const snapshotName = `__rowops_snapshot_${currentTable}`;
          await window.api.exec(
            `CREATE TABLE "${snapshotName}" AS SELECT * FROM "${currentTable}"`
          );
        }

        // Execute the row operation SQL
        const sql = buildRowOpSQL(currentTable, opType, params, viewState.filters, schema);
        await window.api.exec(sql);

        // Record step
        const description = buildRowOpStepDescription(opType, params);
        const step: RowOpStep = {
          id: stepId,
          opType,
          description,
          backupTable: backupName,
          timestamp: Date.now(),
        };

        setRowOpsSteps((prev) => [...prev, step]);
        setRowOpsNextId((prev) => prev + 1);
        setDataVersion((v) => v + 1);
        setResetKey((k) => k + 1);

        // Record in global history
        recordHistoryEntry(currentTable, "row_op", description, [sql]);

        // Refresh schema (remove_duplicates uses CREATE OR REPLACE)
        const newSchema = await window.api.describe(currentTable);
        setSchema(newSchema);

        // Update row count in tables state
        const countResult = await window.api.query(
          `SELECT COUNT(*) as count FROM "${currentTable}"`
        );
        setTables((prev) =>
          prev.map((t) =>
            t.tableName === currentTable
              ? { ...t, rowCount: Number(countResult[0].count) }
              : t
          )
        );
      } catch (err) {
        // If backup was created but operation failed, drop the backup
        if (backupName) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${backupName}"`); } catch (_) { /* ignore */ }
        }
        throw err;
      }
    },
    [activeTable, rowOpsSteps, rowOpsUndoStrategy, rowOpsNextId, viewState.filters, tables, schema, chooseUndoStrategy, recordHistoryEntry]
  );

  const handleRowOpUndo = useCallback(
    async () => {
      if (!activeTable || rowOpsSteps.length === 0) return;
      const lastStep = rowOpsSteps[rowOpsSteps.length - 1];
      if (!lastStep.backupTable) return;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${lastStep.backupTable}" RENAME TO "${activeTable}"`);

      setRowOpsSteps((prev) => prev.slice(0, -1));
      setDataVersion((v) => v + 1);
      setSchemaVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${activeTable}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    [activeTable, rowOpsSteps]
  );

  const handleRowOpRevertAll = useCallback(
    async () => {
      if (!activeTable || rowOpsSteps.length === 0) return;
      const snapshotName = `__rowops_snapshot_${activeTable}`;

      await window.api.exec(`DROP TABLE IF EXISTS "${activeTable}"`);
      await window.api.exec(`ALTER TABLE "${snapshotName}" RENAME TO "${activeTable}"`);

      setRowOpsSteps([]);
      setRowOpsNextId(1);
      setRowOpsUndoStrategy("per-step");
      setDataVersion((v) => v + 1);
      setSchemaVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(activeTable);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${activeTable}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === activeTable
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    [activeTable, rowOpsSteps]
  );

  const handleRowOpClearAll = useCallback(
    async () => {
      if (!activeTable) return;

      // Drop all backup tables
      for (const step of rowOpsSteps) {
        if (step.backupTable) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
        }
      }
      // Drop snapshot if exists
      try { await window.api.exec(`DROP TABLE IF EXISTS "__rowops_snapshot_${activeTable}"`); } catch (_) { /* ignore */ }

      setRowOpsSteps([]);
      setRowOpsNextId(1);
      setRowOpsUndoStrategy("per-step");
    },
    [activeTable, rowOpsSteps]
  );

  // ── History revert / export / import ──

  const handleRevertToEntry = useCallback(
    async (tableName: string, entryId: number, onProgress?: (step: number, total: number, description: string) => void) => {
      const history = tableHistoriesRef.current.get(tableName);
      if (!history) throw new Error("No history for this table");
      if (history.sourceInfo.isGenerated) throw new Error("Cannot revert generated tables");

      const { filePath, importOptions } = history.sourceInfo;

      // Check file exists
      const exists = await window.api.fileExists(filePath);
      if (!exists) throw new Error(`Source file not found at "${filePath}"`);

      onProgress?.(0, 0, "Re-reading source file...");

      // Drop current table
      await window.api.exec(`DROP TABLE IF EXISTS "${tableName}"`);

      // Re-read the file
      const result = await window.api.loadFile(filePath, tableName, importOptions);
      if (result.error) throw new Error(`Failed to re-load file: ${result.error}`);

      // Validate schema: check that all initial columns are present
      const loadedColNames = new Set((result.schema as ColumnInfo[]).map((c: ColumnInfo) => c.column_name));
      const missingCols = history.initialSchema
        .map((c) => c.column_name)
        .filter((name) => !loadedColNames.has(name));
      if (missingCols.length > 0) {
        throw new Error(`Source file schema changed. Missing columns: ${missingCols.join(", ")}`);
      }

      // Determine which entries to replay
      const entriesToReplay = entryId === -1
        ? [] // revert to original = no replay
        : history.entries.filter((e) => e.id <= entryId);

      // Replay SQL statements in order
      for (let i = 0; i < entriesToReplay.length; i++) {
        const entry = entriesToReplay[i];
        onProgress?.(i + 1, entriesToReplay.length, entry.description);
        for (const sql of entry.sqlStatements) {
          try {
            await window.api.exec(sql);
          } catch (err) {
            throw new Error(`Replay failed at step ${i + 1} ("${entry.description}"): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // Trim history entries after the revert point, update timestamps to now
      const now = Date.now();
      setTableHistories((prev) => {
        const h = prev.get(tableName);
        if (!h) return prev;
        const next = new Map(prev);
        const kept = entryId === -1
          ? []
          : h.entries
              .filter((e) => e.id <= entryId)
              .map((e) => ({ ...e, timestamp: now }));
        next.set(tableName, {
          ...h,
          entries: kept,
          nextEntryId: entryId === -1 ? 1 : entryId + 1,
        });
        return next;
      });

      // Clear existing undo state (backup tables are gone)
      setColOpsSteps([]);
      setColOpsNextId(1);
      setUndoStrategy("per-step");
      setRowOpsSteps([]);
      setRowOpsNextId(1);
      setRowOpsUndoStrategy("per-step");

      // Refresh schema and data
      setSchemaVersion((v) => v + 1);
      setDataVersion((v) => v + 1);
      setResetKey((k) => k + 1);

      // Refresh schema and row count
      const newSchema = await window.api.describe(tableName);
      setSchema(newSchema);
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "${tableName}"`
      );
      setTables((prev) =>
        prev.map((t) =>
          t.tableName === tableName
            ? { ...t, rowCount: Number(countResult[0].count) }
            : t
        )
      );
    },
    []
  );

  const handleExportHistory = useCallback(async () => {
    const filePath = await window.api.saveFileDialog("json");
    if (!filePath) return;
    const exportData: HistoryExportData = {
      version: 1,
      exportedAt: Date.now(),
      tables: Array.from(tableHistoriesRef.current.values()),
    };
    await window.api.writeJsonFile(filePath, exportData);
  }, []);

  const handleImportHistory = useCallback(async () => {
    const data = await window.api.readJsonFile();
    if (!data || data.error) return;
    const imported = data as HistoryExportData;
    if (imported.version !== 1 || !Array.isArray(imported.tables)) return;

    const currentTableNames = new Set(tablesRef.current.map((t) => t.tableName));
    let merged = 0;
    let skipped = 0;

    setTableHistories((prev) => {
      const next = new Map(prev);
      for (const th of imported.tables) {
        if (currentTableNames.has(th.tableName)) {
          next.set(th.tableName, th);
          merged++;
        } else {
          skipped++;
        }
      }
      return next;
    });

    console.log(`History import: ${merged} table(s) merged, ${skipped} skipped (tables not found)`);
  }, []);

  const hasData = tables.length > 0;

  return (
    <div className={`app-container${darkMode ? " bp4-dark dark-theme" : ""}`}>
      <div className="main-layout">
        {sidebarVisible ? (
          <Sidebar
            tables={tables}
            activeTable={activeTable}
            schema={schema}
            visibleColumns={viewState.visibleColumns}
            columnOrder={viewState.columnOrder}
            sortColumns={viewState.sortColumns}
            onSort={handleSort}
            onClearSort={handleClearSort}
            pivotConfig={viewState.pivotConfig}
            onPivotGroup={handlePivotGroup}
            onClearPivotGroups={handleClearPivotGroups}
            onSelectTable={(name) => {
              setActiveTable(name);
              setViewState((prev) => ({
                ...prev,
                filters: { logic: "AND", children: [] },
                visibleColumns: [],
                columnOrder: [],
                sortColumns: [],
                pivotConfig: null,
              }));
              setResetKey((k) => k + 1);
            }}
            onToggleColumn={toggleColumn}
            onSetVisibleColumns={(cols: string[]) => {
              setViewState((prev) => ({ ...prev, visibleColumns: cols }));
              setResetKey((k) => k + 1);
            }}
            onReorderColumns={reorderColumns}
            onDataOperation={handleDataOperation}
            onSampleTable={handleSampleTable}
            onDeleteTable={handleDeleteTable}
            onCombine={handleCombineOpen}
            onCreateAggregateTable={handleCreateAggregateTable}
            onCreatePivotTable={handleCreatePivotTable}
            onLookupMerge={handleLookupMerge}
            onExport={() => setExportDialogOpen(true)}
            onOpenHistory={() => setHistoryDialogOpen(true)}
            onHide={() => setSidebarVisible(false)}
          />
        ) : (
          <div className="sidebar-collapsed">
            <Button
              icon="chevron-right"
              minimal
              small
              onClick={() => setSidebarVisible(true)}
              title="Show sidebar"
            />
          </div>
        )}
        <div className="data-area">
          {hasData ? (
            <>
              {pivotActive && viewState.pivotConfig && (
                <PivotToolbar
                  pivotConfig={viewState.pivotConfig}
                  onExpandAll={pivotExpandAll}
                  onCollapseAll={pivotCollapseAll}
                  onToggleGrandTotal={handleToggleGrandTotal}
                  onDefaultAggChange={handleDefaultAggChange}
                  onExitPivot={handleClearPivotGroups}
                />
              )}
              <DataGrid
                totalRows={pivotActive ? pivotFlatRows.length : totalRows}
                getRow={pivotActive ? () => null : getRow}
                ensureRange={pivotActive ? pivotEnsureRange : ensureRange}
                columns={viewState.visibleColumns}
                sortColumns={viewState.sortColumns}
                onSort={handleSort}
                onReorderColumns={pivotActive ? undefined : reorderVisibleColumns}
                resetKey={resetKey}
                pivotMode={pivotActive}
                pivotFlatRows={pivotActive ? pivotFlatRows : undefined}
                pivotGroupColumns={pivotActive ? viewState.pivotConfig?.groupColumns : undefined}
                onToggleExpand={pivotActive ? pivotToggleExpand : undefined}
                grandTotals={pivotActive ? pivotGrandTotals : undefined}
                showGrandTotal={pivotActive ? viewState.pivotConfig?.showGrandTotal : undefined}
                numericColumns={pivotActive ? numericColumns : undefined}
                groupSortMode={pivotActive ? viewState.pivotConfig?.groupSortMode : undefined}
                groupSortDirection={pivotActive ? viewState.pivotConfig?.groupSortDirection : undefined}
                onGroupSort={pivotActive ? handleGroupSort : undefined}
              />
              {filterPanelOpen && (
                <FilterPanel
                  columns={schema}
                  activeFilters={viewState.filters}
                  activeTable={activeTable}
                  onApplyFilters={handleFiltersChange}
                  colOpsSteps={colOpsSteps}
                  undoStrategy={undoStrategy}
                  onColOpApply={handleColOpApply}
                  onColOpUndo={handleColOpUndo}
                  onColOpRevertAll={handleColOpRevertAll}
                  onColOpClearAll={handleColOpClearAll}
                  rowOpsSteps={rowOpsSteps}
                  rowOpsUndoStrategy={rowOpsUndoStrategy}
                  onRowOpApply={handleRowOpApply}
                  onRowOpUndo={handleRowOpUndo}
                  onRowOpRevertAll={handleRowOpRevertAll}
                  onRowOpClearAll={handleRowOpClearAll}
                  totalRows={totalRows}
                  unfilteredRows={
                    hasActiveFilters(viewState.filters)
                      ? tables.find((t) => t.tableName === activeTable)?.rowCount ?? null
                      : null
                  }
                  savedViews={savedViews}
                  currentViewState={viewState}
                  onSaveView={handleSaveView}
                  onApplyView={handleApplyView}
                  onUpdateView={handleUpdateView}
                  onDeleteView={handleDeleteView}
                  onRenameView={handleRenameView}
                  onClose={() => setFilterPanelOpen(false)}
                />
              )}
            </>
          ) : (
            <div className="welcome">
              <h2>Chikku Parser</h2>
              <p>Open files to get started (Cmd+O / Ctrl+O)</p>
              <p>Add more files to combine them (Cmd+Shift+O / Ctrl+Shift+O)</p>
            </div>
          )}
        </div>
      </div>
      <StatusBar
        totalRows={pivotActive ? (tables.find((t) => t.tableName === activeTable)?.rowCount ?? 0) : totalRows}
        unfilteredRows={
          hasActiveFilters(viewState.filters)
            ? tables.find((t) => t.tableName === activeTable)?.rowCount ?? null
            : null
        }
        activeTable={activeTable}
        pivotConfig={viewState.pivotConfig}
        groupCount={pivotActive ? pivotGroupCount : 0}
        filterPanelOpen={filterPanelOpen}
        onToggleFilterPanel={() => setFilterPanelOpen((v) => !v)}
        activeFilterCount={countConditions(viewState.filters)}
        sidebarVisible={sidebarVisible}
      />
      <CombineDialog
        isOpen={combineDialogOpen}
        tables={tables.filter(
          (t) => combineTableNames.includes(t.tableName)
        )}
        onClose={() => setCombineDialogOpen(false)}
        onCombine={handleCombineExecute}
      />
      <ExportDialog
        isOpen={exportDialogOpen}
        onClose={() => setExportDialogOpen(false)}
        tables={tables}
        activeTable={activeTable}
        viewState={viewState}
        schema={schema}
      />
      <HistoryDialog
        isOpen={historyDialogOpen}
        onClose={() => setHistoryDialogOpen(false)}
        tables={tables}
        activeTable={activeTable}
        histories={tableHistories}
        onRevertToEntry={handleRevertToEntry}
        onExportHistory={handleExportHistory}
        onImportHistory={handleImportHistory}
      />
      {pendingExcelImport && (
        <ExcelSheetPickerDialog
          isOpen={true}
          fileName={pendingExcelImport.fileName}
          sheets={pendingExcelImport.sheets}
          onClose={() => {
            const { otherFiles, remainingFiles } = pendingExcelImport;
            setPendingExcelImport(null);
            // Skip this Excel file, continue with remaining files or finalize already-loaded tables
            if (remainingFiles.length > 0) {
              loadFiles(remainingFiles, false, otherFiles);
            } else if (otherFiles.length > 0) {
              setTables(otherFiles);
              setActiveTable(otherFiles[0].tableName);
              setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
              setResetKey((k) => k + 1);
              setFilterPanelOpen(false);
            }
          }}
          onImport={handleExcelSheetImport}
        />
      )}
      {pendingRetry && (
        <ImportRetryDialog
          isOpen={true}
          filePath={pendingRetry.filePath}
          errorMessage={pendingRetry.errorMessage}
          onClose={() => {
            const { otherFiles, remainingFiles } = pendingRetry;
            setPendingRetry(null);
            // Skip this file, continue with remaining files or finalize already-loaded tables
            if (remainingFiles.length > 0) {
              loadFiles(remainingFiles, false, otherFiles);
            } else if (otherFiles.length > 0) {
              setTables(otherFiles);
              setActiveTable(otherFiles[0].tableName);
              setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
              setResetKey((k) => k + 1);
              setFilterPanelOpen(false);
            }
          }}
          onRetry={handleRetryImport}
        />
      )}
    </div>
  );
}
