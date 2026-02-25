import React, { useState, useCallback, useMemo, useRef, useEffect } from "react";
import {
  Button,
  Callout,
  Dialog,
  DialogBody,
  DialogFooter,
  Icon,
  InputGroup,
  Intent,
  NonIdealState,
  Tag,
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
  const [replaceNotice, setReplaceNotice] = useState<{
    mappingId: string;
    message: string;
  } | null>(null);
  const replaceNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mappingsListRef = useRef<HTMLDivElement>(null);
  const lastAddedIdRef = useRef<string | null>(null);

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

  // Sorted unique column names (case-insensitive) for flat display
  const sortedColumnNames = useMemo(() => {
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    return [...allColumns.keys()].sort(collator.compare);
  }, [allColumns]);

  // Set of columns already used as input (for disabling in the right panel)
  const usedInputColumns = useMemo(() => {
    const used = new Set<string>();
    for (const m of mappings) {
      for (const ic of m.inputColumns) {
        if (ic) used.add(ic);
      }
    }
    return used;
  }, [mappings]);

  // Whether any columns are shared across ALL tables
  const hasSharedColumns = useMemo(() => {
    const tableCount = tables.length;
    for (const tableList of allColumns.values()) {
      if (tableList.length === tableCount) return true;
    }
    return false;
  }, [tables, allColumns]);

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
    // Validate that each mapping's input columns exist in at least one table
    for (const m of mappings) {
      for (const ic of m.inputColumns) {
        if (!allColumns.has(ic)) {
          errors.push(`Input column "${ic}" does not exist in any selected table`);
          break;
        }
      }
      if (errors.length > 4) break; // avoid flooding
    }
    return errors;
  }, [mappings, allColumns]);

  // Warnings (non-blocking)
  const validationWarnings = useMemo(() => {
    const warnings: string[] = [];
    // Warn about tables with 0 rows
    for (const t of tables) {
      if (t.rowCount === 0) {
        warnings.push(`Table "${t.tableName}" has 0 rows — it will contribute nothing to the result`);
      }
    }
    // Warn about mappings where input columns don't exist in any table (all NULLs)
    for (const m of mappings) {
      if (m.inputColumns.length > 0) {
        const existsInAny = m.inputColumns.some((ic) => allColumns.has(ic));
        if (!existsInAny && m.outputColumn.trim()) {
          warnings.push(`Output "${m.outputColumn}" — none of the input columns exist in the selected tables (will be all NULL)`);
        }
      }
    }
    return warnings;
  }, [tables, mappings, allColumns]);

  // Fill similar columns — columns that exist in ALL tables
  const handleFillSimilar = useCallback(() => {
    const tableCount = tables.length;
    const newMappings: ColumnMapping[] = [];
    const collator = new Intl.Collator(undefined, { sensitivity: "base" });
    const sorted = [...allColumns.entries()].sort(([a], [b]) =>
      collator.compare(a, b)
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
    lastAddedIdRef.current = id;
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

  // Which tables a column belongs to — used to enforce one-per-table rule
  const columnToTables = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const table of tables) {
      for (const col of table.schema) {
        if (!map.has(col.column_name)) map.set(col.column_name, new Set());
        map.get(col.column_name)!.add(table.tableName);
      }
    }
    return map;
  }, [tables]);

  const handleColumnClick = useCallback(
    (colName: string) => {
      if (!focusedMappingId) return;

      // Detect replacements before updating state
      if (focusedField === "input") {
        const currentMapping = mappings.find((m) => m.id === focusedMappingId);
        if (currentMapping && !currentMapping.inputColumns.includes(colName)) {
          const clickedTables = columnToTables.get(colName) || new Set();
          const replaced = currentMapping.inputColumns.filter((existing) => {
            const existingTables = columnToTables.get(existing) || new Set();
            for (const t of existingTables) {
              if (clickedTables.has(t)) return true;
            }
            return false;
          });
          if (replaced.length > 0) {
            const sharedTables = new Set<string>();
            for (const rep of replaced) {
              const repTables = columnToTables.get(rep) || new Set();
              for (const t of repTables) {
                if (clickedTables.has(t)) sharedTables.add(t);
              }
            }
            const tableStr = [...sharedTables].join(", ");
            const msg = `Replaced ${replaced.join(", ")} — both in ${tableStr}`;
            setReplaceNotice({ mappingId: focusedMappingId, message: msg });
            if (replaceNoticeTimer.current) clearTimeout(replaceNoticeTimer.current);
            replaceNoticeTimer.current = setTimeout(() => setReplaceNotice(null), 3000);
          }
        }
      }

      setMappings((prev) =>
        prev.map((m) => {
          if (m.id !== focusedMappingId) return m;
          if (focusedField === "output") {
            return { ...m, outputColumn: colName };
          } else {
            // Toggle off if already present
            if (m.inputColumns.includes(colName)) {
              return { ...m, inputColumns: m.inputColumns.filter((c) => c !== colName) };
            }
            // Enforce one column per table: remove any existing column from the same tables
            const clickedTables = columnToTables.get(colName) || new Set();
            const filtered = m.inputColumns.filter((existing) => {
              const existingTables = columnToTables.get(existing) || new Set();
              // Keep if no table overlap with the clicked column
              for (const t of existingTables) {
                if (clickedTables.has(t)) return false;
              }
              return true;
            });
            return { ...m, inputColumns: [...filtered, colName] };
          }
        })
      );
    },
    [focusedMappingId, focusedField, columnToTables, mappings]
  );

  const handleOutputChange = useCallback((id: string, value: string) => {
    setMappings((prev) =>
      prev.map((m) => (m.id === id ? { ...m, outputColumn: value } : m))
    );
  }, []);

  const handleRemoveInputColumn = useCallback(
    (mappingId: string, colName: string) => {
      setMappings((prev) =>
        prev.map((m) =>
          m.id === mappingId
            ? { ...m, inputColumns: m.inputColumns.filter((c) => c !== colName) }
            : m
        )
      );
    },
    []
  );

  const handleCombine = useCallback(() => {
    const tableData = tables.map((t) => ({
      tableName: t.tableName,
      columnNames: t.schema.map((c) => c.column_name),
      columnTypes: new Map(t.schema.map((c) => [c.column_name, c.column_type])),
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

  // Scroll to and focus the last added row
  useEffect(() => {
    if (!lastAddedIdRef.current) return;
    const id = lastAddedIdRef.current;
    lastAddedIdRef.current = null;
    // Wait for the DOM to update
    requestAnimationFrame(() => {
      const listEl = mappingsListRef.current;
      if (!listEl) return;
      // Scroll the list to the very bottom so the Add Row button stays visible
      listEl.scrollTop = listEl.scrollHeight;
      // Focus the output input of the newly added row
      const rowEl = listEl.querySelector(`[data-mapping-id="${id}"]`) as HTMLElement | null;
      if (rowEl) {
        const input = rowEl.querySelector<HTMLInputElement>("input");
        if (input) input.focus();
      }
    });
  }, [mappings]);

  // Clean up notice timer on unmount
  useEffect(() => {
    return () => {
      if (replaceNoticeTimer.current) clearTimeout(replaceNoticeTimer.current);
    };
  }, []);

  // Reset state when dialog opens
  const handleOpening = useCallback(() => {
    setMappings([]);
    setFocusedMappingId(null);
    setFocusedField("output");
    setReplaceNotice(null);
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
              <Button
                icon="automatic-updates"
                text="Fill Common"
                onClick={handleFillSimilar}
                disabled={!hasSharedColumns}
                small
              />
            </div>
            {validationErrors.length > 0 && mappings.length > 0 && (
              <Callout
                intent={Intent.WARNING}
                icon="warning-sign"
                className="combine-validation-callout"
              >
                {validationErrors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </Callout>
            )}
            {validationWarnings.length > 0 && validationErrors.length === 0 && mappings.length > 0 && (
              <Callout
                intent={Intent.PRIMARY}
                icon="info-sign"
                className="combine-validation-callout"
              >
                {validationWarnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </Callout>
            )}
            <div className="combine-mappings-list" ref={mappingsListRef}>
              {mappings.map((m, index) => {
                const isActive = focusedMappingId === m.id;
                return (
                  <div
                    key={m.id}
                    data-mapping-id={m.id}
                    className={`combine-mapping-row${isActive ? " active" : ""}`}
                    onClick={() => setFocusedMappingId(m.id)}
                  >
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
                          isActive && focusedField === "output"
                            ? "combine-field-focused"
                            : ""
                        }
                      />
                    </div>
                    <Icon icon="arrow-left" size={12} style={{ opacity: 0.4, flexShrink: 0 }} />
                    <div className="combine-field-group">
                      <label className="combine-field-label">Input</label>
                      <div
                        className={`combine-input-tags${
                          isActive && focusedField === "input" ? " focused" : ""
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setFocusedMappingId(m.id);
                          setFocusedField("input");
                        }}
                      >
                        {m.inputColumns.length === 0 && (
                          <span className="combine-input-placeholder">
                            click columns to add
                          </span>
                        )}
                        {m.inputColumns.map((col) => (
                          <Tag
                            key={col}
                            minimal
                            round
                            intent={Intent.PRIMARY}
                            onRemove={() => handleRemoveInputColumn(m.id, col)}
                          >
                            {col}
                          </Tag>
                        ))}
                      </div>
                      {replaceNotice && replaceNotice.mappingId === m.id && (
                        <div className="combine-replace-notice">
                          <Icon icon="swap-horizontal" size={12} />
                          {replaceNotice.message}
                        </div>
                      )}
                    </div>
                    <Button
                      icon="cross"
                      minimal
                      small
                      intent={Intent.DANGER}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveMapping(m.id);
                      }}
                    />
                  </div>
                );
              })}
              {mappings.length === 0 && (
                <NonIdealState
                  icon="merge-columns"
                  title="No column mappings"
                  description="Map columns from your source tables to define how they combine."
                  className="combine-empty-state"
                  action={
                    <div className="combine-empty-actions">
                      <Button
                        icon="automatic-updates"
                        text="Fill Common Columns"
                        onClick={handleFillSimilar}
                        disabled={!hasSharedColumns}
                        intent={Intent.PRIMARY}
                        outlined
                      />
                      <Button
                        icon="add"
                        text="Add Row Manually"
                        onClick={handleAddMapping}
                      />
                    </div>
                  }
                />
              )}
              {mappings.length > 0 && (
                <Button
                  icon="add"
                  text="Add Row"
                  onClick={handleAddMapping}
                  small
                  minimal
                  style={{ alignSelf: "center", marginTop: 4 }}
                />
              )}
            </div>
          </div>

          {/* Right panel: all columns alphabetically */}
          <div className="combine-columns-panel">
            <h4>Available Columns</h4>
            <p className="combine-columns-hint">
              Only one column per source table can be mapped to each output.
              Clicking a column replaces any existing one from the same table.
            </p>
            <div className="combine-column-buttons">
              {sortedColumnNames.map((colName) => {
                const tableList = allColumns.get(colName) || [];
                const isUsed = usedInputColumns.has(colName);
                return (
                  <Tooltip2
                    key={colName}
                    content={`In: ${tableList.join(", ")}`}
                    placement="top"
                    compact
                  >
                    <Button
                      text={colName}
                      intent={isUsed ? Intent.SUCCESS : Intent.NONE}
                      small
                      onClick={() => handleColumnClick(colName)}
                      outlined={!isUsed}
                      disabled={
                        isUsed &&
                        focusedField === "input" &&
                        focusedMappingId !== null &&
                        !mappings.find(
                          (m) => m.id === focusedMappingId && m.inputColumns.includes(colName)
                        )
                      }
                    />
                  </Tooltip2>
                );
              })}
            </div>
          </div>
        </div>
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
