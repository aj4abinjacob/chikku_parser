import React, { useState, useCallback } from "react";
import {
  Button,
  Callout,
  HTMLSelect,
  InputGroup,
  Checkbox,
  Intent,
  Alert,
  Icon,
} from "@blueprintjs/core";
import { ColumnInfo, ColOpType, ColOpStep, UndoStrategy, FilterGroup } from "../types";
import { RegexPatternPicker } from "./RegexPatternPicker";
import { RegexPatternManagerDialog } from "./RegexPatternManagerDialog";

const OP_OPTIONS: { value: ColOpType; label: string }[] = [
  { value: "assign_value", label: "Assign Value" },
  { value: "find_replace", label: "Find & Replace" },
  { value: "regex_extract", label: "Regex Extract" },
  { value: "extract_numbers", label: "Extract Numbers" },
  { value: "trim", label: "Trim" },
  { value: "upper", label: "Uppercase" },
  { value: "lower", label: "Lowercase" },
  { value: "clear_null", label: "Clear to NULL" },
  { value: "prefix_suffix", label: "Prefix / Suffix" },
];

// Operations that need no extra params — just column + apply
const NO_PARAM_OPS = new Set<ColOpType>(["trim", "upper", "lower", "clear_null", "extract_numbers"]);

interface ColumnOpsPanelProps {
  columns: ColumnInfo[];
  activeTable: string | null;
  activeFilters: FilterGroup;
  colOpsSteps: ColOpStep[];
  undoStrategy: UndoStrategy;
  onApply: (opType: ColOpType, column: string, params: Record<string, string>) => Promise<void>;
  onUndo: () => Promise<void>;
  onRevertAll: () => Promise<void>;
  onClearAll: () => Promise<void>;
  totalRows: number;
  unfilteredRows: number | null;
  visible: boolean;
}

export function ColumnOpsPanel({
  columns,
  activeTable,
  activeFilters,
  colOpsSteps,
  undoStrategy,
  onApply,
  onUndo,
  onRevertAll,
  onClearAll,
  totalRows,
  unfilteredRows,
  visible,
}: ColumnOpsPanelProps): React.ReactElement {
  const [selectedColumn, setSelectedColumn] = useState("");
  const [opType, setOpType] = useState<ColOpType>("assign_value");
  const [params, setParams] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [patternManagerOpen, setPatternManagerOpen] = useState(false);
  const [patternRefreshKey, setPatternRefreshKey] = useState(0);

  const handlePatternsChanged = useCallback(() => {
    setPatternRefreshKey((k) => k + 1);
  }, []);

  const hasFilter = unfilteredRows !== null;
  const isFiltered = hasFilter && totalRows !== unfilteredRows;

  const handleApply = async () => {
    if (!selectedColumn || !activeTable) return;
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const appliedCol = selectedColumn;
      const appliedOp = OP_OPTIONS.find((o) => o.value === opType)?.label ?? opType;
      await onApply(opType, selectedColumn, params);
      // Reset form for next operation
      setSelectedColumn("");
      setOpType("assign_value");
      setParams({});
      // Show success flash
      setSuccessMsg(`${appliedOp} applied to "${appliedCol}"`);
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
      <div className="colops-body" style={{ display: visible ? "flex" : "none" }}>
        <div className="colops-empty">No table selected</div>
      </div>
    );
  }

  const updateParam = (key: string, value: string) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  const needsParams = !NO_PARAM_OPS.has(opType);

  // Inline params that appear on the same row as the selects
  const renderInlineParams = () => {
    switch (opType) {
      case "assign_value":
        return (
          <InputGroup
            className="colops-inline-input"
            value={params.value ?? ""}
            onChange={(e) => updateParam("value", e.target.value)}
            placeholder="New value..."
            onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
          />
        );
      case "find_replace":
        return (
          <>
            <InputGroup
              className="colops-inline-input"
              value={params.pattern ?? ""}
              onChange={(e) => updateParam("pattern", e.target.value)}
              placeholder="Find..."
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
              rightElement={params.useRegex === "true" ? (
                <RegexPatternPicker
                  key={patternRefreshKey}
                  onSelect={(p) => updateParam("pattern", p)}
                  onOpenManager={() => setPatternManagerOpen(true)}
                />
              ) : undefined}
            />
            <Icon icon="arrow-right" className="colops-arrow-icon" />
            <InputGroup
              className="colops-inline-input"
              value={params.replacement ?? ""}
              onChange={(e) => updateParam("replacement", e.target.value)}
              placeholder="Replace..."
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
            />
            <Checkbox
              checked={params.useRegex === "true"}
              onChange={(e) => updateParam("useRegex", (e.target as HTMLInputElement).checked ? "true" : "false")}
              label="Regex"
              className="colops-inline-checkbox"
            />
          </>
        );
      case "regex_extract":
        return (
          <>
            <InputGroup
              className="colops-inline-input"
              value={params.pattern ?? ""}
              onChange={(e) => updateParam("pattern", e.target.value)}
              placeholder="Pattern..."
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
              rightElement={
                <RegexPatternPicker
                  key={patternRefreshKey}
                  onSelect={(p) => updateParam("pattern", p)}
                  onOpenManager={() => setPatternManagerOpen(true)}
                />
              }
            />
            <InputGroup
              className="colops-group-input"
              value={params.groupIndex ?? "1"}
              onChange={(e) => updateParam("groupIndex", e.target.value)}
              placeholder="Group"
              type="number"
            />
          </>
        );
      case "prefix_suffix":
        return (
          <>
            <InputGroup
              className="colops-inline-input"
              value={params.prefix ?? ""}
              onChange={(e) => updateParam("prefix", e.target.value)}
              placeholder="Prefix..."
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
            />
            <span className="colops-plus-icon">+</span>
            <span className="colops-col-placeholder">col</span>
            <span className="colops-plus-icon">+</span>
            <InputGroup
              className="colops-inline-input"
              value={params.suffix ?? ""}
              onChange={(e) => updateParam("suffix", e.target.value)}
              placeholder="Suffix..."
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
            />
          </>
        );
      default:
        return null;
    }
  };

  return (
    <div className="colops-body" style={{ display: visible ? "flex" : "none" }}>
      {/* Top area: form + banner side by side */}
      <div className="colops-top">
        {/* Operation row — all controls inline */}
        <div className="colops-op-row">
          <HTMLSelect
            className="colops-col-select"
            value={selectedColumn}
            onChange={(e) => setSelectedColumn(e.target.value)}
          >
            <option value="">Column...</option>
            {columns.map((c) => (
              <option key={c.column_name} value={c.column_name}>
                {c.column_name}
              </option>
            ))}
          </HTMLSelect>

          <HTMLSelect
            className="colops-op-select"
            value={opType}
            onChange={(e) => {
              setOpType(e.target.value as ColOpType);
              setParams({});
            }}
          >
            {OP_OPTIONS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </HTMLSelect>

          {renderInlineParams()}

          <Button
            className="colops-apply-btn"
            intent={Intent.PRIMARY}
            icon="tick"
            text="Apply"
            small
            onClick={handleApply}
            loading={loading}
            disabled={!selectedColumn || loading}
          />
        </div>

        {/* Status row: scope banner + error */}
        <div className="colops-status-row">
          <span className={isFiltered ? "colops-scope colops-scope-filtered" : "colops-scope colops-scope-all"}>
            <Icon icon={isFiltered ? "filter" : "database"} iconSize={10} />
            {isFiltered
              ? `${totalRows.toLocaleString()} of ${unfilteredRows!.toLocaleString()} rows`
              : `All ${totalRows.toLocaleString()} rows`}
          </span>
          {successMsg && (
            <span className="colops-inline-success">
              <Icon icon="tick-circle" iconSize={12} intent={Intent.SUCCESS} />
              {successMsg}
            </span>
          )}
          {error && (
            <span className="colops-inline-error" title={error}>
              <Icon icon="error" iconSize={12} intent={Intent.DANGER} />
              {error}
            </span>
          )}
        </div>
      </div>

      {/* Step history */}
      {colOpsSteps.length > 0 && (
        <div className="colops-steps">
          <div className="colops-steps-header">
            <span className="colops-steps-title">History ({colOpsSteps.length})</span>
            <div className="colops-steps-actions">
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
          <div className="colops-step-list">
            {[...colOpsSteps].reverse().map((step, idx) => (
              <div key={step.id} className={`colops-step-item ${idx === 0 ? "colops-step-latest" : ""}`}>
                <span className="colops-step-number">{step.id}</span>
                <span className="colops-step-desc" title={step.description}>{step.description}</span>
                {undoStrategy === "per-step" && idx === 0 && (
                  <Button
                    small
                    minimal
                    icon="undo"
                    className="colops-step-undo"
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
        <p>Revert the table to its state before any column operations were applied?</p>
      </Alert>

      <RegexPatternManagerDialog
        isOpen={patternManagerOpen}
        onClose={() => setPatternManagerOpen(false)}
        onPatternsChanged={handlePatternsChanged}
      />
    </div>
  );
}
