import React, { useState, useEffect, useLayoutEffect, useRef } from "react";
import ReactDOM from "react-dom";
import {
  Button,
  Intent,
  Alert,
  Icon,
  RadioGroup,
  Radio,
  Tag,
} from "@blueprintjs/core";
import { SoftSelect } from "./SoftSelect";
import { ColumnInfo, RowOpType, RowOpStep, UndoStrategy, FilterGroup, hasActiveFilters } from "../types";
import { ColumnCheckList } from "./ColumnCheckList";
import { buildRowOpPreviewQuery } from "../utils/rowOpsSQL";
import { rowScopeLabel } from "../utils/operationUX";

const OP_OPTIONS: { value: RowOpType; label: string; description: string }[] = [
  { value: "delete_filtered", label: "Delete Filtered Rows", description: "Remove rows that match the current filter" },
  { value: "keep_filtered", label: "Keep Filtered Rows", description: "Remove rows that do NOT match the current filter" },
  { value: "remove_empty", label: "Remove Empty Rows", description: "Remove rows that are empty in selected columns" },
  { value: "remove_duplicates", label: "Remove Duplicates", description: "Drop duplicate rows by selected columns" },
];

const FILTER_REQUIRED_OPS = new Set<RowOpType>(["delete_filtered", "keep_filtered"]);
const COLUMN_SELECT_OPS = new Set<RowOpType>(["remove_empty", "remove_duplicates"]);

// ── Multi-column picker popover (modeled after filter IN picker) ──

interface ColumnMultiPickerProps {
  columns: ColumnInfo[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  placeholderAll: string;
}

type ColumnDropdownPosition = {
  top?: number;
  bottom?: number;
  left: number;
  width: number;
  maxHeight: number;
};

const COLUMN_DROPDOWN_GAP = 4;
const COLUMN_DROPDOWN_MARGIN = 8;
const COLUMN_DROPDOWN_MIN_WIDTH = 280;
const COLUMN_DROPDOWN_MAX_WIDTH = 420;
const COLUMN_DROPDOWN_MAX_HEIGHT = 300;
const COLUMN_DROPDOWN_MIN_USABLE_HEIGHT = 160;

function ColumnMultiPicker({ columns, selected, onChange, placeholderAll }: ColumnMultiPickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<ColumnDropdownPosition>({
    top: 0,
    left: 0,
    width: COLUMN_DROPDOWN_MIN_WIDTH,
    maxHeight: COLUMN_DROPDOWN_MAX_HEIGHT,
  });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);
  const items = React.useMemo(
    () =>
      [...columns]
        .sort((a, b) => a.column_name.localeCompare(b.column_name, undefined, { sensitivity: "base" }))
        .map((c) => ({ name: c.column_name, type: c.column_type })),
    [columns]
  );

  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      if (!anchorRef.current) return;
      const rect = anchorRef.current.getBoundingClientRect();
      const availableViewportWidth = Math.max(160, window.innerWidth - COLUMN_DROPDOWN_MARGIN * 2);
      const dropdownWidth = Math.min(
        Math.max(rect.width, COLUMN_DROPDOWN_MIN_WIDTH),
        Math.min(COLUMN_DROPDOWN_MAX_WIDTH, availableViewportWidth)
      );
      const maxLeft = Math.max(
        COLUMN_DROPDOWN_MARGIN,
        window.innerWidth - dropdownWidth - COLUMN_DROPDOWN_MARGIN
      );
      const left = Math.min(
        Math.max(rect.left, COLUMN_DROPDOWN_MARGIN),
        maxLeft
      );
      const spaceBelow = window.innerHeight - rect.bottom - COLUMN_DROPDOWN_GAP - COLUMN_DROPDOWN_MARGIN;
      const spaceAbove = rect.top - COLUMN_DROPDOWN_GAP - COLUMN_DROPDOWN_MARGIN;
      const openBelow = spaceBelow >= COLUMN_DROPDOWN_MIN_USABLE_HEIGHT || spaceBelow >= spaceAbove;
      const availableHeight = Math.max(120, openBelow ? spaceBelow : spaceAbove);

      setPos({
        top: openBelow ? rect.bottom + COLUMN_DROPDOWN_GAP : undefined,
        bottom: openBelow ? undefined : window.innerHeight - rect.top + COLUMN_DROPDOWN_GAP,
        left,
        width: dropdownWidth,
        maxHeight: Math.min(COLUMN_DROPDOWN_MAX_HEIGHT, availableHeight),
      });
    };
    updatePosition();

    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  const label = selected.size === 0
    ? placeholderAll
    : selected.size === 1
      ? Array.from(selected)[0]
      : `${selected.size} columns`;

  const dropdown = open
    ? ReactDOM.createPortal(
        <div
          className="in-value-dropdown rowops-column-dropdown"
          ref={dropdownRef}
          style={{
            position: "fixed",
            left: pos.left,
            width: pos.width,
            maxHeight: pos.maxHeight,
            ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
          }}
        >
          <div className="rowops-column-picker-content">
            <ColumnCheckList
              items={items}
              selected={selected}
              onChange={onChange}
              search
              searchPlaceholder="Search columns..."
              autoFocusSearch
              selectAllScope="filtered"
              selectAllMode="merge"
              maxHeight={Math.max(96, pos.maxHeight - 74)}
              emptyMeans="all"
              emptyAllText="All columns will be used."
              className="rowops-column-check-list"
            />
            <div className="rowops-column-picker-count">
              {selected.size} / {columns.length}
            </div>
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="in-value-picker-wrapper rowops-col-picker" ref={anchorRef}>
      <Button
        className="filter-value-btn"
        small
        rightIcon={open ? "caret-up" : "caret-down"}
        text={label}
        onClick={() => setOpen((v) => !v)}
      />
      {dropdown}
    </div>
  );
}

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
  const [emptyMode, setEmptyMode] = useState<"all" | "any">("any");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hasFilter = hasActiveFilters(activeFilters);
  const needsFilter = FILTER_REQUIRED_OPS.has(opType);
  const needsColumns = COLUMN_SELECT_OPS.has(opType);
  const isDisabled = needsFilter && !hasFilter;

  useEffect(() => {
    setSelectedColumns(new Set());
    setEmptyMode("any");
    setPreviewCount(null);
  }, [opType]);

  useEffect(() => {
    if (!activeTable || !visible) return;
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);

    if (isDisabled) {
      setPreviewCount(null);
      return;
    }

    let cancelled = false;
    setPreviewCount(null);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const sql = buildRowOpPreviewQuery(activeTable, opType, {
          columns: JSON.stringify(Array.from(selectedColumns)), emptyMode,
        }, activeFilters, columns);
        const rows = await window.api.query(sql);
        if (!cancelled) setPreviewCount(Number(rows[0]?.cnt ?? 0));
      } catch {
        if (!cancelled) setPreviewCount(null);
      }
    }, 400);

    return () => {
      cancelled = true;
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [opType, activeTable, totalRows, unfilteredRows, hasFilter, selectedColumns, columns, visible, isDisabled, emptyMode, activeFilters]);

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
      if (opType === "remove_empty") {
        params.emptyMode = emptyMode;
      }
      const appliedOp = OP_OPTIONS.find((o) => o.value === opType)?.label ?? opType;
      await onApply(opType, params);
      setOpType("delete_filtered");
      setSelectedColumns(new Set());
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

  const opMeta = OP_OPTIONS.find((o) => o.value === opType)!;

  const previewLabel = (() => {
    if (previewCount === null) return null;
    if (previewCount === 0) return "No rows will be removed";
    return `${previewCount.toLocaleString()} row${previewCount !== 1 ? "s" : ""} will be removed`;
  })();

  const statusInfo = (() => {
    if (successMsg) return { tag: "Done", intent: Intent.SUCCESS, icon: "tick" as const, detail: successMsg };
    if (error) return { tag: "Error", intent: Intent.DANGER, icon: "error" as const, detail: error };
    if (loading) return { tag: "Working", intent: Intent.PRIMARY, icon: "refresh" as const, detail: "Applying..." };
    if (isDisabled) return { tag: "Needs filter", intent: Intent.WARNING, icon: "filter" as const, detail: opMeta.description };
    if (previewLabel) return { tag: "Ready", intent: Intent.WARNING, icon: "edit" as const, detail: previewLabel };
    return { tag: "Ready", intent: undefined, icon: "edit" as const, detail: opMeta.description };
  })();

  return (
    <div className="rowops-body" style={{ display: visible ? "flex" : "none" }}>
      {/* Toolbar — matches filter-toolbar */}
      <div className="rowops-toolbar">
        <div className="rowops-status-strip">
          <div className="motion-status-pair" key={`${statusInfo.tag}:${statusInfo.detail}`}>
            <Tag minimal icon={statusInfo.icon} intent={statusInfo.intent}>
              {statusInfo.tag}
            </Tag>
            <span className="rowops-status-detail" title={statusInfo.detail}>{statusInfo.detail}</span>
          </div>
          <Tag minimal icon={hasFilter ? "filter" : "database"} intent={hasFilter ? Intent.PRIMARY : undefined} className="rowops-scope-tag">
            {opType === "keep_filtered"
              ? `Keep ${rowScopeLabel(hasFilter, totalRows, unfilteredRows)}`
              : rowScopeLabel(hasFilter, totalRows, unfilteredRows)}
          </Tag>
        </div>
        <div className="rowops-toolbar-actions">
          <Button
            intent={Intent.WARNING}
            icon="tick"
            text="Apply"
            small
            onClick={() => setConfirmOpen(true)}
            loading={loading}
            disabled={isDisabled || loading}
          />
        </div>
      </div>

      <div className="rowops-workspace">
        {/* Content */}
        <div className="rowops-content">
          {isDisabled ? (
            <div className="rowops-empty-state">
              <div className="rowops-empty-icon" aria-hidden="true">
                <Icon icon="filter" iconSize={18} />
              </div>
              <div className="rowops-empty-main">
                <div className="rowops-empty-copy">
                  <span className="rowops-empty-title">A filter is required first</span>
                  <span className="rowops-empty-text">
                    {opMeta.label} works on filtered rows. Switch to the Filters tab and add a condition.
                  </span>
                </div>
                <div className="rowops-empty-actions">
                  <SoftSelect
                    className="rowops-empty-op-select"
                    value={opType}
                    onChange={(e) => setOpType(e.target.value as RowOpType)}
                  >
                    {OP_OPTIONS.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </SoftSelect>
                </div>
              </div>
            </div>
          ) : (
            <div className="rowops-form-card">
              <div className="rowops-form-row">
                <div className="rowops-field">
                  <label>Operation</label>
                  <SoftSelect
                    className="rowops-op-select"
                    value={opType}
                    onChange={(e) => setOpType(e.target.value as RowOpType)}
                    fill
                  >
                    {OP_OPTIONS.map((op) => (
                      <option key={op.value} value={op.value}>{op.label}</option>
                    ))}
                  </SoftSelect>
                </div>

                {opType === "remove_empty" && (
                  <div className="rowops-field">
                    <label>Match</label>
                    <div className="rowops-mode-switch" role="group" aria-label="Empty match mode">
                      <button
                        type="button"
                        className={`rowops-mode-option${emptyMode === "any" ? " active" : ""}`}
                        aria-pressed={emptyMode === "any"}
                        onClick={() => setEmptyMode("any")}
                        title="Match if any selected column is empty"
                      >
                        Any
                      </button>
                      <button
                        type="button"
                        className={`rowops-mode-option${emptyMode === "all" ? " active" : ""}`}
                        aria-pressed={emptyMode === "all"}
                        onClick={() => setEmptyMode("all")}
                        title="Match only if all selected columns are empty"
                      >
                        All
                      </button>
                    </div>
                  </div>
                )}

                {needsColumns && (
                  <div className="rowops-field rowops-field-grow">
                    <label>
                      {opType === "remove_duplicates" ? "Dedup by" : "Check"}
                    </label>
                    <ColumnMultiPicker
                      columns={columns}
                      selected={selectedColumns}
                      onChange={setSelectedColumns}
                      placeholderAll="All columns"
                    />
                  </div>
                )}
              </div>

              <div className="rowops-form-hint">
                <Icon icon="info-sign" iconSize={11} />
                <span>{opMeta.description}</span>
              </div>
            </div>
          )}
        </div>

        {/* Step history */}
        <div className="rowops-steps">
          <div className="rowops-steps-header">
            <span className="rowops-steps-title">
              History
              <span className="rowops-steps-count">{rowOpsSteps.length}</span>
            </span>
            <div className="rowops-steps-actions">
              {rowOpsSteps.length > 0 && undoStrategy === "snapshot" && (
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
              {rowOpsSteps.length > 0 && (
                <Button
                  small
                  minimal
                  icon="trash"
                  onClick={() => setClearConfirmOpen(true)}
                  disabled={loading}
                  title="Clear history"
                />
              )}
            </div>
          </div>
          {rowOpsSteps.length > 0 ? (
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
          ) : (
            <div className="rowops-history-empty">
              <svg
                className="rowops-history-empty-art"
                viewBox="0 0 168 108"
                role="img"
                aria-label="Empty history"
              >
                <defs>
                  <linearGradient id="rowops-history-glow" x1="26" y1="18" x2="144" y2="92" gradientUnits="userSpaceOnUse">
                    <stop className="rowops-history-glow-start" />
                    <stop className="rowops-history-glow-mid" offset="0.58" />
                    <stop className="rowops-history-glow-end" offset="1" />
                  </linearGradient>
                  <linearGradient id="rowops-history-line" x1="40" y1="30" x2="130" y2="76" gradientUnits="userSpaceOnUse">
                    <stop className="rowops-history-line-start" />
                    <stop className="rowops-history-line-end" offset="1" />
                  </linearGradient>
                  <filter id="rowops-history-shadow" x="18" y="8" width="132" height="96" filterUnits="userSpaceOnUse">
                    <feDropShadow className="rowops-history-shadow-color" dx="0" dy="5" stdDeviation="6" />
                  </filter>
                </defs>
                <path
                  d="M25 61C25 37 45 18 72 18h23c27 0 48 19 48 43s-21 43-48 43H72c-27 0-47-19-47-43Z"
                  fill="url(#rowops-history-glow)"
                />
                <g filter="url(#rowops-history-shadow)">
                  <rect className="rowops-history-card" x="45" y="26" width="78" height="60" rx="8" />
                  <path className="rowops-history-card-lines" d="M58 44h31M58 57h52M58 70h34" strokeWidth="4" strokeLinecap="round" />
                  <path className="rowops-history-pencil" d="M107 36l9 9-17 17-9-9 17-17Z" />
                  <path className="rowops-history-pencil-line" d="M91 53l8 8" strokeWidth="4" strokeLinecap="round" />
                </g>
                <path
                  d="M34 82c19-10 29-16 47-12 20 5 29 18 55 2"
                  fill="none"
                  stroke="url(#rowops-history-line)"
                  strokeWidth="4"
                  strokeLinecap="round"
                />
                <circle className="rowops-history-dot-warn" cx="34" cy="82" r="4" />
                <circle className="rowops-history-dot-blue" cx="136" cy="72" r="4" />
              </svg>
              <div className="rowops-history-empty-copy">
                <span className="rowops-history-empty-title">History is clear</span>
                <span className="rowops-history-empty-text">Ready for the next row operation.</span>
              </div>
            </div>
          )}
        </div>
      </div>

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
          {opType === "remove_empty" && `Remove rows where ${emptyMode === "any" ? "any" : "all"} of ${selectedColumns.size === 0 ? "all" : selectedColumns.size} column${selectedColumns.size !== 1 ? "s are" : " is"} empty? ${previewCount !== null ? `(${previewCount.toLocaleString()} rows)` : ""}`}
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
