import React, { useEffect, useRef } from "react";
import { Button, Icon, Spinner } from "@blueprintjs/core";
import { TABLE_SEARCH_MAX_TERM } from "../utils/tableSearch";

interface TableFindBarProps {
  term: string;
  onChange: (value: string) => void;
  status: string;
  loading: boolean;
  canNavigate: boolean;
  onNavigate: (direction: 1 | -1) => void;
  onCancel: () => void;
  onClose: () => void;
}

export function TableFindBar({ term, onChange, status, loading, canNavigate, onNavigate, onCancel, onClose }: TableFindBarProps): React.ReactElement {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  return <div id="dg-find-panel" className="dg-find-bar" role="search" aria-label="Find in table" onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}>
    <div className="dg-find-field">
      {loading
        ? <Button className="dg-find-field-icon" small minimal aria-label="Cancel search" title="Cancel search" onMouseDown={keepFocus} onClick={onCancel}><Spinner size={12} /></Button>
        : <Icon className="dg-find-field-icon" icon="search" size={14} />}
      <input ref={input} id="dg-search-term" className="bp4-input" type="search" aria-label="Find in table" placeholder="Find in table" autoComplete="off" spellCheck={false} maxLength={TABLE_SEARCH_MAX_TERM * 2} value={term} onChange={event => onChange(event.currentTarget.value)} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); if (canNavigate) onNavigate(event.shiftKey ? -1 : 1); }
      }} />
    </div>
    <span className="dg-find-status" role="status" aria-live="polite" title={status}>{status}</span>
    <Button small minimal icon="chevron-up" aria-label="Previous match" title="Previous match (Shift Enter)" disabled={!canNavigate} onMouseDown={keepFocus} onClick={() => onNavigate(-1)} />
    <Button small minimal icon="chevron-down" aria-label="Next match" title="Next match (Enter)" disabled={!canNavigate} onMouseDown={keepFocus} onClick={() => onNavigate(1)} />
    <Button small minimal icon="cross" aria-label="Close find" title="Close find (Escape)" onClick={onClose} />
  </div>;
}
