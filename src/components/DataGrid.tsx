import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@blueprintjs/core";

interface CellKey {
  row: number;
  col: string;
}

function cellKeyStr(row: number, col: string): string {
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
  const [selectedCells, setSelectedCells] = useState<Set<string>>(new Set());
  const lastClickedCell = useRef<CellKey | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCellClick = useCallback(
    (rowIdx: number, col: string, e: React.MouseEvent) => {
      const key = cellKeyStr(rowIdx, col);
      const metaKey = e.metaKey || e.ctrlKey;

      if (e.shiftKey && lastClickedCell.current) {
        // Range selection from last clicked cell to current
        const startRow = Math.min(lastClickedCell.current.row, rowIdx);
        const endRow = Math.max(lastClickedCell.current.row, rowIdx);
        const startColIdx = Math.min(
          columns.indexOf(lastClickedCell.current.col),
          columns.indexOf(col)
        );
        const endColIdx = Math.max(
          columns.indexOf(lastClickedCell.current.col),
          columns.indexOf(col)
        );

        const newSelection = metaKey ? new Set(selectedCells) : new Set<string>();
        for (let r = startRow; r <= endRow; r++) {
          for (let c = startColIdx; c <= endColIdx; c++) {
            newSelection.add(cellKeyStr(r, columns[c]));
          }
        }
        setSelectedCells(newSelection);
      } else if (metaKey) {
        // Toggle individual cell
        const next = new Set(selectedCells);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        setSelectedCells(next);
        lastClickedCell.current = { row: rowIdx, col };
      } else {
        // Single cell select
        setSelectedCells(new Set([key]));
        lastClickedCell.current = { row: rowIdx, col };
      }
    },
    [columns, selectedCells]
  );

  // Copy handler
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selectedCells.size > 0) {
        // Parse selected keys and build a grid of values
        const parsed: CellKey[] = [];
        selectedCells.forEach((k) => {
          const sep = k.indexOf(":");
          parsed.push({ row: Number(k.slice(0, sep)), col: k.slice(sep + 1) });
        });

        const rowSet = [...new Set(parsed.map((p) => p.row))].sort((a, b) => a - b);
        const colSet = columns.filter((c) => parsed.some((p) => p.col === c));

        const text = rowSet
          .map((r) =>
            colSet
              .map((c) => {
                if (selectedCells.has(cellKeyStr(r, c))) {
                  return formatCell(rows[r]?.[c]);
                }
                return "";
              })
              .join("\t")
          )
          .join("\n");

        e.preventDefault();
        navigator.clipboard.writeText(text);
      }
    };

    const container = containerRef.current;
    if (container) {
      container.addEventListener("keydown", handler);
      return () => container.removeEventListener("keydown", handler);
    }
  }, [selectedCells, rows, columns]);

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
                  className={selectedCells.has(cellKeyStr(rowIdx, col)) ? "cell-selected" : ""}
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
