import React, { useMemo, useState } from "react";
import { Button, Intent, Menu, MenuItem } from "@blueprintjs/core";
import { Popover2 } from "@blueprintjs/popover2";
import { ColumnInfo, LoadedTable } from "../types";
import { WorkbenchTab } from "../utils/workbenchPanel";
import { DataOperationsDialog } from "./DataOperationsDialog";
import { AggregateDialog } from "./AggregateDialog";
import { PivotDialog } from "./PivotDialog";
import { LookupMergeDialog } from "./LookupMergeDialog";
import { DateConversionDialog } from "./DateConversionDialog";

interface ToolbarProps {
  tables: LoadedTable[];
  activeTable: string | null;
  schema: ColumnInfo[];
  filtersApplied: boolean;
  filterPanelOpen: boolean;
  onOpenWorkbench: (tab: WorkbenchTab) => void;
  onResetView: () => void;
  onDataOperation: (sql: string, description?: string, columnRenames?: Record<string, string>) => Promise<void>;
  onSampleTable: (n: number, isPercent: boolean) => Promise<void>;
  onCreateAggregateTable: (sql: string) => void;
  onCreatePivotTable: (sql: string) => void;
  onLookupMerge: (sql: string, options: { replaceActive: boolean }) => void;
  onCompareTables: () => void;
  onExport: () => void;
  onOpenHistory: () => void;
  onOpenOverview: () => void;
}

type Dialog = "data" | "aggregate" | "pivot" | "lookup" | "dates" | null;

export function Toolbar({
  tables, activeTable, schema, filtersApplied, filterPanelOpen, onOpenWorkbench,
  onResetView, onDataOperation, onSampleTable, onCreateAggregateTable,
  onCreatePivotTable, onLookupMerge, onCompareTables, onExport, onOpenHistory,
  onOpenOverview,
}: ToolbarProps): React.ReactElement {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [transformOpen, setTransformOpen] = useState(false);
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  const comparableTables = useMemo(() => tables.filter((table) => table.schema.length > 0), [tables]);
  const file = tables.find((table) => table.tableName === activeTable);
  const fileName = file && !file.filePath.startsWith("(")
    ? file.filePath.split(/[/\\]/).pop() || file.tableName : activeTable || "No file selected";
  const closeDialog = () => setDialog(null);

  return (
    <>
      <div className="table-toolbar" role="toolbar" aria-label="Table tools">
        <div className="table-toolbar-group">
          <Button small icon="filter" text="Filter" onClick={() => onOpenWorkbench("filters")} aria-expanded={filterPanelOpen} />
          <Popover2
            placement="bottom-start"
            isOpen={transformOpen}
            onInteraction={setTransformOpen}
            content={
              <Menu aria-label="Transform data">
                <MenuItem icon="column-layout" text="Columns" onClick={() => onOpenWorkbench("colops")} />
                <MenuItem icon="list" text="Rows" onClick={() => onOpenWorkbench("rowops")} />
                <MenuItem icon="th" text="Table transformations" onClick={() => setDialog("data")} />
                <MenuItem icon="calendar" text="Convert dates" onClick={() => setDialog("dates")} />
              </Menu>
            }
          >
            <Button small icon="edit" text="Transform" rightIcon="caret-down" aria-haspopup="menu" aria-expanded={transformOpen} />
          </Popover2>
          <Popover2
            placement="bottom-start"
            isOpen={analyzeOpen}
            onInteraction={setAnalyzeOpen}
            content={
              <Menu aria-label="Analyze data">
                <MenuItem icon="grouped-bar-chart" text="Aggregate" onClick={() => setDialog("aggregate")} />
                <MenuItem icon="pivot-table" text="Pivot table" onClick={() => setDialog("pivot")} />
                <MenuItem icon="data-lineage" text="Lookup and merge" disabled={comparableTables.length < 2} onClick={() => setDialog("lookup")} />
                <MenuItem icon="comparison" text="Compare files" disabled={comparableTables.length < 2} onClick={onCompareTables} />
                <MenuItem icon="dashboard" text="Open data profile" onClick={onOpenOverview} />
                {comparableTables.length < 2 && <MenuItem text="Open another file for lookup or comparison" disabled />}
              </Menu>
            }
          >
            <Button small icon="chart" text="Analyze" rightIcon="caret-down" aria-haspopup="menu" aria-expanded={analyzeOpen} />
          </Popover2>
          <Button small icon="endorsed" text="Review / QC" onClick={() => onOpenWorkbench("qc")} />
        </div>
        <div className="table-toolbar-group table-toolbar-secondary">
          <Button small minimal icon="history" text="History" onClick={onOpenHistory} />
          <Button small minimal icon="reset" text="Reset view" title="Show all columns in their original order and clear filters, sorting, and grouping" onClick={onResetView} />
          <Button small intent={Intent.PRIMARY} icon="export" text="Export" onClick={onExport} />
        </div>
      </div>
      <DataOperationsDialog isOpen={dialog === "data"} onClose={closeDialog} activeTable={activeTable} schema={schema} fileName={fileName} totalRows={file?.rowCount ?? 0} filtersApplied={filtersApplied} onApply={onDataOperation} onSampleTable={onSampleTable} />
      <AggregateDialog isOpen={dialog === "aggregate"} onClose={closeDialog} activeTable={activeTable} schema={schema} onCreateTable={onCreateAggregateTable} />
      <PivotDialog isOpen={dialog === "pivot"} onClose={closeDialog} activeTable={activeTable} schema={schema} onCreateTable={onCreatePivotTable} />
      <LookupMergeDialog isOpen={dialog === "lookup"} onClose={closeDialog} activeTable={activeTable} schema={schema} tables={comparableTables} onExecute={onLookupMerge} />
      <DateConversionDialog isOpen={dialog === "dates"} onClose={closeDialog} activeTable={activeTable} schema={schema} tables={comparableTables} filtersApplied={filtersApplied} onApply={onDataOperation} />
    </>
  );
}
