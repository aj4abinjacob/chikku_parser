import React, { useState, useEffect } from "react";
import {
  Button,
  Checkbox,
  Intent,
  HTMLSelect,
  InputGroup,
  Dialog,
  DialogBody,
  DialogFooter,
  FormGroup,
} from "@blueprintjs/core";
import { ColumnInfo } from "../types";

type OpType =
  | "regex_extract"
  | "trim"
  | "upper"
  | "lower"
  | "replace_regex"
  | "substring"
  | "custom_sql"
  | "create_column"
  | "delete_column"
  | "combine_columns"
  | "rename_column";

const OP_LABELS: Record<OpType, string> = {
  regex_extract: "Regex Extract",
  trim: "Trim Whitespace",
  upper: "To Uppercase",
  lower: "To Lowercase",
  replace_regex: "Regex Replace",
  substring: "Substring",
  custom_sql: "Custom SQL Expression",
  create_column: "Create New Column",
  delete_column: "Delete Column",
  combine_columns: "Combine Columns",
  rename_column: "Rename Column",
};

interface DataOperationsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeTable: string | null;
  schema: ColumnInfo[];
  onApply: (sql: string) => void;
}

export function DataOperationsDialog({
  isOpen,
  onClose,
  activeTable,
  schema,
  onApply,
}: DataOperationsDialogProps): React.ReactElement {
  const [opType, setOpType] = useState<OpType>("regex_extract");
  const [sourceCol, setSourceCol] = useState("");
  const [targetCol, setTargetCol] = useState("");
  const [param1, setParam1] = useState("");
  const [param2, setParam2] = useState("");
  const [combineSourceCols, setCombineSourceCols] = useState<string[]>([]);
  const [combineSearch, setCombineSearch] = useState("");
  const [previews, setPreviews] = useState<Array<{ original: string; result: string }>>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Build a lookup map from schema for column types
  const colTypeMap = React.useMemo(() => {
    const map = new Map<string, string>();
    schema.forEach((col) => map.set(col.column_name, col.column_type));
    return map;
  }, [schema]);

  const buildExpression = (op: OpType, col: string, p1: string, p2: string): string | null => {
    // For string-based ops, cast to VARCHAR if the column isn't already a string type
    const colType = colTypeMap.get(col) || "";
    const isString = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(colType);
    const ref = isString ? `"${col}"` : `CAST("${col}" AS VARCHAR)`;

    switch (op) {
      case "regex_extract": {
        const pattern = p1 || "(.+)";
        const groupIdx = p2 || "1";
        return `regexp_extract(${ref}, '${pattern.replace(/'/g, "''")}', ${groupIdx})`;
      }
      case "trim":
        return `TRIM(${ref})`;
      case "upper":
        return `UPPER(${ref})`;
      case "lower":
        return `LOWER(${ref})`;
      case "replace_regex":
        return `regexp_replace(${ref}, '${p1.replace(/'/g, "''")}', '${p2.replace(/'/g, "''")}')`;
      case "substring":
        return `SUBSTRING(${ref}, ${p1 || "1"}, ${p2 || "10"})`;
      case "custom_sql":
        return p1 || null;
      case "create_column":
        return p1 || null;
      case "delete_column":
        return null;
      case "combine_columns":
        return null; // handled separately in handleApply
      case "rename_column":
        return null; // handled separately in handleApply
      default:
        return null;
    }
  };

  const buildCombineExpression = (cols: string[], separator: string): string => {
    const parts = cols.map((col) => {
      const colType = colTypeMap.get(col) || "";
      const isString = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(colType);
      return isString ? `"${col}"` : `CAST("${col}" AS VARCHAR)`;
    });
    if (separator) {
      return parts.join(` || '${separator.replace(/'/g, "''")}' || `);
    }
    return parts.join(" || ");
  };

  // Live preview: fetch 3 distinct non-null samples and show before/after
  useEffect(() => {
    if (!isOpen || !activeTable) {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

    // delete_column, create_column, rename_column: no preview needed
    if (opType === "delete_column" || opType === "create_column" || opType === "rename_column") {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

    // combine_columns: preview the concatenation result
    if (opType === "combine_columns") {
      if (combineSourceCols.length < 2) {
        setPreviews([]);
        setPreviewError(null);
        return;
      }
      const concatExpr = buildCombineExpression(combineSourceCols, param1);
      const timer = setTimeout(async () => {
        try {
          const sql = `SELECT CAST(${concatExpr} AS VARCHAR) AS "result" FROM "${activeTable}" LIMIT 3`;
          const rows = await window.api.query(sql);
          setPreviews(rows.map((r: any) => ({ original: "", result: String(r.result ?? "") })));
          setPreviewError(null);
        } catch (e: any) {
          setPreviews([]);
          setPreviewError(e.message || "Preview failed");
        }
      }, 300);
      return () => clearTimeout(timer);
    }

    // All other operations require a source column
    if (!sourceCol) {
      setPreviews([]);
      setPreviewError(null);
      return;
    }
    const expr = buildExpression(opType, sourceCol, param1, param2);
    if (!expr) {
      setPreviews([]);
      setPreviewError(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const sql = `SELECT DISTINCT CAST("${sourceCol}" AS VARCHAR) AS "original", CAST(${expr} AS VARCHAR) AS "result" FROM "${activeTable}" WHERE "${sourceCol}" IS NOT NULL LIMIT 3`;
        const rows = await window.api.query(sql);
        setPreviews(rows.map((r: any) => ({ original: String(r.original ?? ""), result: String(r.result ?? "") })));
        setPreviewError(null);
      } catch (e: any) {
        setPreviews([]);
        setPreviewError(e.message || "Preview failed");
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [isOpen, activeTable, sourceCol, opType, param1, param2, combineSourceCols]);

  const resetForm = () => {
    setSourceCol("");
    setTargetCol("");
    setParam1("");
    setParam2("");
    setCombineSourceCols([]);
    setCombineSearch("");
    setOpType("regex_extract");
    setPreviews([]);
    setPreviewError(null);
  };

  const handleApply = () => {
    if (!activeTable) return;

    let finalSql: string;

    if (opType === "rename_column") {
      if (!sourceCol || !targetCol) return;
      finalSql = `ALTER TABLE "${activeTable}" RENAME COLUMN "${sourceCol}" TO "${targetCol}"`;
    } else if (opType === "delete_column") {
      if (!sourceCol || schema.length <= 1) return;
      const otherCols = schema
        .filter((c) => c.column_name !== sourceCol)
        .map((c) => `"${c.column_name}"`)
        .join(", ");
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${otherCols} FROM "${activeTable}"`;
    } else if (opType === "create_column") {
      if (!targetCol) return;
      const valueExpr = param1 || "NULL";
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${valueExpr} AS "${targetCol}" FROM "${activeTable}"`;
    } else if (opType === "combine_columns") {
      if (combineSourceCols.length < 2 || !targetCol) return;
      const concatExpr = buildCombineExpression(combineSourceCols, param1);
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${concatExpr} AS "${targetCol}" FROM "${activeTable}"`;
    } else {
      if (!sourceCol) return;
      const target = targetCol || sourceCol;
      const expr = buildExpression(opType, sourceCol, param1, param2);
      if (!expr) return;

      if (target === sourceCol) {
        const otherCols = schema
          .filter((c) => c.column_name !== sourceCol)
          .map((c) => `"${c.column_name}"`)
          .join(", ");
        finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${otherCols}, ${expr} AS "${sourceCol}" FROM "${activeTable}"`;
      } else {
        finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${expr} AS "${target}" FROM "${activeTable}"`;
      }
    }

    onApply(finalSql);
    onClose();
    resetForm();
  };

  const handleClose = () => {
    onClose();
    resetForm();
  };

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title="Data Operations"
    >
      <DialogBody>
        <div className="column-op-form">
          <FormGroup label="Operation">
            <HTMLSelect
              value={opType}
              onChange={(e) => setOpType(e.target.value as OpType)}
              fill
            >
              {Object.entries(OP_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </HTMLSelect>
          </FormGroup>

          {/* Source Column — shown for all ops except create_column and combine_columns */}
          {opType !== "create_column" && opType !== "combine_columns" && (
            <FormGroup label="Source Column">
              <HTMLSelect
                value={sourceCol}
                onChange={(e) => setSourceCol(e.target.value)}
                fill
              >
                <option value="">Select column...</option>
                {schema.map((col) => (
                  <option key={col.column_name} value={col.column_name}>
                    {col.column_name} ({col.column_type})
                  </option>
                ))}
              </HTMLSelect>
            </FormGroup>
          )}

          {/* Target Column — shown for all ops except delete_column */}
          {opType !== "delete_column" && (
            <FormGroup
              label={opType === "create_column" || opType === "combine_columns" ? "New Column Name" : opType === "rename_column" ? "New Name" : "Target Column Name"}
              helperText={opType === "create_column" || opType === "combine_columns" || opType === "rename_column" ? undefined : "Leave blank to replace the source column"}
            >
              <InputGroup
                value={targetCol}
                onChange={(e) => setTargetCol(e.target.value)}
                placeholder={opType === "create_column" || opType === "combine_columns" ? "new_column" : (sourceCol || "new_column")}
              />
            </FormGroup>
          )}

          {/* delete_column: warning */}
          {opType === "delete_column" && sourceCol && (
            <div className="bp4-callout bp4-intent-warning" style={{ marginBottom: 10 }}>
              <p style={{ margin: 0 }}>
                This will permanently remove the column <strong>{sourceCol}</strong> from the table.
                {schema.length <= 1 && " Cannot delete the only column."}
              </p>
            </div>
          )}

          {/* create_column: value input */}
          {opType === "create_column" && (
            <FormGroup
              label="Value"
              helperText={`Leave empty for NULL. Or enter a value (e.g. 0, 'unknown') or SQL expression (e.g. "price" * 1.1)`}
            >
              <InputGroup
                value={param1}
                onChange={(e) => setParam1(e.target.value)}
                placeholder="0"
              />
            </FormGroup>
          )}

          {/* combine_columns: multi-column selector */}
          {opType === "combine_columns" && (
            <>
              <FormGroup label="Columns to Combine" helperText="Select 2 or more columns. They will be concatenated in the order selected.">
                <div className="combine-col-list">
                  <div className="combine-col-search">
                    <InputGroup
                      leftIcon="search"
                      placeholder="Search columns..."
                      value={combineSearch}
                      onChange={(e) => setCombineSearch(e.target.value)}
                      small
                    />
                  </div>
                  <div className="combine-col-items">
                    {schema
                      .filter((col) => col.column_name.toLowerCase().includes(combineSearch.toLowerCase()))
                      .map((col) => {
                        const isSelected = combineSourceCols.includes(col.column_name);
                        const orderIndex = combineSourceCols.indexOf(col.column_name);
                        return (
                          <div key={col.column_name} className={`combine-col-item${isSelected ? " selected" : ""}`}>
                            <Checkbox
                              checked={isSelected}
                              onChange={() => {
                                if (isSelected) {
                                  setCombineSourceCols((prev) => prev.filter((c) => c !== col.column_name));
                                } else {
                                  setCombineSourceCols((prev) => [...prev, col.column_name]);
                                }
                              }}
                              style={{ marginBottom: 0 }}
                            />
                            <span className="combine-col-name">{col.column_name}</span>
                            <span className="column-type">{col.column_type}</span>
                            <span className={`combine-order-badge${isSelected ? " visible" : ""}`}>
                              {isSelected ? orderIndex + 1 : ""}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </FormGroup>
              <FormGroup label="Separator" helperText="String to insert between column values (can be empty)">
                <InputGroup
                  value={param1}
                  onChange={(e) => setParam1(e.target.value)}
                  placeholder=" "
                />
              </FormGroup>
            </>
          )}

          {opType === "regex_extract" && (
            <>
              <FormGroup label="Pattern (regex)" helperText="Use a capture group, e.g. ([0-9]+)">
                <InputGroup
                  value={param1}
                  onChange={(e) => setParam1(e.target.value)}
                  placeholder="([0-9]+\.?[0-9]*)"
                />
              </FormGroup>
              <FormGroup label="Capture Group Index" helperText="Which group to extract (default: 1)">
                <InputGroup
                  value={param2}
                  onChange={(e) => setParam2(e.target.value)}
                  placeholder="1"
                />
              </FormGroup>
            </>
          )}

          {opType === "replace_regex" && (
            <>
              <FormGroup label="Pattern (regex)">
                <InputGroup
                  value={param1}
                  onChange={(e) => setParam1(e.target.value)}
                  placeholder="[^0-9]"
                />
              </FormGroup>
              <FormGroup label="Replacement">
                <InputGroup
                  value={param2}
                  onChange={(e) => setParam2(e.target.value)}
                  placeholder=""
                />
              </FormGroup>
            </>
          )}

          {opType === "substring" && (
            <>
              <FormGroup label="Start Position">
                <InputGroup
                  value={param1}
                  onChange={(e) => setParam1(e.target.value)}
                  placeholder="1"
                />
              </FormGroup>
              <FormGroup label="Length">
                <InputGroup
                  value={param2}
                  onChange={(e) => setParam2(e.target.value)}
                  placeholder="10"
                />
              </FormGroup>
            </>
          )}

          {opType === "custom_sql" && (
            <FormGroup
              label="SQL Expression"
              helperText='Use column names in double quotes, e.g. "price" * 1.1'
            >
              <InputGroup
                value={param1}
                onChange={(e) => setParam1(e.target.value)}
                placeholder='"price" * 1.1'
              />
            </FormGroup>
          )}

          {/* Preview — shown for operations that produce a result */}
          {opType !== "delete_column" && opType !== "create_column" && opType !== "rename_column" && (previews.length > 0 || previewError) && (
            <div className="op-preview">
              <div className="op-preview-header">Preview</div>
              {previewError ? (
                <div className="op-preview-error">{previewError}</div>
              ) : (
                <table className="op-preview-table">
                  <thead>
                    <tr>
                      {opType !== "combine_columns" && <th>Original</th>}
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previews.map((p, i) => (
                      <tr key={i}>
                        {opType !== "combine_columns" && <td>{p.original}</td>}
                        <td>{p.result}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button onClick={handleClose} text="Cancel" />
            <Button
              intent={opType === "delete_column" ? Intent.DANGER : Intent.PRIMARY}
              onClick={handleApply}
              text={opType === "delete_column" ? "Delete" : "Apply"}
              disabled={
                opType === "delete_column"
                  ? !sourceCol || schema.length <= 1
                  : opType === "create_column"
                  ? !targetCol
                  : opType === "combine_columns"
                  ? combineSourceCols.length < 2 || !targetCol
                  : opType === "rename_column"
                  ? !sourceCol || !targetCol
                  : !sourceCol
              }
            />
          </>
        }
      />
    </Dialog>
  );
}
