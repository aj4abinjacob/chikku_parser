import React, { useState, useEffect, useRef, useCallback } from "react";
import ReactDOM from "react-dom";
import {
  Button,
  Checkbox,
  HTMLSelect,
  InputGroup,
  Intent,
  Tag,
} from "@blueprintjs/core";
import { ColumnInfo, FilterCondition } from "../types";

const OPERATORS: { value: FilterCondition["operator"]; label: string }[] = [
  { value: "CONTAINS", label: "contains" },
  { value: "IN", label: "in" },
  { value: ">", label: ">" },
  { value: "<", label: "<" },
  { value: "=", label: "=" },
  { value: "!=", label: "!=" },
  { value: ">=", label: ">=" },
  { value: "<=", label: "<=" },
  { value: "STARTS WITH", label: "starts with" },
  { value: "NOT STARTS WITH", label: "not starts with" },
  { value: "ENDS WITH", label: "ends with" },
  { value: "NOT ENDS WITH", label: "not ends with" },
  { value: "LIKE", label: "like" },
  { value: "NOT LIKE", label: "not like" },
  { value: "IS NULL", label: "is null" },
  { value: "IS NOT NULL", label: "is not null" },
];

const NO_VALUE_OPS = new Set(["IS NULL", "IS NOT NULL"]);

const MIN_PANEL_HEIGHT = 80;
const MAX_PANEL_HEIGHT = 500;
const DEFAULT_PANEL_HEIGHT = 260;

interface DraftFilter {
  column: string;
  operator: FilterCondition["operator"];
  value: string;
}

// ── Unique-value multi-select for IN operator ──

interface InValuePickerProps {
  tableName: string;
  column: string;
  selectedValues: string; // comma-separated
  onChange: (value: string) => void;
}

function InValuePicker({
  tableName,
  column,
  selectedValues,
  onChange,
}: InValuePickerProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [uniqueValues, setUniqueValues] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 });
  const dropdownRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLDivElement>(null);

  // Position the dropdown and close on outside click
  useEffect(() => {
    if (!open) return;

    // Calculate position from anchor
    if (anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setPos({
        top: rect.top,
        left: rect.left,
        width: Math.max(rect.width, 260),
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

  // Fetch distinct values when dropdown opens
  useEffect(() => {
    if (!open || !tableName || !column) return;
    setLoading(true);
    const escapedCol = column.replace(/"/g, '""');
    const escapedTable = tableName.replace(/"/g, '""');
    window.api
      .query(
        `SELECT DISTINCT "${escapedCol}" AS val FROM "${escapedTable}" WHERE "${escapedCol}" IS NOT NULL ORDER BY "${escapedCol}" LIMIT 1000`
      )
      .then((rows) => {
        setUniqueValues(rows.map((r) => String(r.val ?? "")));
        setLoading(false);
      })
      .catch(() => {
        setUniqueValues([]);
        setLoading(false);
      });
  }, [open, tableName, column]);

  const selected = new Set(
    selectedValues
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const toggle = (val: string) => {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    onChange(Array.from(next).join(", "));
  };

  const selectAll = () => {
    const visible = search
      ? uniqueValues.filter((v) =>
          v.toLowerCase().includes(search.toLowerCase())
        )
      : uniqueValues;
    const next = new Set(selected);
    for (const v of visible) next.add(v);
    onChange(Array.from(next).join(", "));
  };

  const clearAll = () => onChange("");

  const filtered = search
    ? uniqueValues.filter((v) =>
        v.toLowerCase().includes(search.toLowerCase())
      )
    : uniqueValues;

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
            <InputGroup
              placeholder="Search values..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              small
              leftIcon="search"
              autoFocus
            />
            <div className="in-value-dropdown-actions">
              <Button small minimal text="All" onClick={selectAll} />
              <Button small minimal text="None" onClick={clearAll} />
            </div>
          </div>
          <div className="in-value-dropdown-list">
            {loading && (
              <div className="in-value-dropdown-empty">Loading...</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className="in-value-dropdown-empty">No values found</div>
            )}
            {!loading &&
              filtered.map((val) => (
                <label
                  key={val}
                  className="in-value-dropdown-item"
                  title={val}
                >
                  <Checkbox
                    checked={selected.has(val)}
                    onChange={() => toggle(val)}
                    style={{ marginBottom: 0 }}
                  />
                  <span className="in-value-dropdown-label">{val}</span>
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

// ── Filter Panel ──

interface FilterPanelProps {
  columns: ColumnInfo[];
  activeFilters: FilterCondition[];
  activeTable: string | null;
  onApplyFilters: (filters: FilterCondition[]) => void;
}

export function FilterPanel({
  columns,
  activeFilters,
  activeTable,
  onApplyFilters,
}: FilterPanelProps): React.ReactElement {
  const [drafts, setDrafts] = useState<DraftFilter[]>([]);
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const startHeight = useRef(0);

  // Sync drafts when active filters change externally (e.g. table switch)
  useEffect(() => {
    setDrafts(
      activeFilters.map((f) => ({
        column: f.column,
        operator: f.operator,
        value: f.value,
      }))
    );
  }, [activeFilters]);

  // ── Resize drag handlers ──
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
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
      const newHeight = Math.min(
        MAX_PANEL_HEIGHT,
        Math.max(MIN_PANEL_HEIGHT, startHeight.current + deltaY)
      );
      setPanelHeight(newHeight);
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const addFilter = () => {
    const col = columns.length > 0 ? columns[0].column_name : "";
    setDrafts((prev) => [
      ...prev,
      { column: col, operator: "CONTAINS", value: "" },
    ]);
  };

  const removeFilter = (index: number) => {
    setDrafts((prev) => prev.filter((_, i) => i !== index));
  };

  const updateFilter = (index: number, patch: Partial<DraftFilter>) => {
    setDrafts((prev) =>
      prev.map((f, i) => (i === index ? { ...f, ...patch } : f))
    );
  };

  const clearAll = () => {
    setDrafts([]);
  };

  const applyFilters = () => {
    const valid = drafts.filter(
      (d) =>
        d.column &&
        (NO_VALUE_OPS.has(d.operator) || d.value.trim() !== "")
    );
    onApplyFilters(
      valid.map((d) => ({
        column: d.column,
        operator: d.operator,
        value: d.value,
      }))
    );
  };

  const isDirty =
    JSON.stringify(drafts) !==
    JSON.stringify(
      activeFilters.map((f) => ({
        column: f.column,
        operator: f.operator,
        value: f.value,
      }))
    );

  return (
    <div className="filter-panel" style={{ height: panelHeight }}>
      {/* Resize handle */}
      <div className="filter-panel-resize-handle" onMouseDown={onMouseDown}>
        <div className="filter-panel-resize-grip" />
      </div>

      <div className="filter-panel-header">
        <div className="filter-panel-header-left">
          <span className="filter-panel-title">Filters</span>
          {activeFilters.length > 0 && (
            <Tag minimal round intent={Intent.PRIMARY}>
              {activeFilters.length} active
            </Tag>
          )}
        </div>
        <div className="filter-panel-header-right">
          <Button
            icon="add"
            text="Add Filter"
            small
            minimal
            onClick={addFilter}
          />
          {drafts.length > 0 && (
            <Button
              icon="cross"
              text="Clear All"
              small
              minimal
              onClick={clearAll}
            />
          )}
          {drafts.length > 0 && (
            <Button
              intent={Intent.PRIMARY}
              text="Apply Filters"
              small
              onClick={applyFilters}
              disabled={!isDirty && activeFilters.length === drafts.length}
            />
          )}
        </div>
      </div>

      {drafts.length > 0 && (
        <div className="filter-panel-body">
          {drafts.map((draft, i) => (
            <div className="filter-row" key={i}>
              <HTMLSelect
                className="filter-col-select"
                value={draft.column}
                onChange={(e) =>
                  updateFilter(i, { column: e.target.value, value: "" })
                }
              >
                {columns.map((c) => (
                  <option key={c.column_name} value={c.column_name}>
                    {c.column_name}
                  </option>
                ))}
              </HTMLSelect>

              <HTMLSelect
                className="filter-op-select"
                value={draft.operator}
                onChange={(e) =>
                  updateFilter(i, {
                    operator: e.target.value as FilterCondition["operator"],
                    value:
                      e.target.value === "IN" || draft.operator === "IN"
                        ? ""
                        : draft.value,
                  })
                }
              >
                {OPERATORS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </HTMLSelect>

              {!NO_VALUE_OPS.has(draft.operator) &&
                (draft.operator === "IN" && activeTable ? (
                  <InValuePicker
                    tableName={activeTable}
                    column={draft.column}
                    selectedValues={draft.value}
                    onChange={(value) => updateFilter(i, { value })}
                  />
                ) : (
                  <InputGroup
                    className="filter-value-input"
                    value={draft.value}
                    onChange={(e) =>
                      updateFilter(i, { value: e.target.value })
                    }
                    placeholder={
                      draft.operator === "CONTAINS"
                        ? "text or regex"
                        : "value"
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyFilters();
                    }}
                  />
                ))}

              <Button
                icon="small-cross"
                minimal
                small
                onClick={() => removeFilter(i)}
              />
            </div>
          ))}
        </div>
      )}

    </div>
  );
}
