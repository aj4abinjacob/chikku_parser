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
  RadioGroup,
  Radio,
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
  | "rename_column"
  | "sample_table"
  | "remove_duplicates"
  | "conditional_column"
  | "replace_empty_null"
  | "replace_sentinel_null";

interface CaseCondition {
  column: string;
  operator: string;
  value: string;
  result: string;
}

const CASE_OPERATORS = ["=", "!=", ">", "<", ">=", "<=", "LIKE", "NOT LIKE", "IS NULL", "IS NOT NULL", "CONTAINS", "STARTS WITH", "ENDS WITH"];

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
  sample_table: "Sample Table",
  remove_duplicates: "Remove Duplicates",
  conditional_column: "Conditional Column (IF/CASE)",
  replace_empty_null: "Replace Empty with NULL",
  replace_sentinel_null: "Replace None/NaN with NULL",
};

interface DataOperationsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeTable: string | null;
  schema: ColumnInfo[];
  onApply: (sql: string) => void;
  onSampleTable: (n: number, isPercent: boolean) => void;
}

export function DataOperationsDialog({
  isOpen,
  onClose,
  activeTable,
  schema,
  onApply,
  onSampleTable,
}: DataOperationsDialogProps): React.ReactElement {
  const [opType, setOpType] = useState<OpType>("regex_extract");
  const [sourceCol, setSourceCol] = useState("");
  const [targetCol, setTargetCol] = useState("");
  const [param1, setParam1] = useState("");
  const [param2, setParam2] = useState("");
  const [combineSourceCols, setCombineSourceCols] = useState<string[]>([]);
  const [combineSearch, setCombineSearch] = useState("");
  const [renameRows, setRenameRows] = useState<Array<{ sourceCol: string; newName: string }>>([{ sourceCol: "", newName: "" }]);
  const [deleteColumns, setDeleteColumns] = useState<string[]>([]);
  const [dedupColumns, setDedupColumns] = useState<string[]>([]);
  const [dedupSearch, setDedupSearch] = useState("");
  const [emptyNullColumns, setEmptyNullColumns] = useState<string[]>([]);
  const [emptyNullSearch, setEmptyNullSearch] = useState("");
  const [sentinelNullColumns, setSentinelNullColumns] = useState<string[]>([]);
  const [sentinelNullSearch, setSentinelNullSearch] = useState("");
  const [sampleMode, setSampleMode] = useState<"rows" | "percent">("rows");
  const [caseConditions, setCaseConditions] = useState<CaseCondition[]>([{ column: "", operator: "=", value: "", result: "" }]);
  const [caseDefault, setCaseDefault] = useState("");
  const [previews, setPreviews] = useState<Array<{ original: string; result: string }>>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [dedupPreview, setDedupPreview] = useState<{ before: number; after: number } | null>(null);

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
      case "conditional_column":
        return null; // handled separately
      case "replace_empty_null":
        return null; // handled separately
      case "replace_sentinel_null":
        return null; // handled separately
      default:
        return null;
    }
  };

  const buildCaseExpression = (conditions: CaseCondition[], defaultValue: string): string | null => {
    const validConditions = conditions.filter((c) => c.column && c.operator && c.result);
    if (validConditions.length === 0) return null;
    const whens = validConditions.map((c) => {
      const colRef = `"${c.column}"`;
      let whenClause: string;
      switch (c.operator) {
        case "IS NULL":
          whenClause = `${colRef} IS NULL`;
          break;
        case "IS NOT NULL":
          whenClause = `${colRef} IS NOT NULL`;
          break;
        case "CONTAINS":
          whenClause = `regexp_matches(CAST(${colRef} AS VARCHAR), '${c.value.replace(/'/g, "''")}', 'i')`;
          break;
        case "LIKE":
        case "NOT LIKE":
          whenClause = `CAST(${colRef} AS VARCHAR) ${c.operator} '${c.value.replace(/'/g, "''")}'`;
          break;
        case "STARTS WITH":
          whenClause = `CAST(${colRef} AS VARCHAR) LIKE '${c.value.replace(/'/g, "''")}%'`;
          break;
        case "ENDS WITH":
          whenClause = `CAST(${colRef} AS VARCHAR) LIKE '%${c.value.replace(/'/g, "''")}'`;
          break;
        default:
          whenClause = `${colRef} ${c.operator} '${c.value.replace(/'/g, "''")}'`;
          break;
      }
      return `WHEN ${whenClause} THEN '${c.result.replace(/'/g, "''")}'`;
    });
    const elseClause = defaultValue ? `ELSE '${defaultValue.replace(/'/g, "''")}'` : "ELSE NULL";
    return `CASE ${whens.join(" ")} ${elseClause} END`;
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

    // delete_column, create_column, rename_column, sample_table, replace_empty_null, replace_sentinel_null: no standard preview needed
    if (opType === "delete_column" || opType === "create_column" || opType === "rename_column" || opType === "sample_table" || opType === "replace_empty_null" || opType === "replace_sentinel_null") {
      setPreviews([]);
      setPreviewError(null);
      return;
    }

    // remove_duplicates: show row count before/after
    if (opType === "remove_duplicates") {
      setPreviews([]);
      setPreviewError(null);
      if (dedupColumns.length === 0) {
        setDedupPreview(null);
        return;
      }
      const timer = setTimeout(async () => {
        try {
          // Build NULLIF for varchar columns in PARTITION BY
          const partitionCols = dedupColumns.map((col) => {
            const colType = colTypeMap.get(col) || "";
            const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(colType);
            return isVarchar ? `NULLIF("${col}", '')` : `"${col}"`;
          }).join(", ");
          const beforeSql = `SELECT COUNT(*) AS cnt FROM "${activeTable}"`;
          const afterSql = `SELECT COUNT(*) AS cnt FROM (SELECT *, row_number() OVER (PARTITION BY ${partitionCols}) AS _rn FROM "${activeTable}") WHERE _rn = 1`;
          const [beforeResult, afterResult] = await Promise.all([
            window.api.query(beforeSql),
            window.api.query(afterSql),
          ]);
          setDedupPreview({
            before: Number(beforeResult[0].cnt),
            after: Number(afterResult[0].cnt),
          });
          setPreviewError(null);
        } catch (e: any) {
          setDedupPreview(null);
          setPreviewError(e.message || "Preview failed");
        }
      }, 300);
      return () => clearTimeout(timer);
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

    // conditional_column: preview the CASE expression
    if (opType === "conditional_column") {
      const caseExpr = buildCaseExpression(caseConditions, caseDefault);
      if (!caseExpr) {
        setPreviews([]);
        setPreviewError(null);
        return;
      }
      const timer = setTimeout(async () => {
        try {
          const sql = `SELECT CAST(${caseExpr} AS VARCHAR) AS "result" FROM "${activeTable}" LIMIT 5`;
          const rows = await window.api.query(sql);
          setPreviews(rows.map((r: any) => ({ original: "", result: String(r.result ?? "NULL") })));
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
  }, [isOpen, activeTable, sourceCol, opType, param1, param2, combineSourceCols, dedupColumns, caseConditions, caseDefault]);

  const resetForm = () => {
    setSourceCol("");
    setTargetCol("");
    setParam1("");
    setParam2("");
    setCombineSourceCols([]);
    setCombineSearch("");
    setRenameRows([{ sourceCol: "", newName: "" }]);
    setDeleteColumns([]);
    setDedupColumns([]);
    setDedupSearch("");
    setEmptyNullColumns([]);
    setEmptyNullSearch("");
    setSentinelNullColumns([]);
    setSentinelNullSearch("");
    setSampleMode("rows");
    setCaseConditions([{ column: "", operator: "=", value: "", result: "" }]);
    setCaseDefault("");
    setOpType("regex_extract");
    setPreviews([]);
    setPreviewError(null);
    setDedupPreview(null);
  };

  const handleApply = () => {
    if (!activeTable) return;

    // sample_table: delegate to onSampleTable callback
    if (opType === "sample_table") {
      const n = Number(param1);
      if (!n || n <= 0) return;
      if (sampleMode === "percent" && n > 100) return;
      onSampleTable(n, sampleMode === "percent");
      onClose();
      resetForm();
      return;
    }

    // remove_duplicates: build dedup SQL
    if (opType === "remove_duplicates") {
      if (dedupColumns.length === 0) return;
      // CTE that converts empty strings to NULL for all VARCHAR columns
      const cleanedCols = schema.map((col) => {
        const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(col.column_type);
        return isVarchar
          ? `NULLIF("${col.column_name}", '') AS "${col.column_name}"`
          : `"${col.column_name}"`;
      }).join(", ");
      // PARTITION BY with NULLIF on varchar dedup columns
      const partitionCols = dedupColumns.map((col) => {
        const colType = colTypeMap.get(col) || "";
        const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(colType);
        return isVarchar ? `NULLIF("${col}", '')` : `"${col}"`;
      }).join(", ");
      const finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS WITH cleaned AS (SELECT ${cleanedCols} FROM "${activeTable}") SELECT * FROM cleaned QUALIFY row_number() OVER (PARTITION BY ${partitionCols}) = 1`;
      onApply(finalSql);
      onClose();
      resetForm();
      return;
    }

    // replace_empty_null: replace empty/whitespace-only strings with NULL
    if (opType === "replace_empty_null") {
      const targetCols = emptyNullColumns.length > 0
        ? emptyNullColumns
        : schema.map((c) => c.column_name);
      const targetSet = new Set(targetCols);
      const cols = schema.map((col) => {
        if (!targetSet.has(col.column_name)) {
          return `"${col.column_name}"`;
        }
        const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(col.column_type);
        if (isVarchar) {
          return `CASE WHEN TRIM("${col.column_name}") = '' THEN NULL ELSE "${col.column_name}" END AS "${col.column_name}"`;
        }
        return `"${col.column_name}"`;
      }).join(", ");
      const finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${cols} FROM "${activeTable}"`;
      onApply(finalSql);
      onClose();
      resetForm();
      return;
    }

    // replace_sentinel_null: replace None, NaN, NULL, N/A etc. with actual NULL
    if (opType === "replace_sentinel_null") {
      const targetCols = sentinelNullColumns.length > 0
        ? sentinelNullColumns
        : schema.map((c) => c.column_name);
      const targetSet = new Set(targetCols);
      const sentinelValues = "('None', 'none', 'NONE', 'NaN', 'Nan', 'nan', 'NULL', 'null', 'Null', 'N/A', 'n/a', 'NA', 'na', '#N/A', '#NA', '#n/a')";
      const cols = schema.map((col) => {
        if (!targetSet.has(col.column_name)) {
          return `"${col.column_name}"`;
        }
        const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(col.column_type);
        if (isVarchar) {
          return `CASE WHEN TRIM("${col.column_name}") IN ${sentinelValues} THEN NULL ELSE "${col.column_name}" END AS "${col.column_name}"`;
        }
        return `"${col.column_name}"`;
      }).join(", ");
      const finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${cols} FROM "${activeTable}"`;
      onApply(finalSql);
      onClose();
      resetForm();
      return;
    }

    let finalSql: string;

    if (opType === "rename_column") {
      const validRows = renameRows.filter((r) => r.sourceCol && r.newName.trim());
      if (validRows.length === 0) return;
      const renameMap = new Map(validRows.map((r) => [r.sourceCol, r.newName.trim()]));
      const cols = schema
        .map((c) => {
          const newName = renameMap.get(c.column_name);
          return newName ? `"${c.column_name}" AS "${newName}"` : `"${c.column_name}"`;
        })
        .join(", ");
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${cols} FROM "${activeTable}"`;
    } else if (opType === "delete_column") {
      if (deleteColumns.length === 0 || deleteColumns.length >= schema.length) return;
      const otherCols = schema
        .filter((c) => !deleteColumns.includes(c.column_name))
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
    } else if (opType === "conditional_column") {
      if (!targetCol) return;
      const caseExpr = buildCaseExpression(caseConditions, caseDefault);
      if (!caseExpr) return;
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${caseExpr} AS "${targetCol}" FROM "${activeTable}"`;
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

          {/* Source Column — hidden for create_column, combine_columns, rename_column, delete_column, sample_table, remove_duplicates, conditional_column, replace_empty_null, replace_sentinel_null */}
          {opType !== "create_column" && opType !== "combine_columns" && opType !== "rename_column" && opType !== "delete_column" && opType !== "sample_table" && opType !== "remove_duplicates" && opType !== "conditional_column" && opType !== "replace_empty_null" && opType !== "replace_sentinel_null" && (
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

          {/* Target Column — hidden for delete_column, rename_column, sample_table, remove_duplicates, replace_empty_null, replace_sentinel_null */}
          {opType !== "delete_column" && opType !== "rename_column" && opType !== "sample_table" && opType !== "remove_duplicates" && opType !== "replace_empty_null" && opType !== "replace_sentinel_null" && (
            <FormGroup
              label={opType === "create_column" || opType === "combine_columns" || opType === "conditional_column" ? "New Column Name" : "Target Column Name"}
              helperText={opType === "create_column" || opType === "combine_columns" || opType === "conditional_column" ? undefined : "Leave blank to replace the source column"}
            >
              <InputGroup
                value={targetCol}
                onChange={(e) => setTargetCol(e.target.value)}
                placeholder={opType === "create_column" || opType === "combine_columns" || opType === "conditional_column" ? "new_column" : (sourceCol || "new_column")}
              />
            </FormGroup>
          )}

          {/* delete_column: multi-select */}
          {opType === "delete_column" && (
            <>
              <FormGroup label="Columns to Delete" helperText="Select one or more columns to remove.">
                <div className="combine-col-list">
                  <div className="combine-col-items">
                    {schema.map((col) => {
                      const isSelected = deleteColumns.includes(col.column_name);
                      return (
                        <div key={col.column_name} className={`combine-col-item${isSelected ? " selected" : ""}`}>
                          <Checkbox
                            checked={isSelected}
                            onChange={() => {
                              if (isSelected) {
                                setDeleteColumns((prev) => prev.filter((c) => c !== col.column_name));
                              } else {
                                setDeleteColumns((prev) => [...prev, col.column_name]);
                              }
                            }}
                            style={{ marginBottom: 0 }}
                          />
                          <span className="combine-col-name">{col.column_name}</span>
                          <span className="column-type">{col.column_type}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </FormGroup>
              {deleteColumns.length > 0 && (
                <div className="bp4-callout bp4-intent-warning" style={{ marginBottom: 10 }}>
                  <p style={{ margin: 0 }}>
                    This will permanently remove {deleteColumns.length} column{deleteColumns.length > 1 ? "s" : ""} from the table.
                    {deleteColumns.length >= schema.length && " Cannot delete all columns — at least one must remain."}
                  </p>
                </div>
              )}
            </>
          )}

          {/* rename_column: multi-row rename */}
          {opType === "rename_column" && (
            <FormGroup label="Columns to Rename" helperText="Select columns and provide new names.">
              <div className="rename-col-list">
                <div className="rename-col-items">
                  {renameRows.map((row, idx) => {
                    const usedCols = renameRows.filter((_, i) => i !== idx).map((r) => r.sourceCol).filter(Boolean);
                    const availableCols = schema.filter((c) => !usedCols.includes(c.column_name));
                    return (
                      <div key={idx} className="rename-col-row">
                        <HTMLSelect
                          value={row.sourceCol}
                          onChange={(e) => {
                            setRenameRows((prev) => prev.map((r, i) => (i === idx ? { ...r, sourceCol: e.target.value } : r)));
                          }}
                          fill
                        >
                          <option value="">Select column...</option>
                          {availableCols.map((col) => (
                            <option key={col.column_name} value={col.column_name}>
                              {col.column_name}
                            </option>
                          ))}
                        </HTMLSelect>
                        <span className="rename-arrow">&rarr;</span>
                        <InputGroup
                          value={row.newName}
                          onChange={(e) => {
                            setRenameRows((prev) => prev.map((r, i) => (i === idx ? { ...r, newName: e.target.value } : r)));
                          }}
                          placeholder="New name"
                          fill
                        />
                        {renameRows.length > 1 && (
                          <Button
                            icon="cross"
                            minimal
                            small
                            onClick={() => setRenameRows((prev) => prev.filter((_, i) => i !== idx))}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
                {renameRows.length < schema.length && (
                  <Button
                    icon="plus"
                    text="Add"
                    small
                    minimal
                    onClick={() => setRenameRows((prev) => [...prev, { sourceCol: "", newName: "" }])}
                    style={{ marginTop: 4 }}
                  />
                )}
              </div>
            </FormGroup>
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

          {/* sample_table: sample mode + size */}
          {opType === "sample_table" && (
            <>
              <FormGroup label="Sample Mode">
                <RadioGroup
                  selectedValue={sampleMode}
                  onChange={(e) => setSampleMode((e.target as HTMLInputElement).value as "rows" | "percent")}
                  inline
                >
                  <Radio label="Number of rows" value="rows" />
                  <Radio label="Percentage" value="percent" />
                </RadioGroup>
              </FormGroup>
              <FormGroup
                label={sampleMode === "rows" ? "Number of Rows" : "Percentage (0-100)"}
                helperText={sampleMode === "rows" ? "How many rows to sample" : "What percentage of rows to sample"}
              >
                <InputGroup
                  value={param1}
                  onChange={(e) => setParam1(e.target.value)}
                  placeholder={sampleMode === "rows" ? "100" : "10"}
                  type="number"
                />
              </FormGroup>
            </>
          )}

          {/* remove_duplicates: multi-select columns for dedup */}
          {opType === "remove_duplicates" && (
            <>
              <FormGroup label="Deduplicate by Columns" helperText="Select columns to check for duplicates. Rows with identical values in these columns will be deduplicated.">
                <div className="combine-col-list">
                  <div className="combine-col-search" style={{ display: "flex", gap: 4 }}>
                    <InputGroup
                      leftIcon="search"
                      placeholder="Search columns..."
                      value={dedupSearch}
                      onChange={(e) => setDedupSearch(e.target.value)}
                      small
                      style={{ flex: 1 }}
                    />
                    <Button
                      small
                      minimal
                      text={dedupColumns.length === schema.length ? "Deselect All" : "Select All"}
                      onClick={() => {
                        if (dedupColumns.length === schema.length) {
                          setDedupColumns([]);
                        } else {
                          setDedupColumns(schema.map((c) => c.column_name));
                        }
                      }}
                    />
                  </div>
                  <div className="combine-col-items">
                    {schema
                      .filter((col) => col.column_name.toLowerCase().includes(dedupSearch.toLowerCase()))
                      .map((col) => {
                        const isSelected = dedupColumns.includes(col.column_name);
                        return (
                          <div key={col.column_name} className={`combine-col-item${isSelected ? " selected" : ""}`}>
                            <Checkbox
                              checked={isSelected}
                              onChange={() => {
                                if (isSelected) {
                                  setDedupColumns((prev) => prev.filter((c) => c !== col.column_name));
                                } else {
                                  setDedupColumns((prev) => [...prev, col.column_name]);
                                }
                              }}
                              style={{ marginBottom: 0 }}
                            />
                            <span className="combine-col-name">{col.column_name}</span>
                            <span className="column-type">{col.column_type}</span>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </FormGroup>
              {dedupPreview && (
                <div className="bp4-callout bp4-intent-primary" style={{ marginBottom: 10 }}>
                  <p style={{ margin: 0 }}>
                    {dedupPreview.before.toLocaleString()} rows → {dedupPreview.after.toLocaleString()} rows ({(dedupPreview.before - dedupPreview.after).toLocaleString()} duplicate{dedupPreview.before - dedupPreview.after !== 1 ? "s" : ""} will be removed)
                  </p>
                </div>
              )}
            </>
          )}

          {/* replace_empty_null: column selector */}
          {opType === "replace_empty_null" && (
            <>
              <FormGroup
                label="Columns"
                helperText="Select columns to clean, or leave empty to apply to all VARCHAR columns. Replaces empty and whitespace-only strings with actual NULL."
              >
                <div className="combine-col-list">
                  <div className="combine-col-search" style={{ display: "flex", gap: 4 }}>
                    <InputGroup
                      leftIcon="search"
                      placeholder="Search columns..."
                      value={emptyNullSearch}
                      onChange={(e) => setEmptyNullSearch(e.target.value)}
                      small
                      style={{ flex: 1 }}
                    />
                    <Button
                      small
                      minimal
                      text={emptyNullColumns.length === schema.length ? "Deselect All" : "Select All"}
                      onClick={() => {
                        if (emptyNullColumns.length === schema.length) {
                          setEmptyNullColumns([]);
                        } else {
                          setEmptyNullColumns(schema.map((c) => c.column_name));
                        }
                      }}
                    />
                  </div>
                  <div className="combine-col-items">
                    {schema
                      .filter((col) => col.column_name.toLowerCase().includes(emptyNullSearch.toLowerCase()))
                      .map((col) => {
                        const isSelected = emptyNullColumns.includes(col.column_name);
                        const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(col.column_type);
                        return (
                          <div key={col.column_name} className={`combine-col-item${isSelected ? " selected" : ""}${!isVarchar ? " non-varchar" : ""}`}>
                            <Checkbox
                              checked={isSelected}
                              onChange={() => {
                                if (isSelected) {
                                  setEmptyNullColumns((prev) => prev.filter((c) => c !== col.column_name));
                                } else {
                                  setEmptyNullColumns((prev) => [...prev, col.column_name]);
                                }
                              }}
                              style={{ marginBottom: 0 }}
                            />
                            <span className="combine-col-name">{col.column_name}</span>
                            <span className="column-type">{col.column_type}</span>
                            {!isVarchar && <span style={{ fontSize: 10, color: "#8a9ba8", fontStyle: "italic" }}>(skipped)</span>}
                          </div>
                        );
                      })}
                  </div>
                </div>
              </FormGroup>
            </>
          )}

          {/* replace_sentinel_null: column selector */}
          {opType === "replace_sentinel_null" && (
            <>
              <FormGroup
                label="Columns"
                helperText="Select columns to clean, or leave empty to apply to all VARCHAR columns. Replaces None, NaN, NULL, N/A, #N/A, etc. with actual NULL."
              >
                <div className="combine-col-list">
                  <div className="combine-col-search" style={{ display: "flex", gap: 4 }}>
                    <InputGroup
                      leftIcon="search"
                      placeholder="Search columns..."
                      value={sentinelNullSearch}
                      onChange={(e) => setSentinelNullSearch(e.target.value)}
                      small
                      style={{ flex: 1 }}
                    />
                    <Button
                      small
                      minimal
                      text={sentinelNullColumns.length === schema.length ? "Deselect All" : "Select All"}
                      onClick={() => {
                        if (sentinelNullColumns.length === schema.length) {
                          setSentinelNullColumns([]);
                        } else {
                          setSentinelNullColumns(schema.map((c) => c.column_name));
                        }
                      }}
                    />
                  </div>
                  <div className="combine-col-items">
                    {schema
                      .filter((col) => col.column_name.toLowerCase().includes(sentinelNullSearch.toLowerCase()))
                      .map((col) => {
                        const isSelected = sentinelNullColumns.includes(col.column_name);
                        const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(col.column_type);
                        return (
                          <div key={col.column_name} className={`combine-col-item${isSelected ? " selected" : ""}${!isVarchar ? " non-varchar" : ""}`}>
                            <Checkbox
                              checked={isSelected}
                              onChange={() => {
                                if (isSelected) {
                                  setSentinelNullColumns((prev) => prev.filter((c) => c !== col.column_name));
                                } else {
                                  setSentinelNullColumns((prev) => [...prev, col.column_name]);
                                }
                              }}
                              style={{ marginBottom: 0 }}
                            />
                            <span className="combine-col-name">{col.column_name}</span>
                            <span className="column-type">{col.column_type}</span>
                            {!isVarchar && <span style={{ fontSize: 10, color: "#8a9ba8", fontStyle: "italic" }}>(skipped)</span>}
                          </div>
                        );
                      })}
                  </div>
                </div>
              </FormGroup>
            </>
          )}

          {/* conditional_column: condition builder */}
          {opType === "conditional_column" && (
            <>
              <FormGroup label="Conditions" helperText="Each condition is evaluated in order. The first match determines the result.">
                <div className="case-condition-list">
                  {caseConditions.map((cond, idx) => (
                    <div key={idx} className="case-condition-row">
                      <span className="case-condition-label">IF</span>
                      <HTMLSelect
                        value={cond.column}
                        onChange={(e) => {
                          setCaseConditions((prev) => prev.map((c, i) => i === idx ? { ...c, column: e.target.value } : c));
                        }}
                        className="case-condition-col"
                      >
                        <option value="">Column...</option>
                        {schema.map((col) => (
                          <option key={col.column_name} value={col.column_name}>
                            {col.column_name}
                          </option>
                        ))}
                      </HTMLSelect>
                      <HTMLSelect
                        value={cond.operator}
                        onChange={(e) => {
                          setCaseConditions((prev) => prev.map((c, i) => i === idx ? { ...c, operator: e.target.value } : c));
                        }}
                        className="case-condition-op"
                      >
                        {CASE_OPERATORS.map((op) => (
                          <option key={op} value={op}>{op}</option>
                        ))}
                      </HTMLSelect>
                      {cond.operator !== "IS NULL" && cond.operator !== "IS NOT NULL" && (
                        <InputGroup
                          value={cond.value}
                          onChange={(e) => {
                            setCaseConditions((prev) => prev.map((c, i) => i === idx ? { ...c, value: e.target.value } : c));
                          }}
                          placeholder="value"
                          className="case-condition-value"
                          small
                        />
                      )}
                      <span className="case-condition-then">THEN</span>
                      <InputGroup
                        value={cond.result}
                        onChange={(e) => {
                          setCaseConditions((prev) => prev.map((c, i) => i === idx ? { ...c, result: e.target.value } : c));
                        }}
                        placeholder="result"
                        className="case-condition-result"
                        small
                      />
                      {caseConditions.length > 1 && (
                        <Button
                          icon="cross"
                          minimal
                          small
                          onClick={() => setCaseConditions((prev) => prev.filter((_, i) => i !== idx))}
                        />
                      )}
                    </div>
                  ))}
                  <Button
                    icon="plus"
                    text="Add Condition"
                    small
                    minimal
                    onClick={() => setCaseConditions((prev) => [...prev, { column: "", operator: "=", value: "", result: "" }])}
                    style={{ marginTop: 4 }}
                  />
                </div>
              </FormGroup>
              <FormGroup label="Default Value (ELSE)" helperText="Value when no condition matches. Leave empty for NULL.">
                <InputGroup
                  value={caseDefault}
                  onChange={(e) => setCaseDefault(e.target.value)}
                  placeholder="NULL"
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
          {opType !== "delete_column" && opType !== "create_column" && opType !== "rename_column" && opType !== "sample_table" && opType !== "remove_duplicates" && opType !== "replace_empty_null" && opType !== "replace_sentinel_null" && (previews.length > 0 || previewError) && (
            <div className="op-preview">
              <div className="op-preview-header">Preview</div>
              {previewError ? (
                <div className="op-preview-error">{previewError}</div>
              ) : (
                <table className="op-preview-table">
                  <thead>
                    <tr>
                      {opType !== "combine_columns" && opType !== "conditional_column" && <th>Original</th>}
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {previews.map((p, i) => (
                      <tr key={i}>
                        {opType !== "combine_columns" && opType !== "conditional_column" && <td>{p.original}</td>}
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
                  ? deleteColumns.length === 0 || deleteColumns.length >= schema.length
                  : opType === "create_column"
                  ? !targetCol
                  : opType === "combine_columns"
                  ? combineSourceCols.length < 2 || !targetCol
                  : opType === "rename_column"
                  ? renameRows.filter((r) => r.sourceCol && r.newName.trim()).length === 0
                  : opType === "sample_table"
                  ? !param1 || Number(param1) <= 0 || (sampleMode === "percent" && Number(param1) > 100)
                  : opType === "remove_duplicates"
                  ? dedupColumns.length === 0
                  : opType === "conditional_column"
                  ? !targetCol || caseConditions.filter((c) => c.column && c.operator && c.result).length === 0
                  : opType === "replace_empty_null" || opType === "replace_sentinel_null"
                  ? false
                  : !sourceCol
              }
            />
          </>
        }
      />
    </Dialog>
  );
}
