import { useCallback, useEffect, useRef, useState } from "react";
import { SortColumn } from "../types";
import { buildTableSearchRequest, FindCell, flattenFindMatches, SearchRequestGate, TableSearchScope } from "../utils/tableSearch";

interface FindBatch { cells: FindCell[]; index: number; before: boolean; after: boolean; offset: number | null; total: number | null }
interface FindOptions { enabled: boolean; contextKey: string; scope?: TableSearchScope; columns: string[]; sortColumns: SortColumn[]; totalRows: number; onNavigate: (cell: FindCell) => void }

/** One bounded page only. Old scans are interrupted and settled before starting replacements. */
export function useTableFind(options: FindOptions) {
  const [term, setTerm] = useState("");
  const [batch, setBatch] = useState<FindBatch | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const gate = useRef(new SearchRequestGate());
  const pending = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(options);
  latest.current = options;
  const batchRef = useRef(batch); batchRef.current = batch;
  const termRef = useRef(term); termRef.current = term;

  const invalidate = useCallback(() => {
    const id = gate.current.invalidate();
    if (id !== null) void window.api.cancelTableSearch(id).catch(() => {});
  }, []);

  const scan = useCallback((direction: "forward" | "backward", cursor: number, placement: "first" | "last", offset: number | null, total: number | null) => {
    invalidate();
    let id = gate.current.begin();
    const captured = latest.current;
    const text = termRef.current;
    setLoading(true); setNotice("");
    const work = pending.current.catch(() => {}).then(async () => {
      if (!gate.current.isCurrent(id) || !captured.scope) return;
      try {
        // A native job can be stopping after window-close cancellation. Retry the
        // coalesced latest request; there is never more than one scan per window.
        let response;
        for (;;) {
          response = await window.api.searchTable(buildTableSearchRequest(id, captured.scope, captured.columns, captured.sortColumns, text, direction, cursor));
          if (!gate.current.isCurrent(id)) return;
          if (response.status !== "busy") break;
          await new Promise(resolve => setTimeout(resolve, 40));
          if (!gate.current.isCurrent(id)) return;
          id = gate.current.begin();
        }
        if (response.status === "timedOut") { setNotice("Search paused — refine the text"); return; }
        if (response.status === "cancelled") { setNotice("Search cancelled"); return; }
        const cells = flattenFindMatches(response.matches);
        const atStart = direction === "forward" ? cursor === 0 : !response.hasMore;
        const atEnd = direction === "backward" ? cursor >= captured.totalRows : !response.hasMore;
        const knownOffset = atStart ? 0 : direction === "backward" && offset !== null ? Math.max(0, offset - cells.length) : offset;
        const knownTotal = total ?? (atEnd && knownOffset !== null ? knownOffset + cells.length : null);
        const next: FindBatch = { cells, index: placement === "last" ? Math.max(0, cells.length - 1) : 0, before: !atStart, after: !atEnd, offset: knownOffset, total: knownTotal };
        setBatch(next);
        if (cells.length) latest.current.onNavigate(cells[next.index]);
      } catch (error) {
        if (gate.current.isCurrent(id)) setNotice(String(error instanceof Error ? error.message : error));
      } finally {
        if (gate.current.isCurrent(id)) setLoading(false);
      }
    });
    pending.current = work;
  }, [invalidate]);

  const changeTerm = useCallback((text: string) => {
    invalidate(); setLoading(false); setBatch(null); setNotice(""); setTerm(text);
  }, [invalidate]);

  useEffect(() => {
    invalidate(); setBatch(null); setNotice(""); setLoading(false);
    if (!options.enabled || !term.length) return;
    const timer = setTimeout(() => scan("forward", 0, "first", 0, null), 350);
    return () => { clearTimeout(timer); invalidate(); };
  }, [options.enabled, options.contextKey, term, invalidate, scan]);

  useEffect(() => () => invalidate(), [invalidate]);

  const navigate = useCallback((direction: 1 | -1) => {
    const current = batchRef.current;
    if (!current?.cells.length) return;
    const index = current.index + direction;
    if (index >= 0 && index < current.cells.length) {
      const next = { ...current, index }; setBatch(next); batchRef.current = next;
      latest.current.onNavigate(next.cells[index]);
      return;
    }
    if (direction === 1 && current.after) {
      scan("forward", current.cells[current.cells.length - 1].row + 1, "first", current.offset === null ? null : current.offset + current.cells.length, current.total);
    } else if (direction === -1 && current.before) {
      scan("backward", current.cells[0].row, "last", current.offset, current.total);
    } else if (!current.before && !current.after) {
      const next = { ...current, index: direction === 1 ? 0 : current.cells.length - 1 }; setBatch(next); batchRef.current = next;
      latest.current.onNavigate(next.cells[next.index]);
    } else if (direction === 1) scan("forward", 0, "first", 0, current.total);
    else scan("backward", latest.current.totalRows, "last", current.total, current.total);
  }, [scan]);

  const cancel = useCallback(() => { invalidate(); setLoading(false); setNotice("Search cancelled"); }, [invalidate]);
  const active = options.enabled && term && batch ? batch.cells[batch.index] ?? null : null;
  let status = notice;
  if (!status && term) {
    if (loading || !batch) status = "Searching…";
    else if (!batch.cells.length) status = "No matches";
    else if (batch.offset === null) status = `${batch.cells.length}+ matches`;
    else status = `${batch.offset + batch.index + 1} of ${batch.total ?? batch.offset + batch.cells.length}${batch.total === null ? "+" : ""}`;
  }
  return { term, changeTerm, loading, status, active, navigate, cancel, canNavigate: !!batch?.cells.length && !loading };
}
