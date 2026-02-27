import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@blueprintjs/core";
import { LoadedTable, ViewState, ColumnInfo, FilterGroup, SheetInfo, hasActiveFilters, ColOpType, ColOpStep, RowOpType, RowOpStep, UndoStrategy, SortColumn } from "../types";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
import { FilterPanel } from "./FilterPanel";
import { StatusBar } from "./StatusBar";
import { CombineDialog } from "./CombineDialog";
import { ExcelSheetPickerDialog } from "./ExcelSheetPickerDialog";
import { ImportRetryDialog } from "./ImportRetryDialog";
import { ExportDialog } from "./ExportDialog";
import { buildCombineQuery } from "../utils/sqlBuilder";
import { buildColOpUpdateSQL, buildStepDescription } from "../utils/colOpsSQL";
import { buildRowOpSQL, buildRowOpStepDescription } from "../utils/rowOpsSQL";
import { useChunkCache } from "../hooks/useChunkCache";

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
  });

  // Use refs so IPC callbacks always see latest state
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const activeTableRef = useRef(activeTable);
  activeTableRef.current = activeTable;

  // Chunk cache for lazy-loaded virtual scrolling
  const { totalRows, getRow, ensureRange } = useChunkCache({
    tableName: activeTable,
    viewState,
    enabled: viewState.visibleColumns.length > 0,
    dataVersion,
  });

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

      if (newTables.length > 0) {
        setActiveTable(newTables[0].tableName);
        setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
        setResetKey((k) => k + 1);
        setFilterPanelOpen(false);
      }
    },
    [loadSingleFile]
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
        if (newTables.length > 0) {
          setActiveTable(newTables[replace ? 0 : newTables.length - selectedSheets.length].tableName);
          setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
          setResetKey((k) => k + 1);
          setFilterPanelOpen(false);
        }
      }
    },
    [pendingExcelImport, loadSingleFile, loadFiles]
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
        if (newTables.length > 0) {
          setActiveTable(newTables[newTables.length - 1].tableName);
          setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
          setResetKey((k) => k + 1);
          setFilterPanelOpen(false);
        }
      }
    },
    [pendingRetry, loadSingleFile, loadFiles]
  );

  // Register IPC listeners once on mount
  useEffect(() => {
    window.api.onOpenFiles((filePaths) => loadFiles(filePaths, true));
    window.api.onAddFiles((filePaths) => loadFiles(filePaths, false));
    window.api.onExportCSV(() => {
      setExportDialogOpen(true);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
  }, []);

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

  // Filters
  const handleFiltersChange = useCallback((filters: FilterGroup) => {
    setViewState((prev) => ({ ...prev, filters }));
    setResetKey((k) => k + 1);
  }, []);

  // Data operation: run SQL to transform columns/rows
  const handleDataOperation = useCallback(
    async (sql: string) => {
      if (!activeTable) return;
      try {
        await window.api.exec(sql);
        setSchemaVersion((v) => v + 1);
        setResetKey((k) => k + 1);
      } catch (err) {
        console.error("Data operation error:", err);
      }
    },
    [activeTable]
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
    [activeTable]
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
    []
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
    []
  );

  // Lookup merge: join data from another table into the active table
  const handleLookupMerge = useCallback(
    async (sql: string, options: { replaceActive: boolean }) => {
      if (!activeTable) return;
      try {
        if (options.replaceActive) {
          await window.api.exec(
            `CREATE OR REPLACE TABLE ${escapeIdent(activeTable)} AS (${sql})`
          );
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
    [activeTable]
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

        // If the operation produces string output, ensure the column is VARCHAR
        const STRING_OPS: Set<ColOpType> = new Set([
          "prefix_suffix", "find_replace", "regex_extract", "upper", "lower", "trim", "assign_value",
        ]);
        if (STRING_OPS.has(opType)) {
          const colInfo = schema.find((c) => c.column_name === column);
          const colType = colInfo?.column_type?.toUpperCase() ?? "";
          if (colType && !colType.startsWith("VARCHAR") && colType !== "TEXT" && colType !== "STRING") {
            await window.api.exec(
              `ALTER TABLE "${currentTable}" ALTER COLUMN "${column}" TYPE VARCHAR`
            );
          }
        }

        // Execute the UPDATE
        const sql = buildColOpUpdateSQL(currentTable, column, opType, params, viewState.filters);
        await window.api.exec(sql);

        // Record step
        const description = buildStepDescription(opType, column, params);
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

        // Refresh schema (column type may have changed from ALTER)
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
        // If backup was created but UPDATE failed, drop the backup
        if (backupName) {
          try { await window.api.exec(`DROP TABLE IF EXISTS "${backupName}"`); } catch (_) { /* ignore */ }
        }
        throw err;
      }
    },
    [activeTable, colOpsSteps, undoStrategy, colOpsNextId, viewState.filters, tables, schema, chooseUndoStrategy]
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

      // Update row count
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

      // Update row count
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
    [activeTable, rowOpsSteps, rowOpsUndoStrategy, rowOpsNextId, viewState.filters, tables, schema, chooseUndoStrategy]
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

      // Update row count
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

      // Update row count
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

  const hasData = tables.length > 0;

  return (
    <div className="app-container">
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
            onSelectTable={(name) => {
              setActiveTable(name);
              setViewState((prev) => ({
                ...prev,
                filters: { logic: "AND", children: [] },
                visibleColumns: [],
                columnOrder: [],
                sortColumns: [],
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
            onHide={() => setSidebarVisible(false)}
            filterPanelOpen={filterPanelOpen}
            onToggleFilterPanel={() => setFilterPanelOpen((v) => !v)}
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
              <DataGrid
                totalRows={totalRows}
                getRow={getRow}
                ensureRange={ensureRange}
                columns={viewState.visibleColumns}
                sortColumns={viewState.sortColumns}
                onSort={handleSort}
                onReorderColumns={reorderVisibleColumns}
                resetKey={resetKey}
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
                />
              )}
            </>
          ) : (
            <div className="welcome">
              <h2>Chikku Data Combiner</h2>
              <p>Open files to get started (Cmd+O / Ctrl+O)</p>
              <p>Add more files to combine them (Cmd+Shift+O / Ctrl+Shift+O)</p>
            </div>
          )}
        </div>
      </div>
      <StatusBar
        totalRows={totalRows}
        unfilteredRows={
          hasActiveFilters(viewState.filters)
            ? tables.find((t) => t.tableName === activeTable)?.rowCount ?? null
            : null
        }
        activeTable={activeTable}
        tableCount={tables.length}
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
