import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@blueprintjs/core";
import { LoadedTable, ViewState, ColumnInfo, FilterCondition } from "../types";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
import { FilterPanel } from "./FilterPanel";
import { StatusBar } from "./StatusBar";
import { CombineDialog } from "./CombineDialog";
import { buildCombineQuery } from "../utils/sqlBuilder";
import { useChunkCache } from "../hooks/useChunkCache";

function makeTableName(filePath: string): string {
  const name = filePath.split(/[/\\]/).pop() || "table";
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.substring(0, dotIdx) : name;
  return base.replace(/[^a-zA-Z0-9_]/g, "_");
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
  const [viewState, setViewState] = useState<ViewState>({
    visibleColumns: [],
    columnOrder: [],
    filters: [],
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
  });

  // Load CSV files into DuckDB
  const loadFiles = useCallback(
    async (filePaths: string[], replace: boolean) => {
      const newTables: LoadedTable[] = replace ? [] : [...tablesRef.current];

      for (const fp of filePaths) {
        const tableName = makeTableName(fp);
        try {
          const result = await window.api.loadCSV(fp, tableName);
          newTables.push({
            tableName: result.tableName,
            filePath: fp,
            schema: result.schema,
            rowCount: result.rowCount,
          });
        } catch (err) {
          console.error(`Failed to load ${fp}:`, err);
        }
      }

      setTables(newTables);

      if (newTables.length > 0) {
        setActiveTable(newTables[0].tableName);
        setViewState((prev) => ({ ...prev, filters: [] }));
        setResetKey((k) => k + 1);
        setFilterPanelOpen(false);
      }
    },
    []
  );

  // Register IPC listeners once on mount
  useEffect(() => {
    window.api.onOpenFiles((filePaths) => loadFiles(filePaths, true));
    window.api.onAddFiles((filePaths) => loadFiles(filePaths, false));
    window.api.onExportCSV(async () => {
      const at = activeTableRef.current;
      const t = tablesRef.current;
      if (!at) return;
      const savePath = await window.api.saveDialog();
      if (!savePath) return;
      // Exclude auto-generated combined/sample/aggregate tables from the export UNION ALL
      const sourceTables = t.filter((tb) => tb.filePath !== "(combined)" && tb.filePath !== "(sample)" && tb.filePath !== "(aggregate)");
      const sql =
        sourceTables.length > 1
          ? buildCombineQuery(sourceTables.map((tb) => tb.tableName))
          : `SELECT * FROM "${at}"`;
      await window.api.exportCSV(sql, savePath);
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
        setViewState((prev) => ({ ...prev, filters: [] }));
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
        filters: [],
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
  const handleFiltersChange = useCallback((filters: FilterCondition[]) => {
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
          filters: [],
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
          filters: [],
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
                filters: [],
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
                />
              )}
            </>
          ) : (
            <div className="welcome">
              <h2>Chikku Data Combiner</h2>
              <p>Open CSV files to get started (Cmd+O / Ctrl+O)</p>
              <p>Add more files to combine them (Cmd+Shift+O / Ctrl+Shift+O)</p>
            </div>
          )}
        </div>
      </div>
      <StatusBar
        totalRows={totalRows}
        unfilteredRows={
          viewState.filters.length > 0
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
    </div>
  );
}
