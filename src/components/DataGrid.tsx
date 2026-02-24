import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@blueprintjs/core";
import { useVirtualizer } from "@tanstack/react-virtual";

const ROW_HEIGHT = 28;

function cellKey(row: number, col: string): string {
  return `${row}:${col}`;
}

interface DataGridProps {
  totalRows: number;
  getRow: (absoluteIndex: number) => any | null;
  ensureRange: (startIndex: number, endIndex: number) => void;
  columns: string[];
  sortColumn: string | null;
  sortDirection: "ASC" | "DESC";
  onSort: (column: string) => void;
  onReorderColumns?: (newOrder: string[]) => void;
  resetKey: number;
}

export function DataGrid({
  totalRows,
  getRow,
  ensureRange,
  columns,
  sortColumn,
  sortDirection,
  onSort,
  onReorderColumns,
  resetKey,
}: DataGridProps): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<{ row: number; col: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // ── Column resize state ──
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const isDragging = useRef(false);
  const dragColRef = useRef<string | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  // ── Header drag-reorder state ──
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const headerDragCol = useRef<string | null>(null);
  const [headerDropTarget, setHeaderDropTarget] = useState<{
    col: string;
    position: "left" | "right";
  } | null>(null);

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: totalRows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  // Notify chunk cache of visible range
  const rangeRef = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    const range = virtualizer.range;
    if (!range) return;
    const { startIndex, endIndex } = range;
    if (
      rangeRef.current &&
      rangeRef.current.start === startIndex &&
      rangeRef.current.end === endIndex
    ) {
      return;
    }
    rangeRef.current = { start: startIndex, end: endIndex };
    ensureRange(startIndex, endIndex);
  });

  // Scroll to top when resetKey changes
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 0;
    }
    setSelected(new Set());
    anchor.current = null;
  }, [resetKey]);

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

  // Total width of all columns for horizontal scroll
  const totalWidth =
    50 + columns.reduce((sum, col) => sum + (columnWidths[col] ?? 150), 0);

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
        const r0 = Math.min(anchor.current.row, rowIdx);
        const r1 = Math.max(anchor.current.row, rowIdx);
        const c0 = Math.min(
          columns.indexOf(anchor.current.col),
          columns.indexOf(col)
        );
        const c1 = Math.max(
          columns.indexOf(anchor.current.col),
          columns.indexOf(col)
        );

        const next = meta ? new Set(selected) : new Set<string>();
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            next.add(cellKey(r, columns[c]));
          }
        }
        setSelected(next);
      } else if (meta) {
        const next = new Set(selected);
        const k = cellKey(rowIdx, col);
        if (next.has(k)) next.delete(k);
        else next.add(k);
        setSelected(next);
        anchor.current = { row: rowIdx, col };
      } else {
        setSelected(new Set([cellKey(rowIdx, col)]));
        anchor.current = { row: rowIdx, col };
      }
    },
    [columns, selected]
  );

  // Cmd/Ctrl+C copy — uses getRow instead of rows array
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selected.size > 0) {
        const parsed = [...selected].map((k) => {
          const i = k.indexOf(":");
          return { row: Number(k.slice(0, i)), col: k.slice(i + 1) };
        });

        const rowNums = [...new Set(parsed.map((p) => p.row))].sort(
          (a, b) => a - b
        );
        const colNames = columns.filter((c) =>
          parsed.some((p) => p.col === c)
        );

        const text = rowNums
          .map((r) => {
            const row = getRow(r);
            return colNames
              .map((c) =>
                selected.has(cellKey(r, c)) ? formatCell(row?.[c]) : ""
              )
              .join("\t");
          })
          .join("\n");

        e.preventDefault();
        navigator.clipboard.writeText(text);
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [selected, getRow, columns]);

  if (columns.length === 0 || totalRows === 0) {
    return (
      <div className="welcome">
        <p>No data to display</p>
      </div>
    );
  }

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div className="data-grid-container" ref={containerRef} tabIndex={-1}>
      <div className="data-grid-scroll" ref={scrollRef}>
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          {/* Sticky header */}
          <div className="dg-header">
            <div className="dg-cell dg-row-num-cell dg-header-num">#</div>
            {columns.map((col) => (
              <div
                key={col}
                className={[
                  "dg-cell dg-header-cell",
                  draggingColumn === col ? "column-dragging" : "",
                  headerDropTarget?.col === col
                    ? `header-drop-${headerDropTarget.position}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{ width: columnWidths[col] ?? 150 }}
                draggable={!!onReorderColumns}
                onClick={() => onSort(col)}
                onDragStart={(e) => handleHeaderDragStart(e, col)}
                onDragOver={(e) => handleHeaderDragOver(e, col)}
                onDragLeave={handleHeaderDragLeave}
                onDrop={handleHeaderDrop}
                onDragEnd={handleHeaderDragEnd}
              >
                <span className="dg-header-text">{col}</span>
                {sortColumn === col && (
                  <span className="sort-indicator">
                    <Icon
                      icon={
                        sortDirection === "ASC" ? "chevron-up" : "chevron-down"
                      }
                      size={12}
                    />
                  </span>
                )}
                <div
                  className="col-resize-handle"
                  onMouseDown={(e) => handleResizeStart(e, col)}
                />
              </div>
            ))}
          </div>

          {/* Virtual rows */}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualRows.map((virtualRow) => {
              const row = getRow(virtualRow.index);
              const loaded = row !== null;
              return (
                <div
                  key={virtualRow.index}
                  className="dg-row"
                  style={{
                    position: "absolute",
                    top: 0,
                    transform: `translateY(${virtualRow.start}px)`,
                    width: "100%",
                    height: ROW_HEIGHT,
                  }}
                >
                  <div className="dg-cell dg-row-num-cell">
                    {virtualRow.index + 1}
                  </div>
                  {columns.map((col) => (
                    <div
                      key={col}
                      className={[
                        "dg-cell",
                        selected.has(cellKey(virtualRow.index, col))
                          ? "cell-selected"
                          : "",
                        draggingColumn === col ? "column-dragging" : "",
                        !loaded ? "loading-cell" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ width: columnWidths[col] ?? 150 }}
                      title={loaded ? String(row[col] ?? "") : ""}
                      onClick={(e) =>
                        handleCellClick(virtualRow.index, col, e)
                      }
                    >
                      {loaded ? formatCell(row[col]) : "..."}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
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
