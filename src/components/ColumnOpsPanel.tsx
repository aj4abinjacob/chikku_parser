import React, { useState, useCallback, useEffect, useRef, useLayoutEffect } from "react";
import {
  Button,
  HTMLSelect,
  InputGroup,
  Checkbox,
  Intent,
  Alert,
  Icon,
  RadioGroup,
  Radio,
} from "@blueprintjs/core";
import { ColumnInfo, ColOpType, ColOpStep, UndoStrategy, FilterGroup, ColOpTargetMode } from "../types";
import { buildColOpExpr } from "../utils/colOpsSQL";
import { RegexPatternPicker } from "./RegexPatternPicker";
import { RegexPatternManagerDialog } from "./RegexPatternManagerDialog";
import { SearchableColumnSelect } from "./SearchableColumnSelect";

// Grouped operation options for <optgroup> structure
const OP_GROUPS: { label: string; ops: { value: ColOpType; label: string }[] }[] = [
  {
    label: "Text",
    ops: [
      { value: "trim", label: "Trim Whitespace" },
      { value: "upper", label: "UPPERCASE" },
      { value: "lower", label: "lowercase" },
    ],
  },
  {
    label: "Search",
    ops: [
      { value: "find_replace", label: "Find & Replace" },
      { value: "regex_extract", label: "Regex Extract" },
    ],
  },
  {
    label: "Modify",
    ops: [
      { value: "assign_value", label: "Set Value" },
      { value: "prefix_suffix", label: "Add Prefix / Suffix" },
      { value: "extract_numbers", label: "Extract Numbers" },
      { value: "clear_null", label: "Clear to NULL" },
    ],
  },
];

// Flat list for lookups
const ALL_OPS = OP_GROUPS.flatMap((g) => g.ops);

// Operations that need no extra params
const NO_PARAM_OPS = new Set<ColOpType>(["trim", "upper", "lower", "clear_null"]);

// Operations that should NOT show target mode (result is always NULL replacement)
const NO_TARGET_OPS = new Set<ColOpType>(["clear_null"]);

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
  onContentHeightChange?: (height: number) => void;
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
  onContentHeightChange,
}: ColumnOpsPanelProps): React.ReactElement {
  const [selectedColumn, setSelectedColumn] = useState("");
  const [opType, setOpType] = useState<ColOpType>("trim");
  const [params, setParams] = useState<Record<string, string>>({});
  const [targetMode, setTargetMode] = useState<ColOpTargetMode>("replace");
  const [targetColumn, setTargetColumn] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [patternManagerOpen, setPatternManagerOpen] = useState(false);
  const [patternRefreshKey, setPatternRefreshKey] = useState(0);
  const [previews, setPreviews] = useState<Array<{ original: string; result: string }>>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [lastAppliedKey, setLastAppliedKey] = useState<string | null>(null);
  const configRef = useRef<HTMLDivElement>(null);

  // Notify parent to grow panel when config content changes
  useLayoutEffect(() => {
    if (!visible || !configRef.current || !onContentHeightChange) return;
    const el = configRef.current;
    // scrollHeight = full content height the config panel needs
    onContentHeightChange(el.scrollHeight + 20);
  }, [visible, opType, targetMode, selectedColumn, historyExpanded, colOpsSteps.length, onContentHeightChange]);

  const handlePatternsChanged = useCallback(() => {
    setPatternRefreshKey((k) => k + 1);
  }, []);

  // Live preview: debounced query for 5 sample rows showing before/after
  useEffect(() => {
    if (!activeTable || !selectedColumn || !visible) {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

    if (opType === "clear_null") {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

    // For ops with required params, skip preview until params are filled
    if (opType === "assign_value" && !params.value) { setPreviews([]); setPreviewError(null); return; }
    if (opType === "find_replace" && !params.pattern) { setPreviews([]); setPreviewError(null); return; }
    if (opType === "regex_extract" && !params.pattern) { setPreviews([]); setPreviewError(null); return; }
    if (opType === "prefix_suffix" && !params.prefix && !params.suffix) { setPreviews([]); setPreviewError(null); return; }

    let expr: string;
    try {
      expr = buildColOpExpr(selectedColumn, opType, params);
    } catch {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const sql = `SELECT DISTINCT CAST("${selectedColumn}" AS VARCHAR) AS "original", CAST(${expr} AS VARCHAR) AS "result" FROM "${activeTable}" WHERE "${selectedColumn}" IS NOT NULL LIMIT 5`;
        const rows = await window.api.query(sql);
        setPreviews(rows.map((r: any) => ({ original: String(r.original ?? ""), result: String(r.result ?? "") })));
        setPreviewError(null);
      } catch (e: any) {
        setPreviews([]);
        setPreviewError(e.message || "Preview failed");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [activeTable, selectedColumn, opType, params, visible, colOpsSteps.length]);

  const hasFilter = unfilteredRows !== null;
  const isFiltered = hasFilter && totalRows !== unfilteredRows;
  const showTargetMode = !NO_TARGET_OPS.has(opType);

  // Track current config to detect changes since last apply
  const currentConfigKey = JSON.stringify({ selectedColumn, opType, params, targetMode: showTargetMode ? targetMode : "replace", targetColumn: showTargetMode ? targetColumn : "" });
  const isUnchangedSinceApply = lastAppliedKey === currentConfigKey;

  const handleApply = async () => {
    if (!selectedColumn || !activeTable) return;
    const effectiveTargetMode = showTargetMode ? targetMode : "replace";
    const effectiveTargetCol = showTargetMode ? targetColumn : "";
    if (effectiveTargetMode === "new_column" && !effectiveTargetCol.trim()) return;
    if (effectiveTargetMode === "existing_column" && !effectiveTargetCol) return;
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const appliedCol = selectedColumn;
      const appliedOp = ALL_OPS.find((o) => o.value === opType)?.label ?? opType;
      const fullParams = { ...params, targetMode: effectiveTargetMode, targetColumn: effectiveTargetCol };
      await onApply(opType, selectedColumn, fullParams);
      // Mark this config as applied
      setLastAppliedKey(currentConfigKey);
      // Show success flash
      const targetLabel = effectiveTargetMode === "new_column" ? ` → new "${effectiveTargetCol}"`
        : effectiveTargetMode === "existing_column" ? ` → "${effectiveTargetCol}"`
        : "";
      setSuccessMsg(`${appliedOp} applied to "${appliedCol}"${targetLabel}`);
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

  // Stacked parameter fields
  const renderParams = () => {
    switch (opType) {
      case "assign_value":
        return (
          <div className="colops-field">
            <label>Value</label>
            <InputGroup
              value={params.value ?? ""}
              onChange={(e) => updateParam("value", e.target.value)}
              placeholder="New value..."
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
              fill
            />
          </div>
        );
      case "find_replace":
        return (
          <>
            <div className="colops-field">
              <label>Find</label>
              <InputGroup
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
                fill
              />
            </div>
            <div className="colops-field">
              <label>Replace</label>
              <InputGroup
                value={params.replacement ?? ""}
                onChange={(e) => updateParam("replacement", e.target.value)}
                placeholder="Replace with..."
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                fill
              />
            </div>
            <div className="colops-field">
              <Checkbox
                checked={params.useRegex === "true"}
                onChange={(e) => updateParam("useRegex", (e.target as HTMLInputElement).checked ? "true" : "false")}
                label="Use regex"
                className="colops-checkbox"
              />
            </div>
          </>
        );
      case "regex_extract":
        return (
          <>
            <div className="colops-field">
              <label>Pattern</label>
              <InputGroup
                value={params.pattern ?? ""}
                onChange={(e) => updateParam("pattern", e.target.value)}
                placeholder="Regex pattern..."
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                rightElement={
                  <RegexPatternPicker
                    key={patternRefreshKey}
                    onSelect={(p) => updateParam("pattern", p)}
                    onOpenManager={() => setPatternManagerOpen(true)}
                  />
                }
                fill
              />
            </div>
            <div className="colops-field colops-field-row">
              <div className="colops-field-half">
                <label>Group</label>
                <InputGroup
                  value={params.groupIndex ?? "1"}
                  onChange={(e) => updateParam("groupIndex", e.target.value)}
                  type="number"
                  fill
                />
              </div>
              {params.allMatches === "true" && (
                <div className="colops-field-half">
                  <label>Separator</label>
                  <InputGroup
                    value={params.separator ?? ""}
                    onChange={(e) => updateParam("separator", e.target.value)}
                    placeholder="Sep"
                    fill
                  />
                </div>
              )}
            </div>
            <div className="colops-field">
              <Checkbox
                checked={params.allMatches === "true"}
                onChange={(e) => updateParam("allMatches", (e.target as HTMLInputElement).checked ? "true" : "false")}
                label="Extract all matches"
                className="colops-checkbox"
              />
            </div>
          </>
        );
      case "extract_numbers":
        return (
          <>
            <div className="colops-field">
              <label>Mode</label>
              <RadioGroup
                inline
                selectedValue={params.mode ?? "first"}
                onChange={(e) => updateParam("mode", (e.target as HTMLInputElement).value)}
              >
                <Radio label="First number" value="first" />
                <Radio label="All numbers" value="all" />
              </RadioGroup>
            </div>
            <div className="colops-field">
              <label>Type</label>
              <HTMLSelect
                value={params.numberType ?? "any"}
                onChange={(e) => updateParam("numberType", e.target.value)}
                fill
              >
                <option value="any">Any number (text)</option>
                <option value="integer">Integer</option>
                <option value="float">Float</option>
              </HTMLSelect>
            </div>
            {params.mode === "all" && (
              <div className="colops-field">
                <label>Separator</label>
                <InputGroup
                  value={params.separator ?? ","}
                  onChange={(e) => updateParam("separator", e.target.value)}
                  placeholder=","
                  fill
                />
              </div>
            )}
          </>
        );
      case "prefix_suffix":
        return (
          <>
            <div className="colops-field">
              <label>Prefix</label>
              <InputGroup
                value={params.prefix ?? ""}
                onChange={(e) => updateParam("prefix", e.target.value)}
                placeholder="Before value..."
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                fill
              />
            </div>
            <div className="colops-field">
              <label>Suffix</label>
              <InputGroup
                value={params.suffix ?? ""}
                onChange={(e) => updateParam("suffix", e.target.value)}
                placeholder="After value..."
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                fill
              />
            </div>
          </>
        );
      default:
        return null;
    }
  };

  const applyDisabled =
    !selectedColumn || loading || isUnchangedSinceApply
    || (showTargetMode && targetMode === "new_column" && (!targetColumn.trim() || columns.some((c) => c.column_name === targetColumn.trim())))
    || (showTargetMode && targetMode === "existing_column" && !targetColumn);

  return (
    <div className="colops-body" style={{ display: visible ? "flex" : "none" }}>
      <div className="colops-layout">
        {/* Left panel: configuration form */}
        <div className="colops-config" ref={configRef}>
          <div className="colops-field">
            <label>Column</label>
            <SearchableColumnSelect
              value={selectedColumn}
              onChange={setSelectedColumn}
              columns={columns}
              placeholder="Select column..."
              className="colops-col-select"
            />
          </div>

          <div className="colops-field">
            <label>Action</label>
            <HTMLSelect
              value={opType}
              onChange={(e) => {
                setOpType(e.target.value as ColOpType);
                setParams({});
              }}
              fill
            >
              {OP_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.ops.map((op) => (
                    <option key={op.value} value={op.value}>
                      {op.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </HTMLSelect>
          </div>

          {needsParams && renderParams()}

          {/* Target mode — shown for all ops except clear_null */}
          {showTargetMode && (
            <div className="colops-field">
              <label>Write to</label>
              <div className="colops-target-group">
                <RadioGroup
                  inline
                  selectedValue={targetMode}
                  onChange={(e) => {
                    setTargetMode((e.target as HTMLInputElement).value as ColOpTargetMode);
                    setTargetColumn("");
                  }}
                >
                  <Radio label="Same column" value="replace" />
                  <Radio label="New column" value="new_column" />
                  <Radio label="Existing column" value="existing_column" />
                </RadioGroup>
                {targetMode === "new_column" && (
                  <InputGroup
                    value={targetColumn}
                    onChange={(e) => setTargetColumn(e.target.value)}
                    placeholder="Column name..."
                    intent={targetColumn && columns.some((c) => c.column_name === targetColumn.trim()) ? Intent.DANGER : Intent.NONE}
                    onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                    fill
                  />
                )}
                {targetMode === "existing_column" && (
                  <SearchableColumnSelect
                    value={targetColumn}
                    onChange={setTargetColumn}
                    columns={columns}
                    placeholder="Target column..."
                    className="colops-target-col-select"
                  />
                )}
              </div>
            </div>
          )}

          {/* Scope badge */}
          <div className="colops-scope-row">
            <span className={isFiltered ? "colops-scope colops-scope-filtered" : "colops-scope colops-scope-all"}>
              <Icon icon={isFiltered ? "filter" : "database"} iconSize={10} />
              {isFiltered
                ? `${totalRows.toLocaleString()} of ${unfilteredRows!.toLocaleString()} rows`
                : `All ${totalRows.toLocaleString()} rows`}
            </span>
          </div>

          {/* Apply button + history toggle */}
          <div className="colops-actions">
            <Button
              intent={Intent.PRIMARY}
              icon="tick"
              text="Apply"
              onClick={handleApply}
              loading={loading}
              disabled={applyDisabled}
              fill
            />
            {colOpsSteps.length > 0 && (
              <Button
                minimal
                small
                rightIcon={historyExpanded ? "chevron-up" : "chevron-down"}
                text={`History (${colOpsSteps.length})`}
                onClick={() => setHistoryExpanded(!historyExpanded)}
                className="colops-history-toggle"
              />
            )}
          </div>

          {/* Success / error messages */}
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

          {/* Collapsible history */}
          {colOpsSteps.length > 0 && historyExpanded && (
            <div className="colops-history-expanded">
              <div className="colops-steps-header">
                <span className="colops-steps-title">Steps</span>
                <div className="colops-steps-actions">
                  {undoStrategy === "per-step" && (
                    <Button
                      small
                      minimal
                      intent={Intent.PRIMARY}
                      icon="undo"
                      text="Undo"
                      onClick={handleUndo}
                      disabled={loading}
                    />
                  )}
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
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Right panel: preview */}
        <div className="colops-preview-panel">
          {previewError ? (
            <span className="colops-preview-error">{previewError}</span>
          ) : previews.length > 0 ? (
            <table className="colops-preview-table">
              <thead>
                <tr><th>Before</th><th>After</th></tr>
              </thead>
              <tbody>
                {previews.map((p, i) => (
                  <tr key={i}><td>{p.original}</td><td>{p.result}</td></tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="colops-preview-empty">
              Select a column and action to see preview
            </div>
          )}
        </div>
      </div>

      {/* Confirmation dialogs */}
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
