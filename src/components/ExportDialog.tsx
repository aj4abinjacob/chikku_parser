import React, { useState, useMemo, useRef, useEffect } from "react";
import {
  Button,
  Callout,
  Classes,
  Dialog,
  Intent,
  Radio,
  RadioGroup,
  Spinner,
} from "@blueprintjs/core";
import { LoadedTable, ViewState, EXCEL_MAX_ROWS, EXCEL_MAX_COLS, FileFormat, hasActiveFilters } from "../types";
import { buildFilterGroupClause, buildSelectQuery } from "../utils/sqlBuilder";
import { ColumnCheckList } from "./ColumnCheckList";
import { AsyncActionGate, errorMessage } from "../utils/operationUX";

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExported?: (tableNames: string[], fullData: boolean) => void | Promise<void>;
  tables: LoadedTable[];
  activeTable: string | null;
  viewState: ViewState;
  schema: { column_name: string }[];
  forceFullData?: boolean;
}

type TableMode = "active" | "select";
type ViewMode = "current" | "full";

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function ExportDialog({
  isOpen,
  onClose,
  onExported,
  tables,
  activeTable,
  viewState,
  schema,
  forceFullData = false,
}: ExportDialogProps): React.ReactElement {
  const [format, setFormat] = useState<FileFormat>("csv");
  const [tableMode, setTableMode] = useState<TableMode>("active");
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("current");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [currentRows, setCurrentRows] = useState<number | null>(null);
  const actionGate = useRef(new AsyncActionGate());
  const handleClose = () => { if (!actionGate.current.pending) onClose(); };
  const effectiveTableMode: TableMode = forceFullData ? "active" : tableMode;

  // Determine if the active table has any view modifications
  const hasViewModifications = useMemo(() => {
    if (!activeTable) return false;
    const hasFilters = hasActiveFilters(viewState.filters);
    const hasSort = viewState.sortColumns.length > 0;
    const allCols = schema.map((c) => c.column_name);
    const hasHiddenCols = viewState.visibleColumns.length < allCols.length;
    const hasReorderedCols =
      viewState.visibleColumns.length > 0 &&
      viewState.visibleColumns.some((c, i) => c !== allCols[i]);
    return hasFilters || hasSort || hasHiddenCols || hasReorderedCols;
  }, [activeTable, viewState, schema]);

  // Which tables will be exported
  const exportTables = useMemo(() => {
    if (effectiveTableMode === "active") {
      return tables.filter((t) => t.tableName === activeTable);
    }
    return tables.filter((t) => selectedTables.has(t.tableName));
  }, [effectiveTableMode, tables, activeTable, selectedTables]);

  const usesCurrentView = !forceFullData && effectiveTableMode === "active" && viewMode === "current" && hasViewModifications;
  const noVisibleColumns = usesCurrentView && viewState.visibleColumns.length === 0;
  const isExcel = format === "xlsx" || format === "xls";
  const columnsToExport = usesCurrentView ? viewState.visibleColumns.length : exportTables[0]?.schema.length ?? 0;

  useEffect(() => {
    if (!isOpen || !activeTable || !usesCurrentView) return;
    let cancelled = false;
    setCurrentRows(null);
    const filter = buildFilterGroupClause(viewState.filters);
    window.api.query(`SELECT COUNT(*) AS cnt FROM ${escapeIdent(activeTable)}${filter ? ` WHERE ${filter}` : ""}`)
      .then((rows) => { if (!cancelled) setCurrentRows(Number(rows[0]?.cnt ?? 0)); })
      .catch(() => { if (!cancelled) setCurrentRows(null); });
    return () => { cancelled = true; };
  }, [isOpen, activeTable, usesCurrentView, viewState.filters]);

  useEffect(() => { if (isOpen) setExportError(null); }, [isOpen]);

  const displayFileName = (table: LoadedTable) => table.filePath.startsWith("(")
    ? table.tableName : table.filePath.split(/[/\\]/).pop() || table.tableName;

  // Excel limit warnings
  const excelRowWarning = useMemo(() => {
    if (format !== "xlsx") return false;
    return usesCurrentView ? currentRows !== null && currentRows > EXCEL_MAX_ROWS : exportTables.some((t) => t.rowCount > EXCEL_MAX_ROWS);
  }, [format, exportTables, usesCurrentView, currentRows]);

  const excelColWarning = useMemo(() => {
    if (format !== "xlsx") return false;
    return usesCurrentView ? columnsToExport > EXCEL_MAX_COLS : exportTables.some((t) => t.schema.length > EXCEL_MAX_COLS);
  }, [format, exportTables, usesCurrentView, columnsToExport]);

  const canExport = exportTables.length > 0 && !exporting && !noVisibleColumns;

  const handleExport = async () => {
    if (!canExport || actionGate.current.pending) return;
    await actionGate.current.run(async () => {
      setExporting(true);
      setExportError(null);
      let fileSaved = false;
      try {
        const savePath = await window.api.saveFileDialog(format);
        if (!savePath) {
          setExporting(false);
          return;
        }

        const isMultiTable = exportTables.length > 1;

        // Build SQL for a single table
        const buildTableSql = (t: LoadedTable): string => {
          if (usesCurrentView && t.tableName === activeTable) {
            return buildSelectQuery(t.tableName, viewState);
          }
          return `SELECT * FROM ${escapeIdent(t.tableName)}`;
        };

        if (isMultiTable && isExcel) {
          // Multi-table Excel: each table becomes a sheet
          const sheets = exportTables.map((t) => ({
            sheetName: t.tableName,
            sql: buildTableSql(t),
          }));
          await window.api.exportExcelMulti(sheets, savePath);
        } else if (isMultiTable) {
          // Multi-table non-Excel: UNION ALL
          const unionSql = exportTables
            .map((t) => buildTableSql(t))
            .join("\nUNION ALL\n");
          await window.api.exportFile(unionSql, savePath, format);
        } else {
          // Single table
          const sql = buildTableSql(exportTables[0]);
          await window.api.exportFile(sql, savePath, format);
        }

        fileSaved = true;
        await onExported?.(
          exportTables.map((table) => table.tableName),
          forceFullData || effectiveTableMode === "select" || viewMode === "full" || !hasViewModifications
        );
        onClose();
      } catch (err) {
        setExportError(fileSaved
          ? `The file was saved, but finishing the export failed. ${errorMessage(err)} You can close this dialog or retry to save again.`
          : `Export failed. ${errorMessage(err)} Your settings are preserved. Check the save location and retry.`);
      } finally {
        setExporting(false);
      }
    });
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      canEscapeKeyClose={!exporting}
      canOutsideClickClose={!exporting}
      isCloseButtonShown={!exporting}
      title={forceFullData ? "Save QC File" : "Export Data"}
      style={{ width: 720 }}
    >
      <div className={Classes.DIALOG_BODY}>
        {exportError && (
          <Callout intent={Intent.DANGER} icon="error" role="alert" style={{ marginBottom: 12 }}>{exportError}</Callout>
        )}
        <fieldset disabled={exporting} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        {/* Section 1: Format */}
        <div className="aggregate-section" style={{ marginBottom: 16 }}>
          <div className="aggregate-section-header">Format</div>
          <RadioGroup
            onChange={(e) => setFormat((e.target as HTMLInputElement).value as FileFormat)}
            selectedValue={format}
            inline
            className="export-format-row"
          >
            <Radio label="CSV" value="csv" />
            <Radio label="TSV" value="tsv" />
            <Radio label="JSON" value="json" />
            <Radio label="Excel (.xlsx)" value="xlsx" />
            <Radio label="Parquet" value="parquet" />
          </RadioGroup>
        </div>

        {/* Section 2: Files */}
        <div className="aggregate-section" style={{ marginBottom: 16 }}>
          <div className="aggregate-section-header">Files</div>
          <RadioGroup
            onChange={(e) => setTableMode((e.target as HTMLInputElement).value as TableMode)}
            selectedValue={effectiveTableMode}
            inline
          >
            <Radio label="Active file only" value="active" disabled={forceFullData} />
            <Radio label="Select files" value="select" disabled={forceFullData} />
          </RadioGroup>

          {effectiveTableMode === "select" && (
            <ColumnCheckList
              items={tables.map((t) => ({
                name: t.tableName,
                type: `${t.rowCount.toLocaleString()} rows · ${t.schema.length.toLocaleString()} columns`,
              }))}
              selected={selectedTables}
              onChange={setSelectedTables}
              emptyMeans="invalid"
              sortItems={false}
              renderItemHint={(item) => {
                const table = tables.find((entry) => entry.tableName === item.name);
                return table ? displayFileName(table) : null;
              }}
            />
          )}
        </div>

        {/* Section 3: View Options */}
        {!forceFullData && effectiveTableMode === "active" && hasViewModifications && (
          <div className="aggregate-section" style={{ marginBottom: 16 }}>
            <div className="aggregate-section-header">View Options</div>
            <RadioGroup
              onChange={(e) => setViewMode((e.target as HTMLInputElement).value as ViewMode)}
              selectedValue={viewMode}
            >
              <Radio
                label="Export current view (filtered/sorted/column selection)"
                value="current"
              />
              <Radio label="Export full data (all rows, all columns)" value="full" />
            </RadioGroup>
          </div>
        )}

        <Callout icon="export" style={{ marginBottom: 12 }}>
          <strong>{usesCurrentView ? "Current view" : "Entire files"}</strong>
          {exportTables.length === 1 ? (
            <div>
              {displayFileName(exportTables[0])} · {usesCurrentView
                ? currentRows === null ? "Matching rows" : `${currentRows.toLocaleString()} rows`
                : `${exportTables[0].rowCount.toLocaleString()} rows`} · {columnsToExport.toLocaleString()} columns.
              {usesCurrentView ? " Active filters, sorting, and visible column order are included." : " All rows and columns are included; table filters are ignored."}
            </div>
          ) : exportTables.length > 1 ? (
            <div>
              {exportTables.map(displayFileName).join(", ")} · {exportTables.reduce((sum, table) => sum + table.rowCount, 0).toLocaleString()} total rows.
              {isExcel
                ? " Each complete file becomes a separate Excel sheet. All columns are included."
                : " Complete files are concatenated into one output, in the order shown above. All columns are included; files must have compatible columns and types."}
              {" Table filters are ignored."}
            </div>
          ) : <div>Select at least one file.</div>}
        </Callout>
        {noVisibleColumns && (
          <Callout intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 12 }}>
            No columns are visible. Show at least one column in the table, or choose full data to export all columns.
          </Callout>
        )}

        {/* Section 4: Warnings */}
        {excelRowWarning && (
          <Callout intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 8 }}>
            One or more tables exceed Excel's row limit of {EXCEL_MAX_ROWS.toLocaleString()} rows. Data may be truncated.
          </Callout>
        )}
        {excelColWarning && (
          <Callout intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 8 }}>
            One or more tables exceed Excel's column limit of {EXCEL_MAX_COLS.toLocaleString()} columns.
          </Callout>
        )}
        </fieldset>
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button text="Cancel" onClick={handleClose} disabled={exporting} />
          <Button
            intent={Intent.PRIMARY}
            text={exporting ? (forceFullData ? "Saving..." : "Exporting...") : exportError ? "Retry" : (forceFullData ? "Save" : "Export")}
            icon={exporting ? <Spinner size={16} /> : "export"}
            onClick={handleExport}
            disabled={!canExport}
          />
        </div>
      </div>
    </Dialog>
  );
}
