import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Checkbox, Classes, Dialog, Intent } from "@blueprintjs/core";
import { ApplyCellEditRequest, MAX_CELL_EDIT_BYTES, ReadCellValueResult } from "../types";
import { canRestoreCell, CellInspection, cellValueLabel, cellValueMetrics, createDraft, DraftHistory, moveDraft, pushDraft, RecentCellEdit, sameCell, textareaDraftValue, valueBytes, visibleWhitespace } from "../utils/cellEditor";

interface Props {
  target: CellInspection;
  context: number;
  activeTable: string | null;
  recentEdits: RecentCellEdit[];
  onClose: () => void;
  onApply: (request: ApplyCellEditRequest, columnType: string) => Promise<ReadCellValueResult>;
  onNativeRevision: (revision: string) => void;
  isTargetCurrent: (target: CellInspection) => boolean;
  onRegisterGuard: (guard: (() => Promise<boolean>) | null) => void;
  onEditorState: (dirty: boolean, busy: boolean) => void;
  onExport: () => void;
}

export function CellValueDialog({ target, context, activeTable, recentEdits, onClose, onApply, onNativeRevision, isTargetCurrent, onRegisterGuard, onEditorState, onExport }: Props): React.ReactElement {
  const [descriptor, setDescriptor] = useState<ReadCellValueResult | null>(null);
  const [original, setOriginal] = useState(target.cachedValue);
  const [draftHistory, setDraftHistory] = useState<DraftHistory>(() => createDraft(target.cachedValue));
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [whitespace, setWhitespace] = useState(false);
  const [comparison, setComparison] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyFilter, setHistoryFilter] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const discardResolver = useRef<((discard: boolean) => void) | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const requestGeneration = useRef(0);
  const draft = draftHistory.states[draftHistory.index].value;
  const dirty = editing && draft !== original;
  const invalidatedTarget = useRef(false);
  if (target.context !== context || target.tableName !== activeTable) invalidatedTarget.current = true;
  const stale = invalidatedTarget.current;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const busyRef = useRef(busy); busyRef.current = busy;
  const staleRef = useRef(stale); staleRef.current = stale;
  const metrics = useMemo(() => cellValueMetrics(editing ? draft : original), [editing, draft, original]);
  const columnType = descriptor?.columnType ?? target.columnType;
  const reason = stale ? "The table changed. Close and reopen this cell to edit its current value. Your draft is kept for copying." : target.reason ?? descriptor?.reason;
  const editable = !stale && !target.reason && !!descriptor?.editable && !loading;
  const textType = /^(VARCHAR|CHAR|BPCHAR|TEXT|STRING)(\b|\()/i.test(columnType);
  const overLimit = valueBytes(draft) > MAX_CELL_EDIT_BYTES;
  const records = recentEdits.filter((record) => sameCell(record, target));
  const filteredRecords = records.filter((record) => !historyFilter || `${cellValueLabel(record.before)}\n${cellValueLabel(record.after)}\n${new Date(record.timestamp).toLocaleString()}`.toLocaleLowerCase().includes(historyFilter.toLocaleLowerCase()));

  useEffect(() => {
    const generation = ++requestGeneration.current;
    if (target.reason || target.rowId === null || stale) { setLoading(false); return; }
    setLoading(true);
    void window.api.readCellValue({ tableName: target.tableName, columnName: target.columnName, rowId: target.rowId }).then((result) => {
      if (generation !== requestGeneration.current || staleRef.current || !isTargetCurrent(target)) return;
      setDescriptor(result);
      onNativeRevision(result.revision);
      // A read-only descriptor deliberately omits oversized/unsupported data.
      if (result.editable) { setOriginal(result.value); setDraftHistory(createDraft(result.value)); }
    }).catch((err) => { if (generation === requestGeneration.current && !staleRef.current && isTargetCurrent(target)) setError(String(err)); }).finally(() => { if (generation === requestGeneration.current) setLoading(false); });
    return () => { requestGeneration.current++; };
  }, [target, stale, onNativeRevision, isTargetCurrent]);

  const guard = useCallback(async (): Promise<boolean> => {
    if (busyRef.current) return false;
    if (!dirtyRef.current) return true;
    if (discardResolver.current) return false;
    return new Promise<boolean>((resolve) => { discardResolver.current = resolve; setDiscardOpen(true); });
  }, []);
  useEffect(() => { onRegisterGuard(guard); return () => { onRegisterGuard(null); discardResolver.current?.(false); }; }, [guard, onRegisterGuard]);
  useEffect(() => { onEditorState(dirty, busy); }, [dirty, busy, onEditorState]);
  useEffect(() => () => { onEditorState(false, false); }, [onEditorState]);
  const resolveDiscard = (discard: boolean) => {
    setDiscardOpen(false);
    if (discard) { dirtyRef.current = false; setEditing(false); setDraftHistory(createDraft(original)); onEditorState(false, false); }
    const resolve = discardResolver.current; discardResolver.current = null; resolve?.(discard);
  };
  const close = async () => { if (await guard()) onClose(); };
  const setDraft = (value: string | null, start = 0, end = start) => {
    if (valueBytes(value) > MAX_CELL_EDIT_BYTES) { setError("Cell edits are limited to 1 MiB of UTF-8 text. The previous draft has been kept."); return; }
    setDraftHistory((history) => pushDraft(history, { value, start, end })); setError(""); setStatus("");
  };
  const navigateDraft = (delta: number) => {
    const next = moveDraft(draftHistory, delta); setDraftHistory(next);
    const snapshot = next.states[next.index];
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(snapshot.start, snapshot.end); });
  };
  const startEditing = (value = original) => { setEditing(true); setDraftHistory(createDraft(original)); if (value !== original) setDraftHistory(pushDraft(createDraft(original), { value, start: 0, end: 0 })); setError(""); setStatus(""); requestAnimationFrame(() => textarea.current?.focus()); };
  const cancelEditing = async () => { if (await guard()) { setEditing(false); setDraftHistory(createDraft(original)); setError(""); } };
  const apply = async () => {
    if (!editable || !dirty || overLimit || busyRef.current || !descriptor || target.rowId === null) return;
    busyRef.current = true; setBusy(true); onEditorState(dirty, true); setError("");
    try {
      const result = await onApply({ tableName: target.tableName, columnName: target.columnName, rowId: target.rowId, expectedValue: original, value: draft, revision: descriptor.revision }, columnType);
      setDescriptor(result); setOriginal(result.value); setDraftHistory(createDraft(result.value)); setEditing(false); dirtyRef.current = false;
      setStatus("Change applied to the loaded table. Export saves a file.");
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText((editing ? draft : original) ?? "NULL"); setStatus("Raw value copied."); } catch { setStatus("Could not copy. Select the value and copy it manually."); } };
  const displayValue = (value: string | null) => value === null ? "NULL" : whitespace ? visibleWhitespace(value) : value;

  return <>
    <Dialog isOpen title={editing ? "Edit cell value" : "Full cell value"} icon={editing ? "edit" : "eye-open"} className={`dg-value-dialog${comparison && editing ? " dg-value-comparing" : ""}`} onClose={() => { void close(); }} canEscapeKeyClose={!busy} canOutsideClickClose={!busy} isCloseButtonShown={!busy}>
      <div className={Classes.DIALOG_BODY}>
        <dl className="dg-value-context">
          <div><dt>Column</dt><dd>{target.columnName}</dd></div>
          <div><dt>Row</dt><dd>{target.row + 1} (when opened)</dd></div>
          <div><dt>Value type</dt><dd>{columnType || "Unknown"} · {(editing ? draft : original) === null ? "NULL" : (editing ? draft : original) === "" ? "Empty string" : "Value"}</dd></div>
        </dl>
        <div className="dg-cell-metrics" title="Characters are counted as Unicode code points; CRLF counts as one line ending.">{metrics.characters.toLocaleString()} characters · {metrics.bytes.toLocaleString()} UTF-8 bytes · {metrics.lines.toLocaleString()} lines</div>
        <div className="dg-cell-options">
          <Checkbox checked={whitespace} onChange={(event) => setWhitespace(event.currentTarget.checked)} label="Show whitespace" />
          {editing && <Checkbox checked={comparison} onChange={(event) => setComparison(event.currentTarget.checked)} label="Compare original and draft" />}
          <Button small minimal icon="history" active={historyOpen} text={`Recent edits (${records.length})`} title="Recent edits keep up to 200 records / 8 MiB for this session" onClick={() => setHistoryOpen((open) => !open)} />
        </div>
        {editing && <div className="dg-cell-edit-tools">
          <Button small icon="undo" text="Undo" title="Draft Undo/Redo keeps up to 100 states / 8 MiB" disabled={busy || draftHistory.index === 0} onClick={() => navigateDraft(-1)} />
          <Button small icon="redo" text="Redo" disabled={busy || draftHistory.index === draftHistory.states.length - 1} onClick={() => navigateDraft(1)} />
          <Button small text="Set NULL" disabled={busy || draft === null} onClick={() => setDraft(null)} />
          <Button small text="Empty string" disabled={busy || !textType || draft === ""} title={textType ? "Set an empty string, distinct from NULL" : "Empty string is available for text columns"} onClick={() => setDraft("")} />
        </div>}
        <div className={comparison && editing ? "dg-cell-comparison" : undefined}>
          {comparison && editing && <div><label className="dg-value-label" htmlFor="dg-original-value">Original</label><textarea id="dg-original-value" className="bp4-input dg-value-text" readOnly value={displayValue(original)} placeholder="Empty string" spellCheck={false} /></div>}
          <div><label className="dg-value-label" htmlFor="dg-inspected-value">{editing ? "Draft" : "Raw value"}{editing && draft === null ? " · NULL (type to replace)" : ""}</label>
            <textarea ref={textarea} id="dg-inspected-value" className="bp4-input dg-value-text" readOnly={!editing || busy} value={editing ? (draft ?? "").replace(/\r\n|\r/g, "\n") : displayValue(original)} placeholder={(editing ? draft : original) === null ? "NULL" : "Empty string"} spellCheck={false}
              onChange={(event) => setDraft(textareaDraftValue(draft, event.currentTarget.value, original), event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
              onKeyDown={(event) => { if (!editing || !(event.metaKey || event.ctrlKey) || event.altKey) return; const key = event.key.toLowerCase(); if (key === "z" || (event.ctrlKey && key === "y")) { event.preventDefault(); if (!busy) navigateDraft(key === "y" || event.shiftKey ? 1 : -1); } }} />
          </div>
        </div>
        {editing && whitespace && <pre className="dg-cell-whitespace" aria-label="Draft whitespace preview">{displayValue(draft) || "Empty string"}</pre>}
        {loading && <p role="status">Reading exact stored value…</p>}
        {reason && <p className="dg-cell-readonly">{reason}</p>}
        {overLimit && editing && <p className="dg-cell-error" role="alert">Cell edits are limited to 1 MiB of UTF-8 text. Shorten the draft before applying.</p>}
        {error && <p className="dg-cell-error" role="alert">{error}</p>}
        <p className="dg-value-note">{editing ? "Changes apply to the loaded table; Export saves a file." : "Complete value before display formatting. Choose Edit to make changes."}</p>
        <div className="dg-value-copy-status" role="status">{status}</div>
        {historyOpen && <section className="dg-cell-history" aria-label="Recent edits for this cell">
          <label className="dg-value-label" htmlFor="dg-cell-history-filter">Recent edits for this cell</label>
          <input id="dg-cell-history-filter" className="bp4-input" type="search" placeholder="Filter by value or time" value={historyFilter} onChange={(event) => setHistoryFilter(event.currentTarget.value)} />
          <p className="dg-value-note">Choose a past value to review it as a draft, then Apply change. Older edits may be unavailable after the table changes.</p>
          {!filteredRecords.length && <p>No matching recent edits.</p>}
          {filteredRecords.slice().reverse().map((record) => <div className="dg-cell-history-entry" key={record.id}>
            <time>{new Date(record.timestamp).toLocaleString()}</time>
            {(["before", "after"] as const).map((side) => <div key={side}><span>{side === "before" ? "Before" : "After"}: <code title={cellValueLabel(record[side]).slice(0, 1000)}>{cellValueLabel(record[side]).slice(0, 160)}{(record[side]?.length ?? 0) > 160 ? "…" : ""}</code></span><Button small text="Use this value" disabled={busy || !editable || !canRestoreCell(record, target, context)} onClick={() => { if (editing) setDraft(record[side]); else startEditing(record[side]); }} /></div>)}
            {!canRestoreCell(record, target, context) && <small>Table changed since this edit; this value cannot be restored.</small>}
          </div>)}
        </section>}
      </div>
      <div className={Classes.DIALOG_FOOTER}><div className={`${Classes.DIALOG_FOOTER_ACTIONS} dg-cell-footer`}>
        <Button icon="clipboard" text="Copy raw value" disabled={busy} onClick={() => { void copy(); }} />
        {editing ? <><Button text="Cancel" disabled={busy} onClick={() => { void cancelEditing(); }} /><Button intent={Intent.PRIMARY} text="Apply change" loading={busy} disabled={!editable || !dirty || overLimit} onClick={() => { void apply(); }} /></> : <><Button text="Export file…" disabled={busy || target.tableName !== activeTable} onClick={async () => { if (await guard()) { onClose(); onExport(); } }} /><Button icon="edit" text="Edit" disabled={!editable} onClick={() => startEditing()} /><Button text="Close" onClick={() => { void close(); }} /></>}
      </div></div>
    </Dialog>
    <Alert isOpen={discardOpen} intent={Intent.WARNING} icon="warning-sign" confirmButtonText="Discard draft" cancelButtonText="Keep editing" onConfirm={() => resolveDiscard(true)} onCancel={() => resolveDiscard(false)}><p>Discard the unapplied cell draft? Export only saves applied table changes.</p></Alert>
  </>;
}
