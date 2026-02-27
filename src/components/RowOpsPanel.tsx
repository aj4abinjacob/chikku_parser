import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Button,
  Checkbox,
  HTMLSelect,
  InputGroup,
  Intent,
  Alert,
  Icon,
} from "@blueprintjs/core";
import { ColumnInfo, RowOpType, RowOpStep, UndoStrategy, FilterGroup, hasActiveFilters } from "../types";

const OP_OPTIONS: { value: RowOpType; label: string }[] = [
  { value: "delete_filtered", label: "Delete Filtered Rows" },
  { value: "keep_filtered", label: "Keep Filtered Rows" },
  { value: "remove_empty", label: "Remove Empty Rows" },
  { value: "remove_duplicates", label: "Remove Duplicates" },
];

const FILTER_REQUIRED_OPS = new Set<RowOpType>(["delete_filtered", "keep_filtered"]);
const COLUMN_SELECT_OPS = new Set<RowOpType>(["remove_empty", "remove_duplicates"]);

interface RowOpsPanelProps {
  columns: ColumnInfo[];
  activeTable: string | null;
  activeFilters: FilterGroup;
  rowOpsSteps: RowOpStep[];
  undoStrategy: UndoStrategy;
  onApply: (opType: RowOpType, params: Record<string, string>) => Promise<void>;
  onUndo: () => Promise<void>;
  onRevertAll: () => Promise<void>;
  onClearAll: () => Promise<void>;
  totalRows: number;
  unfilteredRows: number | null;
  visible: boolean;
}

export function RowOpsPanel({
  columns,
  activeTable,
  activeFilters,
  rowOpsSteps,
  undoStrategy,
  onApply,
  onUndo,
  onRevertAll,
  onClearAll,
  totalRows,
  unfilteredRows,
  visible,
}: RowOpsPanelProps): React.ReactElement {
  const [opType, setOpType] = useState<RowOpType>("delete_filtered");
  const [selectedColumns, setSelectedColumns] = useState<Set<string>>(new Set());
  const [colSearch, setColSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasFilter = hasActiveFilters(activeFilters);
  const isFiltered = unfilteredRows !== null;
  const needsFilter = FILTER_REQUIRED_OPS.has(opType);
  const needsColumns = COLUMN_SELECT_OPS.has(opType);
  const isDisabled = needsFilter && !hasFilter;

  // Reset column selection when op type changes
  useEffect(() => {
    setSelectedColumns(new Set());
    setColSearch("");
    setPreviewCount(null);
  }, [opType]);

  // Debounced preview count
  useEffect(() => {
    if (!activeTable || !visible) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

    if (isDisabled) {
      setPreviewCount(null);
      return;
    }

    previewTimerRef.current = setTimeout(async () => {
      try {
        if (opType === "delete_filtered" && hasFilter) {
          // Count of rows that will be deleted = filtered row count
          setPreviewCount(totalRows);
        } else if (opType === "keep_filtered" && hasFilter) {
          // Count of rows that will be deleted = total - filtered
          const total = unfilteredRows ?? totalRows;
          setPreviewCount(total - totalRows);
        } else if (opType === "remove_empty") {
          const cols = selectedColumns.size > 0
            ? Array.from(selectedColumns)
            : columns.map((c) => c.column_name);
          const conditions = cols.map((colName) => {
            const col = columns.find((c) => c.column_name === colName);
            const ident = `"${colName.replace(/"/g, '""')}"`;
            const colType = col?.column_type?.toUpperCase() ?? "";
            const isVarchar = colType.startsWith("VARCHAR") || colType === "TEXT" || colType === "STRING";
            if (isVarchar) {
              return `(${ident} IS NULL OR TRIM(CAST(${ident} AS VARCHAR)) = '')`;
            }
            return `${ident} IS NULL`;
          });
          const escapedTable = `"${activeTable.replace(/"/g, '""')}"`;
          const sql = `SELECT COUNT(*) as cnt FROM ${escapedTable} WHERE ${conditions.join(" AND ")}`;
          const rows = await window.api.query(sql);
          setPreviewCount(Number(rows[0]?.cnt ?? 0));
        } else if (opType === "remove_duplicates") {
          const cols = selectedColumns.size > 0
            ? Array.from(selectedColumns)
            : columns.map((c) => c.column_name);
          const partitionCols = cols.map((c) => `"${c.replace(/"/g, '""')}"`).join(", ");
          const escapedTable = `"${activeTable.replace(/"/g, '""')}"`;
          const sql = `SELECT COUNT(*) as cnt FROM (SELECT *, row_number() OVER (PARTITION BY ${partitionCols}) as __rn FROM ${escapedTable}) WHERE __rn > 1`;
          const rows = await window.api.query(sql);
          setPreviewCount(Number(rows[0]?.cnt ?? 0));
        } else {
          setPreviewCount(null);
        }
      } catch {
        setPreviewCount(null);
      }
    }, 400);

    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [opType, activeTable, totalRows, unfilteredRows, hasFilter, selectedColumns, columns, visible, isDisabled]);

  const handleApply = async () => {
    setConfirmOpen(false);
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const params: Record<string, string> = {};
      if (needsColumns && selectedColumns.size > 0) {
        params.columns = JSON.stringify(Array.from(selectedColumns));
      }
      const appliedOp = OP_OPTIONS.find((o) => o.value === opType)?.label ?? opType;
      await onApply(opType, params);
      setOpType("delete_filtered");
      setSelectedColumns(new Set());
      setColSearch("");
      setPreviewCount(null);
      setSuccessMsg(`${appliedOp} completed`);
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleClearAll = async () => {
    setClearConfirmOpen(false);
    setLoading(true);
    try {
      await onClearAll();
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleRevertAll = async () => {
    setRevertConfirmOpen(false);
    setLoading(true);
    setError(null);
    try {
      await onRevertAll();
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleUndo = async () => {
    setLoading(true);
    setError(null);
    try {
      await onUndo();
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  if (!activeTable) {
    return (
      <div className="rowops-body" style={{ display: visible ? "flex" : "none" }}>
        <div className="rowops-empty">No table selected</div>
      </div>
    );
  }

  const toggleColumn = (colName: string) => {
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      if (next.has(colName)) next.delete(colName);
      else next.add(colName);
      return next;
    });
  };

  const selectAllColumns = () => {
    const visible = filteredColumns.map((c) => c.column_name);
    setSelectedColumns((prev) => {
      const next = new Set(prev);
      for (const v of visible) next.add(v);
      return next;
    });
  };

  const deselectAllColumns = () => setSelectedColumns(new Set());

  const filteredColumns = columns.filter((c) =>
    !colSearch || c.column_name.toLowerCase().includes(colSearch.toLowerCase())
  );

  const previewLabel = (() => {
    if (previewCount === null) return null;
    if (previewCount === 0) return "No rows will be removed";
    return `${previewCount.toLocaleString()} row${previewCount !== 1 ? "s" : ""} will be removed`;
  })();

  return (
    <div className="rowops-body" style={{ display: visible ? "flex" : "none" }}>
      {/* Top area: form + status */}
      <div className="rowops-top">
        {/* Operation row */}
        <div className="rowops-op-row">
          <HTMLSelect
            className="rowops-op-select"
            value={opType}
            onChange={(e) => setOpType(e.target.value as RowOpType)}
          >
            {OP_OPTIONS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </HTMLSelect>

          <Button
            className="rowops-apply-btn"
            intent={Intent.WARNING}
            icon="tick"
            text="Apply"
            small
            onClick={() => setConfirmOpen(true)}
            loading={loading}
            disabled={isDisabled || loading}
          />
        </div>

        {/* Disabled hint */}
        {isDisabled && (
          <div className="rowops-disabled-hint">
            <Icon icon="info-sign" iconSize={12} />
            Set a filter first to use this operation
          </div>
        )}

        {/* Column selector for remove_empty and remove_duplicates */}
        {needsColumns && (
          <div className="rowops-col-selector">
            <div className="rowops-col-selector-header">
              <span className="rowops-col-selector-label">
                {opType === "remove_duplicates" ? "Dedup by columns" : "Check columns"} ({selectedColumns.size === 0 ? "all" : selectedColumns.size})
              </span>
              <div className="rowops-col-selector-actions">
                <Button small minimal text="All" onClick={selectAllColumns} />
                <Button small minimal text="None" onClick={deselectAllColumns} />
              </div>
            </div>
            <div className="rowops-col-selector-search">
              <InputGroup
                placeholder="Search columns..."
                value={colSearch}
                onChange={(e) => setColSearch(e.target.value)}
                small
                leftIcon="search"
              />
            </div>
            <div className="rowops-col-selector-list">
              {filteredColumns.map((col) => (
                <label key={col.column_name} className={`rowops-col-item ${selectedColumns.has(col.column_name) ? "selected" : ""}`}>
                  <Checkbox
                    checked={selectedColumns.has(col.column_name)}
                    onChange={() => toggleColumn(col.column_name)}
                    style={{ marginBottom: 0 }}
                  />
                  <span className="rowops-col-name">{col.column_name}</span>
                  <span className="rowops-col-type">{col.column_type}</span>
                </label>
              ))}
            </div>
          </div>
        )}

        {/* Status row: scope banner + preview + messages */}
        <div className="rowops-status-row">
          <span className={isFiltered ? "rowops-scope rowops-scope-filtered" : "rowops-scope rowops-scope-all"}>
            <Icon icon={isFiltered ? "filter" : "database"} iconSize={10} />
            {isFiltered
              ? `${totalRows.toLocaleString()} of ${unfilteredRows!.toLocaleString()} rows`
              : `All ${totalRows.toLocaleString()} rows`}
          </span>
          {previewLabel && !isDisabled && (
            <span className="rowops-preview-count">
              <Icon icon="eye-open" iconSize={10} />
              {previewLabel}
            </span>
          )}
          {successMsg && (
            <span className="rowops-inline-success">
              <Icon icon="tick-circle" iconSize={12} intent={Intent.SUCCESS} />
              {successMsg}
            </span>
          )}
          {error && (
            <span className="rowops-inline-error" title={error}>
              <Icon icon="error" iconSize={12} intent={Intent.DANGER} />
              {error}
            </span>
          )}
        </div>
      </div>

      {/* Step history */}
      {rowOpsSteps.length > 0 && (
        <div className="rowops-steps">
          <div className="rowops-steps-header">
            <span className="rowops-steps-title">History ({rowOpsSteps.length})</span>
            <div className="rowops-steps-actions">
              {undoStrategy === "snapshot" && (
                <Button
                  small
                  minimal
                  intent={Intent.WARNING}
                  icon="undo"
                  text="Revert All"
                  onClick={() => setRevertConfirmOpen(true)}
                  disabled={loading}
                />
              )}
              <Button
                small
                minimal
                icon="trash"
                onClick={() => setClearConfirmOpen(true)}
                disabled={loading}
                title="Clear history"
              />
            </div>
          </div>
          <div className="rowops-step-list">
            {[...rowOpsSteps].reverse().map((step, idx) => (
              <div key={step.id} className={`rowops-step-item ${idx === 0 ? "rowops-step-latest" : ""}`}>
                <span className="rowops-step-number">{step.id}</span>
                <span className="rowops-step-desc" title={step.description}>{step.description}</span>
                {undoStrategy === "per-step" && idx === 0 && (
                  <Button
                    small
                    minimal
                    icon="undo"
                    className="rowops-step-undo"
                    title="Undo this step"
                    onClick={handleUndo}
                    disabled={loading}
                  />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Apply confirmation */}
      <Alert
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleApply}
        intent={Intent.WARNING}
        icon="warning-sign"
        confirmButtonText="Apply"
        cancelButtonText="Cancel"
      >
        <p>
          {opType === "delete_filtered" && `Delete ${totalRows.toLocaleString()} filtered rows? This modifies the table data.`}
          {opType === "keep_filtered" && `Delete all rows NOT matching the current filter? This modifies the table data.`}
          {opType === "remove_empty" && `Remove rows where ${selectedColumns.size === 0 ? "all" : selectedColumns.size} column${selectedColumns.size !== 1 ? "s are" : " is"} empty? ${previewCount !== null ? `(${previewCount.toLocaleString()} rows)` : ""}`}
          {opType === "remove_duplicates" && `Remove duplicate rows based on ${selectedColumns.size === 0 ? "all" : selectedColumns.size} column${selectedColumns.size !== 1 ? "s" : ""}? ${previewCount !== null ? `(${previewCount.toLocaleString()} rows)` : ""}`}
        </p>
      </Alert>

      {/* Clear confirmation */}
      <Alert
        isOpen={clearConfirmOpen}
        onClose={() => setClearConfirmOpen(false)}
        onConfirm={handleClearAll}
        intent={Intent.DANGER}
        icon="trash"
        confirmButtonText="Clear All"
        cancelButtonText="Cancel"
      >
        <p>Clear all step history and drop backup tables? This cannot be undone.</p>
      </Alert>

      {/* Revert All confirmation */}
      <Alert
        isOpen={revertConfirmOpen}
        onClose={() => setRevertConfirmOpen(false)}
        onConfirm={handleRevertAll}
        intent={Intent.WARNING}
        icon="undo"
        confirmButtonText="Revert All"
        cancelButtonText="Cancel"
      >
        <p>Revert the table to its state before any row operations were applied?</p>
      </Alert>
    </div>
  );
}
