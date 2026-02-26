import React, { useState, useEffect, useCallback } from "react";
import {
  Button,
  Checkbox,
  HTMLSelect,
  Intent,
  Dialog,
  DialogBody,
  DialogFooter,
  Callout,
  Radio,
  RadioGroup,
} from "@blueprintjs/core";
import { ColumnInfo, LoadedTable } from "../types";

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface KeyPair {
  id: string;
  leftKey: string;
  rightKey: string;
}

interface LookupMergeDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeTable: string | null;
  schema: ColumnInfo[];
  tables: LoadedTable[];
  onExecute: (sql: string, options: { replaceActive: boolean }) => void;
}

let keyPairIdCounter = 0;
function nextKeyPairId(): string {
  return `kp_${++keyPairIdCounter}`;
}

/** Format a cell value for display */
const formatValue = (val: unknown): string => {
  if (val === null || val === undefined) return "NULL";
  if (typeof val === "number") {
    if (Number.isInteger(val)) return val.toLocaleString();
    return val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return String(val);
};

export function LookupMergeDialog({
  isOpen,
  onClose,
  activeTable,
  schema,
  tables,
  onExecute,
}: LookupMergeDialogProps): React.ReactElement {
  // Right table
  const [rightTable, setRightTable] = useState<string>("");
  const [rightSchema, setRightSchema] = useState<ColumnInfo[]>([]);

  // Key pairs (composite key support)
  const [keyPairs, setKeyPairs] = useState<KeyPair[]>([
    { id: nextKeyPairId(), leftKey: "", rightKey: "" },
  ]);

  // Column selection (which right-table columns to bring over)
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());

  // Join options
  const [joinType, setJoinType] = useState<"LEFT" | "INNER">("LEFT");
  const [resultMode, setResultMode] = useState<"new" | "replace">("new");
  const [nullHandling, setNullHandling] = useState<"exclude" | "match">("exclude");
  const [removeDuplicates, setRemoveDuplicates] = useState(false);

  // Warnings (populated after validation queries)
  const [dupCount, setDupCount] = useState<number | null>(null);
  const [leftNullCount, setLeftNullCount] = useState<number | null>(null);
  const [rightNullCount, setRightNullCount] = useState<number | null>(null);
  const [warningsChecked, setWarningsChecked] = useState(false);

  // Preview + execution
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
  const [resultColumns, setResultColumns] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Reset all state when dialog opens or activeTable changes
  useEffect(() => {
    if (isOpen) {
      setRightTable("");
      setRightSchema([]);
      setKeyPairs([{ id: nextKeyPairId(), leftKey: "", rightKey: "" }]);
      setSelectedCols(new Set());
      setJoinType("LEFT");
      setResultMode("new");
      setNullHandling("exclude");
      setRemoveDuplicates(false);
      setDupCount(null);
      setLeftNullCount(null);
      setRightNullCount(null);
      setWarningsChecked(false);
      setResults(null);
      setResultColumns([]);
      setError(null);
    }
  }, [isOpen, activeTable]);

  // Fetch right table schema when selection changes
  useEffect(() => {
    if (!rightTable) {
      setRightSchema([]);
      setSelectedCols(new Set());
      setKeyPairs([{ id: nextKeyPairId(), leftKey: "", rightKey: "" }]);
      setWarningsChecked(false);
      setResults(null);
      return;
    }

    let cancelled = false;
    window.api.describe(rightTable).then((desc: ColumnInfo[]) => {
      if (cancelled) return;
      setRightSchema(desc);
      setSelectedCols(new Set(desc.map((c) => c.column_name)));
      setKeyPairs([{ id: nextKeyPairId(), leftKey: "", rightKey: "" }]);
      setWarningsChecked(false);
      setResults(null);
    }).catch(() => {
      if (!cancelled) setRightSchema([]);
    });
    return () => { cancelled = true; };
  }, [rightTable]);

  // Derive available merge columns (exclude right keys)
  const usedRightKeys = new Set(keyPairs.map((kp) => kp.rightKey).filter(Boolean));
  const mergeableColumns = rightSchema.filter(
    (c) => !usedRightKeys.has(c.column_name)
  );

  // Clean selectedCols when mergeable columns change
  const mergeableColKey = mergeableColumns.map((c) => c.column_name).join("\0");
  useEffect(() => {
    setSelectedCols((prev) => {
      const available = new Set(mergeableColumns.map((c) => c.column_name));
      const cleaned = new Set([...prev].filter((c) => available.has(c)));
      return cleaned.size === prev.size ? prev : cleaned;
    });
  }, [mergeableColKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Key pair manipulation
  const addKeyPair = useCallback(() => {
    setKeyPairs((prev) => [...prev, { id: nextKeyPairId(), leftKey: "", rightKey: "" }]);
    setWarningsChecked(false);
    setResults(null);
  }, []);

  const removeKeyPair = useCallback((id: string) => {
    setKeyPairs((prev) => prev.filter((kp) => kp.id !== id));
    setWarningsChecked(false);
    setResults(null);
  }, []);

  const updateKeyPair = useCallback(
    (id: string, field: "leftKey" | "rightKey", value: string) => {
      setKeyPairs((prev) =>
        prev.map((kp) => (kp.id === id ? { ...kp, [field]: value } : kp))
      );
      setWarningsChecked(false);
      setResults(null);
    },
    []
  );

  // Column toggle
  const toggleCol = useCallback((col: string) => {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
    setResults(null);
  }, []);

  const selectAllCols = useCallback(() => {
    setSelectedCols(new Set(mergeableColumns.map((c) => c.column_name)));
    setResults(null);
  }, [mergeableColumns]);

  const deselectAllCols = useCallback(() => {
    setSelectedCols(new Set());
    setResults(null);
  }, []);

  // Synchronous input validation
  const validateInputs = useCallback((): string | null => {
    if (!rightTable) return "Select a right table.";
    if (keyPairs.length === 0) return "Add at least one key pair.";
    for (const kp of keyPairs) {
      if (!kp.leftKey || !kp.rightKey)
        return "All key pairs must have both left and right keys selected.";
    }
    if (selectedCols.size === 0) return "Select at least one column to merge.";
    return null;
  }, [rightTable, keyPairs, selectedCols]);

  // Async validation: duplicate and NULL key checks
  const runValidationChecks = useCallback(async (): Promise<boolean> => {
    if (!activeTable || !rightTable) return false;

    const keys = keyPairs.filter((kp) => kp.leftKey && kp.rightKey);
    if (keys.length === 0) return false;

    const rightKeyExprs = keys.map((kp) => escapeIdent(kp.rightKey)).join(", ");
    const leftNullCondition = keys
      .map((kp) => `${escapeIdent(kp.leftKey)} IS NULL`)
      .join(" OR ");
    const rightNullCondition = keys
      .map((kp) => `${escapeIdent(kp.rightKey)} IS NULL`)
      .join(" OR ");

    const dupSql = `SELECT COUNT(*) as dup_count FROM (SELECT ${rightKeyExprs}, COUNT(*) as cnt FROM ${escapeIdent(rightTable)} GROUP BY ${rightKeyExprs} HAVING COUNT(*) > 1)`;
    const leftNullSql = `SELECT COUNT(*) as null_count FROM ${escapeIdent(activeTable)} WHERE ${leftNullCondition}`;
    const rightNullSql = `SELECT COUNT(*) as null_count FROM ${escapeIdent(rightTable)} WHERE ${rightNullCondition}`;

    try {
      const [dupResult, leftNullResult, rightNullResult] = await Promise.all([
        window.api.query(dupSql),
        window.api.query(leftNullSql),
        window.api.query(rightNullSql),
      ]);

      setDupCount(Number(dupResult[0].dup_count));
      setLeftNullCount(Number(leftNullResult[0].null_count));
      setRightNullCount(Number(rightNullResult[0].null_count));
      setWarningsChecked(true);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [activeTable, rightTable, keyPairs]);

  // Build the merge SQL
  const buildMergeSQL = useCallback((): string | null => {
    if (!activeTable || !rightTable || keyPairs.length === 0 || selectedCols.size === 0)
      return null;

    const validPairs = keyPairs.filter((kp) => kp.leftKey && kp.rightKey);
    if (validPairs.length === 0) return null;

    // Build ON clause
    const onClauses = validPairs.map((kp) => {
      const l = `l.${escapeIdent(kp.leftKey)}`;
      const r = `r.${escapeIdent(kp.rightKey)}`;
      if (nullHandling === "match") {
        return `${l} IS NOT DISTINCT FROM ${r}`;
      }
      return `${l} = ${r}`;
    });

    // Build right-side source (with optional deduplication)
    const rightKeyColumns = validPairs.map((kp) => escapeIdent(kp.rightKey)).join(", ");
    let rightSource: string;

    if (removeDuplicates) {
      rightSource = `(SELECT * FROM ${escapeIdent(rightTable)} QUALIFY row_number() OVER (PARTITION BY ${rightKeyColumns} ORDER BY rowid) = 1)`;
    } else {
      rightSource = escapeIdent(rightTable);
    }

    // Selected merge columns from right table
    const rightColExprs = [...selectedCols]
      .map((col) => `r.${escapeIdent(col)}`)
      .join(", ");

    const joinKeyword = joinType === "LEFT" ? "LEFT JOIN" : "INNER JOIN";

    return `SELECT l.*, ${rightColExprs} FROM ${escapeIdent(activeTable)} l ${joinKeyword} ${rightSource} r ON ${onClauses.join(" AND ")}`;
  }, [activeTable, rightTable, keyPairs, selectedCols, joinType, nullHandling, removeDuplicates]);

  // Preview
  const handlePreview = useCallback(async () => {
    const validationError = validateInputs();
    if (validationError) {
      setError(validationError);
      return;
    }

    setRunning(true);
    setError(null);

    const checksOk = await runValidationChecks();
    if (!checksOk) {
      setRunning(false);
      return;
    }

    const sql = buildMergeSQL();
    if (!sql) {
      setRunning(false);
      return;
    }

    try {
      const rows = await window.api.query(`${sql} LIMIT 10`);
      if (rows.length > 0) {
        setResultColumns(Object.keys(rows[0]));
      } else {
        setResultColumns([]);
      }
      setResults(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setResults(null);
      setResultColumns([]);
    } finally {
      setRunning(false);
    }
  }, [validateInputs, runValidationChecks, buildMergeSQL]);

  // Merge (execute)
  const handleMerge = useCallback(async () => {
    const validationError = validateInputs();
    if (validationError) {
      setError(validationError);
      return;
    }

    setRunning(true);
    setError(null);

    if (!warningsChecked) {
      const checksOk = await runValidationChecks();
      if (!checksOk) {
        setRunning(false);
        return;
      }
    }

    const sql = buildMergeSQL();
    if (!sql) {
      setRunning(false);
      return;
    }

    try {
      onExecute(sql, { replaceActive: resultMode === "replace" });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }, [validateInputs, warningsChecked, runValidationChecks, buildMergeSQL, resultMode, onExecute, onClose]);

  // Available tables for right side (exclude active table)
  const availableTables = tables.filter((t) => t.tableName !== activeTable);

  const canRun =
    !!rightTable &&
    keyPairs.every((kp) => kp.leftKey && kp.rightKey) &&
    keyPairs.length > 0 &&
    selectedCols.size > 0;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Lookup Merge"
      icon="data-lineage"
      style={{ width: 820, maxWidth: "92vw" }}
      canOutsideClickClose={false}
    >
      <DialogBody>
        <div className="aggregate-dialog-content">
          {/* Section 1: Right Table */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">Right Table</div>
            <HTMLSelect
              value={rightTable}
              onChange={(e) => setRightTable(e.target.value)}
              fill
            >
              <option value="">— Select a table —</option>
              {availableTables.map((t) => (
                <option key={t.tableName} value={t.tableName}>
                  {t.tableName} ({t.rowCount.toLocaleString()} rows)
                </option>
              ))}
            </HTMLSelect>
          </div>

          {/* Section 2: Key Columns */}
          {rightTable && rightSchema.length > 0 && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">Key Columns</div>
              <div className="merge-key-pairs">
                {keyPairs.map((kp) => (
                  <div key={kp.id} className="merge-key-row">
                    <HTMLSelect
                      value={kp.leftKey}
                      onChange={(e) => updateKeyPair(kp.id, "leftKey", e.target.value)}
                      className="merge-key-select"
                    >
                      <option value="">— Left key —</option>
                      {schema.map((c) => (
                        <option key={c.column_name} value={c.column_name}>
                          {c.column_name} ({c.column_type})
                        </option>
                      ))}
                    </HTMLSelect>
                    <span className="merge-key-arrow">↔</span>
                    <HTMLSelect
                      value={kp.rightKey}
                      onChange={(e) => updateKeyPair(kp.id, "rightKey", e.target.value)}
                      className="merge-key-select"
                    >
                      <option value="">— Right key —</option>
                      {rightSchema.map((c) => (
                        <option key={c.column_name} value={c.column_name}>
                          {c.column_name} ({c.column_type})
                        </option>
                      ))}
                    </HTMLSelect>
                    <Button
                      icon="cross"
                      minimal
                      small
                      disabled={keyPairs.length === 1}
                      onClick={() => removeKeyPair(kp.id)}
                    />
                  </div>
                ))}
                <Button
                  icon="plus"
                  minimal
                  small
                  text="Add Key Pair"
                  onClick={addKeyPair}
                  style={{ marginTop: 4 }}
                />
              </div>
            </div>
          )}

          {/* Section 3: Columns to Merge */}
          {rightTable && rightSchema.length > 0 && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">
                <span>Columns to Merge</span>
                <span className="aggregate-section-actions">
                  <Button minimal small text="Select All" onClick={selectAllCols} />
                  <Button minimal small text="Deselect All" onClick={deselectAllCols} />
                </span>
              </div>
              <div className="aggregate-col-grid">
                {mergeableColumns.map((col) => (
                  <div
                    key={col.column_name}
                    className={`aggregate-col-item${selectedCols.has(col.column_name) ? " selected" : ""}`}
                  >
                    <Checkbox
                      checked={selectedCols.has(col.column_name)}
                      onChange={() => toggleCol(col.column_name)}
                      style={{ marginBottom: 0 }}
                    />
                    <span className="aggregate-col-name">{col.column_name}</span>
                    <span className="aggregate-col-type">{col.column_type}</span>
                  </div>
                ))}
                {mergeableColumns.length === 0 && rightSchema.length > 0 && (
                  <div style={{ fontSize: 12, color: "#5c7080", padding: 8 }}>
                    All right-table columns are used as keys. Add more columns to the right table or remove key pairs.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Section 4: Warnings */}
          {warningsChecked && dupCount !== null && dupCount > 0 && (
            <Callout intent={Intent.WARNING} icon="warning-sign">
              <strong>{dupCount.toLocaleString()}</strong> duplicate key
              {dupCount !== 1 ? " groups" : " group"} found in right table.
              This will cause row multiplication — each left row may match multiple right rows.
              <div style={{ marginTop: 8 }}>
                <Checkbox
                  checked={removeDuplicates}
                  onChange={() => {
                    setRemoveDuplicates((v) => !v);
                    setResults(null);
                  }}
                  label="Remove duplicates before merging (keep first row per key)"
                />
              </div>
            </Callout>
          )}

          {warningsChecked && ((leftNullCount ?? 0) > 0 || (rightNullCount ?? 0) > 0) && (
            <Callout intent={Intent.WARNING} icon="warning-sign">
              {(leftNullCount ?? 0) > 0 && (
                <div>
                  <strong>{leftNullCount!.toLocaleString()}</strong> left-table row
                  {leftNullCount !== 1 ? "s" : ""} have NULL key values.
                </div>
              )}
              {(rightNullCount ?? 0) > 0 && (
                <div>
                  <strong>{rightNullCount!.toLocaleString()}</strong> right-table row
                  {rightNullCount !== 1 ? "s" : ""} have NULL key values.
                </div>
              )}
              <div style={{ marginTop: 8 }}>
                <RadioGroup
                  selectedValue={nullHandling}
                  onChange={(e) => {
                    setNullHandling(e.currentTarget.value as "exclude" | "match");
                    setResults(null);
                  }}
                  inline
                >
                  <Radio value="exclude" label="Standard join (NULLs don't match)" />
                  <Radio value="match" label="Match NULLs (treat NULL = NULL)" />
                </RadioGroup>
              </div>
            </Callout>
          )}

          {/* Section 5: Options */}
          {rightTable && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">Options</div>
              <div className="merge-options-grid">
                <div className="merge-option-group">
                  <div className="merge-option-label">Join Type</div>
                  <RadioGroup
                    selectedValue={joinType}
                    onChange={(e) => {
                      setJoinType(e.currentTarget.value as "LEFT" | "INNER");
                      setResults(null);
                    }}
                    inline
                  >
                    <Radio value="LEFT" label="Left Join (keep all left rows)" />
                    <Radio value="INNER" label="Inner Join (matched rows only)" />
                  </RadioGroup>
                </div>
                <div className="merge-option-group">
                  <div className="merge-option-label">Result</div>
                  <RadioGroup
                    selectedValue={resultMode}
                    onChange={(e) => setResultMode(e.currentTarget.value as "new" | "replace")}
                    inline
                  >
                    <Radio value="new" label="Create new table" />
                    <Radio value="replace" label={`Replace "${activeTable}"`} />
                  </RadioGroup>
                </div>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <Callout intent={Intent.DANGER} icon="error" style={{ marginTop: 10 }}>
              {error}
            </Callout>
          )}

          {/* Preview Results */}
          {results && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">
                <span>
                  Preview ({results.length} row{results.length !== 1 ? "s" : ""}
                  {resultColumns.length > 0 && `, ${resultColumns.length} column${resultColumns.length !== 1 ? "s" : ""}`})
                </span>
              </div>
              <div className="aggregate-results-wrapper">
                <table className="aggregate-results-table">
                  <thead>
                    <tr>
                      {resultColumns.map((col) => (
                        <th key={col}>{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((row, i) => (
                      <tr key={i}>
                        {resultColumns.map((col) => (
                          <td key={col}>{formatValue(row[col])}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button text="Close" onClick={onClose} />
            <Button
              intent={Intent.PRIMARY}
              text="Preview"
              icon="play"
              onClick={handlePreview}
              disabled={!canRun}
              loading={running}
            />
            <Button
              intent={Intent.SUCCESS}
              text="Merge"
              icon="data-lineage"
              onClick={handleMerge}
              disabled={!canRun}
              loading={running}
            />
          </>
        }
      />
    </Dialog>
  );
}
