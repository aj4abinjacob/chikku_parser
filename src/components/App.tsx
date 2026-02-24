import React, { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@blueprintjs/core";
import { LoadedTable, ViewState, ColumnInfo, FilterCondition } from "../types";
import { Sidebar } from "./Sidebar";
import { DataGrid } from "./DataGrid";
import { FilterPanel } from "./FilterPanel";
import { StatusBar } from "./StatusBar";
import { CombineDialog } from "./CombineDialog";
import { buildSelectQuery, buildCombineQuery, buildCountQuery } from "../utils/sqlBuilder";

const DEFAULT_PAGE_SIZE = 500;

function makeTableName(filePath: string): string {
  // Extract filename without extension using pure string ops (no Node path module)
  const name = filePath.split(/[/\\]/).pop() || "table";
  const dotIdx = name.lastIndexOf(".");
  const base = dotIdx > 0 ? name.substring(0, dotIdx) : name;
  return base.replace(/[^a-zA-Z0-9_]/g, "_");
}

export function App(): React.ReactElement {
  const [tables, setTables] = useState<LoadedTable[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [combineDialogOpen, setCombineDialogOpen] = useState(false);
  const [schema, setSchema] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<any[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [viewState, setViewState] = useState<ViewState>({
    visibleColumns: [],
    filters: [],
    sortColumn: null,
    sortDirection: "ASC",
    limit: DEFAULT_PAGE_SIZE,
    offset: 0,
  });

  // Use refs so IPC callbacks always see latest state
  const tablesRef = useRef(tables);
  tablesRef.current = tables;
  const activeTableRef = useRef(activeTable);
  activeTableRef.current = activeTable;

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
        // Reset view state so columns get auto-populated on next render
        setViewState((prev) => ({ ...prev, visibleColumns: [], filters: [], offset: 0 }));
        setFilterPanelOpen(false);
      }
    },
    [] // stable — uses refs for latest state
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
      const sql =
        t.length > 1
          ? buildCombineQuery(t.map((tb) => tb.tableName))
          : `SELECT * FROM "${at}"`;
      await window.api.exportCSV(sql, savePath);
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // When active table or view state changes, refresh data
  useEffect(() => {
    if (!activeTable) return;

    const fetchData = async () => {
      try {
        // Get schema for active table
        const desc = await window.api.describe(activeTable);
        setSchema(desc);

        // If no visible columns set, show all and update state
        if (viewState.visibleColumns.length === 0) {
          const allCols = desc.map((c: ColumnInfo) => c.column_name);
          setViewState((prev) => ({ ...prev, visibleColumns: allCols }));
          // Don't query yet — the state update will re-trigger this effect
          return;
        }

        // Get total count (for pagination)
        const countSql = buildCountQuery(activeTable, viewState.filters);
        const countResult = await window.api.query(countSql);
        setTotalRows(Number(countResult[0]?.total ?? 0));

        // Get page of data
        const dataSql = buildSelectQuery(activeTable, viewState);
        const dataRows = await window.api.query(dataSql);
        setRows(dataRows);
      } catch (err) {
        console.error("Query error:", err);
      }
    };

    fetchData();
  }, [activeTable, viewState]);

  // Open the column mapping dialog
  const handleCombineOpen = useCallback(() => {
    if (tables.length < 2) return;
    setCombineDialogOpen(true);
  }, [tables]);

  // Execute the combine SQL produced by CombineDialog
  const handleCombineExecute = useCallback(async (sql: string) => {
    try {
      await window.api.exec(
        `CREATE OR REPLACE TABLE "combined" AS ${sql}`
      );
      const desc = await window.api.describe("combined");
      const countResult = await window.api.query(
        `SELECT COUNT(*) as count FROM "combined"`
      );
      const combinedTable: LoadedTable = {
        tableName: "combined",
        filePath: "(combined)",
        schema: desc,
        rowCount: Number(countResult[0].count),
      };

      setTables((prev) => {
        const without = prev.filter((t) => t.tableName !== "combined");
        return [...without, combinedTable];
      });
      setActiveTable("combined");
      setViewState((prev) => ({ ...prev, visibleColumns: [], filters: [], offset: 0 }));
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
        return { ...prev, visibleColumns: visible, offset: 0 };
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
      offset: 0,
    }));
  }, []);

  // Pagination
  const handlePageChange = useCallback((newOffset: number) => {
    setViewState((prev) => ({ ...prev, offset: newOffset }));
  }, []);

  // Filters
  const handleFiltersChange = useCallback((filters: FilterCondition[]) => {
    setViewState((prev) => ({ ...prev, filters, offset: 0 }));
  }, []);

  // Column operation: run SQL to add/replace column
  const handleColumnOperation = useCallback(
    async (sql: string) => {
      if (!activeTable) return;
      try {
        await window.api.exec(sql);
        // Refresh schema and data
        setViewState((prev) => ({ ...prev, visibleColumns: [] }));
      } catch (err) {
        console.error("Column operation error:", err);
      }
    },
    [activeTable]
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
            onSelectTable={(name) => {
              setActiveTable(name);
              setViewState((prev) => ({ ...prev, visibleColumns: [], filters: [], offset: 0 }));
            }}
            onToggleColumn={toggleColumn}
            onColumnOperation={handleColumnOperation}
            onCombine={handleCombineOpen}
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
                rows={rows}
                columns={viewState.visibleColumns}
                sortColumn={viewState.sortColumn}
                sortDirection={viewState.sortDirection}
                onSort={handleSort}
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
        limit={viewState.limit}
        offset={viewState.offset}
        onPageChange={handlePageChange}
        activeTable={activeTable}
        tableCount={tables.length}
      />
      <CombineDialog
        isOpen={combineDialogOpen}
        tables={tables.filter((t) => t.tableName !== "combined")}
        onClose={() => setCombineDialogOpen(false)}
        onCombine={handleCombineExecute}
      />
    </div>
  );
}
