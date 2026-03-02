import React, { useState, useRef, useEffect } from "react";
import { Button, InputGroup, Intent, Icon } from "@blueprintjs/core";
import { SavedView, ViewState, countConditions } from "../types";

interface ViewsPanelProps {
  visible: boolean;
  savedViews: SavedView[];
  currentViewState: ViewState;
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

export function ViewsPanel({
  visible,
  savedViews,
  currentViewState,
  onSaveView,
  onApplyView,
  onUpdateView,
  onDeleteView,
  onRenameView,
}: ViewsPanelProps): React.ReactElement {
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

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
    <div className="views-body" style={{ display: visible ? "flex" : "none" }}>
      {/* Top area: save form + status */}
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

      {/* Saved views list */}
      {savedViews.length > 0 && (
        <div className="views-steps">
          <div className="views-steps-header">
            <span className="views-steps-title">Saved Views ({savedViews.length})</span>
          </div>
          <div className="views-step-list">
            {savedViews.map((view, idx) => (
              <div key={view.id} className="views-step-item">
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
                  />
                ) : (
                  <span
                    className="views-step-desc"
                    onDoubleClick={() => handleRenameStart(view)}
                    title="Double-click to rename"
                  >
                    {view.name}
                    <span className="views-step-summary">{viewSummary(view.viewState)}</span>
                  </span>
                )}
                <div className="views-step-actions">
                  <Button
                    small
                    minimal
                    text="Apply"
                    intent={Intent.PRIMARY}
                    onClick={() => onApplyView(view)}
                  />
                  <Button
                    small
                    minimal
                    text="Update"
                    onClick={() => onUpdateView(view.id)}
                  />
                  <Button
                    small
                    minimal
                    icon="trash"
                    intent={Intent.DANGER}
                    onClick={() => onDeleteView(view.id)}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {savedViews.length === 0 && (
        <div className="views-empty">No saved views yet</div>
      )}
    </div>
  );
}
