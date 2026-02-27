import React, { useState, useMemo } from "react";
import {
  Button,
  Callout,
  Checkbox,
  Classes,
  Dialog,
  Intent,
  Radio,
  RadioGroup,
  Spinner,
} from "@blueprintjs/core";
import { LoadedTable, ViewState, EXCEL_MAX_ROWS, EXCEL_MAX_COLS, FileFormat, hasActiveFilters } from "../types";
import { buildSelectQuery } from "../utils/sqlBuilder";

interface ExportDialogProps {
  isOpen: boolean;
  onClose: () => void;
  tables: LoadedTable[];
  activeTable: string | null;
  viewState: ViewState;
  schema: { column_name: string }[];
}

type TableMode = "active" | "select";
type ViewMode = "current" | "full";

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function ExportDialog({
  isOpen,
  onClose,
  tables,
  activeTable,
  viewState,
  schema,
}: ExportDialogProps): React.ReactElement {
  const [format, setFormat] = useState<FileFormat>("csv");
  const [tableMode, setTableMode] = useState<TableMode>("active");
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [viewMode, setViewMode] = useState<ViewMode>("current");
  const [exporting, setExporting] = useState(false);

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
    if (tableMode === "active") {
      return tables.filter((t) => t.tableName === activeTable);
    }
    return tables.filter((t) => selectedTables.has(t.tableName));
  }, [tableMode, tables, activeTable, selectedTables]);

  // Excel limit warnings
  const excelRowWarning = useMemo(() => {
    if (format !== "xlsx") return false;
    return exportTables.some((t) => t.rowCount > EXCEL_MAX_ROWS);
  }, [format, exportTables]);

  const excelColWarning = useMemo(() => {
    if (format !== "xlsx") return false;
    return exportTables.some((t) => t.schema.length > EXCEL_MAX_COLS);
  }, [format, exportTables]);

  const toggleTable = (name: string) => {
    setSelectedTables((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const canExport = exportTables.length > 0 && !exporting;

  const handleExport = async () => {
    if (!canExport) return;
    setExporting(true);
    try {
      const savePath = await window.api.saveFileDialog(format);
      if (!savePath) {
        setExporting(false);
        return;
      }

      const isExcel = format === "xlsx" || format === "xls";
      const isMultiTable = exportTables.length > 1;

      // Build SQL for a single table
      const buildTableSql = (t: LoadedTable): string => {
        if (tableMode === "active" && viewMode === "current" && t.tableName === activeTable && hasViewModifications) {
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

      onClose();
    } catch (err) {
      console.error("Export error:", err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Export Data"
      style={{ width: 720 }}
    >
      <div className={Classes.DIALOG_BODY}>
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

        {/* Section 2: Tables */}
        <div className="aggregate-section" style={{ marginBottom: 16 }}>
          <div className="aggregate-section-header">Tables</div>
          <RadioGroup
            onChange={(e) => setTableMode((e.target as HTMLInputElement).value as TableMode)}
            selectedValue={tableMode}
            inline
          >
            <Radio label="Active table only" value="active" />
            <Radio label="Select tables" value="select" />
          </RadioGroup>

          {tableMode === "select" && (
            <div className="export-table-grid">
              {tables.map((t) => (
                <div key={t.tableName} className={`aggregate-col-item${selectedTables.has(t.tableName) ? " selected" : ""}`}>
                  <Checkbox
                    checked={selectedTables.has(t.tableName)}
                    onChange={() => toggleTable(t.tableName)}
                    style={{ marginBottom: 0 }}
                  />
                  <span className="aggregate-col-name">{t.tableName}</span>
                  <span className="aggregate-col-type">
                    {t.rowCount.toLocaleString()} rows
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Section 3: View Options */}
        {tableMode === "active" && hasViewModifications && (
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
      </div>
      <div className={Classes.DIALOG_FOOTER}>
        <div className={Classes.DIALOG_FOOTER_ACTIONS}>
          <Button text="Cancel" onClick={onClose} disabled={exporting} />
          <Button
            intent={Intent.PRIMARY}
            text={exporting ? "Exporting..." : "Export"}
            icon={exporting ? <Spinner size={16} /> : "export"}
            onClick={handleExport}
            disabled={!canExport}
          />
        </div>
      </div>
    </Dialog>
  );
}
