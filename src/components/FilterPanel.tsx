import React, { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import {
  Button,
  Checkbox,
  Icon,
  InputGroup,
  Intent,
  Tag,
} from "@blueprintjs/core";
import { Popover2 } from "@blueprintjs/popover2";
import {
  ColumnInfo,
  FilterGroup,
  FilterListValue,
  FilterNode,
  FilterOperator,
  isFilterGroup,
  hasActiveFilters,
  countConditions,
  isColumnComparisonOperator,
  ColOpType,
  ColOpStep,
  RowOpType,
  RowOpStep,
  UndoStrategy,
  SavedView,
  ViewState,
  QcCreateConfig,
  QcColumnMode,
  QcOptionSortMode,
  QcSession,
} from "../types";
import { ColumnOpsPanel } from "./ColumnOpsPanel";
import { RowOpsPanel } from "./RowOpsPanel";
import { ViewsPanel } from "./ViewsPanel";
import { SearchableColumnSelect } from "./SearchableColumnSelect";
import { SearchInput } from "./SearchInput";
import {
  guardNumberInputDrop,
  guardNumberInputKeyDown,
  guardNumberInputPaste,
  isAllowedNumberInputValue,
  showNumberInputExpectation,
} from "../utils/numberInputWheel";
import { buildDistinctFilterValuesQuery, buildFilterGroupClause, escapeIdent } from "../utils/sqlBuilder";
import { mergeFilterListValues } from "../utils/filterValues";

import { WorkbenchTab, WorkbenchRequest, WorkbenchHeights, getWorkbenchPanelHeight, getWorkbenchHeightLimits } from "../utils/workbenchPanel";

type ColumnKind = "text" | "number" | "date" | "boolean" | "comparison_status" | "unknown";
type OperatorOption = { value: FilterOperator; label: string };
type OperatorGroupOption = { label: string; options: OperatorOption[] };
type OperatorSectionConfig = { label: string; operators: FilterOperator[] };

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  CONTAINS: "contains",
  "DOES NOT CONTAIN": "does not contain",
  "=": "equals",
  "!=": "does not equal",
  "EQUALS IGNORE CASE": "equals, ignoring case",
  "DOES NOT EQUAL IGNORE CASE": "does not equal, ignoring case",
  "EQUALS COLUMN": "equals another column",
  "DOES NOT EQUAL COLUMN": "does not equal another column",
  "IS SAME": "is same",
  "IS DIFFERENT": "is different",
  "IS MISSING": "is missing in compare",
  "IS PRESENT": "is present in compare",
  IN: "is in list",
  "NOT IN": "is not in list",
  "IS NULL": "is empty",
  "IS NOT NULL": "is not empty",
  "IS TRUE": "is true",
  "IS FALSE": "is false",
  ">": "greater than",
  "<": "less than",
  "STARTS WITH": "starts with",
  "ENDS WITH": "ends with",
  LIKE: "matches SQL pattern",
  "NOT LIKE": "does not match SQL pattern",
  ">=": "greater than or equal to",
  "<=": "less than or equal to",
  "NOT STARTS WITH": "does not start with",
  "NOT ENDS WITH": "does not end with",
};

const OPERATOR_SECTIONS_BY_KIND: Record<ColumnKind, OperatorSectionConfig[]> = {
  text: [
    { label: "Text contains", operators: ["CONTAINS", "DOES NOT CONTAIN"] },
    { label: "Text starts or ends", operators: ["STARTS WITH", "NOT STARTS WITH", "ENDS WITH", "NOT ENDS WITH"] },
    { label: "Equals", operators: ["=", "!=", "EQUALS IGNORE CASE", "DOES NOT EQUAL IGNORE CASE"] },
    { label: "Lists and columns", operators: ["IN", "NOT IN", "EQUALS COLUMN", "DOES NOT EQUAL COLUMN"] },
    { label: "Empty values", operators: ["IS NULL", "IS NOT NULL"] },
  ],
  number: [
    { label: "Equals", operators: ["=", "!="] },
    { label: "Compare numbers", operators: [">", ">=", "<", "<="] },
    { label: "Lists and columns", operators: ["IN", "NOT IN", "EQUALS COLUMN", "DOES NOT EQUAL COLUMN"] },
    { label: "Empty values", operators: ["IS NULL", "IS NOT NULL"] },
  ],
  date: [
    { label: "Equals", operators: ["=", "!="] },
    { label: "Compare dates", operators: [">", ">=", "<", "<="] },
    { label: "Lists and columns", operators: ["IN", "NOT IN", "EQUALS COLUMN", "DOES NOT EQUAL COLUMN"] },
    { label: "Empty values", operators: ["IS NULL", "IS NOT NULL"] },
  ],
  boolean: [
    { label: "True or false", operators: ["IS TRUE", "IS FALSE"] },
    { label: "Compare columns", operators: ["EQUALS COLUMN", "DOES NOT EQUAL COLUMN"] },
    { label: "Empty values", operators: ["IS NULL", "IS NOT NULL"] },
  ],
  comparison_status: [
    { label: "Comparison status", operators: ["IS DIFFERENT", "IS SAME", "IS MISSING", "IS PRESENT"] },
    { label: "Equals", operators: ["=", "!="] },
  ],
  unknown: [
    { label: "Text contains", operators: ["CONTAINS", "DOES NOT CONTAIN"] },
    { label: "Text starts or ends", operators: ["STARTS WITH", "NOT STARTS WITH", "ENDS WITH", "NOT ENDS WITH"] },
    { label: "Equals", operators: ["=", "!=", "EQUALS IGNORE CASE", "DOES NOT EQUAL IGNORE CASE"] },
    { label: "Compare values", operators: [">", ">=", "<", "<="] },
    { label: "Lists and columns", operators: ["IN", "NOT IN", "EQUALS COLUMN", "DOES NOT EQUAL COLUMN"] },
    { label: "Empty values", operators: ["IS NULL", "IS NOT NULL"] },
  ],
};

const NO_VALUE_OPS = new Set<FilterOperator>([
  "IS NULL",
  "IS NOT NULL",
  "IS TRUE",
  "IS FALSE",
  "IS SAME",
  "IS DIFFERENT",
  "IS MISSING",
  "IS PRESENT",
]);

// ── Draft types with IDs for React keys ──

interface DraftFilterCondition {
  id: string;
  column: string;
  operator: FilterOperator;
  value: string;
  values: FilterListValue[];
}

interface DraftFilterGroup {
  id: string;
  logic: "AND" | "OR";
  children: DraftFilterNode[];
}

type DraftFilterNode = DraftFilterCondition | DraftFilterGroup;

function isDraftGroup(node: DraftFilterNode): node is DraftFilterGroup {
  return "logic" in node && "children" in node;
}

let nextId = 1;
function genId(): string {
  return `fnode_${nextId++}`;
}

function getColumnKind(columnName: string, columns: ColumnInfo[]): ColumnKind {
  const type = columns
    .find((col) => col.column_name === columnName)
    ?.column_type.toLowerCase() ?? "";

  if (type === "comparison_status") return "comparison_status";
  if (/(bool|boolean)/.test(type)) return "boolean";
  if (/(date|time|timestamp|interval)/.test(type)) return "date";
  if (/(int|decimal|numeric|double|float|real|hugeint|bigint|smallint|tinyint|ubigint|uinteger|usmallint|utinyint)/.test(type)) {
    return "number";
  }
  if (/(char|string|text|varchar|uuid|json)/.test(type)) return "text";
  return "unknown";
}

function getBaseOperatorSections(columnName: string, columns: ColumnInfo[]): OperatorSectionConfig[] {
  const kind = getColumnKind(columnName, columns);
  const seen = new Set<FilterOperator>();

  return OPERATOR_SECTIONS_BY_KIND[kind]
    .map((section) => ({
      ...section,
      operators: section.operators.filter((operator) => {
        if (seen.has(operator)) return false;
        seen.add(operator);
        return true;
      }),
    }))
    .filter((section) => section.operators.length > 0);
}

function getDefaultOperator(columnName: string, columns: ColumnInfo[]): FilterOperator {
  const sections = getBaseOperatorSections(columnName, columns);
  return sections[0]?.operators[0] ?? "=";
}

function isOperatorAvailableForColumn(
  columnName: string,
  columns: ColumnInfo[],
  operator: FilterOperator
): boolean {
  return getBaseOperatorSections(columnName, columns)
    .some((section) => section.operators.includes(operator));
}

function getOperatorGroups(
  columnName: string,
  columns: ColumnInfo[],
  selectedOperator: FilterOperator
): OperatorGroupOption[] {
  const getOption = (value: FilterOperator): OperatorOption => ({
    value,
    label: OPERATOR_LABELS[value],
  });

  const groups = getBaseOperatorSections(columnName, columns).map((section) => ({
    label: section.label,
    options: section.operators.map(getOption),
  }));

  if (!groups.some((group) => group.options.some((option) => option.value === selectedOperator))) {
    groups.push({
      label: "Current filter",
      options: [getOption(selectedOperator)],
    });
  }

  return groups;
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function countDraftConditions(node: DraftFilterNode): number {
  if (!isDraftGroup(node)) return 1;
  return node.children.reduce((total, child) => total + countDraftConditions(child), 0);
}

// ── Conversion helpers ──

function convertToDraft(group: FilterGroup): DraftFilterGroup {
  return {
    id: genId(),
    logic: group.logic,
    children: group.children.map((child) => {
      if (isFilterGroup(child)) {
        return convertToDraft(child);
      }
      return {
        id: genId(),
        column: child.column,
        operator: child.operator,
        value: child.value,
        values: child.values ?? (
          child.operator === "IN" || child.operator === "NOT IN"
            ? child.value
                .split(",")
                .map((value) => value.trim())
                .filter((value) => value.length > 0)
                .map((value) => ({ raw: value, label: value }))
            : []
        ),
      } as DraftFilterCondition;
    }),
  };
}

function convertFromDraft(group: DraftFilterGroup, columns: ColumnInfo[] = []): FilterGroup {
  const children: FilterNode[] = [];
  for (const child of group.children) {
    if (isDraftGroup(child)) {
      const nested = convertFromDraft(child, columns);
      // Keep groups even if empty — let SQL builder handle it
      children.push(nested);
    } else {
      // Only include conditions that have a column set and value (or no-value operator)
      const isListOperator = child.operator === "IN" || child.operator === "NOT IN";
      if (
        child.column
        && (NO_VALUE_OPS.has(child.operator) || (isListOperator ? child.values.length > 0 : child.value.trim() !== ""))
      ) {
        children.push({
          column: child.column,
          operator: child.operator,
          value: child.value,
          values: isListOperator ? child.values : undefined,
          columnType: columns.find((column) => column.column_name === child.column)?.column_type,
        });
      }
    }
  }
  return { logic: group.logic, children };
}

// ── Recursive update helpers ──

function updateNodeById(
  root: DraftFilterGroup,
  targetId: string,
  updater: (node: DraftFilterNode) => DraftFilterNode
): DraftFilterGroup {
  if (root.id === targetId) {
    return updater(root) as DraftFilterGroup;
  }
  return {
    ...root,
    children: root.children.map((child) => {
      if (child.id === targetId) {
        return updater(child);
      }
      if (isDraftGroup(child)) {
        return updateNodeById(child, targetId, updater);
      }
      return child;
    }),
  };
}

function addChildToGroup(
  root: DraftFilterGroup,
  parentId: string,
  newChild: DraftFilterNode
): DraftFilterGroup {
  if (root.id === parentId) {
    return { ...root, children: [...root.children, newChild] };
  }
  return {
    ...root,
    children: root.children.map((child) => {
      if (isDraftGroup(child)) {
        return addChildToGroup(child, parentId, newChild);
      }
      return child;
    }),
  };
}

function removeNodeById(
  root: DraftFilterGroup,
  targetId: string
): DraftFilterGroup {
  return {
    ...root,
    children: root.children
      .filter((child) => child.id !== targetId)
      .map((child) => {
        if (isDraftGroup(child)) {
          return removeNodeById(child, targetId);
        }
        return child;
      }),
  };
}

// ── Unique-value multi-select for IN operator ──

interface InValuePickerProps {
  tableName: string;
  column: string;
  selectedValues: FilterListValue[];
  onChange: (value: FilterListValue[]) => void;
}

function InValuePicker({
  tableName,
  column,
  selectedValues,
  onChange,
}: InValuePickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [uniqueValues, setUniqueValues] = useState<FilterListValue[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [listFilter, setListFilter] = useState<"all" | "selected" | "not-selected">("all");
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) setListFilter("all");
  }, [open]);

  useEffect(() => {
    if (!open) return;

    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({
        top: rect.top,
        left: rect.left,
        width: Math.max(rect.width, 300),
      });
    }

    const handler = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  useEffect(() => {
    if (!open || !tableName || !column) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const timer = window.setTimeout(() => {
      window.api
        .query(buildDistinctFilterValuesQuery(tableName, column, search))
        .then((rows) => {
          if (cancelled) return;
          setUniqueValues(rows.map((row) => ({
            raw: String(row.raw_value ?? ""),
            label: String(row.display_label ?? row.raw_value ?? ""),
          })));
          setLoading(false);
        })
        .catch((err) => {
          if (cancelled) return;
          setUniqueValues([]);
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, tableName, column, search, reloadVersion]);

  const selected = new Map(selectedValues.map((value) => [value.raw, value]));
  const availableValues = mergeFilterListValues(selectedValues, uniqueValues);

  const toggle = (value: FilterListValue) => {
    const next = new Map(selected);
    if (next.has(value.raw)) next.delete(value.raw);
    else next.set(value.raw, value);
    onChange(Array.from(next.values()));
  };

  const selectAll = () => {
    const visible = search
      ? availableValues.filter((value) =>
          value.label.toLowerCase().includes(search.toLowerCase())
        )
      : availableValues;
    const next = new Map(selected);
    for (const value of visible) next.set(value.raw, value);
    onChange(Array.from(next.values()));
  };

  const clearAll = () => onChange([]);

  const filtered = availableValues.filter((value) => {
    if (search && !value.label.toLowerCase().includes(search.toLowerCase())) return false;
    if (listFilter === "selected" && !selected.has(value.raw)) return false;
    if (listFilter === "not-selected" && selected.has(value.raw)) return false;
    return true;
  });

  const dropdown = open
    ? ReactDOM.createPortal(
        <div
          className="in-value-dropdown"
          ref={dropdownRef}
          style={{
            position: "fixed",
            bottom: window.innerHeight - pos.top + 4,
            left: pos.left,
            width: pos.width,
          }}
        >
          <div className="in-value-dropdown-header">
            <SearchInput
              placeholder="Search values..."
              value={search}
              onChange={setSearch}
              small
              autoFocus
            />
            <div className="in-value-dropdown-actions">
              <Button small minimal text="All" onClick={selectAll} />
              <Button small minimal text="None" onClick={clearAll} />
              <span className="in-value-dropdown-separator" />
              <Button
                small
                minimal
                text="Selected"
                active={listFilter === "selected"}
                onClick={() => setListFilter(listFilter === "selected" ? "all" : "selected")}
              />
              <Button
                small
                minimal
                text="Not Selected"
                active={listFilter === "not-selected"}
                onClick={() => setListFilter(listFilter === "not-selected" ? "all" : "not-selected")}
              />
              <span className="in-value-dropdown-count">
                {selected.size} / {availableValues.length}
              </span>
            </div>
          </div>
          <div className="in-value-dropdown-list">
            {loading && (
              <div className="in-value-dropdown-empty">Loading...</div>
            )}
            {!loading && error && (
              <div className="in-value-dropdown-error">
                <span>{error}</span>
                <Button small minimal icon="refresh" text="Retry" onClick={() => setReloadVersion((value) => value + 1)} />
              </div>
            )}
            {!loading && !error && filtered.length === 0 && (
              <div className="in-value-dropdown-empty">No values found</div>
            )}
            {!loading && !error &&
              filtered.map((value) => (
                <label
                  key={value.raw}
                  className="in-value-dropdown-item"
                >
                  <Checkbox
                    checked={selected.has(value.raw)}
                    aria-label={`Include ${value.label || "empty value"}`}
                    onChange={() => toggle(value)}
                    style={{ marginBottom: 0 }}
                  />
                  <span className="in-value-dropdown-label" title={value.label}>
                    {value.label === "" ? "(empty)" : value.label}
                  </span>
                </label>
              ))}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className="in-value-picker-wrapper" ref={anchorRef}>
      <Button
        className="filter-value-btn"
        small
        rightIcon={open ? "caret-up" : "caret-down"}
        text={
          selected.size > 0 ? `${selected.size} selected` : "Select values..."
        }
        onClick={() => setOpen((v) => !v)}
      />
      {dropdown}
    </div>
  );
}

// ── Operator picker ──

interface OperatorSelectProps {
  value: FilterOperator;
  groups: OperatorGroupOption[];
  onChange: (operator: FilterOperator) => void;
}

function OperatorSelect({
  value,
  groups,
  onChange,
}: OperatorSelectProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const selectedLabel = groups
    .flatMap((group) => group.options)
    .find((op) => op.value === value)?.label ?? OPERATOR_LABELS[value];

  const renderGroup = (label: string, options: OperatorOption[]) => (
    <div className="filter-op-menu-group" key={label}>
      <div className="filter-op-menu-label">{label}</div>
      {options.map((op) => (
        <button
          key={op.value}
          type="button"
          className={`filter-op-option${op.value === value ? " active" : ""}`}
          onClick={() => {
            onChange(op.value);
            setOpen(false);
          }}
          role="menuitemradio"
          aria-checked={op.value === value}
        >
          <span className="filter-op-option-text">{op.label}</span>
          {op.value === value && <Icon icon="tick" iconSize={12} />}
        </button>
      ))}
    </div>
  );

  return (
    <Popover2
      content={
        <div className="filter-op-menu" role="menu" aria-label="Filter operator">
          {groups.map((group) => renderGroup(group.label, group.options))}
        </div>
      }
      isOpen={open}
      onInteraction={(nextOpen) => setOpen(nextOpen)}
      placement="bottom-start"
      minimal
      matchTargetWidth
    >
      <button
        type="button"
        className="filter-op-trigger"
        aria-label="Filter operator"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="filter-op-trigger-text">{selectedLabel}</span>
        <Icon icon={open ? "caret-up" : "caret-down"} iconSize={12} className="filter-op-trigger-caret" />
      </button>
    </Popover2>
  );
}

// ── Filter Condition Row (leaf) ──

interface FilterConditionRowProps {
  draft: DraftFilterCondition;
  columns: ColumnInfo[];
  activeTable: string | null;
  connectorLabel: "Where" | "And" | "Or";
  onUpdate: (id: string, patch: Partial<DraftFilterCondition>) => void;
  onRemove: (id: string) => void;
  onApply: () => void;
}

function FilterConditionRow({
  draft,
  columns,
  activeTable,
  connectorLabel,
  onUpdate,
  onRemove,
  onApply,
}: FilterConditionRowProps): React.ReactElement {
  const operatorGroups = getOperatorGroups(draft.column, columns, draft.operator);
  const connectorClass = connectorLabel.toLowerCase();
  const isColumnComparison = isColumnComparisonOperator(draft.operator);
  const isNumberValueInput = getColumnKind(draft.column, columns) === "number" && !isColumnComparison;

  return (
    <div className="filter-row">
      <span className={`filter-row-connector filter-row-connector-${connectorClass}`}>
        {connectorLabel}
      </span>

      <SearchableColumnSelect
        value={draft.column}
        onChange={(val) => {
          const operator = isOperatorAvailableForColumn(val, columns, draft.operator)
            ? draft.operator
            : getDefaultOperator(val, columns);
          onUpdate(draft.id, { column: val, operator, value: "", values: [] });
        }}
        columns={columns}
        placeholder="Column..."
        className="filter-col-select"
        showType
        fill
      />

      <OperatorSelect
        value={draft.operator}
        groups={operatorGroups}
        onChange={(operator) => {
          const wasColumnComparison = isColumnComparisonOperator(draft.operator);
          const nextIsColumnComparison = isColumnComparisonOperator(operator);
          onUpdate(draft.id, {
            operator,
            value:
              operator === "IN" ||
              operator === "NOT IN" ||
              draft.operator === "IN" ||
              draft.operator === "NOT IN" ||
              wasColumnComparison !== nextIsColumnComparison
                ? ""
                : draft.value,
            values:
              operator === "IN" || operator === "NOT IN"
                ? []
                : draft.values,
          });
        }}
      />

      {NO_VALUE_OPS.has(draft.operator) ? (
        <div className="filter-value-empty" />
      ) : (draft.operator === "IN" || draft.operator === "NOT IN") && activeTable ? (
        <InValuePicker
          tableName={activeTable}
          column={draft.column}
          selectedValues={draft.values}
          onChange={(values) => onUpdate(draft.id, {
            values,
            value: values.map((value) => value.label).join(", "),
          })}
        />
      ) : isColumnComparison ? (
        <SearchableColumnSelect
          value={draft.value}
          onChange={(value) => onUpdate(draft.id, { value })}
          columns={columns}
          placeholder="Compare column..."
          className="filter-value-col-select"
          showType
          fill
        />
      ) : (
        <InputGroup
          className="filter-value-input"
          value={draft.value}
          onChange={(e) => {
            if (draft.operator === "IN" || draft.operator === "NOT IN") {
              const value = e.target.value;
              onUpdate(draft.id, {
                value,
                values: value
                  .split(",")
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0)
                  .map((item) => ({ raw: item, label: item })),
              });
              return;
            }
            if (!isNumberValueInput || isAllowedNumberInputValue(e.target.value, { allowDecimal: true, allowNegative: true })) {
              onUpdate(draft.id, { value: e.target.value });
            } else {
              showNumberInputExpectation(e.currentTarget, { allowDecimal: true, allowNegative: true });
            }
          }}
          placeholder={
            draft.operator === "CONTAINS" || draft.operator === "DOES NOT CONTAIN"
              ? "text or regex"
              : "value"
          }
          inputMode={isNumberValueInput ? "decimal" : undefined}
          onKeyDown={(e) => {
            if (isNumberValueInput) {
              guardNumberInputKeyDown(e, { allowDecimal: true, allowNegative: true });
            }
            if (
              isNumberValueInput
              && e.key === "Enter"
              && !isAllowedNumberInputValue(draft.value, { allowDecimal: true, allowNegative: true, allowPartial: false })
            ) {
              e.preventDefault();
            }
            if (!e.defaultPrevented && e.key === "Enter") onApply();
          }}
          onPaste={(e) => {
            if (isNumberValueInput) guardNumberInputPaste(e, { allowDecimal: true, allowNegative: true });
          }}
          onDrop={(e) => {
            if (isNumberValueInput) guardNumberInputDrop(e, { allowDecimal: true, allowNegative: true });
          }}
          onBlur={(e) => {
            if (
              isNumberValueInput
              && !isAllowedNumberInputValue(draft.value, { allowDecimal: true, allowNegative: true, allowPartial: false })
            ) {
              showNumberInputExpectation(e.currentTarget, { allowDecimal: true, allowNegative: true });
              onUpdate(draft.id, { value: "" });
            }
          }}
        />
      )}

      <Button
        className="filter-row-remove"
        icon="small-cross"
        minimal
        small
        onClick={() => onRemove(draft.id)}
        title="Remove filter"
        aria-label="Remove filter"
      />
    </div>
  );
}

// ── Filter Group Renderer (recursive) ──

interface FilterGroupRendererProps {
  group: DraftFilterGroup;
  columns: ColumnInfo[];
  activeTable: string | null;
  depth: number;
  isRoot: boolean;
  emptyTitle: string;
  emptyText: string;
  onUpdateRoot: (updater: (root: DraftFilterGroup) => DraftFilterGroup) => void;
  onApply: () => void;
  scrollContainerRef?: React.RefObject<HTMLDivElement>;
}

function FilterGroupRenderer({
  group,
  columns,
  activeTable,
  depth,
  isRoot,
  emptyTitle,
  emptyText,
  onUpdateRoot,
  onApply,
  scrollContainerRef,
}: FilterGroupRendererProps): React.ReactElement {
  const depthIndex = depth % 4;

  const handleSetLogic = (logic: DraftFilterGroup["logic"]) => {
    if (group.logic === logic) return;
    onUpdateRoot((root) =>
      updateNodeById(root, group.id, (node) => ({
        ...(node as DraftFilterGroup),
        logic,
      })) as DraftFilterGroup
    );
  };

  const scrollToBottom = () => {
    if (scrollContainerRef?.current) {
      requestAnimationFrame(() => {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        scrollContainerRef.current?.scrollTo({
          top: scrollContainerRef.current.scrollHeight,
          behavior: reduceMotion ? "auto" : "smooth",
        });
      });
    }
  };

  const createDefaultCondition = (): DraftFilterCondition => {
    const col = columns.length > 0 ? columns[0].column_name : "";
    return {
      id: genId(),
      column: col,
      operator: getDefaultOperator(col, columns),
      value: "",
      values: [],
    };
  };

  const handleAddCondition = () => {
    const newCond = createDefaultCondition();
    onUpdateRoot((root) => addChildToGroup(root, group.id, newCond));
    scrollToBottom();
  };

  const handleAddSubGroup = () => {
    const newGroup: DraftFilterGroup = {
      id: genId(),
      logic: group.logic === "AND" ? "OR" : "AND",
      children: [createDefaultCondition()],
    };
    onUpdateRoot((root) => addChildToGroup(root, group.id, newGroup));
    scrollToBottom();
  };

  const handleRemoveChild = (childId: string) => {
    onUpdateRoot((root) => removeNodeById(root, childId));
  };

  const handleUpdateCondition = (id: string, patch: Partial<DraftFilterCondition>) => {
    onUpdateRoot((root) =>
      updateNodeById(root, id, (node) => ({ ...node, ...patch })) as DraftFilterGroup
    );
  };

  const handleRemoveSelf = () => {
    onUpdateRoot((root) => removeNodeById(root, group.id));
  };

  const groupDraftConditionCount = countDraftConditions(group);
  const isEmptyRoot = isRoot && group.children.length === 0;
  const filterCountLabel = pluralize(groupDraftConditionCount, "filter");
  const matchTargetLabel = isRoot
    ? (group.logic === "AND" ? "filters" : "filter")
    : `of ${filterCountLabel}`;
  const getConnectorLabel = (index: number): "Where" | "And" | "Or" => {
    if (index === 0) return "Where";
    return group.logic === "AND" ? "And" : "Or";
  };

  if (isEmptyRoot) {
    return (
      <div className="filter-empty-state">
        <div className="filter-empty-icon" aria-hidden="true">
          <Icon icon="filter" iconSize={18} />
        </div>
        <div className="filter-empty-main">
          <div className="filter-empty-copy">
            <span className="filter-empty-title">{emptyTitle}</span>
            <span className="filter-empty-text">{emptyText}</span>
          </div>
          <div className="filter-empty-actions">
            <Button
              icon="add"
              text="Add filter"
              small
              intent={Intent.PRIMARY}
              disabled={columns.length === 0}
              onClick={handleAddCondition}
            />
            <Button
              icon="group-objects"
              text="Filter group"
              small
              minimal
              disabled={columns.length === 0}
              onClick={handleAddSubGroup}
              title="Add a group of filters with its own all/any match"
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`filter-group ${isRoot ? "filter-group-root" : "filter-group-nested"}`}
      data-depth={depthIndex}
    >
      <div className="filter-group-header">
        <div className="filter-group-title">
          <span className="filter-group-label">{isRoot ? "Show rows that match" : "Filter group: match"}</span>
          <div className="filter-group-logic-switch" role="group" aria-label="Filter match mode">
            <button
              type="button"
              className={`filter-group-logic-option filter-group-logic-option-all${group.logic === "AND" ? " active" : ""}`}
              aria-pressed={group.logic === "AND"}
              onClick={() => handleSetLogic("AND")}
              title="Match all filters"
            >
              All
            </button>
            <button
              type="button"
              className={`filter-group-logic-option filter-group-logic-option-any${group.logic === "OR" ? " active" : ""}`}
              aria-pressed={group.logic === "OR"}
              onClick={() => handleSetLogic("OR")}
              title="Match any filter"
            >
              Any
            </button>
          </div>
          <span className="filter-group-count">
            {matchTargetLabel}
          </span>
        </div>
        <div className="filter-group-header-actions">
          <Button
            className="filter-group-action-button"
            icon="add"
            text="Add filter"
            small
            minimal
            onClick={handleAddCondition}
            title="Add filter"
            aria-label="Add filter"
          />
          <Button
            className="filter-group-action-button"
            icon="group-objects"
            text="Add group"
            small
            minimal
            onClick={handleAddSubGroup}
            title="Add a filter group with its own all/any match"
            aria-label="Add filter group"
          />
          {!isRoot && (
            <Button
              className="filter-group-action-button filter-group-delete"
              icon="small-cross"
              minimal
              small
              onClick={handleRemoveSelf}
              title="Remove filter group"
              aria-label="Remove filter group"
            />
          )}
        </div>
      </div>

      <div className="filter-group-children">
        {group.children.length === 0 ? (
          <div className="filter-group-empty-inline">
            <Icon icon="filter" iconSize={12} />
            <span>Empty group</span>
          </div>
        ) : group.children.map((child, index) => {
          const connectorLabel = getConnectorLabel(index);

          if (isDraftGroup(child)) {
            return (
              <div className="filter-group-relation" key={child.id}>
                <span className={`filter-row-connector filter-row-connector-${connectorLabel.toLowerCase()}`}>
                  {connectorLabel}
                </span>
                <FilterGroupRenderer
                  group={child}
                  columns={columns}
                  activeTable={activeTable}
                  depth={depth + 1}
                  isRoot={false}
                  emptyTitle={emptyTitle}
                  emptyText={emptyText}
                  onUpdateRoot={onUpdateRoot}
                  onApply={onApply}
                  scrollContainerRef={scrollContainerRef}
                />
              </div>
            );
          }

          return (
            <FilterConditionRow
              key={child.id}
              draft={child}
              columns={columns}
              activeTable={activeTable}
              connectorLabel={connectorLabel}
              onUpdate={handleUpdateCondition}
              onRemove={handleRemoveChild}
              onApply={onApply}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── QC Panel ──

function suggestQcColumnName(columns: ColumnInfo[]): string {
  const existing = new Set(columns.map((column) => column.column_name));
  if (!existing.has("qc_status")) return "qc_status";
  let i = 2;
  while (existing.has(`qc_status_${i}`)) i++;
  return `qc_status_${i}`;
}

function suggestQcNotesColumnName(columns: ColumnInfo[], qcColumnName: string): string {
  const existing = new Set(columns.map((column) => column.column_name));
  const base = `${(qcColumnName || "qc_status").trim() || "qc_status"}_notes`;
  if (!existing.has(base)) return base;
  let i = 2;
  while (existing.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

const DEFAULT_QC_OPTIONS = "Pass\nFail\nReview";

function parseQcOptions(text: string): string[] {
  const seen = new Set<string>();
  const options: string[] = [];
  for (const rawOption of text.split(/\r?\n|,/)) {
    const option = rawOption.trim();
    if (!option || seen.has(option)) continue;
    seen.add(option);
    options.push(option);
  }
  return options;
}

function sortQcOptionsForPreview(options: string[], sortMode: QcOptionSortMode): string[] {
  if (sortMode === "entered") return options;
  if (sortMode === "numeric") {
    return [...options].sort((a, b) => {
      const aNum = Number(a);
      const bNum = Number(b);
      const aValid = Number.isFinite(aNum);
      const bValid = Number.isFinite(bNum);
      if (aValid && bValid) return aNum - bNum;
      if (aValid) return -1;
      if (bValid) return 1;
      return a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
    });
  }
  return [...options].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true }));
}

function getQcOptionSortMeta(options: string[], sortMode: QcOptionSortMode): {
  sortedOptions: string[];
  numericCount: number;
  textCount: number;
  note: string;
  tone: "neutral" | "warning";
} {
  const sortedOptions = sortQcOptionsForPreview(options, sortMode);
  const numericCount = options.filter((option) => Number.isFinite(Number(option))).length;
  const textCount = options.length - numericCount;

  if (sortMode === "numeric") {
    if (numericCount === 0 && options.length > 0) {
      return {
        sortedOptions,
        numericCount,
        textCount,
        note: "No numeric values found; preview falls back to text order.",
        tone: "warning",
      };
    }
    if (textCount > 0) {
      return {
        sortedOptions,
        numericCount,
        textCount,
        note: `${numericCount} numeric, ${textCount} text. Numbers sort first; text follows A-Z.`,
        tone: "warning",
      };
    }
    return {
      sortedOptions,
      numericCount,
      textCount,
      note: "All values are numeric; the QC column will be stored as number.",
      tone: "neutral",
    };
  }

  return {
    sortedOptions,
    numericCount,
    textCount,
    note: sortMode === "entered" ? "Uses the order entered above." : "Sorted A-Z, ignoring case.",
    tone: "neutral",
  };
}

function findQcFilter(group: FilterGroup, column: string): DraftFilterCondition | null {
  for (const child of group.children) {
    if (isFilterGroup(child)) {
      const nested = findQcFilter(child, column);
      if (nested) return nested;
      continue;
    }
    if (child.column === column) {
      return {
        id: "",
        column: child.column,
        operator: child.operator,
        value: child.value,
        values: child.values ?? [],
      };
    }
  }
  return null;
}

function removeQcColumnFilters(group: FilterGroup, column: string): FilterGroup {
  const children: FilterNode[] = [];
  for (const child of group.children) {
    if (isFilterGroup(child)) {
      const nested = removeQcColumnFilters(child, column);
      if (nested.children.length > 0) children.push(nested);
      continue;
    }
    if (child.column !== column) children.push(child);
  }
  return { ...group, children };
}

function qcSqlLiteral(value: string, valueType: QcSession["valueType"]): string {
  if (valueType === "number") {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? String(numeric) : "NULL";
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function QcPanel({
  columns,
  activeTable,
  activeFilters,
  totalRows,
  session,
  onCreate,
  onResetAll,
  onMarkDone,
  onResume,
  onStartNew,
  onQuickFilter,
  visible,
}: {
  columns: ColumnInfo[];
  activeTable: string | null;
  activeFilters: FilterGroup;
  totalRows: number;
  session?: QcSession | null;
  onCreate?: (config: QcCreateConfig) => Promise<void>;
  onResetAll?: () => Promise<void>;
  onMarkDone?: () => Promise<void>;
  onResume?: () => void;
  onStartNew?: () => void;
  onQuickFilter?: (value: string | null | "__all__") => void;
  visible: boolean;
}): React.ReactElement | null {
  const suggestedName = suggestQcColumnName(columns);
  const [mode, setMode] = useState<QcColumnMode>("boolean");
  const [columnName, setColumnName] = useState(suggestedName);
  const [trueValue, setTrueValue] = useState("Accepted");
  const [falseValue, setFalseValue] = useState("Rejected");
  const [optionsText, setOptionsText] = useState(DEFAULT_QC_OPTIONS);
  const [optionDraft, setOptionDraft] = useState("");
  const [optionSearch, setOptionSearch] = useState("");
  const [sortMode, setSortMode] = useState<QcOptionSortMode>("alpha");
  const [notesEnabled, setNotesEnabled] = useState(false);
  const [notesColumnName, setNotesColumnName] = useState("");
  const [notesNameTouched, setNotesNameTouched] = useState(false);
  const [working, setWorking] = useState<"create" | "reset" | "done" | null>(null);
  const [message, setMessage] = useState<{ tone: "error" | "success"; text: string } | null>(null);
  const [progress, setProgress] = useState<{ reviewed: number; total: number; valueCounts: Record<string, number> } | null>(null);

  const suggestedNotesName = suggestQcNotesColumnName(columns, columnName);

  useEffect(() => {
    setColumnName((prev) => {
      if (prev && !columns.some((column) => column.column_name === prev)) return prev;
      return suggestedName;
    });
  }, [columns, suggestedName]);

  useEffect(() => {
    if (notesNameTouched) return;
    setNotesColumnName(suggestedNotesName);
  }, [notesNameTouched, suggestedNotesName]);

  const markedCount = session ? Object.keys(session.valuesByRowId).length : 0;
  const parsedOptions = parseQcOptions(optionsText);
  const optionSortMeta = getQcOptionSortMeta(parsedOptions, sortMode);
  const previewOptions = optionSortMeta.sortedOptions;
  const displayedOptions = optionSearch.trim()
    ? previewOptions.filter((option) => option.toLowerCase().includes(optionSearch.trim().toLowerCase()))
    : previewOptions;
  const canCreate = !!activeTable && !!onCreate && !session && !working;
  const activeMode = session?.mode ?? mode;
  const isOptionMode = activeMode === "options";
  const reviewedRows = progress?.reviewed ?? (session ? markedCount : 0);
  const totalReviewRows = progress?.total ?? totalRows;
  const notQcRows = Math.max(0, totalReviewRows - reviewedRows);
  const progressPercent = totalReviewRows > 0 ? Math.round((reviewedRows / totalReviewRows) * 100) : 0;

  useEffect(() => {
    if (!visible || !activeTable || !session) {
      setProgress(null);
      return;
    }

    let cancelled = false;
    const statsFilters = removeQcColumnFilters(activeFilters, session.columnName);
    const whereClause = buildFilterGroupClause(statsFilters);
    const wherePrefix = whereClause ? `WHERE ${whereClause} AND` : "WHERE";
    const countValues = session.mode === "boolean" ? [session.trueValue, session.falseValue] : session.options;
    const countSelects = countValues.map((value, index) =>
      `SUM(CASE WHEN ${escapeIdent(session.columnName)} = ${qcSqlLiteral(value, session.valueType)} THEN 1 ELSE 0 END) AS ${escapeIdent(`value_${index}`)}`
    );
    const selectParts = [
      `COUNT(*) AS total`,
      `SUM(CASE WHEN ${escapeIdent(session.columnName)} IS NOT NULL THEN 1 ELSE 0 END) AS reviewed`,
      ...countSelects,
    ];
    const sql = `SELECT ${selectParts.join(", ")} FROM ${escapeIdent(activeTable)} ${wherePrefix} TRUE`;
    window.api.query(sql)
      .then((rows) => {
        if (cancelled) return;
        const row = rows[0] ?? {};
        const valueCounts = countValues.reduce<Record<string, number>>((acc, value, index) => {
          acc[value] = Number(row[`value_${index}`] ?? 0);
          return acc;
        }, {});
        setProgress({
          total: Number(row.total ?? totalRows),
          reviewed: Number(row.reviewed ?? 0),
          valueCounts,
        });
      })
      .catch(() => {
        if (!cancelled) setProgress({ total: totalRows, reviewed: markedCount, valueCounts: {} });
      });

    return () => {
      cancelled = true;
    };
  }, [activeFilters, activeTable, markedCount, session, totalRows, visible]);

  if (!visible) return null;

  const resetBoolDefaults = () => {
    setTrueValue("Accepted");
    setFalseValue("Rejected");
    setMessage(null);
  };

  const resetOptionDefaults = () => {
    setOptionsText(DEFAULT_QC_OPTIONS);
    setOptionDraft("");
    setOptionSearch("");
    setSortMode("alpha");
    setMessage(null);
  };

  const setDraftMode = (nextMode: QcColumnMode) => {
    setMode(nextMode);
    setMessage(null);
    if (nextMode === "options") {
      setOptionsText((prev) => parseQcOptions(prev).length > 0 ? prev : DEFAULT_QC_OPTIONS);
    }
  };

  const addOption = () => {
    const nextOption = optionDraft.trim();
    if (!nextOption) return;
    const nextOptions = parseQcOptions(`${optionsText}\n${nextOption}`);
    setOptionsText(nextOptions.join("\n"));
    setOptionDraft("");
    setMessage(null);
  };

  const removeOption = (option: string) => {
    setOptionsText(parsedOptions.filter((item) => item !== option).join("\n"));
    setMessage(null);
  };

  const handleCreate = async () => {
    if (!onCreate || !canCreate) return;
    setWorking("create");
    setMessage(null);
    try {
      await onCreate({
        columnName,
        mode,
        trueValue,
        falseValue,
        options: parsedOptions,
        optionSortMode: sortMode,
        notesEnabled,
        notesColumnName,
      });
      setMessage({ tone: "success", text: "QC column ready" });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "Unable to create QC column" });
    } finally {
      setWorking(null);
    }
  };

  const handleResetAll = async () => {
    if (!onResetAll || !session || session.done) return;
    setWorking("reset");
    setMessage(null);
    try {
      await onResetAll();
      setMessage({ tone: "success", text: "QC values reset" });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "Unable to reset QC" });
    } finally {
      setWorking(null);
    }
  };

  const handleMarkDone = async () => {
    if (!onMarkDone || !session || session.done) return;
    setWorking("done");
    setMessage(null);
    try {
      await onMarkDone();
      setMessage({ tone: "success", text: "QC marked done" });
    } catch (err) {
      setMessage({ tone: "error", text: err instanceof Error ? err.message : "Unable to mark QC done" });
    } finally {
      setWorking(null);
    }
  };

  const values = session ? Object.values(session.valuesByRowId).filter(Boolean) : [];
  const sessionValueCounts = values.reduce<Record<string, number>>((acc, value) => {
    acc[value] = (acc[value] ?? 0) + 1;
    return acc;
  }, {});
  const valueCounts = progress?.valueCounts ?? sessionValueCounts;
  const sessionValues = session
    ? session.mode === "boolean"
      ? [session.trueValue, session.falseValue]
      : session.options
    : [];
  const quickFilterValues = sessionValues.slice(0, 6);
  const activeQcFilter = session ? findQcFilter(activeFilters, session.columnName) : null;
  const activeQcFilterLabel = activeQcFilter
    ? activeQcFilter.operator === "IS NULL"
      ? "Not QC'd"
      : activeQcFilter.value
    : "";

  return (
    <div className="qc-panel">
      <div className="qc-workbench">
        <div className="qc-card qc-create-card">
          <div className="qc-create-header">
            <div className="qc-card-title">
              <div>
                <strong>{session ? "QC field" : "Create QC field"}</strong>
                <em>{activeMode === "boolean" ? "Boolean" : "Dropdown"}</em>
              </div>
              {session && (
                <Tag minimal intent={session.done ? Intent.SUCCESS : Intent.PRIMARY}>
                  {session.done ? "Done" : "Draft"}
                </Tag>
              )}
            </div>
          </div>

          <div className="qc-create-body">
            <label className="qc-panel-field qc-column-field">
              <span>Column</span>
              <InputGroup
                value={session?.columnName ?? columnName}
                onChange={(e) => {
                  setColumnName(e.target.value);
                  setMessage(null);
                }}
                small
                disabled={!!session || !canCreate}
              />
            </label>

            <div className="qc-panel-field">
              <span>Field type</span>
              <div className="qc-mode-toggle qc-mode-toggle-full" role="group" aria-label="QC type">
                <button
                  type="button"
                  className={activeMode === "boolean" ? "active" : ""}
                  onClick={() => setDraftMode("boolean")}
                  disabled={!!session}
                >
                  Boolean
                </button>
                <button
                  type="button"
                  className={activeMode === "options" ? "active" : ""}
                  onClick={() => setDraftMode("options")}
                  disabled={!!session}
                >
                  Dropdown
                </button>
              </div>
            </div>

            {activeMode === "boolean" ? (
              <div className="qc-bool-values-grid">
                <label className="qc-panel-field qc-value-field accepted">
                  <span>
                    <Icon icon="tick" size={11} />
                    Tick value
                  </span>
                  <InputGroup
                    value={session?.trueValue ?? trueValue}
                    onChange={(e) => setTrueValue(e.target.value)}
                    small
                    disabled={!!session || !canCreate}
                  />
                </label>
                <label className="qc-panel-field qc-value-field rejected">
                  <span>
                    <Icon icon="cross" size={11} />
                    X value
                  </span>
                  <InputGroup
                    value={session?.falseValue ?? falseValue}
                    onChange={(e) => setFalseValue(e.target.value)}
                    small
                    disabled={!!session || !canCreate}
                  />
                </label>
              </div>
            ) : (
              <div className="qc-create-note">
                Dropdown options are managed in the values panel.
              </div>
            )}
          </div>

          <div className="qc-notes-option">
            <Checkbox
              checked={session ? !!session.notesColumnName : notesEnabled}
              disabled={!!session || !canCreate}
              label="Add notes column"
              className="qc-notes-checkbox"
              onChange={(e) => {
                setNotesEnabled((e.target as HTMLInputElement).checked);
                setMessage(null);
              }}
            />
            {(session ? !!session.notesColumnName : notesEnabled) && (
              <InputGroup
                value={session?.notesColumnName ?? notesColumnName}
                onChange={(e) => {
                  setNotesColumnName(e.target.value);
                  setNotesNameTouched(true);
                  setMessage(null);
                }}
                placeholder={suggestedNotesName}
                small
                disabled={!!session || !canCreate}
                aria-label="Notes column name"
              />
            )}
            <em>Free-text note per row, edited inline in the grid</em>
          </div>

          <div className="qc-create-footer">
            <Checkbox
              checked
              disabled
              label="Leave untouched as NULL"
              className="qc-null-checkbox"
            />

            {!session && (
              <div className="qc-create-actions">
                {activeMode === "boolean" && (
                  <Button
                    small
                    icon="undo"
                    text="Reset values"
                    disabled={!canCreate}
                    onClick={resetBoolDefaults}
                  />
                )}
                <Button
                  intent={Intent.PRIMARY}
                  icon="add"
                  text="Create QC Column"
                  disabled={!canCreate || (isOptionMode && parsedOptions.length === 0)}
                  loading={working === "create"}
                  onClick={handleCreate}
                  small
                />
              </div>
            )}
          </div>
        </div>

        <div className="qc-card qc-values-card">
          <div className="qc-card-title">
            <div>
              <strong>{isOptionMode ? "Dropdown values" : "Boolean actions"}</strong>
              <em>{isOptionMode ? "used when field type is Dropdown" : "what users click in the QC column"}</em>
            </div>
            {!session && isOptionMode && (
              <Button
                small
                icon="undo"
                text="Reset"
                disabled={!canCreate}
                onClick={resetOptionDefaults}
              />
            )}
          </div>

          {isOptionMode ? (
            <>
              <div className="qc-values-toolbar">
                <InputGroup
                  leftIcon="add"
                  placeholder="Add value..."
                  value={optionDraft}
                  onChange={(e) => setOptionDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addOption();
                    }
                  }}
                  small
                  className="qc-add-option-input"
                  disabled={!!session || !canCreate}
                />
                <div className="qc-option-sort-buttons" role="group" aria-label="Option sort">
                  {[
                    ["alpha", "A-Z caseless"],
                    ["numeric", "Numeric-aware"],
                    ["entered", "Entered order"],
                  ].map(([value, label]) => (
                    <button
                      type="button"
                      key={value}
                      className={sortMode === value ? "active" : ""}
                      onClick={() => setSortMode(value as QcOptionSortMode)}
                      disabled={!!session || !canCreate}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <InputGroup
                leftIcon="search"
                placeholder="Search values..."
                value={optionSearch}
                onChange={(e) => setOptionSearch(e.target.value)}
                small
                className="qc-option-search"
              />
              <div className="qc-values-list">
                {(session ? sessionValues : displayedOptions).length > 0 ? (
                  (session ? sessionValues : displayedOptions).map((option) => (
                    <div className="qc-value-row" key={option}>
                      <Icon icon="drag-handle-vertical" size={13} />
                      <span title={option}>{option}</span>
                      {session && valueCounts[option] !== undefined && (
                        <Tag minimal>{valueCounts[option].toLocaleString()}</Tag>
                      )}
                      {!session && (
                        <Button
                          small
                          minimal
                          icon="trash"
                          title="Remove value"
                          aria-label={`Remove ${option}`}
                          onClick={() => removeOption(option)}
                        />
                      )}
                    </div>
                  ))
                ) : (
                  <div className="qc-values-empty">No values</div>
                )}
              </div>
              {!session && (
                <div className={`qc-option-sort-note ${optionSortMeta.tone}`}>
                  {optionSortMeta.note}
                </div>
              )}
            </>
          ) : (
            <div className="qc-boolean-preview">
              <div className="qc-boolean-action-row accepted">
                <span className="qc-boolean-action-icon">
                  <Icon icon="tick" size={13} />
                </span>
                <div>
                  <strong>{session?.trueValue ?? trueValue}</strong>
                  <span>Tick writes this value</span>
                </div>
              </div>
              <div className="qc-boolean-action-row rejected">
                <span className="qc-boolean-action-icon">
                  <Icon icon="cross" size={13} />
                </span>
                <div>
                  <strong>{session?.falseValue ?? falseValue}</strong>
                  <span>X writes this value</span>
                </div>
              </div>
              <div className="qc-boolean-action-row blank">
                <span className="qc-boolean-action-icon">
                  <Icon icon="reset" size={13} />
                </span>
                <div>
                  <strong>Blank</strong>
                  <span>Not QC'd rows remain NULL</span>
                </div>
              </div>
              <div className="qc-option-sort-note neutral">
                While QC is active the grid shows icons. Mark done keeps the selected values in the column.
              </div>
            </div>
          )}
        </div>

        <div className="qc-card qc-progress-card">
          <div className="qc-card-title">
            <strong>Progress</strong>
          </div>
          <div className="qc-progress-body">
            <div
              className="qc-progress-ring"
              style={{ "--qc-progress": `${Math.min(100, progressPercent)}%` } as React.CSSProperties}
            >
              <span>{progressPercent}%</span>
            </div>
            <div className="qc-progress-counts">
              <strong>{reviewedRows.toLocaleString()}</strong>
              <span>reviewed</span>
              <strong className="muted">{notQcRows.toLocaleString()}</strong>
              <span>not QC'd</span>
            </div>
          </div>
          <div className="qc-progress-total">
            {totalReviewRows.toLocaleString()} current rows
          </div>

          <div className="qc-filter-block">
            <div className="qc-filter-heading">
              <strong>Filter QC</strong>
              <Icon icon="info-sign" size={13} />
            </div>
            {session ? (
              <div className="qc-filter-options">
                <button
                  type="button"
                  disabled={!onQuickFilter}
                  className={!activeQcFilter ? "active" : ""}
                  onClick={() => onQuickFilter?.("__all__")}
                >
                  <span>All</span>
                </button>
                <button
                  type="button"
                  disabled={!onQuickFilter}
                  className={activeQcFilterLabel === "Not QC'd" ? "active" : ""}
                  onClick={() => onQuickFilter?.(null)}
                >
                  <span>Not QC'd</span>
                  <strong>{notQcRows.toLocaleString()}</strong>
                </button>
                {quickFilterValues.map((value) => (
                  <button
                    type="button"
                    key={value}
                    disabled={!onQuickFilter}
                    className={activeQcFilterLabel === value ? "active" : ""}
                    onClick={() => onQuickFilter?.(value)}
                  >
                    <span title={value}>{value}</span>
                    <strong>{(valueCounts[value] ?? 0).toLocaleString()}</strong>
                  </button>
                ))}
              </div>
            ) : (
              <div className="qc-filter-empty">
                Create the QC column to enable quick filters.
              </div>
            )}
            {session && activeQcFilterLabel && (
              <div className="qc-applied-filter">
                <span>{session?.columnName} = {activeQcFilterLabel}</span>
                <button type="button" onClick={() => onQuickFilter?.("__all__")}>
                  <Icon icon="cross" size={11} />
                </button>
              </div>
            )}
          </div>

          {session && (
            <div className="qc-progress-actions">
              {session.done ? (
                <>
                  <Button
                    small
                    icon="edit"
                    text="Resume QC"
                    disabled={!onResume}
                    onClick={() => {
                      setMessage(null);
                      onResume?.();
                    }}
                  />
                  <Button
                    small
                    intent={Intent.PRIMARY}
                    icon="add"
                    text="Start New QC"
                    disabled={!onStartNew}
                    onClick={() => {
                      setMessage(null);
                      onStartNew?.();
                    }}
                  />
                </>
              ) : (
                <>
                  <Button
                    small
                    icon="undo"
                    text="Reset"
                    disabled={reviewedRows === 0 || !!working}
                    loading={working === "reset"}
                    onClick={handleResetAll}
                  />
                  <Button
                    small
                    intent={Intent.PRIMARY}
                    icon="tick"
                    text="Mark Done"
                    disabled={!!working}
                    loading={working === "done"}
                    onClick={handleMarkDone}
                  />
                </>
              )}
            </div>
          )}
        </div>
      </div>

      {message && (
        <div className={`qc-panel-message ${message.tone}`}>
          <Icon icon={message.tone === "error" ? "error" : "tick"} size={13} />
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
}

// ── Filter Panel ──

interface FilterPanelProps {
  tabRequest?: WorkbenchRequest;
  heightPreferences?: WorkbenchHeights;
  onHeightPreferenceChange?: (tab: WorkbenchTab, height: number) => void;
  columns: ColumnInfo[];
  activeFilters: FilterGroup;
  activeTable: string | null;
  onApplyFilters: (filters: FilterGroup) => void;
  colOpsSteps: ColOpStep[];
  undoStrategy: UndoStrategy;
  onColOpApply: (opType: ColOpType, column: string, params: Record<string, string>) => Promise<void>;
  onColOpUndo: () => Promise<void>;
  onColOpRevertAll: () => Promise<void>;
  onColOpClearAll: () => Promise<void>;
  rowOpsSteps: RowOpStep[];
  rowOpsUndoStrategy: UndoStrategy;
  onRowOpApply: (opType: RowOpType, params: Record<string, string>) => Promise<void>;
  onRowOpUndo: () => Promise<void>;
  onRowOpRevertAll: () => Promise<void>;
  onRowOpClearAll: () => Promise<void>;
  totalRows: number;
  unfilteredRows: number | null;
  savedViews: SavedView[];
  currentViewState: ViewState;
  onSaveView: (name: string) => void;
  onApplyView: (view: SavedView) => void;
  onUpdateView: (viewId: string) => void;
  onDeleteView: (viewId: string) => void;
  onRenameView: (viewId: string, newName: string) => void;
  onClose: () => void;
  qcSession?: QcSession | null;
  qcFocusRequest?: number;
  onQcFocusHandled?: () => void;
  onQcCreate?: (config: QcCreateConfig) => Promise<void>;
  onQcResetAll?: () => Promise<void>;
  onQcMarkDone?: () => Promise<void>;
  onQcResume?: () => void;
  onQcStartNew?: () => void;
  onQcQuickFilter?: (value: string | null | "__all__") => void;
  motionState?: "open" | "closing";
  filtersOnly?: boolean;
  savedViewsEnabled?: boolean;
  emptyTitle?: string;
  emptyText?: string;
}

export function FilterPanel({
  tabRequest,
  heightPreferences,
  onHeightPreferenceChange,
  columns,
  activeFilters,
  activeTable,
  onApplyFilters,
  colOpsSteps,
  undoStrategy,
  onColOpApply,
  onColOpUndo,
  onColOpRevertAll,
  onColOpClearAll,
  rowOpsSteps,
  rowOpsUndoStrategy,
  onRowOpApply,
  onRowOpUndo,
  onRowOpRevertAll,
  onRowOpClearAll,
  totalRows,
  unfilteredRows,
  savedViews,
  currentViewState,
  onSaveView,
  onApplyView,
  onUpdateView,
  onDeleteView,
  onRenameView,
  onClose,
  qcSession,
  qcFocusRequest = 0,
  onQcFocusHandled,
  onQcCreate,
  onQcResetAll,
  onQcMarkDone,
  onQcResume,
  onQcStartNew,
  onQcQuickFilter,
  motionState = "open",
  filtersOnly = false,
  savedViewsEnabled = true,
  emptyTitle = "Narrow this table",
  emptyText = "Add a filter to show only matching rows.",
}: FilterPanelProps): React.ReactElement {
  const [draftRoot, setDraftRoot] = useState<DraftFilterGroup>(() =>
    convertToDraft(activeFilters)
  );
  const [activeTab, setActiveTab] = useState<WorkbenchTab>(filtersOnly ? "filters" : tabRequest?.tab ?? "filters");
  const [localHeights, setLocalHeights] = useState<WorkbenchHeights>({});
  const [availableHeight, setAvailableHeight] = useState(() => window.innerHeight - 100);
  const panelRef = useRef<HTMLDivElement>(null);
  const manualHeights = heightPreferences ?? localHeights;
  const panelHeight = getWorkbenchPanelHeight(activeTab, countDraftConditions(draftRoot), availableHeight, manualHeights[activeTab]);
  const heightLimits = getWorkbenchHeightLimits(availableHeight);
  const rememberHeight = useCallback((height: number) => {
    const clamped = getWorkbenchPanelHeight(activeTab, 0, availableHeight, height);
    if (onHeightPreferenceChange) onHeightPreferenceChange(activeTab, clamped);
    else setLocalHeights((previous) => ({ ...previous, [activeTab]: clamped }));
  }, [activeTab, availableHeight, onHeightPreferenceChange]);
  const [splitPercent, setSplitPercent] = useState(68);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [viewsPaneOpen, setViewsPaneOpen] = useState(savedViews.length > 0);
  const [saveViewName, setSaveViewName] = useState("");
  const [isPanelResizing, setIsPanelResizing] = useState(false);
  const [isSplitResizing, setIsSplitResizing] = useState(false);
  const lastSavedViewSnapshot = useRef<string | null>(null);
  const isSplitDragging = useRef(false);
  const splitStartX = useRef(0);
  const splitStartPercent = useRef(0);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const filterScrollRef = useRef<HTMLDivElement>(null);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // Sync drafts when active filters change externally (e.g. table switch)
  useEffect(() => {
    setDraftRoot(convertToDraft(activeFilters));
  }, [activeFilters]);

  // Reset saved-view snapshot when switching tables
  useEffect(() => {
    lastSavedViewSnapshot.current = null;
  }, [activeTable]);

  useEffect(() => {
    setViewsPaneOpen(savedViews.length > 0);
  }, [savedViews.length]);

  useEffect(() => {
    if (tabRequest) setActiveTab(filtersOnly ? "filters" : tabRequest.tab);
  }, [tabRequest, filtersOnly]);

  useEffect(() => {
    const parent = panelRef.current?.parentElement;
    if (!parent) return;
    const toolbarSelector = ".table-toolbar, .pivot-toolbar, .qc-session-bar, .comparison-toolbar, .comparison-subtoolbar";
    const measure = () => {
      // Reserve space for controls above the grid as well as the table itself.
      const overhead = Array.from(parent.children)
        .filter((child) => child.matches(toolbarSelector))
        .reduce((height, child) => height + child.getBoundingClientRect().height, 0);
      setAvailableHeight(Math.max(0, parent.getBoundingClientRect().height - overhead));
    };
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    Array.from(parent.children).forEach((child) => {
      if (child.matches(toolbarSelector)) observer.observe(child);
    });
    measure();
    return () => observer.disconnect();
  }, [activeTab, qcSession]);

  useEffect(() => {
    if (qcFocusRequest <= 0) return;
    setActiveTab("qc");
    onQcFocusHandled?.();
  }, [onQcFocusHandled, qcFocusRequest]);

  // ── Resize drag handlers ──
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      setIsPanelResizing(true);
      startY.current = e.clientY;
      startHeight.current = panelHeight;
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
    },
    [panelHeight]
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const deltaY = startY.current - e.clientY;
      rememberHeight(startHeight.current + deltaY);
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      setIsPanelResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      if (isDragging.current) {
        isDragging.current = false;
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      }
    };
  }, [rememberHeight]);

  // ── Horizontal split drag handlers ──
  const onSplitMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isSplitDragging.current = true;
      setIsSplitResizing(true);
      splitStartX.current = e.clientX;
      splitStartPercent.current = splitPercent;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [splitPercent]
  );

  useEffect(() => {
    const onSplitMove = (e: MouseEvent) => {
      if (!isSplitDragging.current || !splitContainerRef.current) return;
      const containerWidth = splitContainerRef.current.getBoundingClientRect().width;
      if (containerWidth === 0) return;
      const deltaX = e.clientX - splitStartX.current;
      const deltaPct = (deltaX / containerWidth) * 100;
      const newPct = Math.min(82, Math.max(48, splitStartPercent.current + deltaPct));
      setSplitPercent(newPct);
    };

    const onSplitUp = () => {
      if (!isSplitDragging.current) return;
      isSplitDragging.current = false;
      setIsSplitResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onSplitMove);
    document.addEventListener("mouseup", onSplitUp);
    return () => {
      document.removeEventListener("mousemove", onSplitMove);
      document.removeEventListener("mouseup", onSplitUp);
    };
  }, []);

  const handleUpdateRoot = useCallback(
    (updater: (root: DraftFilterGroup) => DraftFilterGroup) => {
      setDraftRoot((prev) => updater(prev));
    },
    []
  );

  const clearAll = () => {
    const emptyRoot: DraftFilterGroup = { id: genId(), logic: "AND", children: [] };
    setDraftRoot(emptyRoot);
    onApplyFilters({ logic: "AND", children: [] });
  };

  const applyFilters = () => {
    onApplyFilters(convertFromDraft(draftRoot, columns));
  };

  const handleSaveView = () => {
    const trimmed = saveViewName.trim();
    if (!trimmed) return;
    onSaveView(trimmed);
    lastSavedViewSnapshot.current = JSON.stringify(currentViewState);
    setSaveViewName("");
    setShowSaveInput(false);
  };

  const draftFilters = convertFromDraft(draftRoot, columns);
  const isDirty =
    JSON.stringify(draftFilters) !== JSON.stringify(activeFilters);

  const activeCount = countConditions(activeFilters);
  const draftCount = countConditions(draftFilters);
  const draftHasContent = draftRoot.children.length > 0;
  const draftRowCount = countDraftConditions(draftRoot);
  const incompleteDraftCount = Math.max(0, draftRowCount - draftCount);
  const viewStateMatchesLastSave =
    lastSavedViewSnapshot.current !== null &&
    lastSavedViewSnapshot.current === JSON.stringify(currentViewState);
  const canApply = isDirty && (draftCount > 0 || hasActiveFilters(activeFilters));
  const canClear = draftHasContent || hasActiveFilters(activeFilters);
  const canSaveView = savedViewsEnabled && hasActiveFilters(activeFilters) && !viewStateMatchesLastSave;
  const showSaveViewAction = savedViewsEnabled && (showSaveInput || canSaveView);
  const showViewsPane = savedViewsEnabled && viewsPaneOpen && savedViews.length > 0;
  const statusText = isDirty
    ? "Draft"
    : hasActiveFilters(activeFilters)
      ? "Applied"
      : draftHasContent
        ? "Editing"
        : "Ready";
  const statusDetail = isDirty
    ? [
        draftCount > 0 ? pluralize(draftCount, "complete filter") : null,
        incompleteDraftCount > 0 ? pluralize(incompleteDraftCount, "incomplete filter") : null,
      ].filter(Boolean).join(", ")
    : hasActiveFilters(activeFilters)
      ? pluralize(activeCount, "filter")
      : draftHasContent
        ? pluralize(draftRowCount, "incomplete filter")
      : "No filters";
  const filterPanelClassName = [
    "filter-panel",
    motionState === "closing" ? "filter-panel-closing" : "filter-panel-open",
    isPanelResizing ? "filter-panel-resizing" : "",
    isSplitResizing ? "filter-panel-split-resizing" : "",
  ].filter(Boolean).join(" ");

  return (
    <div ref={panelRef} className={filterPanelClassName} style={{ height: panelHeight }}>
      {/* Resize handle */}
      <div
        className="filter-panel-resize-handle"
        role="separator"
        tabIndex={0}
        aria-label="Resize workbench. Use Arrow Up or Arrow Down."
        aria-orientation="horizontal"
        aria-valuemin={heightLimits.min}
        aria-valuemax={heightLimits.max}
        aria-valuenow={panelHeight}
        onMouseDown={onMouseDown}
        onKeyDown={(event) => {
          if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          rememberHeight(event.key === "Home" ? heightLimits.min : event.key === "End" ? heightLimits.max : panelHeight + (event.key === "ArrowUp" ? 20 : -20));
        }}
      >
        <div className="filter-panel-resize-grip" />
      </div>

      <div className="filter-panel-header">
        <div className="filter-panel-header-left">
          <div className="filter-panel-tabs">
            <Button
              className="filter-panel-tab"
              small
              minimal
              active={activeTab === "filters"}
              aria-pressed={activeTab === "filters"}
              onClick={() => setActiveTab("filters")}
              text="Filters"
            />
            {activeCount > 0 && activeTab !== "filters" && (
              <Tag minimal round intent={Intent.PRIMARY} className="filter-panel-tab-badge">
                {activeCount}
              </Tag>
            )}
            {!filtersOnly && (
              <>
                <Button
                  className="filter-panel-tab"
                  small
                  minimal
                  active={activeTab === "colops"}
              aria-pressed={activeTab === "colops"}
                  onClick={() => setActiveTab("colops")}
                  text="Columns"
                />
                {colOpsSteps.length > 0 && activeTab !== "colops" && (
                  <Tag minimal round intent={Intent.SUCCESS} className="filter-panel-tab-badge">
                    {colOpsSteps.length}
                  </Tag>
                )}
                <Button
                  className="filter-panel-tab"
                  small
                  minimal
                  active={activeTab === "rowops"}
              aria-pressed={activeTab === "rowops"}
                  onClick={() => setActiveTab("rowops")}
                  text="Rows"
                />
                {rowOpsSteps.length > 0 && activeTab !== "rowops" && (
                  <Tag minimal round intent={Intent.WARNING} className="filter-panel-tab-badge">
                    {rowOpsSteps.length}
                  </Tag>
                )}
                <Button
                  className="filter-panel-tab"
                  small
                  minimal
                  active={activeTab === "qc"}
              aria-pressed={activeTab === "qc"}
                  onClick={() => setActiveTab("qc")}
                  text="Review / QC"
                />
                {qcSession && activeTab !== "qc" && (
                  <Tag minimal round intent={qcSession.done ? Intent.SUCCESS : Intent.PRIMARY} className="filter-panel-tab-badge">
                    {qcSession.done ? "done" : Object.keys(qcSession.valuesByRowId).length}
                  </Tag>
                )}
              </>
            )}
          </div>
        </div>
        <div className="filter-panel-header-right">
          <Button
            className="filter-panel-close-button"
            icon="cross"
            small
            minimal
            onClick={onClose}
            title="Close workbench"
            aria-label="Close workbench"
          />
        </div>
      </div>

      {/* Filters + Views side-by-side */}
      <div
        className="filter-views-split"
        ref={splitContainerRef}
        style={{ display: activeTab === "filters" ? "flex" : "none" }}
      >
        <div
          className={`filter-views-left${showViewsPane ? "" : " filter-views-left-full"}`}
          style={{ width: showViewsPane ? `${splitPercent}%` : "100%" }}
        >
          <div className="filter-toolbar">
            <div className="filter-status-strip">
              <div className="motion-status-pair" key={`${statusText}:${statusDetail}`}>
                <Tag
                  minimal
                  icon={isDirty || (!hasActiveFilters(activeFilters) && draftHasContent) ? "edit" : hasActiveFilters(activeFilters) ? "tick" : "filter"}
                  intent={isDirty ? Intent.WARNING : hasActiveFilters(activeFilters) ? Intent.SUCCESS : undefined}
                >
                  {statusText}
                </Tag>
                <span>{statusDetail}</span>
              </div>
            </div>
            <div className="filter-toolbar-actions">
              {savedViewsEnabled && savedViews.length > 0 && (
                <Button
                  icon="bookmark"
                  small
                  minimal
                  active={showViewsPane}
                  onClick={() => setViewsPaneOpen((open) => !open)}
                  title={showViewsPane ? "Hide saved views" : "Show saved views"}
                  aria-label={showViewsPane ? "Hide saved views" : "Show saved views"}
                  aria-expanded={showViewsPane}
                />
              )}
              {showSaveInput ? (
                <div className="filter-panel-save-inline">
                  <InputGroup
                    className="filter-panel-save-input"
                    placeholder="View name..."
                    value={saveViewName}
                    onChange={(e) => setSaveViewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveView();
                      if (e.key === "Escape") { setShowSaveInput(false); setSaveViewName(""); }
                    }}
                    small
                    autoFocus
                  />
                  <Button
                    icon="tick"
                    small
                    minimal
                    intent={Intent.SUCCESS}
                    disabled={!saveViewName.trim()}
                    onClick={handleSaveView}
                    aria-label="Save view"
                  />
                  <Button
                    icon="cross"
                    small
                    minimal
                    onClick={() => { setShowSaveInput(false); setSaveViewName(""); }}
                    aria-label="Cancel saving view"
                  />
                </div>
              ) : showSaveViewAction ? (
                <Button
                  icon="bookmark"
                  text="Save View"
                  small
                  minimal
                  disabled={!canSaveView}
                  onClick={() => setShowSaveInput(true)}
                />
              ) : null}
              {canClear && (
                <Button
                  icon="cross"
                  text="Clear"
                  small
                  minimal
                  onClick={clearAll}
                />
              )}
              <Button
                icon="filter"
                text="Apply"
                small
                intent={Intent.PRIMARY}
                disabled={!canApply}
                onClick={applyFilters}
              />
            </div>
          </div>
          <div
            className={`filter-builder-scroll${draftHasContent ? "" : " filter-builder-scroll-empty"}`}
            ref={filterScrollRef}
          >
            <FilterGroupRenderer
              group={draftRoot}
              columns={columns}
              activeTable={activeTable}
              depth={0}
              isRoot={true}
              emptyTitle={emptyTitle}
              emptyText={emptyText}
              onUpdateRoot={handleUpdateRoot}
              onApply={applyFilters}
              scrollContainerRef={filterScrollRef}
            />
          </div>
        </div>
        {showViewsPane && (
          <>
            <div
              className="filter-views-divider"
              role="separator"
              tabIndex={0}
              aria-label="Resize filters and saved views"
              aria-orientation="vertical"
              aria-valuemin={48}
              aria-valuemax={82}
              aria-valuenow={splitPercent}
              onMouseDown={onSplitMouseDown}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                setSplitPercent((current) => Math.min(82, Math.max(48, current + (event.key === "ArrowRight" ? 4 : -4))));
              }}
            >
              <div className="filter-views-divider-grip" />
            </div>
            <div className="filter-views-right" style={{ width: `${100 - splitPercent}%` }}>
              <ViewsPanel
                savedViews={savedViews}
                schema={columns}
                onApplyView={onApplyView}
                onUpdateView={onUpdateView}
                onDeleteView={onDeleteView}
                onRenameView={onRenameView}
              />
            </div>
          </>
        )}
      </div>
      {!filtersOnly && (
        <>
          <QcPanel
            columns={columns}
            activeTable={activeTable}
            activeFilters={activeFilters}
            totalRows={totalRows}
            session={qcSession}
            onCreate={onQcCreate}
            onResetAll={onQcResetAll}
            onMarkDone={onQcMarkDone}
            onResume={onQcResume}
            onStartNew={onQcStartNew}
            onQuickFilter={onQcQuickFilter}
            visible={activeTab === "qc"}
          />
          <ColumnOpsPanel
            columns={columns}
            activeTable={activeTable}
            activeFilters={activeFilters}
            colOpsSteps={colOpsSteps}
            undoStrategy={undoStrategy}
            onApply={onColOpApply}
            onUndo={onColOpUndo}
            onRevertAll={onColOpRevertAll}
            onClearAll={onColOpClearAll}
            totalRows={totalRows}
            unfilteredRows={unfilteredRows}
            visible={activeTab === "colops"}
          />
          <RowOpsPanel
            columns={columns}
            activeTable={activeTable}
            activeFilters={activeFilters}
            rowOpsSteps={rowOpsSteps}
            undoStrategy={rowOpsUndoStrategy}
            onApply={onRowOpApply}
            onUndo={onRowOpUndo}
            onRevertAll={onRowOpRevertAll}
            onClearAll={onRowOpClearAll}
            totalRows={totalRows}
            unfilteredRows={unfilteredRows}
            visible={activeTab === "rowops"}
          />
        </>
      )}
    </div>
  );
}
