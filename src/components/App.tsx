import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@blueprintjs/core";
import { LoadedTable, ViewState, ColumnInfo, FilterGroup, SheetInfo, hasActiveFilters, ColOpType, ColOpStep, UndoStrategy } from "../types";
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
}

interface PendingRetry {
  filePath: string;
  tableName: string;
  errorMessage: string;
  replace: boolean;
  otherFiles: LoadedTable[];
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
  const [dataVersion, setDataVersion] = useState(0);
  const [viewState, setViewState] = useState<ViewState>({
    visibleColumns: [],
    columnOrder: [],
    filters: { logic: "AND", children: [] },
    sortColumn: null,
    sortDirection: "ASC",
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
  const loadFiles = useCallback(
    async (filePaths: string[], replace: boolean) => {
      const newTables: LoadedTable[] = replace ? [] : [...tablesRef.current];

      for (const fp of filePaths) {
        const ext = getFileExtension(fp);

        if (ext === "xlsx" || ext === "xls") {
          // Excel: check for multiple sheets
          try {
            const sheets = await window.api.getExcelSheets(fp);
            if (sheets.length > 1) {
              // Show sheet picker dialog
              setPendingExcelImport({
                filePath: fp,
                fileName: fp.split(/[/\\]/).pop() || fp,
                sheets,
                replace,
                otherFiles: newTables,
              });
              return; // Wait for dialog result
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
            });
            return; // Wait for retry dialog
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
      const { filePath, otherFiles, replace } = pendingExcelImport;
      const newTables = [...otherFiles];
      const baseName = makeTableName(filePath);

      for (const sheetName of selectedSheets) {
        const tableName = `${baseName}_${sheetName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
        const result = await loadSingleFile(filePath, tableName, { excelSheet: sheetName });
        if (result && !("error" in result)) {
          newTables.push(result);
        }
      }

      setTables(newTables);
      if (newTables.length > 0) {
        setActiveTable(newTables[replace ? 0 : newTables.length - selectedSheets.length].tableName);
        setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
        setResetKey((k) => k + 1);
        setFilterPanelOpen(false);
      }
      setPendingExcelImport(null);
    },
    [pendingExcelImport, loadSingleFile]
  );

  // Handle CSV retry
  const handleRetryImport = useCallback(
    async (options: { csvDelimiter?: string; csvIgnoreErrors?: boolean }) => {
      if (!pendingRetry) return;
      const { filePath, tableName, otherFiles } = pendingRetry;
      const newTables = [...otherFiles];

      const result = await loadSingleFile(filePath, tableName, options);
      if (result && !("error" in result)) {
        newTables.push(result);
      } else if (result && "error" in result) {
        // Still failing — update the error message
        setPendingRetry((prev) => prev ? { ...prev, errorMessage: result.error } : null);
        return;
      }

      setTables(newTables);
      if (newTables.length > 0) {
        setActiveTable(newTables[newTables.length - 1].tableName);
        setViewState((prev) => ({ ...prev, filters: { logic: "AND", children: [] } }));
        setResetKey((k) => k + 1);
        setFilterPanelOpen(false);
      }
      setPendingRetry(null);
    },
    [pendingRetry, loadSingleFile]
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

  // Clean up colOps state when active table changes
  const prevActiveTableRef = useRef<string | null>(null);
  useEffect(() => {
    const prevTable = prevActiveTableRef.current;
    prevActiveTableRef.current = activeTable;

    if (prevTable && prevTable !== activeTable && colOpsSteps.length > 0) {
      // Drop all backup/snapshot tables for the previous table
      const dropBackups = async () => {
        for (const step of colOpsSteps) {
          if (step.backupTable) {
            try { await window.api.exec(`DROP TABLE IF EXISTS "${step.backupTable}"`); } catch (_) { /* ignore */ }
          }
        }
        // Also try dropping snapshot table
        try { await window.api.exec(`DROP TABLE IF EXISTS "__colops_snapshot_${prevTable}"`); } catch (_) { /* ignore */ }
      };
      dropBackups();
      setColOpsSteps([]);
      setUndoStrategy("per-step");
      setColOpsNextId(1);
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
        sortColumn: null,
        sortDirection: "ASC",
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
  const handleSort = useCallback((column: string) => {
    setViewState((prev) => ({
      ...prev,
      sortColumn: column,
      sortDirection:
        prev.sortColumn === column && prev.sortDirection === "ASC"
          ? "DESC"
          : "ASC",
    }));
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
          sortColumn: null,
          sortDirection: "ASC",
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
          sortColumn: null,
          sortDirection: "ASC",
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
          sortColumn: null,
          sortDirection: "ASC",
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
            sortColumn: null,
            sortDirection: "ASC",
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
            onSelectTable={(name) => {
              setActiveTable(name);
              setViewState((prev) => ({
                ...prev,
                filters: { logic: "AND", children: [] },
                visibleColumns: [],
                columnOrder: [],
                sortColumn: null,
                sortDirection: "ASC",
              }));
              setResetKey((k) => k + 1);
            }}
            onToggleColumn={toggleColumn}
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
                sortColumn={viewState.sortColumn}
                sortDirection={viewState.sortDirection}
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
          onClose={() => setPendingExcelImport(null)}
          onImport={handleExcelSheetImport}
        />
      )}
      {pendingRetry && (
        <ImportRetryDialog
          isOpen={true}
          filePath={pendingRetry.filePath}
          errorMessage={pendingRetry.errorMessage}
          onClose={() => setPendingRetry(null)}
          onRetry={handleRetryImport}
        />
      )}
    </div>
  );
}
