import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@blueprintjs/core";

function cellKey(row: number, col: string): string {
  return `${row}:${col}`;
}

interface DataGridProps {
  rows: any[];
  columns: string[];
  sortColumn: string | null;
  sortDirection: "ASC" | "DESC";
  onSort: (column: string) => void;
}

export function DataGrid({
  rows,
  columns,
  sortColumn,
  sortDirection,
  onSort,
}: DataGridProps): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<{ row: number; col: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCellClick = useCallback(
    (rowIdx: number, col: string, e: React.MouseEvent) => {
      const meta = e.metaKey || e.ctrlKey;

      if (e.shiftKey && anchor.current) {
        // Range select
        const r0 = Math.min(anchor.current.row, rowIdx);
        const r1 = Math.max(anchor.current.row, rowIdx);
        const c0 = Math.min(columns.indexOf(anchor.current.col), columns.indexOf(col));
        const c1 = Math.max(columns.indexOf(anchor.current.col), columns.indexOf(col));

        const next = meta ? new Set(selected) : new Set<string>();
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            next.add(cellKey(r, columns[c]));
          }
        }
        setSelected(next);
      } else if (meta) {
        // Toggle cell
        const next = new Set(selected);
        const k = cellKey(rowIdx, col);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        setSelected(next);
        anchor.current = { row: rowIdx, col };
      } else {
        // Single select
        setSelected(new Set([cellKey(rowIdx, col)]));
        anchor.current = { row: rowIdx, col };
      }
    },
    [columns, selected]
  );

  // Cmd/Ctrl+C copy
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selected.size > 0) {
        const parsed = [...selected].map((k) => {
          const i = k.indexOf(":");
          return { row: Number(k.slice(0, i)), col: k.slice(i + 1) };
        });

        const rowNums = [...new Set(parsed.map((p) => p.row))].sort((a, b) => a - b);
        const colNames = columns.filter((c) => parsed.some((p) => p.col === c));

        const text = rowNums
          .map((r) =>
            colNames
              .map((c) => (selected.has(cellKey(r, c)) ? formatCell(rows[r]?.[c]) : ""))
              .join("\t")
          )
          .join("\n");

        e.preventDefault();
        navigator.clipboard.writeText(text);
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [selected, rows, columns]);

  if (columns.length === 0 || rows.length === 0) {
    return (
      <div className="welcome">
        <p>No data to display</p>
      </div>
    );
  }

  return (
    <div className="data-grid-container" ref={containerRef} tabIndex={-1}>
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 50, textAlign: "right", color: "#5c7080" }}>#</th>
            {columns.map((col) => (
              <th key={col} onClick={() => onSort(col)}>
                {col}
                {sortColumn === col && (
                  <span className="sort-indicator">
                    <Icon
                      icon={sortDirection === "ASC" ? "chevron-up" : "chevron-down"}
                      size={12}
                    />
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIdx) => (
            <tr key={rowIdx}>
              <td style={{ textAlign: "right", color: "#5c7080", fontSize: 11 }}>
                {rowIdx + 1}
              </td>
              {columns.map((col) => (
                <td
                  key={col}
                  title={String(row[col] ?? "")}
                  className={selected.has(cellKey(rowIdx, col)) ? "cell-selected" : ""}
                  onClick={(e) => handleCellClick(rowIdx, col, e)}
                >
                  {formatCell(row[col])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatCell(value: any): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") {
    return Number.isInteger(value) ? value.toString() : value.toFixed(4);
  }
  return String(value);
}
