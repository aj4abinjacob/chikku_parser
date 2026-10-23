import React, { useEffect, useRef, useState } from "react";
import { Button, Classes, Dialog, Icon, Spinner } from "@blueprintjs/core";
import { SoftSelect } from "./SoftSelect";
import { TableSearchResult } from "../types";
import { buildTableSearchRequest, SearchRequestGate, TableSearchScope, TABLE_SEARCH_LIMIT, TABLE_SEARCH_MAX_COLUMNS, TABLE_SEARCH_MAX_TERM } from "../utils/tableSearch";

interface TableSearchDialogProps {
  scope: TableSearchScope;
  columns: string[];
  filtersActive: boolean;
  onClose: () => void;
}

export function TableSearchDialog({ scope, columns, filtersActive, onClose }: TableSearchDialogProps): React.ReactElement {
  const [term, setTerm] = useState("");
  const [column, setColumn] = useState("");
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [result, setResult] = useState<TableSearchResult | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [copied, setCopied] = useState<number | null>(null);
  const gate = useRef(new SearchRequestGate());
  const pending = useRef<number | null>(null);
  const cancelled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const invalidate = () => {
    const requestId = gate.current.invalidate();
    if (requestId !== null) void window.api.cancelTableSearch(requestId).catch(() => {});
  };

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      const requestId = gate.current.invalidate();
      if (requestId !== null) void window.api.cancelTableSearch(requestId).catch(() => {});
    };
  }, []);

  const clear = () => {
    invalidate();
    setResult(null);
    setError("");
    setNotice("");
    setCopied(null);
    setCancelling(false);
  };

  const cancel = () => {
    cancelled.current = true;
    invalidate();
    setCancelling(true);
    setResult(null);
    setError("");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current !== null) return;
    const requestId = gate.current.begin();
    try {
      const request = buildTableSearchRequest(requestId, scope, columns, column, term);
      pending.current = requestId;
      cancelled.current = false;
      setLoading(true);
      setCancelling(false);
      setResult(null);
      setError("");
      setNotice("");
      setCopied(null);
      const response = await window.api.searchTable(request);
      if (!gate.current.isCurrent(requestId)) return;
      if (response.status === "busy") setError("The previous search is stopping. Try Search again in a moment.");
      else if (response.status === "timedOut") setError("Search stopped after 15 seconds. Choose one column or add filters, then try again.");
      else if (response.status === "cancelled") setNotice("Search cancelled.");
      else setResult(response);
    } catch (err) {
      if (gate.current.isCurrent(requestId)) setError(String(err instanceof Error ? err.message : err));
    } finally {
      if (pending.current === requestId) {
        pending.current = null;
        setLoading(false);
        setCancelling(false);
        if (cancelled.current) setNotice("Search cancelled.");
      }
    }
  };

  return <Dialog isOpen onClose={onClose} title="Search table" icon="search" className="dg-search-dialog" canOutsideClickClose={false}>
    <form onSubmit={submit}>
      <div className={Classes.DIALOG_BODY}>
        <div className="dg-search-scope"><Icon icon="document" /><strong title={scope.displayName}>{scope.displayName}</strong><span>{filtersActive ? "Current filtered rows" : "All rows"}</span></div>
        <div className="dg-search-fields">
          <label htmlFor="dg-search-term">Find text
            <input ref={inputRef} id="dg-search-term" className="bp4-input" type="search" autoComplete="off" spellCheck={false} maxLength={TABLE_SEARCH_MAX_TERM * 2} placeholder="Text to find…" value={term} disabled={loading} onChange={event => { clear(); setTerm(event.target.value); }} aria-describedby="dg-search-help" />
          </label>
          <label htmlFor="dg-search-column">Search in
            <SoftSelect id="dg-search-column" className="dg-search-column" fill aria-label="Search in" value={column} disabled={loading} onChange={event => { clear(); setColumn(event.target.value); }}>
              <option value="">Visible columns ({columns.length})</option>
              {columns.map(name => <option key={name} value={name}>{name}</option>)}
            </SoftSelect>
          </label>
        </div>
        {!column && columns.length > TABLE_SEARCH_MAX_COLUMNS && <p className="dg-search-error">Choose one column to search this wide table (more than 200 visible columns).</p>}
        <p id="dg-search-help" className="dg-search-help">Case-insensitive, literal text. Searches complete stored values when you press Search or Enter. Choose one column for less work on large files.</p>
        <p className="dg-search-help">Up to {TABLE_SEARCH_LIMIT} matching rows, with a preview of the first matching cell in each row. A broad search can scan the file; it stops after 15 seconds. Results may appear in a different order from the table.</p>
        <div className="dg-search-status" role="status" aria-live="polite">
          {loading ? <span><Spinner size={16} />{cancelling ? "Stopping search…" : "Searching… You can cancel at any time."}</span> : error ? <span className="dg-search-error"><Icon icon="warning-sign" />{error}</span> : notice ? <span>{notice}</span> : result ? <strong>{result.matches.length === 0 ? "No matching rows in this scope." : result.hasMore ? `Showing ${result.limit} matching rows. More exist; refine the text or choose one column.` : `${result.matches.length} matching ${result.matches.length === 1 ? "row" : "rows"}.`}</strong> : "Enter text, then press Search."}
        </div>
        {result && result.matches.length > 0 && <ol className="dg-search-results" aria-label="Matching row previews">
          {result.matches.map((match, index) => <li key={`${index}-${match.column}`}>
            <div className="dg-search-match-header"><span className="dg-search-match-number">Match {index + 1}</span><strong title={match.column}>{match.column}</strong><Button type="button" minimal small icon="clipboard" text={copied === index ? "Copied" : "Copy preview"} aria-label={`Copy preview for match ${index + 1}`} onClick={async () => {
              try { await navigator.clipboard.writeText(match.preview); setCopied(index); }
              catch { setError("Could not copy. Select the preview text and copy it manually."); }
            }} /></div>
            <pre tabIndex={0} aria-label={`Preview for match ${index + 1}`}>{match.truncatedStart && <span className="dg-search-ellipsis" aria-label="Earlier text omitted">…</span>}{match.preview}{match.truncatedEnd && <span className="dg-search-ellipsis" aria-label="Later text omitted">…</span>}</pre>
          </li>)}
        </ol>}
      </div>
      <div className={Classes.DIALOG_FOOTER}><div className={Classes.DIALOG_FOOTER_ACTIONS}>
        {loading && <Button type="button" text="Cancel search" disabled={cancelling} onClick={cancel} />}
        {!loading && result && <Button type="button" text="Clear results" onClick={() => { clear(); inputRef.current?.focus(); }} />}
        <Button type="submit" intent="primary" icon="search" text="Search" disabled={loading || !term.length || !columns.length || (!column && columns.length > TABLE_SEARCH_MAX_COLUMNS)} />
        <Button type="button" text="Close" onClick={onClose} />
      </div></div>
    </form>
  </Dialog>;
}
