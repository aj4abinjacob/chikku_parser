import React, { useState, useEffect, useCallback } from "react";
import {
  Button,
  Checkbox,
  Intent,
  Dialog,
  DialogBody,
  DialogFooter,
  Callout,
} from "@blueprintjs/core";
import { ColumnInfo } from "../types";
import { PreviewTableDialog } from "./PreviewTableDialog";

const NUMERIC_RE = /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i;

const ALL_FUNCTIONS = [
  "SUM",
  "MIN",
  "MAX",
  "AVG",
  "COUNT",
  "COUNT DISTINCT",
  "COUNT NULL",
  "MEDIAN",
  "STDDEV",
] as const;

type AggFunc = (typeof ALL_FUNCTIONS)[number];

/** Functions available for non-numeric columns */
const NON_NUMERIC_FUNCTIONS: Set<AggFunc> = new Set(["COUNT", "COUNT DISTINCT", "COUNT NULL", "MIN", "MAX"]);

function isNumeric(colType: string): boolean {
  return NUMERIC_RE.test(colType);
}

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface AggregateDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeTable: string | null;
  schema: ColumnInfo[];
  onCreateTable: (sql: string, filePath: string) => void;
}

export function AggregateDialog({
  isOpen,
  onClose,
  activeTable,
  schema,
  onCreateTable,
}: AggregateDialogProps): React.ReactElement {
  // Group By columns
  const [groupByCols, setGroupByCols] = useState<Set<string>>(new Set());

  // Selected columns (which columns to aggregate)
  const [selectedCols, setSelectedCols] = useState<Set<string>>(new Set());

  // Selected functions
  const [selectedFuncs, setSelectedFuncs] = useState<Set<AggFunc>>(new Set());

  // Results
  const [results, setResults] = useState<Record<string, unknown>[] | null>(null);
  const [resultColumns, setResultColumns] = useState<string[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  // Reset state when dialog opens or table changes
  useEffect(() => {
    if (isOpen) {
      setGroupByCols(new Set());
      setSelectedCols(new Set());
      setSelectedFuncs(new Set());
      setResults(null);
      setResultColumns([]);
      setPreviewOpen(false);
      setError(null);
    }
  }, [isOpen, activeTable]);

  const numericCols = schema.filter((c) => isNumeric(c.column_type));
  const allColNames = schema.map((c) => c.column_name);

  const toggleGroupBy = useCallback((col: string) => {
    setGroupByCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
    setResults(null);
  }, []);

  const toggleCol = useCallback((col: string) => {
    setSelectedCols((prev) => {
      const next = new Set(prev);
      if (next.has(col)) next.delete(col);
      else next.add(col);
      return next;
    });
    setResults(null);
  }, []);

  const toggleFunc = useCallback((fn: AggFunc) => {
    setSelectedFuncs((prev) => {
      const next = new Set(prev);
      if (next.has(fn)) next.delete(fn);
      else next.add(fn);
      return next;
    });
    setResults(null);
  }, []);

  const selectAllNumeric = useCallback(() => {
    setSelectedCols(new Set(numericCols.map((c) => c.column_name)));
    setResults(null);
  }, [numericCols]);

  const deselectAll = useCallback(() => {
    setSelectedCols(new Set());
    setResults(null);
  }, []);

  /** Build the aggregate SQL */
  const buildSQL = useCallback((): string | null => {
    if (!activeTable || selectedCols.size === 0 || selectedFuncs.size === 0) return null;

    const selectParts: string[] = [];

    // Group By columns first
    for (const col of groupByCols) {
      selectParts.push(escapeIdent(col));
    }

    // Aggregate expressions
    for (const col of selectedCols) {
      const colInfo = schema.find((c) => c.column_name === col);
      const colIsNumeric = colInfo ? isNumeric(colInfo.column_type) : false;

      for (const fn of ALL_FUNCTIONS) {
        if (!selectedFuncs.has(fn)) continue;
        // Skip numeric-only functions on non-numeric columns
        if (!colIsNumeric && !NON_NUMERIC_FUNCTIONS.has(fn)) continue;

        const ident = escapeIdent(col);
        let expr: string;
        let alias: string;
        if (fn === "COUNT DISTINCT") {
          expr = `COUNT(DISTINCT ${ident})`;
          alias = `COUNT_DISTINCT(${col})`;
        } else if (fn === "COUNT NULL") {
          expr = `SUM(CASE WHEN ${ident} IS NULL THEN 1 ELSE 0 END)`;
          alias = `COUNT_NULL(${col})`;
        } else {
          expr = `${fn}(${ident})`;
          alias = `${fn}(${col})`;
        }
        selectParts.push(`${expr} AS ${escapeIdent(alias)}`);
      }
    }

    if (selectParts.length === 0) return null;

    let sql = `SELECT ${selectParts.join(", ")} FROM ${escapeIdent(activeTable)}`;
    if (groupByCols.size > 0) {
      sql += ` GROUP BY ${[...groupByCols].map(escapeIdent).join(", ")}`;
    }

    return sql;
  }, [activeTable, selectedCols, selectedFuncs, groupByCols, schema]);

  const handleRun = useCallback(async () => {
    const sql = buildSQL();
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
  }, [buildSQL]);

  const handleCreateTable = useCallback(() => {
    const sql = buildSQL();
    if (!sql) return;
    onCreateTable(sql, "(aggregate)");
    onClose();
  }, [buildSQL, onCreateTable, onClose]);

  const canRun = selectedCols.size > 0 && selectedFuncs.size > 0 && activeTable;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Aggregate Summary"
      style={{ width: 720, maxWidth: "90vw" }}
      canOutsideClickClose={false}
    >
      <DialogBody>
        <div className="aggregate-dialog-content">
          {/* Group By Section */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">Group By (optional)</div>
            <div className="aggregate-checkbox-list">
              {allColNames.map((col) => (
                <Checkbox
                  key={col}
                  checked={groupByCols.has(col)}
                  onChange={() => toggleGroupBy(col)}
                  label={col}
                  style={{ marginBottom: 0 }}
                />
              ))}
            </div>
          </div>

          {/* Function Selection */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">Aggregate Functions</div>
            <div className="aggregate-func-row">
              {ALL_FUNCTIONS.map((fn) => (
                <Checkbox
                  key={fn}
                  checked={selectedFuncs.has(fn)}
                  onChange={() => toggleFunc(fn)}
                  label={fn}
                  style={{ marginBottom: 0 }}
                />
              ))}
            </div>
          </div>

          {/* Column Selection */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">
              <span>Columns</span>
              <span className="aggregate-section-actions">
                <Button minimal small text="Select All Numeric" onClick={selectAllNumeric} />
                <Button minimal small text="Deselect All" onClick={deselectAll} />
              </span>
            </div>
            <div className="aggregate-col-grid">
              {schema.map((col) => {
                const numeric = isNumeric(col.column_type);
                return (
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
                    <span className="aggregate-col-type">
                      {col.column_type}
                      {!numeric && <span className="aggregate-col-hint"> (count/count null/min/max only)</span>}
                    </span>
                  </div>
                );
              })}
            </div>
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
            title="Aggregate Results"
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
