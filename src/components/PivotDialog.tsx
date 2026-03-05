import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Button,
  Checkbox,
  HTMLSelect,
  Intent,
  Dialog,
  DialogBody,
  DialogFooter,
  Callout,
} from "@blueprintjs/core";
import { ColumnInfo } from "../types";
import { PreviewTableDialog } from "./PreviewTableDialog";

const NUMERIC_RE =
  /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i;

const AGG_FUNCTIONS = [
  "SUM",
  "COUNT",
  "COUNT NULL",
  "AVG",
  "MIN",
  "MAX",
  "MEDIAN",
  "STDDEV",
  "FIRST",
] as const;

type AggFunc = (typeof AGG_FUNCTIONS)[number];

/** Functions that work on non-numeric columns */
const NON_NUMERIC_FUNCTIONS: Set<AggFunc> = new Set([
  "COUNT",
  "COUNT NULL",
  "MIN",
  "MAX",
  "FIRST",
]);

function isNumeric(colType: string): boolean {
  return NUMERIC_RE.test(colType);
}

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface PivotDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeTable: string | null;
  schema: ColumnInfo[];
  onCreateTable: (sql: string, filePath: string) => void;
}

export function PivotDialog({
  isOpen,
  onClose,
  activeTable,
  schema,
  onCreateTable,
}: PivotDialogProps): React.ReactElement {
  // Row fields (GROUP BY in the pivot)
  const [rowFields, setRowFields] = useState<Set<string>>(new Set());

  // Pivot column (the column whose values become headers)
  const [pivotColumn, setPivotColumn] = useState<string>("");

  // Value fields (columns to aggregate)
  const [valueFields, setValueFields] = useState<Set<string>>(new Set());

  // Aggregate function
  const [aggFunction, setAggFunction] = useState<AggFunc>("SUM");

  // Results
  const [results, setResults] = useState<Record<string, unknown>[] | null>(
    null
  );
  const [resultColumns, setResultColumns] = useState<string[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Distinct value info for pivot column
  const [pivotDistinctCount, setPivotDistinctCount] = useState<number | null>(
    null
  );
  const [pivotDistinctValues, setPivotDistinctValues] = useState<string[]>([]);
  const [loadingDistinct, setLoadingDistinct] = useState(false);

  // Debounce timer ref
  const distinctTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state when dialog opens or table changes
  useEffect(() => {
    if (isOpen) {
      setRowFields(new Set());
      setPivotColumn("");
      setValueFields(new Set());
      setAggFunction("SUM");
      setResults(null);
      setResultColumns([]);
      setPreviewOpen(false);
      setError(null);
      setPivotDistinctCount(null);
      setPivotDistinctValues([]);
    }
  }, [isOpen, activeTable]);

  // Fetch distinct values when pivot column changes (with 300ms debounce)
  useEffect(() => {
    if (distinctTimerRef.current) {
      clearTimeout(distinctTimerRef.current);
      distinctTimerRef.current = null;
    }

    if (!pivotColumn || !activeTable) {
      setPivotDistinctCount(null);
      setPivotDistinctValues([]);
      return;
    }

    setLoadingDistinct(true);

    distinctTimerRef.current = setTimeout(async () => {
      try {
        const countResult = await window.api.query(
          `SELECT COUNT(DISTINCT ${escapeIdent(pivotColumn)}) AS cnt FROM ${escapeIdent(activeTable)}`
        );
        const count = Number(countResult[0].cnt);
        setPivotDistinctCount(count);

        const valuesResult = await window.api.query(
          `SELECT DISTINCT ${escapeIdent(pivotColumn)} AS val FROM ${escapeIdent(activeTable)} ORDER BY ${escapeIdent(pivotColumn)} LIMIT 50`
        );
        setPivotDistinctValues(
          valuesResult.map((r: Record<string, unknown>) =>
            r.val === null ? "NULL" : String(r.val)
          )
        );
      } catch {
        setPivotDistinctCount(null);
        setPivotDistinctValues([]);
      } finally {
        setLoadingDistinct(false);
      }
    }, 300);

    return () => {
      if (distinctTimerRef.current) {
        clearTimeout(distinctTimerRef.current);
      }
    };
  }, [pivotColumn, activeTable]);

  const numericCols = schema.filter((c) => isNumeric(c.column_type));
  const allColNames = schema.map((c) => c.column_name);

  // Columns available for pivot (exclude row fields)
  const pivotColumnOptions = allColNames.filter((c) => !rowFields.has(c));

  const toggleRowField = useCallback(
    (col: string) => {
      setRowFields((prev) => {
        const next = new Set(prev);
        if (next.has(col)) next.delete(col);
        else next.add(col);
        return next;
      });
      setResults(null);
      // If the removed/added column is the current pivot column, clear it
      setPivotColumn((prev) => {
        // We need to check if the column being toggled will make the current
        // pivot column invalid. If adding col to rowFields and col === pivotColumn, clear it.
        return prev;
      });
    },
    []
  );

  // Clear pivot column if it becomes a row field
  useEffect(() => {
    if (pivotColumn && rowFields.has(pivotColumn)) {
      setPivotColumn("");
    }
  }, [rowFields, pivotColumn]);

  const toggleValueField = useCallback((col: string) => {
    setValueFields((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
    setResults(null);
  }, []);

  const selectAllNumeric = useCallback(() => {
    setValueFields(new Set(numericCols.map((c) => c.column_name)));
    setResults(null);
  }, [numericCols]);

  const deselectAll = useCallback(() => {
    setValueFields(new Set());
    setResults(null);
  }, []);

  /** Build the DuckDB PIVOT SQL */
  const buildPivotSQL = useCallback((): string | null => {
    if (!activeTable || !pivotColumn || valueFields.size === 0) return null;

    // Build USING clause: filter out invalid combos (non-numeric col + numeric-only func)
    const usingParts: string[] = [];
    for (const col of valueFields) {
      const colInfo = schema.find((c) => c.column_name === col);
      const colIsNumeric = colInfo ? isNumeric(colInfo.column_type) : false;
      if (!colIsNumeric && !NON_NUMERIC_FUNCTIONS.has(aggFunction)) continue;
      if (aggFunction === "COUNT NULL") {
        usingParts.push(`SUM(CASE WHEN ${escapeIdent(col)} IS NULL THEN 1 ELSE 0 END)`);
      } else {
        usingParts.push(`${aggFunction}(${escapeIdent(col)})`);
      }
    }

    if (usingParts.length === 0) return null;

    let sql = `PIVOT ${escapeIdent(activeTable)} ON ${escapeIdent(pivotColumn)} USING ${usingParts.join(", ")}`;

    if (rowFields.size > 0) {
      sql += ` GROUP BY ${[...rowFields].map(escapeIdent).join(", ")}`;
    }

    return sql;
  }, [activeTable, pivotColumn, valueFields, aggFunction, rowFields, schema]);

  const handleRun = useCallback(async () => {
    const sql = buildPivotSQL();
    if (!sql) return;

    setRunning(true);
    setError(null);
    try {
      const rows = await window.api.query(sql);
      if (rows.length > 0) {
        setResultColumns(Object.keys(rows[0]));
      } else {
        setResultColumns([]);
      }
      setResults(rows);
      setPreviewOpen(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setResults(null);
      setResultColumns([]);
    } finally {
      setRunning(false);
    }
  }, [buildPivotSQL]);

  const handleCreateTable = useCallback(() => {
    const sql = buildPivotSQL();
    if (!sql) return;
    onCreateTable(sql, "(pivot)");
    onClose();
  }, [buildPivotSQL, onCreateTable, onClose]);

  // Can run: pivot column selected + at least one valid value field
  const hasValidUsing = (() => {
    for (const col of valueFields) {
      const colInfo = schema.find((c) => c.column_name === col);
      const colIsNumeric = colInfo ? isNumeric(colInfo.column_type) : false;
      if (colIsNumeric || NON_NUMERIC_FUNCTIONS.has(aggFunction)) return true;
    }
    return false;
  })();

  const canRun = !!pivotColumn && valueFields.size > 0 && hasValidUsing && !!activeTable;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Pivot Table"
      icon="pivot-table"
      style={{ width: 780, maxWidth: "90vw" }}
      canOutsideClickClose={false}
    >
      <DialogBody>
        <div className="aggregate-dialog-content">
          {/* Row Fields Section */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">
              Row Fields (optional — becomes GROUP BY)
            </div>
            <div className="aggregate-checkbox-list">
              {allColNames.map((col) => (
                <Checkbox
                  key={col}
                  checked={rowFields.has(col)}
                  onChange={() => toggleRowField(col)}
                  label={col}
                  style={{ marginBottom: 0 }}
                />
              ))}
            </div>
          </div>

          {/* Pivot Column Section */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">
              Pivot Column (required — values become column headers)
            </div>
            <HTMLSelect
              value={pivotColumn}
              onChange={(e) => {
                setPivotColumn(e.target.value);
                setResults(null);
              }}
              fill
            >
              <option value="">— Select a column —</option>
              {pivotColumnOptions.map((col) => (
                <option key={col} value={col}>
                  {col}
                </option>
              ))}
            </HTMLSelect>

            {/* Distinct values preview */}
            {pivotColumn && (
              <div className="pivot-distinct-preview">
                {loadingDistinct ? (
                  <span className="pivot-distinct-loading">
                    Loading distinct values...
                  </span>
                ) : (
                  pivotDistinctCount !== null && (
                    <>
                      <span className="pivot-distinct-count">
                        {pivotDistinctCount} distinct value
                        {pivotDistinctCount !== 1 ? "s" : ""}
                      </span>
                      {pivotDistinctValues.length > 0 && (
                        <span className="pivot-distinct-sample">
                          {pivotDistinctValues.join(", ")}
                          {pivotDistinctCount! > 50 && ", ..."}
                        </span>
                      )}
                    </>
                  )
                )}
              </div>
            )}

            {/* Cardinality warnings */}
            {pivotDistinctCount !== null && pivotDistinctCount > 200 && (
              <Callout
                intent={Intent.DANGER}
                icon="warning-sign"
                style={{ marginTop: 8 }}
              >
                This column has {pivotDistinctCount} distinct values — the pivot
                will create {pivotDistinctCount}+ columns. This may be slow or
                produce an unwieldy result.
              </Callout>
            )}
            {pivotDistinctCount !== null &&
              pivotDistinctCount > 50 &&
              pivotDistinctCount <= 200 && (
                <Callout
                  intent={Intent.WARNING}
                  icon="warning-sign"
                  style={{ marginTop: 8 }}
                >
                  This column has {pivotDistinctCount} distinct values — the
                  pivot will create {pivotDistinctCount}+ columns.
                </Callout>
              )}
          </div>

          {/* Value Fields Section */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">
              <span>Value Fields (required — columns to aggregate)</span>
              <span className="aggregate-section-actions">
                <Button
                  minimal
                  small
                  text="Select All Numeric"
                  onClick={selectAllNumeric}
                />
                <Button
                  minimal
                  small
                  text="Deselect All"
                  onClick={deselectAll}
                />
              </span>
            </div>
            <div className="aggregate-col-grid">
              {schema.map((col) => {
                const numeric = isNumeric(col.column_type);
                return (
                  <div
                    key={col.column_name}
                    className={`aggregate-col-item${valueFields.has(col.column_name) ? " selected" : ""}`}
                  >
                    <Checkbox
                      checked={valueFields.has(col.column_name)}
                      onChange={() => toggleValueField(col.column_name)}
                      style={{ marginBottom: 0 }}
                    />
                    <span className="aggregate-col-name">
                      {col.column_name}
                    </span>
                    <span className="aggregate-col-type">
                      {col.column_type}
                      {!numeric && (
                        <span className="aggregate-col-hint">
                          {" "}
                          (count/min/max/first only)
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Aggregate Function Section */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">
              Aggregate Function
            </div>
            <HTMLSelect
              value={aggFunction}
              onChange={(e) => {
                setAggFunction(e.target.value as AggFunc);
                setResults(null);
              }}
              fill
            >
              {AGG_FUNCTIONS.map((fn) => (
                <option key={fn} value={fn}>
                  {fn}
                </option>
              ))}
            </HTMLSelect>
          </div>

          {/* Error */}
          {error && (
            <Callout intent={Intent.DANGER} icon="error" style={{ marginTop: 10 }}>
              {error}
            </Callout>
          )}

          {/* Results — opens in separate dialog */}
          <PreviewTableDialog
            isOpen={previewOpen}
            onClose={() => setPreviewOpen(false)}
            title="Pivot Results"
            rows={results ?? []}
            columns={resultColumns}
          />
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button text="Close" onClick={onClose} />
            <Button
              intent={Intent.PRIMARY}
              text="Run"
              icon="play"
              onClick={handleRun}
              disabled={!canRun}
              loading={running}
            />
            <Button
              intent={Intent.SUCCESS}
              text="Create as Table"
              icon="th-derived"
              onClick={handleCreateTable}
              disabled={!results || results.length === 0}
            />
          </>
        }
      />
    </Dialog>
  );
}
