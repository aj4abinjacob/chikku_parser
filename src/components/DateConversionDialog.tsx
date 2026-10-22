import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  InputGroup,
  Intent,
  Radio,
  RadioGroup,
  Spinner,
  Tag,
} from "@blueprintjs/core";
import { SoftSelect } from "./SoftSelect";
import { ColumnInfo, LoadedTable } from "../types";
import {
  detectDateFormat,
  DetectionResult,
  OUTPUT_FORMATS,
} from "../utils/dateDetection";
import { PreviewTableDialog } from "./PreviewTableDialog";
import { SearchableColumnSelect } from "./SearchableColumnSelect";
import { AsyncActionGate, columnNameExists, errorMessage, suggestColumnName } from "../utils/operationUX";

function escapeIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function escapeLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Check if a DuckDB type is already a date/timestamp */
function isDateType(colType: string): boolean {
  const upper = colType.toUpperCase();
  return (
    upper.startsWith("DATE") ||
    upper.startsWith("TIMESTAMP") ||
    upper.startsWith("TIME")
  );
}

interface GroupDetection {
  groupValue: string; // group label, or "(All rows)" if ungrouped
  samples: string[];
  detection: DetectionResult;
  /** User-selected format override (from dropdown or manual input) */
  selectedFormat: string;
}

interface DateConversionDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeTable: string | null;
  schema: ColumnInfo[];
  tables: LoadedTable[];
  filtersApplied: boolean;
  onApply: (sql: string, description?: string) => Promise<void>;
}

const MAX_DISPLAY_GROUPS = 50;
const DETECTION_DEBOUNCE_MS = 400;

export function DateConversionDialog({
  isOpen,
  onClose,
  activeTable,
  schema,
  tables,
  filtersApplied,
  onApply,
}: DateConversionDialogProps): React.ReactElement {
  // Section 1: Date column & group-by
  const [dateColumn, setDateColumn] = useState("");
  const [groupByColumn, setGroupByColumn] = useState("");

  // Section 2: Detection results
  const [groupDetections, setGroupDetections] = useState<GroupDetection[]>([]);
  const [detecting, setDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);

  // Section 3: Output format
  const [outputFormatPreset, setOutputFormatPreset] = useState("%Y-%m-%d");
  const [customOutputFormat, setCustomOutputFormat] = useState("");
  const outputFormat =
    outputFormatPreset === "custom" ? customOutputFormat : outputFormatPreset;

  // Section 4: Result mode
  const [resultMode, setResultMode] = useState<"replace" | "new">("new");
  const [newColumnName, setNewColumnName] = useState("");

  // Preview
  const [previewRows, setPreviewRows] = useState<Record<string, unknown>[] | null>(null);
  const [previewColumns, setPreviewColumns] = useState<string[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewNullCount, setPreviewNullCount] = useState<number | null>(null);

  // General
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [pendingAction, setPendingAction] = useState<"preview" | "apply" | null>(null);
  const actionGate = useRef(new AsyncActionGate());
  const activeFile = tables.find((table) => table.tableName === activeTable);
  const fileName = activeFile && !activeFile.filePath.startsWith("(")
    ? activeFile.filePath.split(/[/\\]/).pop() || activeTable : activeTable;
  const columnNames = schema.map((column) => column.column_name);
  const invalidTarget = resultMode === "new" && (!newColumnName.trim() || columnNameExists(columnNames, newColumnName));
  const handleClose = () => { if (!actionGate.current.pending) onClose(); };

  // Debounce ref
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whether the date column is already a DATE/TIMESTAMP type
  const dateColInfo = schema.find((c) => c.column_name === dateColumn);
  const alreadyDateType = dateColInfo ? isDateType(dateColInfo.column_type) : false;

  // Reset state on dialog open
  useEffect(() => {
    if (isOpen) {
      setDateColumn("");
      setGroupByColumn("");
      setGroupDetections([]);
      setDetecting(false);
      setDetectionError(null);
      setOutputFormatPreset("%Y-%m-%d");
      setCustomOutputFormat("");
      setResultMode("new");
      setNewColumnName("");
      setPreviewRows(null);
      setPreviewColumns([]);
      setPreviewOpen(false);
      setPreviewNullCount(null);
      setError(null);
      setRunning(false);
      setPendingAction(null);
    }
  }, [isOpen, activeTable]);

  // Refresh untouched suggestions when the source schema changes; preserve typed names.
  const suggestedName = useRef<string | null>(null);
  const suggestionContext = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !dateColumn) {
      suggestionContext.current = null;
      return;
    }
    const next = suggestColumnName(schema.map((column) => column.column_name), `${dateColumn}_converted`);
    const context = JSON.stringify([activeTable, dateColumn]);
    if (suggestionContext.current !== context) {
      setNewColumnName(next);
      suggestionContext.current = context;
    } else {
      const previous = suggestedName.current;
      setNewColumnName((current) => current === previous ? next : current);
    }
    suggestedName.current = next;
  }, [isOpen, activeTable, dateColumn, schema]);

  // ── Detection logic ──────────────────────────────────────────────

  const runDetection = useCallback(async () => {
    if (!activeTable || !dateColumn) {
      setGroupDetections([]);
      return;
    }

    // Skip detection if column is already a DATE type
    if (alreadyDateType) {
      setGroupDetections([
        {
          groupValue: "(All rows)",
          samples: [],
          detection: { format: "%Y-%m-%d", confidence: "high", alternatives: [] },
          selectedFormat: "%Y-%m-%d",
        },
      ]);
      return;
    }

    setDetecting(true);
    setDetectionError(null);

    try {
      if (!groupByColumn) {
        // No grouping — single detection
        const sampleSql = `SELECT CAST(${escapeIdent(dateColumn)} AS VARCHAR) AS val FROM ${escapeIdent(activeTable)} WHERE ${escapeIdent(dateColumn)} IS NOT NULL AND CAST(${escapeIdent(dateColumn)} AS VARCHAR) != '' LIMIT 200`;
        const rows = await window.api.query(sampleSql);
        const samples = rows.map((r: Record<string, unknown>) => String(r.val));
        const detection = detectDateFormat(samples);

        setGroupDetections([
          {
            groupValue: "(All rows)",
            samples: samples.slice(0, 5),
            detection,
            selectedFormat: detection.format,
          },
        ]);
      } else {
        // Grouped detection — fetch distinct groups
        const groupSql = `SELECT DISTINCT CAST(${escapeIdent(groupByColumn)} AS VARCHAR) AS grp FROM ${escapeIdent(activeTable)} WHERE ${escapeIdent(groupByColumn)} IS NOT NULL ORDER BY grp LIMIT 200`;
        const groupRows = await window.api.query(groupSql);
        const groups = groupRows.map((r: Record<string, unknown>) => String(r.grp));

        const detections: GroupDetection[] = [];

        for (const grp of groups) {
          const sampleSql = `SELECT CAST(${escapeIdent(dateColumn)} AS VARCHAR) AS val FROM ${escapeIdent(activeTable)} WHERE CAST(${escapeIdent(groupByColumn)} AS VARCHAR) = ${escapeLiteral(grp)} AND ${escapeIdent(dateColumn)} IS NOT NULL AND CAST(${escapeIdent(dateColumn)} AS VARCHAR) != '' LIMIT 200`;
          const rows = await window.api.query(sampleSql);
          const samples = rows.map((r: Record<string, unknown>) => String(r.val));
          const detection = detectDateFormat(samples);

          detections.push({
            groupValue: grp,
            samples: samples.slice(0, 5),
            detection,
            selectedFormat: detection.format,
          });
        }

        setGroupDetections(detections);
      }
    } catch (err) {
      setDetectionError(err instanceof Error ? err.message : String(err));
      setGroupDetections([]);
    } finally {
      setDetecting(false);
    }
  }, [activeTable, dateColumn, groupByColumn, alreadyDateType]);

  // Debounced detection trigger
  useEffect(() => {
    if (!isOpen || !activeTable || !dateColumn) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(runDetection, DETECTION_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [isOpen, activeTable, dateColumn, groupByColumn, runDetection]);

  // ── Format selection handler ─────────────────────────────────────

  const updateGroupFormat = useCallback((index: number, format: string) => {
    setGroupDetections((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], selectedFormat: format };
      return next;
    });
  }, []);

  // ── SQL generation ───────────────────────────────────────────────

  const buildConversionExpr = useCallback(
    (inputFormat: string, outFmt: string): string => {
      if (alreadyDateType) {
        // Already a date type — just reformat
        return `strftime(${escapeIdent(dateColumn)}, ${escapeLiteral(outFmt)})`;
      }
      return `strftime(TRY_STRPTIME(CAST(${escapeIdent(dateColumn)} AS VARCHAR), ${escapeLiteral(inputFormat)}), ${escapeLiteral(outFmt)})`;
    },
    [dateColumn, alreadyDateType]
  );

  const buildSQL = useCallback((): string | null => {
    if (!activeTable || !dateColumn || groupDetections.length === 0 || invalidTarget) return null;

    const outFmt = outputFormat;
    if (!outFmt) return null;

    // Determine the target column name/alias
    const targetColName =
      resultMode === "new" ? (newColumnName.trim() || `${dateColumn}_converted`) : dateColumn;

    let conversionExpr: string;

    if (groupDetections.length === 1 || !groupByColumn) {
      // Single format for all rows
      const fmt = groupDetections[0].selectedFormat;
      if (!fmt) return null;
      conversionExpr = buildConversionExpr(fmt, outFmt);
    } else {
      // Per-group CASE WHEN
      const caseClauses = groupDetections
        .filter((g) => g.selectedFormat)
        .map(
          (g) =>
            `WHEN CAST(${escapeIdent(groupByColumn)} AS VARCHAR) = ${escapeLiteral(g.groupValue)} THEN ${buildConversionExpr(g.selectedFormat, outFmt)}`
        )
        .join("\n      ");

      // Default: use the most common format for unmatched groups
      const defaultFmt = groupDetections[0]?.selectedFormat || "%Y-%m-%d";
      conversionExpr = `CASE\n      ${caseClauses}\n      ELSE ${buildConversionExpr(defaultFmt, outFmt)}\n    END`;
    }

    if (resultMode === "replace") {
      // Rebuild SELECT with conversion at the original column position
      const selectCols = schema
        .map((c) => {
          if (c.column_name === dateColumn) {
            return `${conversionExpr} AS ${escapeIdent(dateColumn)}`;
          }
          return escapeIdent(c.column_name);
        })
        .join(", ");

      return `CREATE OR REPLACE TABLE ${escapeIdent(activeTable)} AS SELECT ${selectCols} FROM ${escapeIdent(activeTable)}`;
    } else {
      // Add new column
      return `CREATE OR REPLACE TABLE ${escapeIdent(activeTable)} AS SELECT *, ${conversionExpr} AS ${escapeIdent(targetColName)} FROM ${escapeIdent(activeTable)}`;
    }
  }, [
    activeTable,
    dateColumn,
    groupByColumn,
    groupDetections,
    outputFormat,
    resultMode,
    newColumnName,
    schema,
    buildConversionExpr,
    invalidTarget,
  ]);

  // ── Preview ──────────────────────────────────────────────────────

  const handlePreview = useCallback(async () => {
    if (actionGate.current.pending) return;
    const sql = buildSQL();
    if (!sql) {
      setError("Cannot build conversion SQL. Ensure a format is detected/selected.");
      return;
    }

    await actionGate.current.run(async () => {
      setRunning(true);
      setPendingAction("preview");
      setError(null);

      try {
        // Extract the SELECT part (strip CREATE OR REPLACE TABLE ... AS )
        const selectMatch = sql.match(/AS\s+(SELECT\s+.+)$/is);
        if (!selectMatch) {
          setError("Could not extract SELECT from generated SQL.");
          setRunning(false);
          return;
        }
        const selectSql = selectMatch[1];

        const rows = await window.api.query(`${selectSql} LIMIT 200`);
        if (rows.length > 0) {
          setPreviewColumns(Object.keys(rows[0]));
        } else {
          setPreviewColumns([]);
        }
        setPreviewRows(rows);

        // Count NULLs in the target column
        const targetCol =
          resultMode === "new"
            ? (newColumnName.trim() || `${dateColumn}_converted`)
            : dateColumn;
        const nullCountSql = `SELECT COUNT(*) AS cnt FROM (${selectSql}) WHERE ${escapeIdent(targetCol)} IS NULL`;
        const nullResult = await window.api.query(nullCountSql);
        setPreviewNullCount(Number(nullResult[0]?.cnt ?? 0));

        setPreviewOpen(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRunning(false);
        setPendingAction(null);
      }
    });
  }, [buildSQL, resultMode, newColumnName, dateColumn]);

  // ── Apply ────────────────────────────────────────────────────────

  const handleApply = useCallback(async () => {
    if (actionGate.current.pending) return;
    const sql = buildSQL();
    if (!sql) {
      setError("Cannot build conversion SQL. Ensure a format is detected/selected.");
      return;
    }

    await actionGate.current.run(async () => {
      setRunning(true);
      setPendingAction("apply");
      setError(null);

      try {
        const targetName = resultMode === "new" ? (newColumnName.trim() || `${dateColumn}_converted`) : dateColumn;
        await onApply(sql, `Date conversion on "${dateColumn}"${resultMode === "new" ? ` → "${targetName}"` : ""}`);
        onClose();
      } catch (err) {
        setError(`Conversion failed. ${errorMessage(err)} Your settings are preserved. Review them and retry.`);
      } finally {
        setRunning(false);
        setPendingAction(null);
      }
    });
  }, [buildSQL, onApply, onClose, resultMode, newColumnName, dateColumn]);

  // ── Validation ───────────────────────────────────────────────────

  const hasFormats = groupDetections.length > 0 && groupDetections.every((g) => g.selectedFormat);
  const canRun = !!dateColumn && hasFormats && !!outputFormat && !invalidTarget && !detecting && !!activeFile;

  // Available columns (all columns for group-by, all for date)
  const dateColumns = schema;
  const groupColumns = schema.filter((c) => c.column_name !== dateColumn);

  // Display groups (limit to MAX_DISPLAY_GROUPS)
  const displayGroups = groupDetections.slice(0, MAX_DISPLAY_GROUPS);
  const hiddenGroupCount = groupDetections.length - displayGroups.length;

  // Format today's date for output format example
  const formatExample = (() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const y = now.getFullYear();
    const m = pad(now.getMonth() + 1);
    const d = pad(now.getDate());
    const h = pad(now.getHours());
    const min = pad(now.getMinutes());
    const sec = pad(now.getSeconds());

    return outputFormat
      .replace("%Y", String(y))
      .replace("%y", String(y).slice(-2))
      .replace("%m", m)
      .replace("%d", d)
      .replace("%H", h)
      .replace("%M", min)
      .replace("%S", sec);
  })();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      canEscapeKeyClose={!running}
      isCloseButtonShown={!running}
      title="Date Conversion"
      icon="calendar"
      style={{ width: 820, maxWidth: "92vw" }}
      canOutsideClickClose={false}
    >
      <DialogBody>
        <Callout icon="database" style={{ marginBottom: 12 }}>
          <strong>{fileName}</strong> · Entire file · {(activeFile?.rowCount ?? 0).toLocaleString()} rows.
        </Callout>
        {filtersApplied && (
          <Callout intent={Intent.WARNING} icon="filter" style={{ marginBottom: 12 }}>
            Filters are active in the table. Date conversion includes hidden rows and applies to the entire file.
          </Callout>
        )}
        <fieldset className="aggregate-dialog-content" disabled={running} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          {/* Section 1: Date Column & Group By */}
          <div className="aggregate-section">
            <div className="aggregate-section-header">Date Column</div>
            <SearchableColumnSelect
              value={dateColumn}
              onChange={(val) => {
                setDateColumn(val);
                setGroupDetections([]);
                setPreviewRows(null);
              }}
              columns={dateColumns}
              placeholder="— Select a column —"
              showType
              fill
            />
          </div>

          {dateColumn && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">
                <span>Group By (optional)</span>
              </div>
              <SearchableColumnSelect
                value={groupByColumn}
                onChange={(val) => {
                  setGroupByColumn(val);
                  setGroupDetections([]);
                  setPreviewRows(null);
                }}
                columns={groupColumns}
                placeholder="— No grouping —"
                fill
                allowEmpty
                emptyLabel="— No grouping —"
              />
              <div className="date-conv-group-hint">
                Use grouping when the same date format (e.g. 1/12/20) means different things
                across data sources — the format will be detected per group.
              </div>
            </div>
          )}

          {/* Section 2: Detection Results */}
          {dateColumn && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">Detected Formats</div>

              {detecting && (
                <div className="date-conv-detecting">
                  <Spinner size={16} />
                  <span>Analyzing date values...</span>
                </div>
              )}

              {detectionError && (
                <Callout intent={Intent.DANGER} icon="error">
                  {detectionError}
                </Callout>
              )}

              {!detecting && !detectionError && alreadyDateType && (
                <Callout intent={Intent.PRIMARY} icon="info-sign">
                  Column is already a <strong>{dateColInfo?.column_type}</strong> type.
                  Conversion will reformat the values directly.
                </Callout>
              )}

              {!detecting && !detectionError && groupDetections.length > 0 && !alreadyDateType && (
                <div className="date-conv-detection-table">
                  <table>
                    <thead>
                      <tr>
                        {groupByColumn && <th>Group</th>}
                        <th>Sample Values</th>
                        <th>Format</th>
                        <th>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {displayGroups.map((g, i) => (
                        <tr key={g.groupValue}>
                          {groupByColumn && (
                            <td className="date-conv-group-cell">{g.groupValue}</td>
                          )}
                          <td className="date-conv-sample-values">
                            {g.samples.slice(0, 3).join(", ")}
                            {g.samples.length > 3 && " ..."}
                          </td>
                          <td>
                            {g.detection.confidence === "ambiguous" ? (
                              <SoftSelect
                                value={g.selectedFormat}
                                onChange={(e) => updateGroupFormat(i, e.target.value)}
                                className="date-conv-format-select"
                              >
                                {g.detection.alternatives.map((alt) => (
                                  <option key={alt} value={alt}>
                                    {alt}
                                  </option>
                                ))}
                              </SoftSelect>
                            ) : g.detection.confidence === "unknown" ? (
                              <InputGroup
                                value={g.selectedFormat}
                                onChange={(e) => updateGroupFormat(i, e.target.value)}
                                className="date-conv-format-input"
                                small
                                placeholder="e.g. %d/%m/%Y"
                              />
                            ) : (
                              <code>{g.selectedFormat}</code>
                            )}
                          </td>
                          <td>
                            <Tag
                              minimal
                              intent={
                                g.detection.confidence === "high"
                                  ? Intent.SUCCESS
                                  : g.detection.confidence === "ambiguous"
                                  ? Intent.WARNING
                                  : Intent.DANGER
                              }
                            >
                              {g.detection.confidence}
                            </Tag>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {hiddenGroupCount > 0 && (
                    <div className="date-conv-hidden-groups">
                      +{hiddenGroupCount} more groups (using most common format as default)
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Section 3: Output Format */}
          {dateColumn && groupDetections.length > 0 && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">Output Format</div>
              <SoftSelect
                value={outputFormatPreset}
                onChange={(e) => setOutputFormatPreset(e.target.value)}
                fill
              >
                {OUTPUT_FORMATS.map(([label, fmt]) => (
                  <option key={fmt} value={fmt}>
                    {label} ({fmt})
                  </option>
                ))}
                <option value="custom">Custom...</option>
              </SoftSelect>
              {outputFormatPreset === "custom" && (
                <InputGroup
                  value={customOutputFormat}
                  onChange={(e) => setCustomOutputFormat(e.target.value)}
                  placeholder="DuckDB format string, e.g. %Y-%m-%d"
                  small
                  style={{ marginTop: 6 }}
                />
              )}
              <div className="date-conv-example">
                Example: <code>{formatExample || "—"}</code>
              </div>
            </div>
          )}

          {/* Section 4: Result Mode */}
          {dateColumn && groupDetections.length > 0 && (
            <div className="aggregate-section">
              <div className="aggregate-section-header">Result</div>
              <div className="merge-options-grid">
                <RadioGroup
                  selectedValue={resultMode}
                  onChange={(e) => setResultMode(e.currentTarget.value as "replace" | "new")}
                  inline
                >
                  <Radio value="replace" label={`Replace "${dateColumn}"`} />
                  <Radio value="new" label="Create new column" />
                </RadioGroup>
                {resultMode === "new" && (
                  <InputGroup
                    value={newColumnName}
                    onChange={(e) => setNewColumnName(e.target.value)}
                    placeholder="New column name"
                    intent={invalidTarget ? Intent.DANGER : Intent.NONE}
                    small
                  />
                )}
              </div>
            </div>
          )}

          {dateColumn && (
            <Callout icon={resultMode === "new" ? "add-column-right" : "warning-sign"} intent={resultMode === "new" ? Intent.NONE : Intent.WARNING}>
              {resultMode === "new"
                ? `Creates new column "${newColumnName.trim()}" in ${fileName}; the source column is preserved.`
                : `Overwrites "${dateColumn}" in ${fileName} on every row.`}
              {invalidTarget && " Enter a unique column name."}
            </Callout>
          )}

          {/* NULL parse warning */}
          {previewNullCount !== null && previewNullCount > 0 && (
            <Callout
              intent={Intent.WARNING}
              icon="warning-sign"
              className="date-conv-null-warning"
            >
              <strong>{previewNullCount.toLocaleString()}</strong> row
              {previewNullCount !== 1 ? "s" : ""} failed to parse and will become NULL.
              Check that the detected format matches your data.
            </Callout>
          )}

          {/* Error */}
          {error && (
            <Callout intent={Intent.DANGER} icon="error" role="alert" style={{ marginTop: 10 }}>
              {error}
            </Callout>
          )}

          {/* Preview dialog */}
          <PreviewTableDialog
            isOpen={previewOpen}
            onClose={() => setPreviewOpen(false)}
            title="Date Conversion Preview"
            rows={previewRows ?? []}
            columns={previewColumns}
          />
        </fieldset>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button text="Close" onClick={handleClose} disabled={running} />
            <Button
              intent={Intent.PRIMARY}
              text="Preview"
              icon="eye-open"
              onClick={handlePreview}
              disabled={!canRun || running}
              loading={running && pendingAction === "preview"}
            />
            <Button
              intent={Intent.SUCCESS}
              text={pendingAction === "apply" ? "Applying..." : error ? "Retry Apply" : "Apply"}
              icon="tick"
              onClick={handleApply}
              disabled={!canRun || running}
              loading={running && pendingAction === "apply"}
            />
          </>
        }
      />
    </Dialog>
  );
}
