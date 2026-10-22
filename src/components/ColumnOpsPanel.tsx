import React, { useState, useCallback, useEffect, useRef } from "react";
import {
  Button,
  InputGroup,
  Checkbox,
  Intent,
  Alert,
  Icon,
  RadioGroup,
  Radio,
  Tag,
} from "@blueprintjs/core";
import { SoftSelect } from "./SoftSelect";
import { ColumnInfo, ColOpType, ColOpStep, UndoStrategy, FilterGroup, ColOpTargetMode, hasActiveFilters } from "../types";
import { buildColOpExpr } from "../utils/colOpsSQL";
import {
  guardNumberInputDrop,
  guardNumberInputKeyDown,
  guardNumberInputPaste,
  isAllowedNumberInputValue,
  showNumberInputExpectation,
  stepNumberInputOnWheel,
} from "../utils/numberInputWheel";
import { buildFilterGroupClause } from "../utils/sqlBuilder";
import { RegexPatternPicker } from "./RegexPatternPicker";
import { RegexPatternManagerDialog } from "./RegexPatternManagerDialog";
import { SearchableColumnSelect } from "./SearchableColumnSelect";
import { columnNameExists, rowScopeLabel, suggestColumnName } from "../utils/operationUX";

const OP_GROUPS: { label: string; ops: { value: ColOpType; label: string }[] }[] = [
  {
    label: "Search",
    ops: [
      { value: "find_replace", label: "Find & Replace" },
      { value: "regex_extract", label: "Regex Extract" },
    ],
  },
  {
    label: "Text",
    ops: [
      { value: "trim", label: "Trim Whitespace" },
      { value: "upper", label: "UPPERCASE" },
      { value: "lower", label: "lowercase" },
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
  {
    label: "Manage",
    ops: [
      { value: "rename_column", label: "Rename Column" },
      { value: "delete_column", label: "Delete Column" },
    ],
  },
];

const ALL_OPS = OP_GROUPS.flatMap((g) => g.ops);

const NO_PARAM_OPS = new Set<ColOpType>(["trim", "upper", "lower", "clear_null", "delete_column"]);
const NO_TARGET_OPS = new Set<ColOpType>(["clear_null", "rename_column", "delete_column"]);
const NO_EXISTING_TARGET_OPS = new Set<ColOpType>(["assign_value"]);
const SCHEMA_OPS = new Set<ColOpType>(["rename_column", "delete_column"]);

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
  const [opType, setOpType] = useState<ColOpType>("find_replace");
  const [params, setParams] = useState<Record<string, string>>({});
  const [targetMode, setTargetMode] = useState<ColOpTargetMode>("new_column");
  const [targetColumn, setTargetColumn] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [patternManagerOpen, setPatternManagerOpen] = useState(false);
  const [patternRefreshKey, setPatternRefreshKey] = useState(0);
  const [previews, setPreviews] = useState<Array<{ original: string; result: string }>>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [lastAppliedKey, setLastAppliedKey] = useState<string | null>(null);

  const handlePatternsChanged = useCallback(() => {
    setPatternRefreshKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!activeTable || !selectedColumn || !visible) {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

    if (opType === "clear_null" || SCHEMA_OPS.has(opType)) {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

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
        const filterClause = buildFilterGroupClause(activeFilters);
        const whereConditions = [`"${selectedColumn}" IS NOT NULL`, ...(filterClause ? [filterClause] : [])];
        const sql = `SELECT DISTINCT CAST("${selectedColumn}" AS VARCHAR) AS "original", CAST(${expr} AS VARCHAR) AS "result" FROM "${activeTable}" WHERE ${whereConditions.join(" AND ")} LIMIT 5`;
        const rows = await window.api.query(sql);
        setPreviews(rows.map((r: any) => ({ original: String(r.original ?? ""), result: String(r.result ?? "") })));
        setPreviewError(null);
      } catch (e: any) {
        setPreviews([]);
        setPreviewError(e.message || "Preview failed");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [activeTable, selectedColumn, opType, params, visible, colOpsSteps.length, activeFilters]);

  const hasFilter = hasActiveFilters(activeFilters);
  const isSchemaOp = SCHEMA_OPS.has(opType);
  const columnNames = columns.map((column) => column.column_name);
  const targetMissing = targetMode === "existing_column" && !columnNames.includes(targetColumn);
  const newTargetInvalid = targetMode === "new_column" && (!targetColumn.trim() || columnNameExists(columnNames, targetColumn));
  const suggestedName = useRef<string | null>(null);
  const suggestionContext = useRef<string | null>(null);

  useEffect(() => {
    const next = suggestColumnName(columns.map((column) => column.column_name), `${selectedColumn || "value"}_${opType === "find_replace" ? "replaced" : opType}`);
    const context = JSON.stringify([activeTable, selectedColumn, opType]);
    if (suggestionContext.current !== context) {
      setTargetMode("new_column");
      setTargetColumn(next);
      suggestionContext.current = context;
    } else {
      const previous = suggestedName.current;
      setTargetColumn((current) => current === previous ? next : current);
    }
    suggestedName.current = next;
  }, [activeTable, selectedColumn, opType, columns]);
  const showTargetMode = !NO_TARGET_OPS.has(opType);
  const hideExistingTarget = NO_EXISTING_TARGET_OPS.has(opType);
  const needsParams = !NO_PARAM_OPS.has(opType);

  const currentConfigKey = JSON.stringify({ selectedColumn, opType, params, targetMode: showTargetMode ? targetMode : "replace", targetColumn: showTargetMode ? targetColumn : "" });
  const isUnchangedSinceApply = lastAppliedKey === currentConfigKey;

  const opLabel = ALL_OPS.find((o) => o.value === opType)?.label ?? opType;
  const newColumnName = (params.newName ?? "").trim();
  const renameDuplicate = opType === "rename_column"
    && !!newColumnName
    && columns.some((c) => c.column_name === newColumnName && c.column_name !== selectedColumn);
  const renameSameName = opType === "rename_column" && !!newColumnName && newColumnName === selectedColumn;
  const deleteWouldRemoveLastColumn = opType === "delete_column" && columns.length <= 1;

  const paramsMissing = (() => {
    if (!needsParams) return false;
    if (opType === "rename_column") return !newColumnName;
    if (opType === "assign_value") return !params.value;
    if (opType === "find_replace") return !params.pattern;
    if (opType === "regex_extract") return !params.pattern;
    if (opType === "prefix_suffix") return !params.prefix && !params.suffix;
    return false;
  })();

  const handleApply = async (confirmedDelete = false) => {
    if (!selectedColumn || !activeTable || loading || paramsMissing || (showTargetMode && (targetMissing || newTargetInvalid))) return;
    if (opType === "rename_column" && (!newColumnName || renameDuplicate || renameSameName)) return;
    if (opType === "delete_column" && deleteWouldRemoveLastColumn) return;
    if (opType === "delete_column" && !confirmedDelete) {
      setDeleteConfirmOpen(true);
      return;
    }
    const effectiveTargetMode = showTargetMode ? targetMode : "replace";
    const effectiveTargetCol = showTargetMode ? targetColumn.trim() : "";
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
      setLastAppliedKey(currentConfigKey);
      if (opType === "rename_column") {
        setSelectedColumn(newColumnName);
        setParams({});
        setSuccessMsg(`Renamed "${appliedCol}" to "${newColumnName}"`);
      } else if (opType === "delete_column") {
        setSelectedColumn("");
        setParams({});
        setSuccessMsg(`Deleted "${appliedCol}"`);
      } else {
        const targetLabel = effectiveTargetMode === "new_column" ? ` → new "${effectiveTargetCol}"`
          : effectiveTargetMode === "existing_column" ? ` → "${effectiveTargetCol}"`
          : "";
        setSuccessMsg(`${appliedOp} applied to "${appliedCol}"${targetLabel}`);
      }
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
                placeholder="Text to find..."
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
              <label>Replace with</label>
              <InputGroup
                value={params.replacement ?? ""}
                onChange={(e) => updateParam("replacement", e.target.value)}
                placeholder="Replacement..."
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                fill
              />
            </div>
            <div className="colops-field colops-field-inline">
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
                  onChange={(e) => {
                    if (!isAllowedNumberInputValue(e.target.value)) {
                      showNumberInputExpectation(e.currentTarget);
                      return;
                    }
                    const val = parseInt(e.target.value, 10);
                    updateParam("groupIndex", String(isNaN(val) || val < 0 ? 0 : val));
                  }}
                  onKeyDown={(e) => guardNumberInputKeyDown(e)}
                  onPaste={(e) => guardNumberInputPaste(e)}
                  onDrop={(e) => guardNumberInputDrop(e)}
                  onWheel={(e) => stepNumberInputOnWheel(e, (value) => updateParam("groupIndex", value))}
                  type="number"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min={0}
                  fill
                />
              </div>
              {params.allMatches === "true" && (
                <div className="colops-field-half">
                  <label>Separator</label>
                  <InputGroup
                    value={params.separator ?? ""}
                    onChange={(e) => updateParam("separator", e.target.value)}
                    placeholder=", "
                    fill
                  />
                </div>
              )}
            </div>
            <div className="colops-field colops-field-inline">
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
              <SoftSelect
                value={params.numberType ?? "any"}
                onChange={(e) => updateParam("numberType", e.target.value)}
                fill
              >
                <option value="any">Any number (text)</option>
                <option value="integer">Integer</option>
                <option value="float">Float</option>
              </SoftSelect>
            </div>
            {params.mode === "all" && (
              <div className="colops-field">
                <label>Separator</label>
                <InputGroup
                  value={params.separator ?? ""}
                  onChange={(e) => updateParam("separator", e.target.value)}
                  placeholder=", "
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
                placeholder="Text before..."
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                fill
              />
            </div>
            <div className="colops-field">
              <label>Suffix</label>
              <InputGroup
                value={params.suffix ?? ""}
                onChange={(e) => updateParam("suffix", e.target.value)}
                placeholder="Text after..."
                onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
                fill
              />
            </div>
          </>
        );
      case "rename_column":
        return (
          <div className="colops-field">
            <label>New name</label>
            <InputGroup
              value={params.newName ?? ""}
              onChange={(e) => updateParam("newName", e.target.value)}
              placeholder={selectedColumn ? `${selectedColumn}_renamed` : "New column name..."}
              intent={renameDuplicate || renameSameName ? Intent.DANGER : Intent.NONE}
              onKeyDown={(e) => { if (e.key === "Enter") handleApply(); }}
              fill
            />
            {renameDuplicate && (
              <span className="colops-field-hint colops-field-hint-danger">A column named "{newColumnName}" already exists.</span>
            )}
            {renameSameName && (
              <span className="colops-field-hint colops-field-hint-danger">Use a different name.</span>
            )}
          </div>
        );
      case "delete_column":
        return (
          <div className="colops-danger-note">
            <Icon icon="warning-sign" iconSize={14} />
            <span>
              {deleteWouldRemoveLastColumn
                ? "At least one column must remain."
                : selectedColumn
                  ? `Delete "${selectedColumn}" from the current table.`
                  : "Select a column to delete."}
            </span>
          </div>
        );
      default:
        return null;
    }
  };

  const applyDisabled =
    !selectedColumn || loading || (!SCHEMA_OPS.has(opType) && isUnchangedSinceApply) || paramsMissing
    || renameDuplicate || renameSameName || deleteWouldRemoveLastColumn
    || (showTargetMode && (newTargetInvalid || targetMissing));

  const statusInfo = (() => {
    if (successMsg) return { tag: "Applied", intent: Intent.SUCCESS, icon: "tick" as const, detail: successMsg };
    if (error) return { tag: "Error", intent: Intent.DANGER, icon: "error" as const, detail: error };
    if (loading) return { tag: "Working", intent: Intent.PRIMARY, icon: "refresh" as const, detail: "Applying..." };
    if (!selectedColumn) return { tag: "Ready", intent: undefined, icon: "edit" as const, detail: "Pick a column to start" };
    if (opType === "rename_column" && paramsMissing) return { tag: "Editing", intent: Intent.WARNING, icon: "edit" as const, detail: `Rename "${selectedColumn}" — enter a new name` };
    if (renameDuplicate) return { tag: "Error", intent: Intent.DANGER, icon: "error" as const, detail: `"${newColumnName}" already exists` };
    if (renameSameName) return { tag: "Editing", intent: Intent.WARNING, icon: "edit" as const, detail: "Choose a different name" };
    if (deleteWouldRemoveLastColumn) return { tag: "Blocked", intent: Intent.DANGER, icon: "error" as const, detail: "At least one column must remain" };
    if (opType === "delete_column") return { tag: "Confirm", intent: Intent.DANGER, icon: "trash" as const, detail: `Delete "${selectedColumn}"` };
    if (paramsMissing) return { tag: "Editing", intent: Intent.WARNING, icon: "edit" as const, detail: `${opLabel} on "${selectedColumn}" — fill required fields` };
    if (isUnchangedSinceApply) return { tag: "Applied", intent: Intent.SUCCESS, icon: "tick" as const, detail: `${opLabel} on "${selectedColumn}"` };
    return { tag: "Draft", intent: Intent.WARNING, icon: "edit" as const, detail: `${opLabel} on "${selectedColumn}" — ready to apply` };
  })();

  return (
    <div className="colops-body" style={{ display: visible ? "flex" : "none" }}>
      {/* Toolbar — matches filter-toolbar */}
      <div className="colops-toolbar">
        <div className="colops-status-strip">
          <div className="motion-status-pair" key={`${statusInfo.tag}:${statusInfo.detail}`}>
            <Tag minimal icon={statusInfo.icon} intent={statusInfo.intent}>
              {statusInfo.tag}
            </Tag>
            <span className="colops-status-detail" title={statusInfo.detail}>{statusInfo.detail}</span>
          </div>
          <Tag minimal icon={!isSchemaOp && hasFilter ? "filter" : "database"} intent={!isSchemaOp && hasFilter ? Intent.PRIMARY : undefined} className="colops-scope-tag">
            {isSchemaOp
              ? `Whole column · ${(unfilteredRows ?? totalRows).toLocaleString()} rows`
              : rowScopeLabel(hasFilter, totalRows, unfilteredRows)}
          </Tag>
        </div>
        <div className="colops-toolbar-actions">
          <Button
            intent={opType === "delete_column" ? Intent.DANGER : Intent.PRIMARY}
            icon={opType === "delete_column" ? "trash" : "tick"}
            text={opType === "delete_column" ? "Delete" : "Apply"}
            small
            onClick={() => handleApply()}
            loading={loading}
            disabled={applyDisabled}
          />
        </div>
      </div>

      <div className="colops-layout">
        {/* Left: configuration */}
        <div className="colops-config">
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
            <SoftSelect
              value={opType}
              onChange={(e) => {
                const newOp = e.target.value as ColOpType;
                setOpType(newOp);
                setParams({});
                if (NO_EXISTING_TARGET_OPS.has(newOp) && targetMode === "existing_column") {
                  setTargetMode("new_column");
                  setTargetColumn("");
                }
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
            </SoftSelect>
          </div>

          {needsParams && renderParams()}

          {selectedColumn && (
            <div role="status" style={{ fontSize: 12, lineHeight: 1.5 }}>
              {isSchemaOp
                ? `Changes the whole column in ${activeTable}; filters do not limit schema changes.`
                : showTargetMode && targetMode === "new_column"
                  ? `Creates "${targetColumn.trim()}"; source values are preserved.${hasFilter ? " Rows outside the filters are NULL in the new column." : ""}`
                  : `Overwrites "${showTargetMode && targetMode === "existing_column" ? targetColumn : selectedColumn}" on ${hasFilter ? "rows matching the active filters" : "all rows"}.`}
            </div>
          )}

          {showTargetMode && (
            <div className="colops-field">
              <label>Write to</label>
              <div className="colops-target-group">
                <RadioGroup
                  inline
                  selectedValue={targetMode}
                  onChange={(e) => {
                    const mode = (e.target as HTMLInputElement).value as ColOpTargetMode;
                    setTargetMode(mode);
                    setTargetColumn(mode === "new_column" ? suggestColumnName(columnNames, `${selectedColumn || "value"}_${opType === "find_replace" ? "replaced" : opType}`) : "");
                  }}
                >
                  <Radio label="Same column" value="replace" />
                  <Radio label="New column" value="new_column" />
                  {!hideExistingTarget && <Radio label="Existing column" value="existing_column" />}
                </RadioGroup>
                {targetMode === "new_column" && (
                  <InputGroup
                    value={targetColumn}
                    onChange={(e) => setTargetColumn(e.target.value)}
                    placeholder="New column name..."
                    intent={targetColumn && columnNameExists(columnNames, targetColumn) ? Intent.DANGER : Intent.NONE}
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
        </div>

        {/* Center: preview / guidance */}
        <div className="colops-preview-panel">
          {previewError ? (
            <div className="colops-preview-error-card">
              <Icon icon="error" iconSize={14} />
              <span>{previewError}</span>
            </div>
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
            <div className="colops-empty-state">
              <div className="colops-empty-icon" aria-hidden="true">
                <Icon icon={selectedColumn ? "edit" : "th"} iconSize={18} />
              </div>
              <div className="colops-empty-main">
                <div className="colops-empty-copy">
                  <span className="colops-empty-title">
                    {!selectedColumn
                      ? "Transform a column"
                      : paramsMissing
                        ? `Configure ${opLabel}`
                        : opType === "rename_column"
                          ? "Ready to rename column"
                          : opType === "delete_column"
                            ? "Ready to delete column"
                        : opType === "clear_null"
                          ? "Ready to clear values to NULL"
                          : "Preview will appear here"}
                  </span>
                  <span className="colops-empty-text">
                    {!selectedColumn
                      ? "Pick a column and an action to preview before applying."
                      : paramsMissing
                        ? "Fill the parameters on the left to see how rows will change."
                        : opType === "rename_column"
                          ? `Apply will rename "${selectedColumn}" to "${newColumnName}".`
                          : opType === "delete_column"
                            ? `Delete will remove "${selectedColumn}" from the table schema.`
                        : opType === "clear_null"
                          ? `Apply will set "${selectedColumn}" to NULL on every row in scope.`
                          : "No distinct values to preview yet."}
                  </span>
                </div>
                {!selectedColumn && (
                  <div className="colops-empty-actions">
                    <SearchableColumnSelect
                      value={selectedColumn}
                      onChange={setSelectedColumn}
                      columns={columns}
                      placeholder="Choose column"
                      leftIcon="th"
                      className="colops-empty-choose-select"
                    />
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Right: history */}
        <div className="colops-history-panel">
          <div className="colops-history-header">
            <span className="colops-history-title">
              History
              {colOpsSteps.length > 0 && (
                <span className="colops-history-count">{colOpsSteps.length}</span>
              )}
            </span>
            {colOpsSteps.length > 0 && (
              <div className="colops-steps-actions">
                {undoStrategy === "per-step" && (
                  <Button
                    small
                    minimal
                    icon="undo"
                    onClick={handleUndo}
                    disabled={loading}
                    title="Undo last step"
                  />
                )}
                {undoStrategy === "snapshot" && (
                  <Button
                    small
                    minimal
                    intent={Intent.WARNING}
                    icon="undo"
                    onClick={() => setRevertConfirmOpen(true)}
                    disabled={loading}
                    title="Revert all"
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
            )}
          </div>
          {colOpsSteps.length > 0 ? (
            <div className="colops-step-list">
              {[...colOpsSteps].reverse().map((step, idx) => (
                <div key={step.id} className={`colops-step-item ${idx === 0 ? "colops-step-latest" : ""}`}>
                  <span className="colops-step-number">{step.id}</span>
                  <span className="colops-step-desc" title={step.description}>{step.description}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="colops-history-empty">
              <Icon icon="history" iconSize={14} />
              <span>Applied steps will show here</span>
            </div>
          )}
        </div>
      </div>

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

      <Alert
        isOpen={deleteConfirmOpen}
        onClose={() => setDeleteConfirmOpen(false)}
        onConfirm={() => {
          setDeleteConfirmOpen(false);
          handleApply(true);
        }}
        intent={Intent.DANGER}
        icon="trash"
        confirmButtonText="Delete Column"
        cancelButtonText="Cancel"
      >
        <p>Delete column <strong>{selectedColumn}</strong> from the current table?</p>
      </Alert>

      <RegexPatternManagerDialog
        isOpen={patternManagerOpen}
        onClose={() => setPatternManagerOpen(false)}
        onPatternsChanged={handlePatternsChanged}
      />
    </div>
  );
}
