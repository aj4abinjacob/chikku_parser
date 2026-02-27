import React, { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@blueprintjs/core";
import { useVirtualizer } from "@tanstack/react-virtual";

const TOOLTIP_DELAY = 600; // ms before tooltip appears

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

  // ── Cell tooltip state ──
  const [tooltip, setTooltip] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCellMouseEnter = useCallback(
    (e: React.MouseEvent, value: string) => {
      if (!value) return;
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      tooltipTimer.current = setTimeout(() => {
        setTooltip({
          text: value,
          x: rect.left,
          y: rect.top,
        });
      }, TOOLTIP_DELAY);
    },
    []
  );

  const handleCellMouseLeave = useCallback(() => {
    if (tooltipTimer.current) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
    setTooltip(null);
  }, []);

  // Clean up timer on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    };
  }, []);

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

  // Reset range tracking when columns change so ensureRange re-fires after schema update
  const columnsKey = columns.join(",");
  useEffect(() => {
    rangeRef.current = null;
  }, [columnsKey]);

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
    rangeRef.current = null; // force ensureRange to re-fire
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

  // ── Click-drag selection state ──
  const dragSelecting = useRef(false);
  const dragBaseSelected = useRef<Set<string>>(new Set());

  const buildRange = useCallback(
    (
      fromRow: number,
      fromCol: string,
      toRow: number,
      toCol: string
    ): Set<string> => {
      const r0 = Math.min(fromRow, toRow);
      const r1 = Math.max(fromRow, toRow);
      const c0 = Math.min(columns.indexOf(fromCol), columns.indexOf(toCol));
      const c1 = Math.max(columns.indexOf(fromCol), columns.indexOf(toCol));
      const s = new Set<string>();
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          s.add(cellKey(r, columns[c]));
        }
      }
      return s;
    },
    [columns]
  );

  const handleCellMouseDown = useCallback(
    (rowIdx: number, col: string, e: React.MouseEvent) => {
      // Only handle left button
      if (e.button !== 0) return;
      const meta = e.metaKey || e.ctrlKey;

      if (e.shiftKey && anchor.current) {
        // Shift+click range — same behavior as before, no drag
        const range = buildRange(anchor.current.row, anchor.current.col, rowIdx, col);
        const next = meta ? new Set(selected) : new Set<string>();
        for (const k of range) next.add(k);
        setSelected(next);
        return;
      }

      // Prevent text selection during drag
      e.preventDefault();
      // Re-focus the container so Cmd+C keydown listener works
      containerRef.current?.focus();

      // Start drag selection
      dragSelecting.current = true;
      anchor.current = { row: rowIdx, col };

      if (meta) {
        // Cmd/Ctrl+click toggle: keep existing selection as base
        const k = cellKey(rowIdx, col);
        const base = new Set(selected);
        if (base.has(k)) base.delete(k);
        else base.add(k);
        dragBaseSelected.current = new Set(selected);
        setSelected(base);
      } else {
        dragBaseSelected.current = new Set();
        setSelected(new Set([cellKey(rowIdx, col)]));
      }
    },
    [columns, selected, buildRange]
  );

  const handleCellMouseEnterDrag = useCallback(
    (rowIdx: number, col: string) => {
      if (!dragSelecting.current || !anchor.current) return;
      const range = buildRange(anchor.current.row, anchor.current.col, rowIdx, col);
      const next = new Set(dragBaseSelected.current);
      for (const k of range) next.add(k);
      setSelected(next);
    },
    [buildRange]
  );

  // End drag selection on mouseup (document-level to catch releases outside grid)
  useEffect(() => {
    const onMouseUp = () => {
      dragSelecting.current = false;
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, []);

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
                  {columns.map((col) => {
                    const cellText = loaded ? formatCell(row[col]) : "...";
                    return (
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
                        onMouseDown={(e) =>
                          handleCellMouseDown(virtualRow.index, col, e)
                        }
                        onMouseEnter={(e) => {
                          handleCellMouseEnterDrag(virtualRow.index, col);
                          if (loaded && !dragSelecting.current)
                            handleCellMouseEnter(
                              e,
                              String(row[col] ?? "")
                            );
                        }}
                        onMouseLeave={handleCellMouseLeave}
                      >
                        {cellText}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {tooltip && (
        <div
          className="dg-tooltip"
          style={{
            left: tooltip.x,
            top: tooltip.y,
          }}
        >
          {tooltip.text}
        </div>
      )}
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
