import React, { useState, useEffect, useMemo } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Icon,
  InputGroup,
  Intent,
} from "@blueprintjs/core";
import { LoadedTable, ColumnInfo, SortColumn } from "../types";
import { DataOperationsDialog } from "./DataOperationsDialog";
import { AggregateDialog } from "./AggregateDialog";
import { PivotDialog } from "./PivotDialog";
import { LookupMergeDialog } from "./LookupMergeDialog";
import { DateConversionDialog } from "./DateConversionDialog";

interface SidebarProps {
  tables: LoadedTable[];
  activeTable: string | null;
  schema: ColumnInfo[];
  visibleColumns: string[];
  columnOrder: string[];
  sortColumns: SortColumn[];
  filterPanelOpen: boolean;
  onSelectTable: (tableName: string) => void;
  onToggleColumn: (colName: string) => void;
  onSetVisibleColumns: (cols: string[]) => void;
  onReorderColumns: (newOrder: string[]) => void;
  onSort: (column: string, addLevel: boolean) => void;
  onClearSort: () => void;
  onDataOperation: (sql: string) => void;
  onSampleTable: (n: number, isPercent: boolean) => void;
  onDeleteTable: (tableName: string) => void;
  onCombine: (selectedNames: string[]) => void;
  onCreateAggregateTable: (sql: string) => void;
  onCreatePivotTable: (sql: string) => void;
  onLookupMerge: (sql: string, options: { replaceActive: boolean }) => void;
  onExport: () => void;
  onHide: () => void;
  onToggleFilterPanel: () => void;
}

export function Sidebar({
  tables,
  activeTable,
  schema,
  visibleColumns,
  columnOrder,
  sortColumns,
  filterPanelOpen,
  onSelectTable,
  onToggleColumn,
  onSetVisibleColumns,
  onReorderColumns,
  onSort,
  onClearSort,
  onDataOperation,
  onSampleTable,
  onDeleteTable,
  onCombine,
  onCreateAggregateTable,
  onCreatePivotTable,
  onLookupMerge,
  onExport,
  onHide,
  onToggleFilterPanel,
}: SidebarProps): React.ReactElement {
  const [dataOpDialogOpen, setDataOpDialogOpen] = useState(false);
  const [aggregateDialogOpen, setAggregateDialogOpen] = useState(false);
  const [pivotDialogOpen, setPivotDialogOpen] = useState(false);
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [dateConvDialogOpen, setDateConvDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selectedForCombine, setSelectedForCombine] = useState<Set<string>>(new Set());
  const [columnSearch, setColumnSearch] = useState("");

  // Drag-and-drop state
  const dragIndexRef = React.useRef<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; position: "top" | "bottom" } | null>(null);

  // Clean up stale selections when tables change
  useEffect(() => {
    const tableNames = new Set(tables.map((t) => t.tableName));
    setSelectedForCombine((prev) => {
      const cleaned = new Set([...prev].filter((n) => tableNames.has(n)));
      return cleaned.size === prev.size ? prev : cleaned;
    });
  }, [tables]);

  // Clear search when active table changes
  useEffect(() => {
    setColumnSearch("");
  }, [activeTable]);

  const toggleCombineSelection = (tableName: string) => {
    setSelectedForCombine((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  };

  // Use columnOrder if available, otherwise fall back to schema order
  const orderedColumns = columnOrder.length > 0
    ? columnOrder.map((name) => schema.find((c) => c.column_name === name)).filter(Boolean) as ColumnInfo[]
    : schema;

  // Filter columns by search
  const filteredColumns = useMemo(() => {
    if (!columnSearch.trim()) return orderedColumns;
    const q = columnSearch.toLowerCase();
    return orderedColumns.filter((col) => col.column_name.toLowerCase().includes(q));
  }, [orderedColumns, columnSearch]);

  // Build a sort index map for quick lookup
  const sortIndexMap = useMemo(() => {
    const map = new Map<string, { index: number; direction: "ASC" | "DESC" }>();
    sortColumns.forEach((sc, i) => map.set(sc.column, { index: i + 1, direction: sc.direction }));
    return map;
  }, [sortColumns]);

  const handleDragStart = (e: React.DragEvent, index: number) => {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = "move";
    const target = e.currentTarget as HTMLElement;
    target.classList.add("dragging");
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIndexRef.current === null || dragIndexRef.current === index) {
      setDropTarget(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    const position = e.clientY < midY ? "top" : "bottom";
    setDropTarget({ index, position });
  };

  const handleDragLeave = () => {
    setDropTarget(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const fromIndex = dragIndexRef.current;
    if (fromIndex === null || !dropTarget) return;

    const newOrder = [...orderedColumns.map((c) => c.column_name)];
    const [moved] = newOrder.splice(fromIndex, 1);
    let toIndex = dropTarget.index;
    if (fromIndex < toIndex) toIndex--;
    if (dropTarget.position === "bottom") toIndex++;
    newOrder.splice(toIndex, 0, moved);

    onReorderColumns(newOrder);
    dragIndexRef.current = null;
    setDropTarget(null);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove("dragging");
    dragIndexRef.current = null;
    setDropTarget(null);
  };

  const allColumnNames = orderedColumns.map((c) => c.column_name);
  const allVisible = visibleColumns.length === allColumnNames.length;
  const noneVisible = visibleColumns.length === 0;

  return (
    <div className="sidebar">
      {/* Loaded tables */}
      <div className="sidebar-section sidebar-section-tables">
        <div className="sidebar-section-header">
          <h4>Tables</h4>
          <Button
            icon="chevron-left"
            minimal
            small
            onClick={onHide}
            title="Hide sidebar"
          />
        </div>
        {tables.length === 0 && (
          <div style={{ fontSize: 12, color: "#5c7080" }}>No tables loaded</div>
        )}
        {tables.map((t) => (
          <div
            key={t.tableName}
            className={`table-list-item${t.tableName === activeTable ? " active" : ""}`}
            style={{ cursor: "pointer" }}
          >
            {tables.length >= 2 && (
              <Checkbox
                checked={selectedForCombine.has(t.tableName)}
                onChange={() => toggleCombineSelection(t.tableName)}
                className="table-combine-checkbox"
                style={{ marginBottom: 0, marginRight: 4 }}
              />
            )}
            <span
              className="table-name"
              onClick={() => onSelectTable(t.tableName)}
            >
              <Icon
                icon="th"
                size={12}
                style={{ marginRight: 6, opacity: 0.6 }}
              />
              {t.tableName}
            </span>
            <span className="row-count">
              {t.rowCount.toLocaleString()} rows
            </span>
            <Button
              icon="cross"
              minimal
              small
              className="table-delete-btn"
              onClick={(e) => {
                e.stopPropagation();
                setDeleteTarget(t.tableName);
              }}
            />
          </div>
        ))}
      </div>

      {/* Combine button */}
      {tables.length >= 2 && (
        <div className="sidebar-section sidebar-actions-inline">
          <Button
            intent={Intent.PRIMARY}
            icon="merge-columns"
            text={`Combine ${selectedForCombine.size} Selected`}
            onClick={() => onCombine([...selectedForCombine])}
            small
            fill
            disabled={selectedForCombine.size < 2}
          />
        </div>
      )}

      {/* Column visibility */}
      {schema.length > 0 && (
        <div className="sidebar-section sidebar-section-columns">
          <div className="column-header-row">
            <h4>Columns</h4>
            <div className="column-header-actions">
              <Button
                minimal
                small
                text="All"
                title="Show all columns"
                disabled={allVisible}
                onClick={() => onSetVisibleColumns(allColumnNames)}
              />
              <Button
                minimal
                small
                text="None"
                title="Hide all columns"
                disabled={noneVisible}
                onClick={() => onSetVisibleColumns([])}
              />
              {sortColumns.length > 0 && (
                <Button
                  minimal
                  small
                  icon="sort"
                  title="Clear all sorts"
                  onClick={onClearSort}
                  className="column-clear-sort-btn"
                />
              )}
            </div>
          </div>
          {orderedColumns.length > 8 && (
            <div className="column-search">
              <InputGroup
                leftIcon="search"
                placeholder="Search columns..."
                value={columnSearch}
                onChange={(e) => setColumnSearch(e.target.value)}
                rightElement={
                  columnSearch ? (
                    <Button icon="cross" minimal small onClick={() => setColumnSearch("")} />
                  ) : undefined
                }
                small
              />
            </div>
          )}
          {filteredColumns.map((col, index) => {
            const sortInfo = sortIndexMap.get(col.column_name);
            return (
              <div
                key={col.column_name}
                className={`column-item${
                  dropTarget?.index === index
                    ? ` drag-over-${dropTarget.position}`
                    : ""
                }`}
                title={col.column_name}
                draggable
                onDragStart={(e) => handleDragStart(e, index)}
                onDragOver={(e) => handleDragOver(e, index)}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                onDragEnd={handleDragEnd}
              >
                <Icon
                  icon="drag-handle-vertical"
                  size={12}
                  className="drag-handle"
                />
                <Checkbox
                  checked={visibleColumns.includes(col.column_name)}
                  onChange={() => onToggleColumn(col.column_name)}
                  style={{ marginBottom: 0 }}
                />
                <span className="column-name-text">{col.column_name}</span>
                <span className="column-type">{col.column_type}</span>
                <span
                  className={`column-sort-indicator${sortInfo ? " active" : ""}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSort(col.column_name, e.shiftKey);
                  }}
                  title={
                    sortInfo
                      ? `Sort ${sortInfo.index}: ${sortInfo.direction} (click to toggle, shift+click for multi-sort)`
                      : "Click to sort (shift+click for multi-sort)"
                  }
                >
                  {sortInfo ? (
                    <>
                      <span className="column-sort-number">{sortInfo.index}</span>
                      <Icon icon={sortInfo.direction === "ASC" ? "chevron-up" : "chevron-down"} size={10} />
                    </>
                  ) : (
                    <Icon icon="double-caret-vertical" size={10} className="column-sort-idle" />
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Data operation + filter buttons */}
      {activeTable && schema.length > 0 && (
        <div className="sidebar-section sidebar-actions">
          <Button
            icon="filter"
            text="Filters"
            onClick={onToggleFilterPanel}
            active={filterPanelOpen}
            small
            fill
          />
          <Button
            icon="grouped-bar-chart"
            text="Aggregate"
            onClick={() => setAggregateDialogOpen(true)}
            small
            fill
          />
          <Button
            icon="pivot-table"
            text="Pivot Table"
            onClick={() => setPivotDialogOpen(true)}
            small
            fill
          />
          {tables.length >= 2 && (
            <Button
              icon="data-lineage"
              text="Lookup Merge"
              onClick={() => setMergeDialogOpen(true)}
              small
              fill
            />
          )}
          <Button
            icon="column-layout"
            text="Data Operations"
            onClick={() => setDataOpDialogOpen(true)}
            small
            fill
          />
          <Button
            icon="calendar"
            text="Date Conversion"
            onClick={() => setDateConvDialogOpen(true)}
            small
            fill
          />
          <Button
            icon="export"
            text="Export"
            onClick={onExport}
            small
            fill
          />
        </div>
      )}

      <Alert
        isOpen={deleteTarget !== null}
        onConfirm={() => {
          if (deleteTarget) onDeleteTable(deleteTarget);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
        cancelButtonText="Cancel"
        confirmButtonText="Remove"
        intent={Intent.DANGER}
        icon="trash"
      >
        <p>Remove table <strong>{deleteTarget}</strong>? This will drop it from the current session.</p>
      </Alert>

      <DataOperationsDialog
        isOpen={dataOpDialogOpen}
        onClose={() => setDataOpDialogOpen(false)}
        activeTable={activeTable}
        schema={schema}
        onApply={onDataOperation}
        onSampleTable={onSampleTable}
      />

      <AggregateDialog
        isOpen={aggregateDialogOpen}
        onClose={() => setAggregateDialogOpen(false)}
        activeTable={activeTable}
        schema={schema}
        onCreateTable={onCreateAggregateTable}
      />

      <PivotDialog
        isOpen={pivotDialogOpen}
        onClose={() => setPivotDialogOpen(false)}
        activeTable={activeTable}
        schema={schema}
        onCreateTable={onCreatePivotTable}
      />

      <LookupMergeDialog
        isOpen={mergeDialogOpen}
        onClose={() => setMergeDialogOpen(false)}
        activeTable={activeTable}
        schema={schema}
        tables={tables}
        onExecute={onLookupMerge}
      />

      <DateConversionDialog
        isOpen={dateConvDialogOpen}
        onClose={() => setDateConvDialogOpen(false)}
        activeTable={activeTable}
        schema={schema}
        tables={tables}
        onApply={onDataOperation}
      />
    </div>
  );
}
