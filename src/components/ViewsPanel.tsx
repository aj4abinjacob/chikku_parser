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
  visible: boolean;
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

/** Render a filter tree as readable text lines */
function renderFilterLines(group: FilterGroup, depth: number = 0): React.ReactNode[] {
  const lines: React.ReactNode[] = [];
  group.children.forEach((child: FilterNode, i: number) => {
    if (i > 0) {
      lines.push(
        <span key={`logic-${depth}-${i}`} className="views-detail-logic">{group.logic}</span>
      );
    }
    if (isFilterGroup(child)) {
      lines.push(
        <span key={`group-${depth}-${i}`} className="views-detail-filter">
          ({child.logic} group: {countConditions(child)} condition{countConditions(child) !== 1 ? "s" : ""})
        </span>
      );
    } else {
      const needsValue = child.operator !== "IS NULL" && child.operator !== "IS NOT NULL";
      lines.push(
        <span key={`cond-${depth}-${i}`} className="views-detail-filter">
          <span className="views-detail-col">{child.column}</span>
          {" "}{child.operator.toLowerCase()}
          {needsValue && <> <span className="views-detail-val">{child.value}</span></>}
        </span>
      );
    }
  });
  return lines;
}

export function ViewsPanel({
  visible,
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
  const [selectedViewId, setSelectedViewId] = useState<string | null>(null);
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

  const selectedView = savedViews.find((v) => v.id === selectedViewId) || null;
  const detailState = selectedView?.viewState ?? null;

  return (
    <div className="views-body" style={{ display: visible ? "flex" : "none" }}>
      <div className="views-layout">
        {/* Left: save form + view list */}
        <div className="views-left">
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
                  const itemClass = `views-step-item ${selectedViewId === view.id ? "views-step-selected" : ""} ${!isCompatible ? "views-step-incompatible" : ""}`;
                  const row = (
                    <div
                      key={view.id}
                      className={itemClass}
                      onClick={() => setSelectedViewId(selectedViewId === view.id ? null : view.id)}
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
                        />
                      ) : (
                        <span
                          className="views-step-desc"
                          onDoubleClick={(e) => { e.stopPropagation(); handleRenameStart(view); }}
                          title="Double-click to rename"
                        >
                          {view.name}
                          <span className="views-step-origin">{view.tableName}</span>
                        </span>
                      )}
                      <div className="views-step-actions">
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

        {/* Right: detail panel showing what's in the selected view */}
        <div className="views-right">
          {detailState ? (
            <div className="views-detail">
              <div className="views-detail-header">{selectedView!.name}</div>

              {/* Filters */}
              <div className="views-detail-section">
                <span className="views-detail-label">Filters</span>
                {hasActiveFilters(detailState.filters) ? (
                  <div className="views-detail-items">
                    {renderFilterLines(detailState.filters)}
                  </div>
                ) : (
                  <span className="views-detail-none">None</span>
                )}
              </div>

              {/* Sorts */}
              <div className="views-detail-section">
                <span className="views-detail-label">Sorts</span>
                {detailState.sortColumns.length > 0 ? (
                  <div className="views-detail-items">
                    {detailState.sortColumns.map((s, i) => (
                      <span key={i} className="views-detail-sort">
                        <span className="views-detail-col">{s.column}</span>
                        {" "}<span className="views-detail-dir">{s.direction}</span>
                      </span>
                    ))}
                  </div>
                ) : (
                  <span className="views-detail-none">None</span>
                )}
              </div>

              {/* Pivot */}
              {detailState.pivotConfig && detailState.pivotConfig.groupColumns.length > 0 && (
                <div className="views-detail-section">
                  <span className="views-detail-label">Pivot</span>
                  <div className="views-detail-items">
                    {detailState.pivotConfig.groupColumns.map((g, i) => (
                      <span key={i} className="views-detail-sort">
                        <span className="views-detail-col">{g.column}</span>
                        {" "}<span className="views-detail-dir">{g.direction}</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Hidden columns */}
              {detailState.columnOrder.length > 0 && detailState.visibleColumns.length < detailState.columnOrder.length && (
                <div className="views-detail-section">
                  <span className="views-detail-label">Columns</span>
                  <span className="views-detail-none">
                    {detailState.visibleColumns.length} of {detailState.columnOrder.length} visible
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="views-detail-empty">
              Select a view to see its details
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
