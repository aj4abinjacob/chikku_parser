import React, { useState, useRef, useEffect, useMemo, useCallback } from "react";
import { Button, InputGroup, Intent, Icon } from "@blueprintjs/core";
import { Tooltip2 } from "@blueprintjs/popover2";
import {
  SavedView,
  ViewState,
  ColumnInfo,
  FilterGroup,
  FilterNode,
  isFilterGroup,
  countConditions,
  hasActiveFilters,
  extractFilterColumns,
} from "../types";

interface ViewsPanelProps {
  savedViews: SavedView[];
  currentViewState: ViewState;
  schema: ColumnInfo[];
  onSaveView: (name: string) => void;
  onApplyView: (view: SavedView) => void;
  onUpdateView: (viewId: string) => void;
  onDeleteView: (viewId: string) => void;
  onRenameView: (viewId: string, newName: string) => void;
}

function viewSummary(vs: ViewState): string {
  const parts: string[] = [];
  const filterCount = countConditions(vs.filters);
  if (filterCount > 0) parts.push(`${filterCount} filter${filterCount !== 1 ? "s" : ""}`);
  if (vs.sortColumns.length > 0) parts.push(`${vs.sortColumns.length} sort${vs.sortColumns.length !== 1 ? "s" : ""}`);
  if (vs.pivotConfig && vs.pivotConfig.groupColumns.length > 0) parts.push("pivot");
  if (parts.length === 0) return "default view";
  return parts.join(" \u00B7 ");
}

/** Render compact inline detail for a view's filters/sorts/pivot */
function renderInlineDetail(vs: ViewState): React.ReactNode {
  const sections: React.ReactNode[] = [];

  // Filters
  if (hasActiveFilters(vs.filters)) {
    sections.push(
      <div key="filters" className="views-inline-detail-section">
        <span className="views-inline-detail-label">Filters:</span>
        {renderFilterPills(vs.filters)}
      </div>
    );
  }

  // Sorts
  if (vs.sortColumns.length > 0) {
    sections.push(
      <div key="sorts" className="views-inline-detail-section">
        <span className="views-inline-detail-label">Sort:</span>
        {vs.sortColumns.map((s, i) => (
          <span key={i}>
            <span className="views-inline-detail-col">{s.column}</span>
            {" "}<span className="views-inline-detail-dir">{s.direction}</span>
          </span>
        ))}
      </div>
    );
  }

  // Pivot
  if (vs.pivotConfig && vs.pivotConfig.groupColumns.length > 0) {
    sections.push(
      <div key="pivot" className="views-inline-detail-section">
        <span className="views-inline-detail-label">Pivot:</span>
        {vs.pivotConfig.groupColumns.map((g, i) => (
          <span key={i}>
            <span className="views-inline-detail-col">{g.column}</span>
            {" "}<span className="views-inline-detail-dir">{g.direction}</span>
          </span>
        ))}
      </div>
    );
  }

  // Hidden columns
  if (vs.columnOrder.length > 0 && vs.visibleColumns.length < vs.columnOrder.length) {
    sections.push(
      <div key="cols" className="views-inline-detail-section">
        <span className="views-inline-detail-label">Columns:</span>
        <span className="views-inline-detail-none">
          {vs.visibleColumns.length} of {vs.columnOrder.length} visible
        </span>
      </div>
    );
  }

  if (sections.length === 0) {
    return <div className="views-inline-detail"><span className="views-inline-detail-none">Default view (no filters/sorts)</span></div>;
  }

  return <div className="views-inline-detail">{sections}</div>;
}

function renderFilterPills(group: FilterGroup): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  group.children.forEach((child: FilterNode, i: number) => {
    if (i > 0) {
      nodes.push(
        <span key={`logic-${i}`} className="views-inline-detail-logic">{group.logic}</span>
      );
    }
    if (isFilterGroup(child)) {
      nodes.push(
        <span key={`group-${i}`}>
          ({child.logic} group: {countConditions(child)} condition{countConditions(child) !== 1 ? "s" : ""})
        </span>
      );
    } else {
      const needsValue = child.operator !== "IS NULL" && child.operator !== "IS NOT NULL";
      nodes.push(
        <span key={`cond-${i}`}>
          <span className="views-inline-detail-col">{child.column}</span>
          {" "}{child.operator.toLowerCase()}
          {needsValue && <> <span className="views-inline-detail-val">{child.value}</span></>}
        </span>
      );
    }
  });
  return nodes;
}

export function ViewsPanel({
  savedViews,
  currentViewState,
  schema,
  onSaveView,
  onApplyView,
  onUpdateView,
  onDeleteView,
  onRenameView,
}: ViewsPanelProps): React.ReactElement {
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [expandedViewId, setExpandedViewId] = useState<string | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  const schemaColumnNames = useMemo(
    () => new Set(schema.map((c) => c.column_name)),
    [schema]
  );

  const getMissingColumns = useCallback(
    (view: SavedView): string[] => {
      const referenced = new Set<string>();
      // Filter columns
      for (const c of extractFilterColumns(view.viewState.filters)) referenced.add(c);
      // Sort columns
      for (const s of view.viewState.sortColumns) referenced.add(s.column);
      // Pivot group columns
      if (view.viewState.pivotConfig) {
        for (const g of view.viewState.pivotConfig.groupColumns) referenced.add(g.column);
      }
      return Array.from(referenced).filter((c) => !schemaColumnNames.has(c));
    },
    [schemaColumnNames]
  );

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  const handleSave = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onSaveView(trimmed);
    setNewName("");
  };

  const handleRenameStart = (view: SavedView) => {
    setRenamingId(view.id);
    setRenameValue(view.name);
  };

  const handleRenameCommit = () => {
    if (renamingId && renameValue.trim()) {
      onRenameView(renamingId, renameValue.trim());
    }
    setRenamingId(null);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleRenameCommit();
    if (e.key === "Escape") setRenamingId(null);
  };

  return (
    <div className="views-body">
      <div className="views-top">
        <div className="views-op-row">
          <InputGroup
            className="views-name-input"
            placeholder="Name this view..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
            leftIcon="bookmark"
            small
          />
          <Button
            className="views-save-btn"
            icon="floppy-disk"
            text="Save"
            intent={Intent.PRIMARY}
            small
            disabled={!newName.trim()}
            onClick={handleSave}
          />
        </div>
        <div className="views-status-row">
          <span className="views-scope">
            <Icon icon="eye-open" iconSize={10} />
            {viewSummary(currentViewState)}
          </span>
        </div>
      </div>

      {savedViews.length > 0 ? (
        <div className="views-steps">
          <div className="views-steps-header">
            <span className="views-steps-title">Saved Views ({savedViews.length})</span>
          </div>
          <div className="views-step-list">
            {savedViews.map((view, idx) => {
              const missing = getMissingColumns(view);
              const isCompatible = missing.length === 0;
              const isExpanded = expandedViewId === view.id;
              const itemClass = `views-step-item ${isExpanded ? "views-step-selected" : ""} ${!isCompatible ? "views-step-incompatible" : ""}`;
              const row = (
                <div key={view.id}>
                  <div
                    className={itemClass}
                    onDoubleClick={() => setExpandedViewId(isExpanded ? null : view.id)}
                    title="Double-click to show details"
                  >
                    <span className="views-step-number">{idx + 1}</span>
                    {renamingId === view.id ? (
                      <InputGroup
                        inputRef={renameInputRef}
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={handleRenameKeyDown}
                        onBlur={handleRenameCommit}
                        small
                        className="views-rename-input"
                        onClick={(e) => e.stopPropagation()}
                        onDoubleClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="views-step-desc">
                        {view.name}
                        <span className="views-step-origin">{view.tableName}</span>
                      </span>
                    )}
                    <div className="views-step-actions">
                      <Button
                        small
                        minimal
                        icon="edit"
                        onClick={(e) => { e.stopPropagation(); handleRenameStart(view); }}
                        title="Rename"
                      />
                      <Button
                        small
                        minimal
                        text="Apply"
                        intent={Intent.PRIMARY}
                        disabled={!isCompatible}
                        onClick={(e) => { e.stopPropagation(); onApplyView(view); }}
                      />
                      <Button
                        small
                        minimal
                        text="Update"
                        onClick={(e) => { e.stopPropagation(); onUpdateView(view.id); }}
                      />
                      <Button
                        small
                        minimal
                        icon="trash"
                        intent={Intent.DANGER}
                        onClick={(e) => { e.stopPropagation(); onDeleteView(view.id); }}
                      />
                    </div>
                  </div>
                  {isExpanded && renderInlineDetail(view.viewState)}
                </div>
              );
              if (!isCompatible) {
                return (
                  <Tooltip2
                    key={view.id}
                    content={`Missing columns: ${missing.join(", ")}`}
                    placement="top"
                    minimal
                  >
                    {row}
                  </Tooltip2>
                );
              }
              return row;
            })}
          </div>
        </div>
      ) : (
        <div className="views-empty">No saved views yet</div>
      )}
    </div>
  );
}
