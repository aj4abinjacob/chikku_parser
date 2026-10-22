import React, { useState, useEffect, useRef } from "react";
import {
  Button,
  Callout,
  Intent,
  InputGroup,
  Dialog,
  DialogBody,
  DialogFooter,
  FormGroup,
  RadioGroup,
  Radio,
} from "@blueprintjs/core";
import { SoftSelect } from "./SoftSelect";
import { ColumnInfo, ColOpTargetMode } from "../types";
import {
  guardNumberInputDrop,
  guardNumberInputKeyDown,
  guardNumberInputPaste,
  isAllowedNumberInputValue,
  showNumberInputExpectation,
  stepNumberInputOnWheel,
} from "../utils/numberInputWheel";
import { SearchableColumnSelect } from "./SearchableColumnSelect";
import { ColumnCheckList, ColumnCheckItem } from "./ColumnCheckList";
import { AsyncActionGate, columnNameExists, errorMessage, suggestColumnName } from "../utils/operationUX";

type OpType =
  | "substring"
  | "custom_sql"
  | "create_column"
  | "delete_column"
  | "combine_columns"
  | "rename_column"
  | "sample_table"
  | "remove_duplicates"
  | "remove_empty_rows"
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
const CASE_TEXT_VALUE_OPERATORS = new Set(["LIKE", "NOT LIKE", "CONTAINS", "STARTS WITH", "ENDS WITH"]);

const OP_LABELS: Record<OpType, string> = {
  substring: "Substring",
  custom_sql: "Custom SQL Expression",
  create_column: "Create New Column",
  delete_column: "Delete Column",
  combine_columns: "Combine Columns",
  rename_column: "Rename Column",
  sample_table: "Sample Table",
  remove_duplicates: "Remove Duplicates",
  remove_empty_rows: "Remove Empty Rows",
  conditional_column: "Conditional Column (IF/CASE)",
  replace_empty_null: "Replace Empty with NULL",
  replace_sentinel_null: "Replace None/NaN with NULL",
};

interface DataOperationsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  activeTable: string | null;
  schema: ColumnInfo[];
  fileName: string;
  totalRows: number;
  filtersApplied: boolean;
  onApply: (sql: string, description?: string, columnRenames?: Record<string, string>) => Promise<void>;
  onSampleTable: (n: number, isPercent: boolean) => Promise<void>;
}

export function DataOperationsDialog({
  isOpen,
  onClose,
  activeTable,
  schema,
  fileName,
  totalRows,
  filtersApplied,
  onApply,
  onSampleTable,
}: DataOperationsDialogProps): React.ReactElement {
  const [opType, setOpType] = useState<OpType>("substring");
  const [sourceCol, setSourceCol] = useState("");
  const [targetCol, setTargetCol] = useState("");
  const [param1, setParam1] = useState("");
  const [param2, setParam2] = useState("");
  const [combineSourceCols, setCombineSourceCols] = useState<string[]>([]);
  const [renameRows, setRenameRows] = useState<Array<{ sourceCol: string; newName: string }>>([{ sourceCol: "", newName: "" }]);
  const [deleteColumns, setDeleteColumns] = useState<string[]>([]);
  const [dedupColumns, setDedupColumns] = useState<string[]>([]);
  const [emptyNullColumns, setEmptyNullColumns] = useState<string[]>([]);
  const [sentinelNullColumns, setSentinelNullColumns] = useState<string[]>([]);
  const [removeEmptyColumns, setRemoveEmptyColumns] = useState<string[]>([]);
  const [removeEmptyMode, setRemoveEmptyMode] = useState<"all" | "any">("any");
  const [removeEmptyPreview, setRemoveEmptyPreview] = useState<{ before: number; after: number } | null>(null);
  const [sampleMode, setSampleMode] = useState<"rows" | "percent">("rows");
  const [caseConditions, setCaseConditions] = useState<CaseCondition[]>([{ column: "", operator: "=", value: "", result: "" }]);
  const [caseDefault, setCaseDefault] = useState("");
  const [previews, setPreviews] = useState<Array<{ original: string; result: string }>>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [dedupPreview, setDedupPreview] = useState<{ before: number; after: number } | null>(null);
  const [targetMode, setTargetMode] = useState<ColOpTargetMode>("new_column");

  const actionGate = useRef(new AsyncActionGate());
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const columnNames = schema.map((column) => column.column_name);
  const newTargetInvalid = !targetCol.trim() || columnNameExists(columnNames, targetCol);
  const suggestedName = useRef<string | null>(null);
  const suggestionContext = useRef<string | null>(null);

  useEffect(() => {
    if (!isOpen) {
      suggestionContext.current = null;
      return;
    }
    const base = opType === "substring" ? `${sourceCol || "text"}_substring`
      : opType === "custom_sql" ? `${sourceCol || "value"}_transformed`
      : opType === "combine_columns" ? "combined"
      : opType === "conditional_column" ? "condition_result" : "new_column";
    const next = suggestColumnName(schema.map((column) => column.column_name), base);
    const context = JSON.stringify([activeTable, sourceCol, opType]);
    if (suggestionContext.current !== context) {
      setTargetCol(next);
      setTargetMode("new_column");
      suggestionContext.current = context;
    } else {
      const previous = suggestedName.current;
      setTargetCol((current) => current === previous ? next : current);
    }
    suggestedName.current = next;
  }, [isOpen, activeTable, sourceCol, opType, schema]);

  // Build a lookup map from schema for column types
  const colTypeMap = React.useMemo(() => {
    const map = new Map<string, string>();
    schema.forEach((col) => map.set(col.column_name, col.column_type));
    return map;
  }, [schema]);

  const schemaItems = React.useMemo<ColumnCheckItem[]>(
    () => schema.map((col) => ({ name: col.column_name, type: col.column_type })),
    [schema]
  );

  const sortedSchemaItems = React.useMemo<ColumnCheckItem[]>(
    () =>
      [...schema]
        .sort((a, b) => a.column_name.localeCompare(b.column_name, undefined, { sensitivity: "base" }))
        .map((col) => ({ name: col.column_name, type: col.column_type })),
    [schema]
  );

  const isVarcharType = React.useCallback(
    (type: string | undefined) => /^(VARCHAR|TEXT|STRING|CHAR)/i.test(type ?? ""),
    []
  );

  const isNumberType = React.useCallback(
    (type: string | undefined) => /(int|decimal|numeric|double|float|real|hugeint|bigint|smallint|tinyint|ubigint|uinteger|usmallint|utinyint)/i.test(type ?? ""),
    []
  );

  const buildExpression = (op: OpType, col: string, p1: string, p2: string): string | null => {
    // For string-based ops, cast to VARCHAR if the column isn't already a string type
    const colType = colTypeMap.get(col) || "";
    const isString = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(colType);
    const ref = isString ? `"${col}"` : `CAST("${col}" AS VARCHAR)`;

    switch (op) {
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
      case "remove_empty_rows":
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

    // remove_empty_rows: show row count before/after
    if (opType === "remove_empty_rows") {
      setPreviews([]);
      setPreviewError(null);
      const cols = removeEmptyColumns.length > 0
        ? removeEmptyColumns
        : schema.map((c) => c.column_name);
      const timer = setTimeout(async () => {
        try {
          const conditions = cols.map((colName) => {
            const colType = colTypeMap.get(colName) || "";
            const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(colType);
            const ident = `"${colName}"`;
            if (isVarchar) {
              return `(${ident} IS NULL OR TRIM(CAST(${ident} AS VARCHAR)) = '')`;
            }
            return `${ident} IS NULL`;
          });
          const joiner = removeEmptyMode === "any" ? " OR " : " AND ";
          const beforeSql = `SELECT COUNT(*) AS cnt FROM "${activeTable}"`;
          const afterSql = `SELECT COUNT(*) AS cnt FROM "${activeTable}" WHERE NOT (${conditions.join(joiner)})`;
          const [beforeResult, afterResult] = await Promise.all([
            window.api.query(beforeSql),
            window.api.query(afterSql),
          ]);
          setRemoveEmptyPreview({
            before: Number(beforeResult[0].cnt),
            after: Number(afterResult[0].cnt),
          });
          setPreviewError(null);
        } catch (e: any) {
          setRemoveEmptyPreview(null);
          setPreviewError(e.message || "Preview failed");
        }
      }, 300);
      return () => clearTimeout(timer);
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
  }, [isOpen, activeTable, sourceCol, opType, param1, param2, combineSourceCols, dedupColumns, removeEmptyColumns, removeEmptyMode, caseConditions, caseDefault]);

  const resetForm = () => {
    setSourceCol("");
    setTargetCol("");
    setParam1("");
    setParam2("");
    setCombineSourceCols([]);
    setRenameRows([{ sourceCol: "", newName: "" }]);
    setDeleteColumns([]);
    setDedupColumns([]);
    setRemoveEmptyColumns([]);
    setRemoveEmptyMode("any");
    setRemoveEmptyPreview(null);
    setEmptyNullColumns([]);
    setSentinelNullColumns([]);
    setSampleMode("rows");
    setCaseConditions([{ column: "", operator: "=", value: "", result: "" }]);
    setCaseDefault("");
    setOpType("substring");
    setPreviews([]);
    setPreviewError(null);
    setDedupPreview(null);
    setTargetMode("new_column");
    setApplyError(null);
  };

  const applyOperation = async () => {
    if (!activeTable) throw new Error("Select a file before applying an operation.");

    // sample_table: delegate to onSampleTable callback
    if (opType === "sample_table") {
      const n = Number(param1);
      if (!Number.isFinite(n) || n <= 0 || (sampleMode === "percent" && n > 100)) throw new Error("Enter a valid sample size.");
      await onSampleTable(n, sampleMode === "percent");
      return;
    }

    // remove_duplicates: build dedup SQL
    if (opType === "remove_duplicates") {
      if (dedupColumns.length === 0) throw new Error("Select key columns before removing duplicates.");
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
      await onApply(finalSql, `${OP_LABELS[opType]} on ${dedupColumns.map(c => `"${c}"`).join(", ")}`);
      return;
    }

    // remove_empty_rows: delete rows where all/any selected columns are empty
    if (opType === "remove_empty_rows") {
      const cols = removeEmptyColumns.length > 0
        ? removeEmptyColumns
        : schema.map((c) => c.column_name);
      const conditions = cols.map((colName) => {
        const colType = colTypeMap.get(colName) || "";
        const isVarchar = /^(VARCHAR|TEXT|STRING|CHAR)/i.test(colType);
        const ident = `"${colName}"`;
        if (isVarchar) {
          return `(${ident} IS NULL OR TRIM(CAST(${ident} AS VARCHAR)) = '')`;
        }
        return `${ident} IS NULL`;
      });
      const joiner = removeEmptyMode === "any" ? " OR " : " AND ";
      const whereClause = `WHERE NOT (${conditions.join(joiner)})`;
      const allCols = schema.map((c) => `"${c.column_name}"`).join(", ");
      const finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${allCols} FROM "${activeTable}" ${whereClause}`;
      const modeLabel = removeEmptyMode === "any" ? "any" : "all";
      await onApply(finalSql, `${OP_LABELS[opType]} [${modeLabel}] on ${cols.length} column(s)`);
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
      await onApply(finalSql, `${OP_LABELS[opType]} on ${targetCols.length} column(s)`);
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
      await onApply(finalSql, `${OP_LABELS[opType]} on ${targetCols.length} column(s)`);
      return;
    }

    let finalSql: string;
    let description: string | undefined;

    if (opType === "rename_column") {
      const validRows = renameRows.filter((r) => r.sourceCol && r.newName.trim());
      if (validRows.length === 0) throw new Error("Enter at least one new column name.");
      const renameMap = new Map(validRows.map((r) => [r.sourceCol, r.newName.trim()]));
      const cols = schema
        .map((c) => {
          const newName = renameMap.get(c.column_name);
          return newName ? `"${c.column_name}" AS "${newName}"` : `"${c.column_name}"`;
        })
        .join(", ");
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${cols} FROM "${activeTable}"`;
      description = `${OP_LABELS[opType]}: ${validRows.map(r => `"${r.sourceCol}" → "${r.newName.trim()}"`).join(", ")}`;
    } else if (opType === "delete_column") {
      if (deleteColumns.length === 0 || deleteColumns.length >= schema.length) throw new Error("Select columns to delete and leave at least one column.");
      const otherCols = schema
        .filter((c) => !deleteColumns.includes(c.column_name))
        .map((c) => `"${c.column_name}"`)
        .join(", ");
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${otherCols} FROM "${activeTable}"`;
      description = `${OP_LABELS[opType]}: ${deleteColumns.map(c => `"${c}"`).join(", ")}`;
    } else if (opType === "create_column") {
      if (newTargetInvalid) throw new Error("Enter a unique new column name.");
      const valueExpr = param1.trim() || "NULL";
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${valueExpr} AS "${targetCol.trim()}" FROM "${activeTable}"`;
      description = `${OP_LABELS[opType]} "${targetCol}"`;
    } else if (opType === "combine_columns") {
      if (combineSourceCols.length < 2 || newTargetInvalid) throw new Error("Select two source columns and enter a unique new column name.");
      const concatExpr = buildCombineExpression(combineSourceCols, param1);
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${concatExpr} AS "${targetCol.trim()}" FROM "${activeTable}"`;
      description = `${OP_LABELS[opType]} → "${targetCol}"`;
    } else if (opType === "conditional_column") {
      if (newTargetInvalid) throw new Error("Enter a unique new column name.");
      const caseExpr = buildCaseExpression(caseConditions, caseDefault);
      if (!caseExpr) throw new Error("Enter a complete condition and its result.");
      finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${caseExpr} AS "${targetCol.trim()}" FROM "${activeTable}"`;
      description = `${OP_LABELS[opType]} "${targetCol}"`;
    } else {
      if (!columnNames.includes(sourceCol)) throw new Error("Select an available source column.");
      const expr = buildExpression(opType, sourceCol, param1, param2);
      if (!expr?.trim()) throw new Error("Enter a SQL expression before applying.");

      // Only extract-type ops support target mode; others always replace source
      const hasTargetMode = opType === "substring" || opType === "custom_sql";
      const effectiveMode = hasTargetMode ? targetMode : "replace";
      const effectiveTarget = hasTargetMode ? targetCol.trim() : "";

      if (effectiveMode === "new_column") {
        if (newTargetInvalid) throw new Error("Enter a unique new column name.");
        finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT *, ${expr} AS "${effectiveTarget}" FROM "${activeTable}"`;
      } else if (effectiveMode === "existing_column") {
        if (!columnNames.includes(effectiveTarget)) throw new Error("Select an available target column.");
        // Replace existing column value in-place (preserving column position)
        const cols = schema
          .map((c) =>
            c.column_name === effectiveTarget
              ? `${expr} AS "${effectiveTarget}"`
              : `"${c.column_name}"`
          )
          .join(", ");
        finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${cols} FROM "${activeTable}"`;
      } else {
        // "replace" source column
        const otherCols = schema
          .filter((c) => c.column_name !== sourceCol)
          .map((c) => `"${c.column_name}"`)
          .join(", ");
        finalSql = `CREATE OR REPLACE TABLE "${activeTable}" AS SELECT ${otherCols}, ${expr} AS "${sourceCol}" FROM "${activeTable}"`;
      }
      description = `${OP_LABELS[opType]} on "${sourceCol}"${effectiveTarget ? ` → "${effectiveTarget}"` : ""}`;
    }

    await onApply(finalSql, description, opType === "rename_column"
      ? Object.fromEntries(renameRows.filter((row) => row.sourceCol && row.newName.trim()).map((row) => [row.sourceCol, row.newName.trim()]))
      : undefined);
  };

  const handleApply = async () => {
    if (actionGate.current.pending || applyDisabled || !activeTable) return;
    await actionGate.current.run(async () => {
      setApplying(true);
      setApplyError(null);
      try {
        await applyOperation();
        onClose();
        resetForm();
      } catch (error) {
        setApplyError(errorMessage(error));
      } finally {
        setApplying(false);
      }
    });
  };

  const handleClose = () => {
    if (actionGate.current.pending) return;
    onClose();
    resetForm();
  };

  const validRenameCount = renameRows.filter((r) => r.sourceCol && r.newName.trim()).length;
  const validConditionCount = caseConditions.filter((c) => c.column && c.operator && c.result).length;
  const applyDisabled =
    opType === "delete_column"
      ? deleteColumns.length === 0 || deleteColumns.length >= schema.length
      : opType === "create_column"
      ? newTargetInvalid
      : opType === "combine_columns"
      ? combineSourceCols.length < 2 || newTargetInvalid
      : opType === "rename_column"
      ? validRenameCount === 0
      : opType === "sample_table"
      ? !param1 || !Number.isFinite(Number(param1)) || Number(param1) <= 0 || (sampleMode === "percent" && Number(param1) > 100)
      : opType === "remove_duplicates"
      ? dedupColumns.length === 0
      : opType === "conditional_column"
      ? newTargetInvalid || validConditionCount === 0
      : opType === "remove_empty_rows" || opType === "replace_empty_null" || opType === "replace_sentinel_null"
      ? false
      : !columnNames.includes(sourceCol)
        || (opType === "custom_sql" && !param1.trim())
        || ((opType === "substring" || opType === "custom_sql") && targetMode === "new_column" && newTargetInvalid)
        || ((opType === "substring" || opType === "custom_sql") && targetMode === "existing_column" && !columnNames.includes(targetCol));

  const sourceSummary = sourceCol ? `${sourceCol}${colTypeMap.get(sourceCol) ? ` (${colTypeMap.get(sourceCol)})` : ""}` : "No source selected";
  const targetSummary = (() => {
    if (opType === "create_column" || opType === "combine_columns" || opType === "conditional_column") {
      return targetCol ? `New column "${targetCol.trim()}"${opType === "create_column" && !param1.trim() ? " (NULL values)" : ""}` : "New column not named";
    }
    if (opType === "substring" || opType === "custom_sql") {
      if (targetMode === "new_column") return targetCol ? `New column "${targetCol.trim()}"` : "New column not named";
      if (targetMode === "existing_column") return targetCol ? `Overwrite existing column "${targetCol}"` : "No target selected";
      return sourceCol ? `Replace "${sourceCol}"` : "Replace source";
    }
    if (opType === "delete_column") return `${deleteColumns.length} column${deleteColumns.length !== 1 ? "s" : ""} selected`;
    if (opType === "rename_column") return `${validRenameCount} rename${validRenameCount !== 1 ? "s" : ""} ready`;
    if (opType === "remove_duplicates") return `${dedupColumns.length} key column${dedupColumns.length !== 1 ? "s" : ""}`;
    if (opType === "remove_empty_rows") {
      const count = removeEmptyColumns.length || schema.length;
      return `${removeEmptyMode === "any" ? "Any" : "All"} empty across ${count} column${count !== 1 ? "s" : ""}`;
    }
    if (opType === "replace_empty_null") {
      const count = emptyNullColumns.length || schema.filter((c) => isVarcharType(c.column_type)).length;
      return `Overwrite values in ${count} text column${count !== 1 ? "s" : ""}`;
    }
    if (opType === "replace_sentinel_null") {
      const count = sentinelNullColumns.length || schema.filter((c) => isVarcharType(c.column_type)).length;
      return `Overwrite values in ${count} text column${count !== 1 ? "s" : ""}`;
    }
    if (opType === "sample_table") return param1 ? `${param1}${sampleMode === "percent" ? "%" : " rows"}` : "Sample size not set";
    return "Current table";
  })();

  return (
    <Dialog
      isOpen={isOpen}
      onClose={handleClose}
      title="Table transformations"
      canEscapeKeyClose={!applying}
      canOutsideClickClose={!applying}
      isCloseButtonShown={!applying}
      className="workbench-dialog data-operations-workbench-dialog"
      style={{ width: 860, maxWidth: "94vw" }}
    >
      <DialogBody className="workbench-dialog-body">
        <Callout icon="database" style={{ marginBottom: 12 }}>
          <strong>{fileName}</strong> · Entire file · {totalRows.toLocaleString()} rows.
          {opType === "rename_column" || opType === "delete_column" ? " Changes affect whole columns." : ""}
        </Callout>
        {filtersApplied && (
          <Callout intent={Intent.WARNING} icon="filter" style={{ marginBottom: 12 }}>
            Filters are active in the table. This operation includes hidden rows and applies to the entire file.
          </Callout>
        )}
        {applyError && (
          <Callout intent={Intent.DANGER} icon="error" role="alert" style={{ marginBottom: 12 }}>
            <strong>Operation failed.</strong> {applyError} Your settings are preserved. Review them and retry.
          </Callout>
        )}
        <div className="workbench-layout data-operations-workbench-layout">
        <fieldset className="column-op-form workbench-config" disabled={applying} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
          <FormGroup label="Operation">
            <SoftSelect
              value={opType}
              onChange={(e) => setOpType(e.target.value as OpType)}
              fill
            >
              {Object.entries(OP_LABELS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </SoftSelect>
          </FormGroup>

          {/* Source Column — hidden for create_column, combine_columns, rename_column, delete_column, sample_table, remove_duplicates, remove_empty_rows, conditional_column, replace_empty_null, replace_sentinel_null */}
          {opType !== "create_column" && opType !== "combine_columns" && opType !== "rename_column" && opType !== "delete_column" && opType !== "sample_table" && opType !== "remove_duplicates" && opType !== "remove_empty_rows" && opType !== "conditional_column" && opType !== "replace_empty_null" && opType !== "replace_sentinel_null" && (
            <FormGroup label="Source Column">
              <SearchableColumnSelect
                value={sourceCol}
                onChange={setSourceCol}
                columns={schema}
                placeholder="Select column..."
                showType
                fill
              />
            </FormGroup>
          )}

          {/* Target Column — for create_column/combine_columns/conditional_column: always new column name input */}
          {(opType === "create_column" || opType === "combine_columns" || opType === "conditional_column") && (
            <FormGroup label="New Column Name">
              <InputGroup
                value={targetCol}
                onChange={(e) => setTargetCol(e.target.value)}
                placeholder="new_column"
              />
            </FormGroup>
          )}

          {/* Target Mode — only for extract-type ops */}
          {(opType === "substring" || opType === "custom_sql") && (
            <FormGroup label="Write Result To">
              <div className="workbench-segmented-radio">
                <RadioGroup
                  inline
                  selectedValue={targetMode}
                  onChange={(e) => {
                    const mode = (e.target as HTMLInputElement).value as ColOpTargetMode;
                    setTargetMode(mode);
                    setTargetCol(mode === "new_column" ? suggestColumnName(columnNames, `${sourceCol || "value"}_${opType === "substring" ? "substring" : "transformed"}`) : "");
                  }}
                >
                  <Radio label="Replace source" value="replace" />
                  <Radio label="New column" value="new_column" />
                  <Radio label="Existing column" value="existing_column" />
                </RadioGroup>
              </div>
              {targetMode === "new_column" && (
                <InputGroup
                  value={targetCol}
                  onChange={(e) => setTargetCol(e.target.value)}
                  placeholder="new_column"
                  style={{ marginTop: 6 }}
                  intent={targetCol && columnNameExists(columnNames, targetCol) ? Intent.DANGER : Intent.NONE}
                />
              )}
              {targetMode === "existing_column" && (
                <div style={{ marginTop: 6 }}>
                  <SearchableColumnSelect
                    value={targetCol}
                    onChange={setTargetCol}
                    columns={schema}
                    placeholder="Select target column..."
                    showType
                    fill
                  />
                </div>
              )}
            </FormGroup>
          )}

          {/* delete_column: multi-select */}
          {opType === "delete_column" && (
            <>
              <FormGroup label="Columns to Delete" helperText="Select one or more columns to remove.">
                <ColumnCheckList
                  items={schemaItems}
                  selected={new Set(deleteColumns)}
                  onChange={(next) => setDeleteColumns(Array.from(next))}
                  showSelectAll={false}
                  maxHeight={240}
                />
              </FormGroup>
              {deleteColumns.length > 0 && (
                <Callout intent={Intent.WARNING} style={{ marginBottom: 10 }}>
                  <p style={{ margin: 0 }}>
                    This will permanently remove {deleteColumns.length} column{deleteColumns.length > 1 ? "s" : ""} from the table.
                    {deleteColumns.length >= schema.length && " Cannot delete all columns — at least one must remain."}
                  </p>
                </Callout>
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
                        <SoftSelect
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
                        </SoftSelect>
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
                <ColumnCheckList
                  items={sortedSchemaItems}
                  selected={new Set(combineSourceCols)}
                  onChange={(next) => setCombineSourceCols(Array.from(next))}
                  search
                  searchPlaceholder="Search columns..."
                  showSelectAll={false}
                  maxHeight={240}
                  renderItemBadge={(item, isSelected) => {
                    const orderIndex = combineSourceCols.indexOf(item.name);
                    return (
                      <span className={`column-check-list-order-badge${isSelected ? " visible" : ""}`}>
                        {isSelected ? orderIndex + 1 : ""}
                      </span>
                    );
                  }}
                />
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
                  onChange={(e) => {
                    const nextMode = (e.target as HTMLInputElement).value as "rows" | "percent";
                    setSampleMode(nextMode);
                    if (nextMode === "rows" && !isAllowedNumberInputValue(param1)) {
                      setParam1("");
                    }
                  }}
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
                  onChange={(e) => {
                    if (isAllowedNumberInputValue(e.target.value, { allowDecimal: sampleMode === "percent" })) {
                      setParam1(e.target.value);
                    } else {
                      showNumberInputExpectation(e.currentTarget, { allowDecimal: sampleMode === "percent" });
                    }
                  }}
                  onKeyDown={(e) => guardNumberInputKeyDown(e, { allowDecimal: sampleMode === "percent" })}
                  onPaste={(e) => guardNumberInputPaste(e, { allowDecimal: sampleMode === "percent" })}
                  onDrop={(e) => guardNumberInputDrop(e, { allowDecimal: sampleMode === "percent" })}
                  onWheel={(e) => stepNumberInputOnWheel(e, setParam1)}
                  placeholder={sampleMode === "rows" ? "100" : "10"}
                  type="number"
                  inputMode={sampleMode === "rows" ? "numeric" : "decimal"}
                  pattern={sampleMode === "rows" ? "[0-9]*" : "[0-9]*[.]?[0-9]*"}
                  min={sampleMode === "rows" ? 1 : 0}
                  max={sampleMode === "percent" ? 100 : undefined}
                  step={sampleMode === "rows" ? 1 : "any"}
                />
              </FormGroup>
            </>
          )}

          {/* remove_duplicates: multi-select columns for dedup */}
          {opType === "remove_duplicates" && (
            <>
              <FormGroup label="Deduplicate by Columns" helperText="Select columns to check for duplicates. Rows with identical values in these columns will be deduplicated.">
                <ColumnCheckList
                  items={sortedSchemaItems}
                  selected={new Set(dedupColumns)}
                  onChange={(next) => setDedupColumns(Array.from(next))}
                  search
                  searchPlaceholder="Search columns..."
                  maxHeight={240}
                />
              </FormGroup>
              {dedupPreview && (
                <Callout intent={Intent.PRIMARY} style={{ marginBottom: 10 }}>
                  <p style={{ margin: 0 }}>
                    {dedupPreview.before.toLocaleString()} rows → {dedupPreview.after.toLocaleString()} rows ({(dedupPreview.before - dedupPreview.after).toLocaleString()} duplicate{dedupPreview.before - dedupPreview.after !== 1 ? "s" : ""} will be removed)
                  </p>
                </Callout>
              )}
            </>
          )}

          {/* remove_empty_rows: column selector + all/any mode */}
          {opType === "remove_empty_rows" && (
            <>
              <FormGroup label="Mode" helperText="Any: remove rows where at least one selected column is empty. All: remove rows where every selected column is empty.">
                <RadioGroup
                  inline
                  selectedValue={removeEmptyMode}
                  onChange={(e) => setRemoveEmptyMode((e.target as HTMLInputElement).value as "all" | "any")}
                >
                  <Radio label="Any column empty" value="any" />
                  <Radio label="All columns empty" value="all" />
                </RadioGroup>
              </FormGroup>
              <FormGroup label="Columns" helperText="Select columns to check for empty values, or leave empty to check all columns.">
                <ColumnCheckList
                  items={sortedSchemaItems}
                  selected={new Set(removeEmptyColumns)}
                  onChange={(next) => setRemoveEmptyColumns(Array.from(next))}
                  search
                  searchPlaceholder="Search columns..."
                  emptyMeans="all"
                  emptyAllText="All columns will be checked."
                  maxHeight={240}
                />
              </FormGroup>
              {removeEmptyPreview && (
                <Callout intent={Intent.PRIMARY} style={{ marginBottom: 10 }}>
                  <p style={{ margin: 0 }}>
                    {removeEmptyPreview.before.toLocaleString()} rows → {removeEmptyPreview.after.toLocaleString()} rows ({(removeEmptyPreview.before - removeEmptyPreview.after).toLocaleString()} empty row{removeEmptyPreview.before - removeEmptyPreview.after !== 1 ? "s" : ""} will be removed)
                  </p>
                </Callout>
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
                <ColumnCheckList
                  items={sortedSchemaItems}
                  selected={new Set(emptyNullColumns)}
                  onChange={(next) => setEmptyNullColumns(Array.from(next))}
                  search
                  searchPlaceholder="Search columns..."
                  emptyMeans="all"
                  emptyAllText="All VARCHAR columns will be cleaned."
                  maxHeight={240}
                  renderItemHint={(item) =>
                    !isVarcharType(item.type) ? (
                      <span className="column-check-list-muted-hint">(skipped)</span>
                    ) : null
                  }
                />
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
                <ColumnCheckList
                  items={sortedSchemaItems}
                  selected={new Set(sentinelNullColumns)}
                  onChange={(next) => setSentinelNullColumns(Array.from(next))}
                  search
                  searchPlaceholder="Search columns..."
                  emptyMeans="all"
                  emptyAllText="All VARCHAR columns will be cleaned."
                  maxHeight={240}
                  renderItemHint={(item) =>
                    !isVarcharType(item.type) ? (
                      <span className="column-check-list-muted-hint">(skipped)</span>
                    ) : null
                  }
                />
              </FormGroup>
            </>
          )}

          {/* conditional_column: condition builder */}
          {opType === "conditional_column" && (
            <>
              <FormGroup label="Conditions" helperText="Each condition is evaluated in order. The first match determines the result.">
                <div className="case-condition-list">
                  {caseConditions.map((cond, idx) => {
                    const caseValueIsNumber = isNumberType(colTypeMap.get(cond.column))
                      && !CASE_TEXT_VALUE_OPERATORS.has(cond.operator);

                    return (
                      <div key={idx} className="case-condition-row">
                        <span className="case-condition-label">IF</span>
                        <SearchableColumnSelect
                          value={cond.column}
                          onChange={(val) => {
                            const nextValueIsNumber = isNumberType(colTypeMap.get(val))
                              && !CASE_TEXT_VALUE_OPERATORS.has(cond.operator);
                            setCaseConditions((prev) => prev.map((c, i) => i === idx ? {
                              ...c,
                              column: val,
                              value: nextValueIsNumber && !isAllowedNumberInputValue(c.value, { allowDecimal: true, allowNegative: true, allowPartial: false }) ? "" : c.value,
                            } : c));
                          }}
                          columns={schema}
                          placeholder="Column..."
                          className="case-condition-col"
                        />
                        <SoftSelect
                          value={cond.operator}
                          onChange={(e) => {
                            const nextOperator = e.target.value;
                            const nextValueIsNumber = isNumberType(colTypeMap.get(cond.column))
                              && !CASE_TEXT_VALUE_OPERATORS.has(nextOperator);
                            setCaseConditions((prev) => prev.map((c, i) => i === idx ? {
                              ...c,
                              operator: nextOperator,
                              value: nextValueIsNumber && !isAllowedNumberInputValue(c.value, { allowDecimal: true, allowNegative: true, allowPartial: false }) ? "" : c.value,
                            } : c));
                          }}
                          className="case-condition-op"
                        >
                          {CASE_OPERATORS.map((op) => (
                            <option key={op} value={op}>{op}</option>
                          ))}
                        </SoftSelect>
                        {cond.operator !== "IS NULL" && cond.operator !== "IS NOT NULL" && (
                          <InputGroup
                            value={cond.value}
                            onChange={(e) => {
                              const nextValue = e.target.value;
                              if (!caseValueIsNumber || isAllowedNumberInputValue(nextValue, { allowDecimal: true, allowNegative: true })) {
                                setCaseConditions((prev) => prev.map((c, i) => i === idx ? { ...c, value: nextValue } : c));
                              } else {
                                showNumberInputExpectation(e.currentTarget, { allowDecimal: true, allowNegative: true });
                              }
                            }}
                            onKeyDown={(e) => {
                              if (caseValueIsNumber) guardNumberInputKeyDown(e, { allowDecimal: true, allowNegative: true });
                            }}
                            onPaste={(e) => {
                              if (caseValueIsNumber) guardNumberInputPaste(e, { allowDecimal: true, allowNegative: true });
                            }}
                            onDrop={(e) => {
                              if (caseValueIsNumber) guardNumberInputDrop(e, { allowDecimal: true, allowNegative: true });
                            }}
                            onBlur={(e) => {
                              if (caseValueIsNumber && !isAllowedNumberInputValue(cond.value, { allowDecimal: true, allowNegative: true, allowPartial: false })) {
                                showNumberInputExpectation(e.currentTarget, { allowDecimal: true, allowNegative: true });
                                setCaseConditions((prev) => prev.map((c, i) => i === idx ? { ...c, value: "" } : c));
                              }
                            }}
                            inputMode={caseValueIsNumber ? "decimal" : undefined}
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
                    );
                  })}
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

          {opType === "substring" && (
            <div className="workbench-field-row">
              <FormGroup label="Start Position">
                <InputGroup
                  value={param1}
                  onChange={(e) => {
                    if (isAllowedNumberInputValue(e.target.value)) {
                      setParam1(e.target.value);
                    } else {
                      showNumberInputExpectation(e.currentTarget);
                    }
                  }}
                  onKeyDown={(e) => guardNumberInputKeyDown(e)}
                  onPaste={(e) => guardNumberInputPaste(e)}
                  onDrop={(e) => guardNumberInputDrop(e)}
                  onWheel={(e) => stepNumberInputOnWheel(e, setParam1)}
                  placeholder="1"
                  type="number"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min={1}
                />
              </FormGroup>
              <FormGroup label="Length">
                <InputGroup
                  value={param2}
                  onChange={(e) => {
                    if (isAllowedNumberInputValue(e.target.value)) {
                      setParam2(e.target.value);
                    } else {
                      showNumberInputExpectation(e.currentTarget);
                    }
                  }}
                  onKeyDown={(e) => guardNumberInputKeyDown(e)}
                  onPaste={(e) => guardNumberInputPaste(e)}
                  onDrop={(e) => guardNumberInputDrop(e)}
                  onWheel={(e) => stepNumberInputOnWheel(e, setParam2)}
                  placeholder="10"
                  type="number"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  min={0}
                />
              </FormGroup>
            </div>
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

        </fieldset>
        <aside className="workbench-sidecar data-operation-sidecar">
          <div className="workbench-sidecar-title">
            Preview
            <span>first rows</span>
          </div>

          {previewError ? (
            <div className="op-preview-error">{previewError}</div>
          ) : previews.length > 0 ? (
            <table className="op-preview-table workbench-preview-table">
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
          ) : dedupPreview ? (
            <div className="workbench-impact-card">
              <strong>{(dedupPreview.before - dedupPreview.after).toLocaleString()}</strong>
              <span>duplicate row{dedupPreview.before - dedupPreview.after !== 1 ? "s" : ""} will be removed.</span>
            </div>
          ) : removeEmptyPreview ? (
            <div className="workbench-impact-card">
              <strong>{(removeEmptyPreview.before - removeEmptyPreview.after).toLocaleString()}</strong>
              <span>empty row{removeEmptyPreview.before - removeEmptyPreview.after !== 1 ? "s" : ""} will be removed.</span>
            </div>
          ) : (
            <div className="workbench-empty-preview">
              <strong>{applyDisabled ? "Waiting for required input" : "Ready to apply"}</strong>
              <span>{OP_LABELS[opType]}</span>
            </div>
          )}

          <div className="workbench-summary-block">
            <div className="workbench-summary-label">Impact Summary</div>
            <div className="workbench-summary-lines">
              <div><span>File</span><strong>{fileName}</strong></div>
              <div><span>Scope</span><strong>Entire file · {totalRows.toLocaleString()} rows</strong></div>
              <div>
                <span>Operation</span>
                <strong>{OP_LABELS[opType]}</strong>
              </div>
              <div>
                <span>Source</span>
                <strong>{sourceSummary}</strong>
              </div>
              <div>
                <span>Target</span>
                <strong>{targetSummary}</strong>
              </div>
            </div>
          </div>
        </aside>
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <>
            <Button onClick={handleClose} text="Cancel" disabled={applying} />
            <Button
              intent={opType === "delete_column" ? Intent.DANGER : Intent.PRIMARY}
              onClick={handleApply}
              text={applying ? "Applying..." : applyError ? "Retry" : opType === "delete_column" ? "Delete" : "Apply"}
              loading={applying}
              disabled={applyDisabled || applying}
            />
          </>
        }
      />
    </Dialog>
  );
}
