import React, { useState, useCallback, useMemo } from "react";
import {
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  InputGroup,
  Intent,
} from "@blueprintjs/core";
import { Tooltip2 } from "@blueprintjs/popover2";
import { LoadedTable, ColumnMapping } from "../types";
import { buildMappedCombineQuery } from "../utils/sqlBuilder";

interface CombineDialogProps {
  isOpen: boolean;
  tables: LoadedTable[];
  onClose: () => void;
  onCombine: (sql: string) => void;
}

let nextIdCounter = 1;
function genId(): string {
  return String(nextIdCounter++);
}

export function CombineDialog({
  isOpen,
  tables,
  onClose,
  onCombine,
}: CombineDialogProps): React.ReactElement {
  const [mappings, setMappings] = useState<ColumnMapping[]>([]);
  const [focusedMappingId, setFocusedMappingId] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<"output" | "input">("output");

  // All unique columns mapped to the tables that contain them
  const allColumns = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const table of tables) {
      for (const col of table.schema) {
        const existing = map.get(col.column_name) || [];
        existing.push(table.tableName);
        map.set(col.column_name, existing);
      }
    }
    return map;
  }, [tables]);

  // Sorted column names for stable display
  const sortedColumnNames = useMemo(() => {
    return [...allColumns.keys()].sort(Intl.Collator().compare);
  }, [allColumns]);

  // How many times each column is used in input mappings
  const columnUsage = useMemo(() => {
    const usage = new Map<string, number>();
    for (const m of mappings) {
      for (const ic of m.inputColumns) {
        if (ic) usage.set(ic, (usage.get(ic) || 0) + 1);
      }
    }
    return usage;
  }, [mappings]);

  // Validation errors
  const validationErrors = useMemo(() => {
    const errors: string[] = [];
    if (mappings.length === 0) {
      errors.push("Add at least one column mapping");
      return errors;
    }
    for (const m of mappings) {
      if (!m.outputColumn.trim()) {
        errors.push("All mapping rows must have an output column name");
        break;
      }
    }
    const outputNames = mappings.map((m) => m.outputColumn.trim().toLowerCase());
    const seen = new Set<string>();
    for (const name of outputNames) {
      if (name && seen.has(name)) {
        errors.push(`Duplicate output column: "${name}"`);
        break;
      }
      seen.add(name);
    }
    for (const m of mappings) {
      if (m.inputColumns.length === 0) {
        errors.push("All mapping rows must have at least one input column");
        break;
      }
    }
    for (const [col, count] of columnUsage) {
      if (count > 1) {
        errors.push(`Column "${col}" is mapped more than once`);
        break;
      }
    }
    return errors;
  }, [mappings, columnUsage]);

  // Fill similar columns — columns that exist in ALL tables
  const handleFillSimilar = useCallback(() => {
    const tableCount = tables.length;
    const newMappings: ColumnMapping[] = [];
    const sorted = [...allColumns.entries()].sort(([a], [b]) =>
      Intl.Collator().compare(a, b)
    );
    for (const [colName, tableList] of sorted) {
      if (tableList.length === tableCount) {
        newMappings.push({
          id: genId(),
          outputColumn: colName,
          inputColumns: [colName],
        });
      }
    }
    setMappings(newMappings);
    if (newMappings.length > 0) {
      setFocusedMappingId(newMappings[0].id);
      setFocusedField("output");
    }
  }, [tables, allColumns]);

  const handleAddMapping = useCallback(() => {
    const id = genId();
    setMappings((prev) => [...prev, { id, outputColumn: "", inputColumns: [] }]);
    setFocusedMappingId(id);
    setFocusedField("output");
  }, []);

  const handleRemoveMapping = useCallback(
    (id: string) => {
      setMappings((prev) => prev.filter((m) => m.id !== id));
      if (focusedMappingId === id) {
        setFocusedMappingId(null);
      }
    },
    [focusedMappingId]
  );

  const handleColumnClick = useCallback(
    (colName: string) => {
      if (!focusedMappingId) return;
      setMappings((prev) =>
        prev.map((m) => {
          if (m.id !== focusedMappingId) return m;
          if (focusedField === "output") {
            return { ...m, outputColumn: colName };
          } else {
            // Toggle: remove if present, add if not
            const existing = m.inputColumns.includes(colName);
            return {
              ...m,
              inputColumns: existing
                ? m.inputColumns.filter((c) => c !== colName)
                : [...m.inputColumns, colName],
            };
          }
        })
      );
    },
    [focusedMappingId, focusedField]
  );

  const handleOutputChange = useCallback((id: string, value: string) => {
    setMappings((prev) =>
      prev.map((m) => (m.id === id ? { ...m, outputColumn: value } : m))
    );
  }, []);

  const handleInputChange = useCallback((id: string, value: string) => {
    const cols = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    setMappings((prev) =>
      prev.map((m) => (m.id === id ? { ...m, inputColumns: cols } : m))
    );
  }, []);

  const handleCombine = useCallback(() => {
    const tableData = tables.map((t) => ({
      tableName: t.tableName,
      columnNames: t.schema.map((c) => c.column_name),
    }));
    const sql = buildMappedCombineQuery(
      tableData,
      mappings.map((m) => ({
        outputColumn: m.outputColumn,
        inputColumns: m.inputColumns,
      }))
    );
    if (sql) onCombine(sql);
  }, [tables, mappings, onCombine]);

  // Reset state when dialog opens
  const handleOpening = useCallback(() => {
    setMappings([]);
    setFocusedMappingId(null);
    setFocusedField("output");
  }, []);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      onOpening={handleOpening}
      title="Combine Tables — Column Mapping"
      style={{ width: "90vw", maxWidth: 1100 }}
      canOutsideClickClose={false}
    >
      <DialogBody>
        <div className="combine-dialog-body">
          {/* Left panel: mapping rows */}
          <div className="combine-mappings-panel">
            <div className="combine-mappings-header">
              <h4>Column Mappings</h4>
              <div>
                <Button
                  icon="automatic-updates"
                  text="Fill Similar"
                  onClick={handleFillSimilar}
                  small
                  style={{ marginRight: 4 }}
                />
                <Button icon="add" text="Add Row" onClick={handleAddMapping} small />
              </div>
            </div>
            <div className="combine-mappings-list">
              {mappings.map((m, index) => (
                <div key={m.id} className="combine-mapping-row">
                  <span className="combine-mapping-index">{index + 1}</span>
                  <div className="combine-field-group">
                    <label className="combine-field-label">Output</label>
                    <InputGroup
                      value={m.outputColumn}
                      onChange={(e) => handleOutputChange(m.id, e.target.value)}
                      onFocus={() => {
                        setFocusedMappingId(m.id);
                        setFocusedField("output");
                      }}
                      placeholder="output column name"
                      className={
                        focusedMappingId === m.id && focusedField === "output"
                          ? "combine-field-focused"
                          : ""
                      }
                    />
                  </div>
                  <Icon icon="arrow-left" size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
                  <div className="combine-field-group">
                    <label className="combine-field-label">Input</label>
                    <InputGroup
                      value={m.inputColumns.join(", ")}
                      onChange={(e) => handleInputChange(m.id, e.target.value)}
                      onFocus={() => {
                        setFocusedMappingId(m.id);
                        setFocusedField("input");
                      }}
                      placeholder="source column(s)"
                      className={
                        focusedMappingId === m.id && focusedField === "input"
                          ? "combine-field-focused"
                          : ""
                      }
                    />
                  </div>
                  <Button
                    icon="cross"
                    minimal
                    small
                    intent={Intent.DANGER}
                    onClick={() => handleRemoveMapping(m.id)}
                  />
                </div>
              ))}
              {mappings.length === 0 && (
                <div className="combine-empty-state">
                  Click "Fill Similar" to auto-map shared columns, or "Add Row" to
                  map manually.
                </div>
              )}
            </div>
          </div>

          {/* Right panel: all column buttons */}
          <div className="combine-columns-panel">
            <h4>Available Columns</h4>
            <div className="combine-column-buttons">
              {sortedColumnNames.map((colName) => {
                const tableList = allColumns.get(colName) || [];
                const usageCount = columnUsage.get(colName) || 0;
                const intent =
                  usageCount === 0
                    ? Intent.NONE
                    : usageCount === 1
                    ? Intent.SUCCESS
                    : Intent.DANGER;
                return (
                  <Tooltip2
                    key={colName}
                    content={`In: ${tableList.join(", ")}`}
                    placement="top"
                    compact
                  >
                    <Button
                      text={colName}
                      intent={intent}
                      small
                      onClick={() => handleColumnClick(colName)}
                      outlined={usageCount === 0}
                    />
                  </Tooltip2>
                );
              })}
            </div>
          </div>
        </div>

        {validationErrors.length > 0 && (
          <Callout intent={Intent.WARNING} style={{ marginTop: 12 }} icon="warning-sign">
            {validationErrors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </Callout>
        )}
      </DialogBody>

      <DialogFooter
        actions={
          <>
            <Button text="Cancel" onClick={onClose} />
            <Button
              intent={Intent.PRIMARY}
              text="Combine"
              icon="merge-columns"
              disabled={validationErrors.length > 0 || mappings.length === 0}
              onClick={handleCombine}
            />
          </>
        }
      />
    </Dialog>
  );
}
