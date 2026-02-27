import React, { useState, useEffect, useCallback } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  InputGroup,
  Intent,
  Alert,
  Callout,
  Icon,
} from "@blueprintjs/core";
import { RegexPattern } from "../types";

interface RegexPatternManagerDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onPatternsChanged: () => void;
}

export function RegexPatternManagerDialog({
  isOpen,
  onClose,
  onPatternsChanged,
}: RegexPatternManagerDialogProps): React.ReactElement {
  const [patterns, setPatterns] = useState<RegexPattern[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Inline form state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formPattern, setFormPattern] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formCategory, setFormCategory] = useState("");

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadPatterns = useCallback(async () => {
    setLoading(true);
    try {
      const all = await window.api.getRegexPatterns();
      setPatterns(all);
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      loadPatterns();
      resetForm();
      setError(null);
      setSuccessMsg(null);
    }
  }, [isOpen, loadPatterns]);

  const resetForm = () => {
    setEditingId(null);
    setFormTitle("");
    setFormPattern("");
    setFormDescription("");
    setFormCategory("");
  };

  const handleEdit = (p: RegexPattern) => {
    setEditingId(p.id);
    setFormTitle(p.title);
    setFormPattern(p.pattern);
    setFormDescription(p.description || "");
    setFormCategory(p.category || "");
  };

  const handleSave = async () => {
    if (!formTitle.trim() || !formPattern.trim()) return;
    setError(null);
    try {
      const pattern: RegexPattern = {
        id: editingId || `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: formTitle.trim(),
        pattern: formPattern.trim(),
        description: formDescription.trim(),
        category: formCategory.trim() || undefined,
        isBuiltin: false,
      };
      await window.api.saveUserPattern(pattern);
      resetForm();
      await loadPatterns();
      onPatternsChanged();
      setSuccessMsg(editingId ? "Pattern updated" : "Pattern added");
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteTarget(null);
    try {
      await window.api.deleteUserPattern(deleteTarget);
      await loadPatterns();
      onPatternsChanged();
      if (editingId === deleteTarget) resetForm();
      setSuccessMsg("Pattern deleted");
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    }
  };

  const handleExport = async () => {
    try {
      await window.api.exportPatterns();
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    }
  };

  const handleImport = async () => {
    try {
      const result = await window.api.importPatterns();
      if (result.error) {
        setError(result.error);
      } else if (result.imported > 0) {
        await loadPatterns();
        onPatternsChanged();
        setSuccessMsg(`Imported ${result.imported} pattern(s)`);
        setTimeout(() => setSuccessMsg(null), 3000);
      }
    } catch (err: any) {
      setError(typeof err === "string" ? err : err?.message || String(err));
    }
  };

  const builtinPatterns = patterns.filter((p) => p.isBuiltin);
  const userPatterns = patterns.filter((p) => !p.isBuiltin);

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title="Regex Pattern Library"
      icon="manual"
      style={{ width: 700 }}
    >
      <DialogBody>
        <div className="regex-manager-content">
          {error && (
            <Callout intent={Intent.DANGER} icon="error" className="regex-manager-error">
              {error}
            </Callout>
          )}
          {successMsg && (
            <Callout intent={Intent.SUCCESS} icon="tick-circle" className="regex-manager-success">
              {successMsg}
            </Callout>
          )}

          {/* Built-in patterns section */}
          <div className="regex-manager-section">
            <div className="regex-manager-section-header">
              Built-in Patterns ({builtinPatterns.length})
            </div>
            <div className="regex-manager-table-wrapper">
              <table className="regex-manager-table">
                <thead>
                  <tr>
                    <th>Title</th>
                    <th>Pattern</th>
                    <th>Category</th>
                  </tr>
                </thead>
                <tbody>
                  {builtinPatterns.map((p) => (
                    <tr key={p.id}>
                      <td title={p.description}>{p.title}</td>
                      <td><code>{p.pattern}</code></td>
                      <td>{p.category || ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* User patterns section */}
          <div className="regex-manager-section">
            <div className="regex-manager-section-header">
              My Patterns ({userPatterns.length})
            </div>
            {userPatterns.length > 0 && (
              <div className="regex-manager-table-wrapper">
                <table className="regex-manager-table">
                  <thead>
                    <tr>
                      <th>Title</th>
                      <th>Pattern</th>
                      <th style={{ width: 70 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userPatterns.map((p) => (
                      <tr key={p.id} className={editingId === p.id ? "regex-manager-editing" : ""}>
                        <td title={p.description}>{p.title}</td>
                        <td><code>{p.pattern}</code></td>
                        <td>
                          <Button
                            minimal
                            small
                            icon="edit"
                            title="Edit"
                            onClick={() => handleEdit(p)}
                          />
                          <Button
                            minimal
                            small
                            icon="trash"
                            intent={Intent.DANGER}
                            title="Delete"
                            onClick={() => setDeleteTarget(p.id)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {userPatterns.length === 0 && (
              <div className="regex-manager-empty">No custom patterns yet. Add one below.</div>
            )}

            {/* Add/Edit form */}
            <div className="regex-manager-form">
              <div className="regex-manager-form-header">
                {editingId ? "Edit Pattern" : "Add Pattern"}
                {editingId && (
                  <Button minimal small icon="cross" onClick={resetForm} title="Cancel edit" />
                )}
              </div>
              <div className="regex-manager-form-row">
                <InputGroup
                  value={formTitle}
                  onChange={(e) => setFormTitle(e.target.value)}
                  placeholder="Title (e.g. Phone Number)"
                  small
                  className="regex-manager-form-title"
                />
                <InputGroup
                  value={formCategory}
                  onChange={(e) => setFormCategory(e.target.value)}
                  placeholder="Category (optional)"
                  small
                  className="regex-manager-form-category"
                />
              </div>
              <InputGroup
                value={formPattern}
                onChange={(e) => setFormPattern(e.target.value)}
                placeholder="Pattern (e.g. ([0-9]+))"
                small
                className="regex-manager-form-pattern"
                style={{ fontFamily: '"SF Mono", "Menlo", "Monaco", monospace' }}
              />
              <div className="regex-manager-form-row">
                <InputGroup
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  placeholder="Description (optional)"
                  small
                  className="regex-manager-form-desc"
                />
                <Button
                  small
                  intent={Intent.PRIMARY}
                  icon={editingId ? "floppy-disk" : "plus"}
                  text={editingId ? "Update" : "Add"}
                  onClick={handleSave}
                  disabled={!formTitle.trim() || !formPattern.trim()}
                />
              </div>
            </div>
          </div>
        </div>
      </DialogBody>
      <DialogFooter
        actions={
          <Button text="Close" onClick={onClose} />
        }
      >
        <div className="regex-manager-footer-left">
          <Button small minimal icon="import" text="Import" onClick={handleImport} />
          <Button small minimal icon="export" text="Export" onClick={handleExport} disabled={userPatterns.length === 0} />
        </div>
      </DialogFooter>

      <Alert
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        intent={Intent.DANGER}
        icon="trash"
        confirmButtonText="Delete"
        cancelButtonText="Cancel"
      >
        <p>Delete this pattern? This cannot be undone.</p>
      </Alert>
    </Dialog>
  );
}
