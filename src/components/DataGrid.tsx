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
  onReorderColumns?: (newOrder: string[]) => void;
}

export function DataGrid({
  rows,
  columns,
  sortColumn,
  sortDirection,
  onSort,
  onReorderColumns,
}: DataGridProps): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<{ row: number; col: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ── Column resize state ──
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const isDragging = useRef(false);
  const dragColRef = useRef<string | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // ── Header drag-reorder state ──
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const headerDragCol = useRef<string | null>(null);
  const [headerDropTarget, setHeaderDropTarget] = useState<{ col: string; position: "left" | "right" } | null>(null);

  // Calculate initial column widths when columns change
  useEffect(() => {
    if (columns.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const availableWidth = container.clientWidth - 50; // subtract row-number column
    const perCol = Math.max(150, Math.floor(availableWidth / columns.length));
    const widths: Record<string, number> = {};
    for (const col of columns) {
      widths[col] = perCol;
    }
    setColumnWidths(widths);
  }, [columns]);

  // Document-level drag listeners for column resize
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragColRef.current) return;
      const delta = e.clientX - dragStartX.current;
      const newWidth = Math.max(50, dragStartWidth.current + delta);
      setColumnWidths((prev) => ({
        ...prev,
        [dragColRef.current!]: newWidth,
      }));
    };

    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      dragColRef.current = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // ── Header drag-reorder handlers ──
  const handleHeaderDragStart = useCallback(
    (e: React.DragEvent, col: string) => {
      // Don't start header drag if a resize is active
      if (isDragging.current) {
        e.preventDefault();
        return;
      }
      headerDragCol.current = col;
      setDraggingColumn(col);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  const handleHeaderDragOver = useCallback(
    (e: React.DragEvent, col: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (!headerDragCol.current || headerDragCol.current === col) {
        setHeaderDropTarget(null);
        return;
      }
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      const position = e.clientX < midX ? "left" : "right";
      setHeaderDropTarget({ col, position });
    },
    []
  );

  const handleHeaderDragLeave = useCallback(() => {
    setHeaderDropTarget(null);
  }, []);

  const handleHeaderDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const fromCol = headerDragCol.current;
      if (!fromCol || !headerDropTarget || !onReorderColumns) return;

      const newOrder = [...columns];
      const fromIndex = newOrder.indexOf(fromCol);
      newOrder.splice(fromIndex, 1);
      let toIndex = newOrder.indexOf(headerDropTarget.col);
      if (headerDropTarget.position === "right") toIndex++;
      newOrder.splice(toIndex, 0, fromCol);

      onReorderColumns(newOrder);
      headerDragCol.current = null;
      setDraggingColumn(null);
      setHeaderDropTarget(null);
    },
    [columns, headerDropTarget, onReorderColumns]
  );

  const handleHeaderDragEnd = useCallback(() => {
    headerDragCol.current = null;
    setDraggingColumn(null);
    setHeaderDropTarget(null);
  }, []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, col: string) => {
      e.preventDefault();
      e.stopPropagation();
      isDragging.current = true;
      dragColRef.current = col;
      dragStartX.current = e.clientX;
      dragStartWidth.current = columnWidths[col] ?? 150;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [columnWidths]
  );

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
        <colgroup>
          <col style={{ width: 50 }} />
          {columns.map((col) => (
            <col key={col} style={{ width: columnWidths[col] ?? 150 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <th style={{ textAlign: "right", color: "#5c7080" }}>#</th>
            {columns.map((col) => (
              <th
                key={col}
                className={[
                  draggingColumn === col ? "column-dragging" : "",
                  headerDropTarget?.col === col ? `header-drop-${headerDropTarget.position}` : "",
                ].filter(Boolean).join(" ") || undefined}
                draggable={!!onReorderColumns}
                onClick={() => onSort(col)}
                onDragStart={(e) => handleHeaderDragStart(e, col)}
                onDragOver={(e) => handleHeaderDragOver(e, col)}
                onDragLeave={handleHeaderDragLeave}
                onDrop={handleHeaderDrop}
                onDragEnd={handleHeaderDragEnd}
              >
                {col}
                {sortColumn === col && (
                  <span className="sort-indicator">
                    <Icon
                      icon={sortDirection === "ASC" ? "chevron-up" : "chevron-down"}
                      size={12}
                    />
                  </span>
                )}
                <div
                  className="col-resize-handle"
                  onMouseDown={(e) => handleResizeStart(e, col)}
                />
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
                  className={[
                    selected.has(cellKey(rowIdx, col)) ? "cell-selected" : "",
                    draggingColumn === col ? "column-dragging" : "",
                  ].filter(Boolean).join(" ") || undefined}
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
