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
import {
  ColumnInfo,
  FilterCondition,
  FilterGroup,
  FilterNode,
  isFilterGroup,
  hasActiveFilters,
  countConditions,
  ColOpType,
  ColOpStep,
  RowOpType,
  RowOpStep,
  UndoStrategy,
  SavedView,
  ViewState,
} from "../types";
import { ColumnOpsPanel } from "./ColumnOpsPanel";
import { RowOpsPanel } from "./RowOpsPanel";
import { ViewsPanel } from "./ViewsPanel";
import { SearchableColumnSelect } from "./SearchableColumnSelect";

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

// ── Draft types with IDs for React keys ──

interface DraftFilterCondition {
  id: string;
  column: string;
  operator: FilterCondition["operator"];
  value: string;
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
      } as DraftFilterCondition;
    }),
  };
}

function convertFromDraft(group: DraftFilterGroup): FilterGroup {
  const children: FilterNode[] = [];
  for (const child of group.children) {
    if (isDraftGroup(child)) {
      const nested = convertFromDraft(child);
      // Keep groups even if empty — let SQL builder handle it
      children.push(nested);
    } else {
      // Only include conditions that have a column set and value (or no-value operator)
      if (child.column && (NO_VALUE_OPS.has(child.operator) || child.value.trim() !== "")) {
        children.push({
          column: child.column,
          operator: child.operator,
          value: child.value,
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
  selectedValues: string;
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

  const filtered = uniqueValues.filter((v) => {
    if (search && !v.toLowerCase().includes(search.toLowerCase())) return false;
    if (listFilter === "selected" && !selected.has(v)) return false;
    if (listFilter === "not-selected" && selected.has(v)) return false;
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
                {selected.size} / {uniqueValues.length}
              </span>
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
                >
                  <Checkbox
                    checked={selected.has(val)}
                    onChange={() => toggle(val)}
                    style={{ marginBottom: 0 }}
                  />
                  <span className="in-value-dropdown-label" title={val}>{val}</span>
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

// ── Filter Condition Row (leaf) ──

interface FilterConditionRowProps {
  draft: DraftFilterCondition;
  columns: ColumnInfo[];
  activeTable: string | null;
  onUpdate: (id: string, patch: Partial<DraftFilterCondition>) => void;
  onRemove: (id: string) => void;
  onApply: () => void;
}

function FilterConditionRow({
  draft,
  columns,
  activeTable,
  onUpdate,
  onRemove,
  onApply,
}: FilterConditionRowProps): React.ReactElement {
  return (
    <div className="filter-row">
      <SearchableColumnSelect
        value={draft.column}
        onChange={(val) => onUpdate(draft.id, { column: val, value: "" })}
        columns={columns}
        placeholder="Column..."
        className="filter-col-select"
      />

      <HTMLSelect
        className="filter-op-select"
        value={draft.operator}
        onChange={(e) =>
          onUpdate(draft.id, {
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
            onChange={(value) => onUpdate(draft.id, { value })}
          />
        ) : (
          <InputGroup
            className="filter-value-input"
            value={draft.value}
            onChange={(e) =>
              onUpdate(draft.id, { value: e.target.value })
            }
            placeholder={
              draft.operator === "CONTAINS"
                ? "text or regex"
                : "value"
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") onApply();
            }}
          />
        ))}

      <Button
        icon="small-cross"
        minimal
        small
        onClick={() => onRemove(draft.id)}
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
  onUpdateRoot,
  onApply,
  scrollContainerRef,
}: FilterGroupRendererProps): React.ReactElement {
  const depthIndex = depth % 4;

  const handleToggleLogic = () => {
    onUpdateRoot((root) =>
      updateNodeById(root, group.id, (node) => ({
        ...(node as DraftFilterGroup),
        logic: (node as DraftFilterGroup).logic === "AND" ? "OR" : "AND",
      })) as DraftFilterGroup
    );
  };

  const scrollToBottom = () => {
    if (scrollContainerRef?.current) {
      requestAnimationFrame(() => {
        scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" });
      });
    }
  };

  const handleAddCondition = () => {
    const col = columns.length > 0 ? columns[0].column_name : "";
    const newCond: DraftFilterCondition = {
      id: genId(),
      column: col,
      operator: "CONTAINS",
      value: "",
    };
    onUpdateRoot((root) => addChildToGroup(root, group.id, newCond));
    scrollToBottom();
  };

  const handleAddSubGroup = () => {
    const newGroup: DraftFilterGroup = {
      id: genId(),
      logic: group.logic === "AND" ? "OR" : "AND",
      children: [],
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

  return (
    <div
      className={`filter-group ${isRoot ? "filter-group-root" : "filter-group-nested"}`}
      data-depth={depthIndex}
    >
      <div className="filter-group-header">
        <Button
          small
          minimal
          className="filter-group-logic-btn"
          intent={group.logic === "OR" ? Intent.WARNING : Intent.PRIMARY}
          text={group.logic}
          onClick={handleToggleLogic}
          title={`Click to switch to ${group.logic === "AND" ? "OR" : "AND"}`}
        />
        {!isRoot && (
          <Button
            className="filter-group-delete"
            icon="small-cross"
            minimal
            small
            onClick={handleRemoveSelf}
            title="Remove group"
          />
        )}
      </div>

      <div className="filter-group-children">
        {group.children.map((child) => {
          if (isDraftGroup(child)) {
            return (
              <FilterGroupRenderer
                key={child.id}
                group={child}
                columns={columns}
                activeTable={activeTable}
                depth={depth + 1}
                isRoot={false}
                onUpdateRoot={onUpdateRoot}
                onApply={onApply}
                scrollContainerRef={scrollContainerRef}
              />
            );
          }
          return (
            <FilterConditionRow
              key={child.id}
              draft={child}
              columns={columns}
              activeTable={activeTable}
              onUpdate={handleUpdateCondition}
              onRemove={handleRemoveChild}
              onApply={onApply}
            />
          );
        })}
      </div>

      <div className="filter-group-actions">
        <Button
          icon="add"
          text="Condition"
          small
          minimal
          onClick={handleAddCondition}
        />
        <Button
          icon="group-objects"
          text="Sub-group"
          small
          minimal
          onClick={handleAddSubGroup}
        />
      </div>
    </div>
  );
}

// ── Filter Panel ──

interface FilterPanelProps {
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
}

export function FilterPanel({
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
}: FilterPanelProps): React.ReactElement {
  const [draftRoot, setDraftRoot] = useState<DraftFilterGroup>(() =>
    convertToDraft(activeFilters)
  );
  const [panelHeight, setPanelHeight] = useState(DEFAULT_PANEL_HEIGHT);
  const [activeTab, setActiveTab] = useState<"filters" | "colops" | "rowops">("filters");
  const [splitPercent, setSplitPercent] = useState(55);
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [saveViewName, setSaveViewName] = useState("");
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

  // Header + resize handle take ~36px; content gets the rest
  const PANEL_CHROME_HEIGHT = 42;

  // Called by child panels when their content height changes — set exactly what's needed
  const handleContentHeightChange = useCallback((contentHeight: number) => {
    const needed = contentHeight + PANEL_CHROME_HEIGHT;
    const clamped = Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, needed));
    setPanelHeight(clamped);
  }, []);

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

  // ── Horizontal split drag handlers ──
  const onSplitMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isSplitDragging.current = true;
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
      const newPct = Math.min(80, Math.max(30, splitStartPercent.current + deltaPct));
      setSplitPercent(newPct);
    };

    const onSplitUp = () => {
      if (!isSplitDragging.current) return;
      isSplitDragging.current = false;
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
    onApplyFilters(convertFromDraft(draftRoot));
  };

  const handleSaveView = () => {
    const trimmed = saveViewName.trim();
    if (!trimmed) return;
    onSaveView(trimmed);
    lastSavedViewSnapshot.current = JSON.stringify(currentViewState);
    setSaveViewName("");
    setShowSaveInput(false);
  };

  const isDirty =
    JSON.stringify(convertFromDraft(draftRoot)) !==
    JSON.stringify(activeFilters);

  const activeCount = countConditions(activeFilters);
  const draftHasContent = draftRoot.children.length > 0;
  const viewStateMatchesLastSave =
    lastSavedViewSnapshot.current !== null &&
    lastSavedViewSnapshot.current === JSON.stringify(currentViewState);

  return (
    <div className="filter-panel" style={{ height: panelHeight }}>
      {/* Resize handle */}
      <div className="filter-panel-resize-handle" onMouseDown={onMouseDown}>
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
              onClick={() => activeTab === "filters" ? onClose() : setActiveTab("filters")}
              text="Filters"
            />
            {activeCount > 0 && activeTab !== "filters" && (
              <Tag minimal round intent={Intent.PRIMARY} className="filter-panel-tab-badge">
                {activeCount}
              </Tag>
            )}
            <Button
              className="filter-panel-tab"
              small
              minimal
              active={activeTab === "colops"}
              onClick={() => setActiveTab("colops")}
              text="Column Ops"
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
              onClick={() => setActiveTab("rowops")}
              text="Row Ops"
            />
            {rowOpsSteps.length > 0 && activeTab !== "rowops" && (
              <Tag minimal round intent={Intent.WARNING} className="filter-panel-tab-badge">
                {rowOpsSteps.length}
              </Tag>
            )}
          </div>
          {activeTab === "filters" && draftHasContent && (
            <>
              <span className="filter-panel-tab-separator" />
              <Button
                intent={Intent.PRIMARY}
                text="Apply Filters"
                small
                onClick={applyFilters}
                disabled={!isDirty && hasActiveFilters(activeFilters)}
              />
              <Button
                icon="cross"
                text="Clear"
                small
                minimal
                onClick={clearAll}
              />
            </>
          )}
        </div>
        <div className="filter-panel-header-right">
          {activeTab === "filters" && hasActiveFilters(activeFilters) && !viewStateMatchesLastSave && (
            <>
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
                  />
                  <Button
                    icon="cross"
                    small
                    minimal
                    onClick={() => { setShowSaveInput(false); setSaveViewName(""); }}
                  />
                </div>
              ) : (
                <Button
                  icon="bookmark"
                  text="Save View"
                  small
                  minimal
                  onClick={() => setShowSaveInput(true)}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Filters + Views side-by-side */}
      <div
        className="filter-views-split"
        ref={splitContainerRef}
        style={{ display: activeTab === "filters" ? "flex" : "none" }}
      >
        <div className="filter-views-left" ref={filterScrollRef} style={{ width: `${splitPercent}%` }}>
          <FilterGroupRenderer
            group={draftRoot}
            columns={columns}
            activeTable={activeTable}
            depth={0}
            isRoot={true}
            onUpdateRoot={handleUpdateRoot}
            onApply={applyFilters}
            scrollContainerRef={filterScrollRef}
          />
        </div>
        <div className="filter-views-divider" onMouseDown={onSplitMouseDown}>
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
      </div>
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
        onContentHeightChange={handleContentHeightChange}
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
    </div>
  );
}
