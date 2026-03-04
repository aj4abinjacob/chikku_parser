import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@blueprintjs/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SortColumn, PivotFlatRow, PivotGroupColumn } from "../types";

const TOOLTIP_DELAY = 600; // ms before tooltip appears

const ROW_HEIGHT = 28;
const PIVOT_GROUP_COL_WIDTH = 250;
const PIVOT_GROUP_COL_KEY = "__pivot_group__";

function cellKey(row: number, col: string): string {
  return `${row}:${col}`;
}

interface DataGridProps {
  totalRows: number;
  getRow: (absoluteIndex: number) => any | null;
  ensureRange: (startIndex: number, endIndex: number) => void;
  columns: string[];
  sortColumns: SortColumn[];
  onSort: (column: string, addLevel: boolean) => void;
  onReorderColumns?: (newOrder: string[]) => void;
  resetKey: number;
  pivotMode?: boolean;
  pivotFlatRows?: PivotFlatRow[];
  pivotGroupColumns?: PivotGroupColumn[];
  onToggleExpand?: (rowKey: string) => void;
  grandTotals?: Record<string, any> | null;
  showGrandTotal?: boolean;
  numericColumns?: Set<string>;
}

export function DataGrid({
  totalRows,
  getRow,
  ensureRange,
  columns,
  sortColumns,
  onSort,
  onReorderColumns,
  resetKey,
  pivotMode,
  pivotFlatRows,
  pivotGroupColumns,
  onToggleExpand,
  grandTotals,
  showGrandTotal,
  numericColumns,
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
    cellHeight: number;
  } | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipHovered = useRef(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [tooltipFlipped, setTooltipFlipped] = useState(false);

  /** Returns true if user has selected text inside the tooltip */
  const hasTooltipSelection = useCallback(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString()) return false;
    if (!tooltipRef.current) return false;
    return tooltipRef.current.contains(sel.anchorNode);
  }, []);

  // After tooltip renders, check if it overflows viewport and adjust
  useEffect(() => {
    if (!tooltip || !tooltipRef.current) { setTooltipFlipped(false); return; }
    const el = tooltipRef.current;
    const rect = el.getBoundingClientRect();
    // If top edge is above viewport, flip to below cell
    setTooltipFlipped(rect.top < 0);
    // Clamp horizontal position so it doesn't overflow right edge
    const overflowRight = rect.right - window.innerWidth + 8;
    if (overflowRight > 0) {
      el.style.left = `${tooltip.x - overflowRight}px`;
    }
  }, [tooltip]);

  const clearDismissTimer = useCallback(() => {
    if (tooltipDismissTimer.current) {
      clearTimeout(tooltipDismissTimer.current);
      tooltipDismissTimer.current = null;
    }
  }, []);

  const scheduleDismiss = useCallback((delay: number) => {
    clearDismissTimer();
    tooltipDismissTimer.current = setTimeout(() => {
      // Don't dismiss if user is hovering the tooltip or has text selected in it
      if (tooltipHovered.current || hasTooltipSelection()) return;
      setTooltip(null);
      setCopied(false);
    }, delay);
  }, [clearDismissTimer, hasTooltipSelection]);

  const handleCellMouseEnter = useCallback(
    (e: React.MouseEvent, value: string) => {
      if (!value) return;
      // Cancel any pending dismiss when entering a new cell
      clearDismissTimer();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      tooltipTimer.current = setTimeout(() => {
        setTooltip({
          text: value,
          x: rect.left,
          y: rect.top,
          cellHeight: rect.height,
        });
      }, TOOLTIP_DELAY);
    },
    [clearDismissTimer]
  );

  const handleCellMouseLeave = useCallback(() => {
    if (tooltipTimer.current) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
    // Delay dismiss so user can move cursor into tooltip
    scheduleDismiss(200);
  }, [scheduleDismiss]);

  const handleTooltipMouseEnter = useCallback(() => {
    tooltipHovered.current = true;
    clearDismissTimer();
  }, [clearDismissTimer]);

  const handleTooltipMouseLeave = useCallback(() => {
    tooltipHovered.current = false;
    const hadSelection = hasTooltipSelection();
    // Clear selection so it doesn't bleed into grid cells
    if (hadSelection) window.getSelection()?.removeAllRanges();
    // If text was selected, keep tooltip visible longer
    if (hadSelection) {
      scheduleDismiss(2000);
    } else {
      scheduleDismiss(150);
    }
  }, [hasTooltipSelection, scheduleDismiss]);

  const handleCopyTooltip = useCallback(() => {
    if (!tooltip) return;
    navigator.clipboard.writeText(tooltip.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [tooltip]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
      if (tooltipDismissTimer.current) clearTimeout(tooltipDismissTimer.current);
    };
  }, []);

  // ── Sort / pivot group index map ──
  const sortIndexMap = useMemo(() => {
    const map = new Map<string, { index: number; direction: "ASC" | "DESC" }>();
    sortColumns.forEach((sc, i) => map.set(sc.column, { index: i + 1, direction: sc.direction }));
    return map;
  }, [sortColumns]);

  // Set of column names being grouped — hidden from data columns in pivot mode
  const groupedColumnNames = useMemo(() => {
    if (!pivotGroupColumns) return new Set<string>();
    return new Set(pivotGroupColumns.map(gc => gc.column));
  }, [pivotGroupColumns]);

  // In pivot mode, exclude grouped columns from data columns (they're shown in the Group column)
  const dataColumns = useMemo(() => {
    if (!pivotMode || groupedColumnNames.size === 0) return columns;
    return columns.filter(c => !groupedColumnNames.has(c));
  }, [columns, pivotMode, groupedColumnNames]);

  // ── Column resize state ──
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});
  const isDragging = useRef(false);
  const justFinishedResize = useRef(false);
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

  // Effective row count
  const effectiveRowCount = pivotMode && pivotFlatRows ? pivotFlatRows.length : totalRows;

  // Virtualizer
  const virtualizer = useVirtualizer({
    count: effectiveRowCount,
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

  // Calculate column widths — preserve existing widths, only compute defaults for new columns
  useEffect(() => {
    if (columns.length === 0) return;
    const container = containerRef.current;
    if (!container) return;
    const firstColWidth = pivotMode ? PIVOT_GROUP_COL_WIDTH : 50;
    const availableWidth = container.clientWidth - firstColWidth;
    const defaultWidth = Math.max(150, Math.floor(availableWidth / columns.length));
    setColumnWidths((prev) => {
      const widths: Record<string, number> = {};
      if (pivotMode) {
        widths[PIVOT_GROUP_COL_KEY] = prev[PIVOT_GROUP_COL_KEY] ?? PIVOT_GROUP_COL_WIDTH;
      }
      for (const col of columns) {
        widths[col] = prev[col] ?? defaultWidth;
      }
      return widths;
    });
  }, [columns, pivotMode]);

  // Total width of all columns for horizontal scroll
  const groupColWidth = pivotMode ? (columnWidths[PIVOT_GROUP_COL_KEY] ?? PIVOT_GROUP_COL_WIDTH) : 50;
  // Use dataColumns (excludes grouped cols) for pivot mode width
  const displayColumns = pivotMode ? dataColumns : columns;
  const totalWidth =
    groupColWidth + displayColumns.reduce((sum, col) => sum + (columnWidths[col] ?? 150), 0);

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
      justFinishedResize.current = true;
      requestAnimationFrame(() => { justFinishedResize.current = false; });
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

  // Canvas context for text measurement (reused across calls)
  const measureCtx = useRef<CanvasRenderingContext2D | null>(null);
  // Track which columns are currently auto-fitted (double-click toggles)
  const autoFittedCols = useRef<Set<string>>(new Set());

  const handleResizeDoubleClick = useCallback(
    (e: React.MouseEvent, col: string) => {
      e.preventDefault();
      e.stopPropagation();

      // If already auto-fitted, revert to default width
      if (autoFittedCols.current.has(col)) {
        autoFittedCols.current.delete(col);
        const container = containerRef.current;
        if (!container) return;
        const firstColWidth = pivotMode ? PIVOT_GROUP_COL_WIDTH : 50;
        const availableWidth = container.clientWidth - firstColWidth;
        const defaultWidth = Math.max(150, Math.floor(availableWidth / columns.length));
        setColumnWidths((prev) => ({ ...prev, [col]: defaultWidth }));
        return;
      }

      // Lazily create a measurement canvas
      if (!measureCtx.current) {
        const canvas = document.createElement("canvas");
        measureCtx.current = canvas.getContext("2d");
      }
      const ctx = measureCtx.current;
      if (!ctx) return;

      const CELL_PADDING = 24; // 12px left + 12px right
      const HEADER_EXTRA = 30; // room for sort indicator + resize handle
      const MIN_WIDTH = 50;

      // Measure header text (bold)
      ctx.font = 'bold 13px "SF Mono", Menlo, Monaco, monospace';
      let maxWidth = ctx.measureText(col).width + CELL_PADDING + HEADER_EXTRA;

      // Measure visible data cells
      ctx.font = '13px "SF Mono", Menlo, Monaco, monospace';
      const range = virtualizer.range;
      if (range) {
        for (let i = range.startIndex; i <= range.endIndex; i++) {
          let value: any;
          if (pivotMode && pivotFlatRows) {
            const pRow = pivotFlatRows[i];
            if (pRow?.type === "data" && pRow.data) value = pRow.data[col];
            else if (pRow?.type === "group") continue;
          } else {
            const row = getRow(i);
            if (row) value = row[col];
          }
          const text = formatCell(value);
          if (text) {
            const w = ctx.measureText(text).width + CELL_PADDING;
            if (w > maxWidth) maxWidth = w;
          }
        }
      }

      const fitWidth = Math.max(MIN_WIDTH, Math.ceil(maxWidth));
      autoFittedCols.current.add(col);
      setColumnWidths((prev) => ({ ...prev, [col]: fitWidth }));
    },
    [virtualizer, getRow, pivotMode, pivotFlatRows, columns]
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
            if (pivotMode && pivotFlatRows) {
              const flatRow = pivotFlatRows[r];
              if (!flatRow || flatRow.type === "group") return "";
              const row = flatRow.data;
              return colNames
                .map((c) =>
                  selected.has(cellKey(r, c)) ? formatCell(row?.[c]) : ""
                )
                .join("\t");
            }
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
  }, [selected, getRow, columns, pivotMode, pivotFlatRows]);

  if (columns.length === 0 || (effectiveRowCount === 0 && !pivotMode)) {
    return (
      <div className="welcome">
        <p>No data to display</p>
      </div>
    );
  }

  // In pivot mode with no groups yet, show hint
  if (pivotMode && (!pivotGroupColumns || pivotGroupColumns.length === 0)) {
    return (
      <div className="welcome">
        <p>Click a column header to group by that column</p>
        <p style={{ fontSize: 12, color: "#5c7080" }}>Shift+click to add more group levels</p>
      </div>
    );
  }

  const virtualRows = virtualizer.getVirtualItems();
  const maxGroupDepth = pivotGroupColumns ? pivotGroupColumns.length - 1 : 0;

  // Helper: get aggregate value for a column from an aggregates record
  const getAggValue = (aggregates: Record<string, any> | undefined, col: string): string => {
    if (!aggregates) return "";
    for (const key of Object.keys(aggregates)) {
      if (key.startsWith(`${col}:`)) {
        return formatCell(aggregates[key]);
      }
    }
    return "";
  };

  return (
    <div className="data-grid-container" ref={containerRef} tabIndex={-1}>
      <div className="data-grid-scroll" ref={scrollRef}>
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          {/* Sticky header */}
          <div className="dg-header">
            {pivotMode ? (
              <div className="dg-cell dg-pivot-group-header" style={{ width: groupColWidth }}>
                <span className="dg-header-text">Group</span>
                <div
                  className="col-resize-handle"
                  onMouseDown={(e) => handleResizeStart(e, PIVOT_GROUP_COL_KEY)}
                  onDoubleClick={(e) => handleResizeDoubleClick(e, PIVOT_GROUP_COL_KEY)}
                />
              </div>
            ) : (
              <div className="dg-cell dg-row-num-cell dg-header-num">#</div>
            )}
            {displayColumns.map((col) => {
              const sortInfo = sortIndexMap.get(col);
              return (
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
                  draggable={!pivotMode && !!onReorderColumns}
                  onClick={(e) => { if (!justFinishedResize.current) onSort(col, e.shiftKey); }}
                  onDragStart={(e) => handleHeaderDragStart(e, col)}
                  onDragOver={(e) => handleHeaderDragOver(e, col)}
                  onDragLeave={handleHeaderDragLeave}
                  onDrop={handleHeaderDrop}
                  onDragEnd={handleHeaderDragEnd}
                >
                  <span className="dg-header-text">{col}</span>
                  {sortInfo && (
                    <span className="sort-indicator">
                      {sortColumns.length > 1 && (
                        <span className="sort-indicator-number">{sortInfo.index}</span>
                      )}
                      <Icon
                        icon={sortInfo.direction === "ASC" ? "chevron-up" : "chevron-down"}
                        size={12}
                      />
                    </span>
                  )}
                  <div
                    className="col-resize-handle"
                    onMouseDown={(e) => handleResizeStart(e, col)}
                    onDoubleClick={(e) => handleResizeDoubleClick(e, col)}
                  />
                </div>
              );
            })}
          </div>

          {/* Virtual rows */}
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualRows.map((virtualRow) => {
              // Pivot mode rendering
              if (pivotMode && pivotFlatRows) {
                const flatRow = pivotFlatRows[virtualRow.index];
                if (!flatRow) return null;

                if (flatRow.type === "group") {
                  const indent = 16 + flatRow.depth * 24;
                  return (
                    <div
                      key={virtualRow.index}
                      className={`dg-row dg-pivot-group-row dg-pivot-depth-${Math.min(flatRow.depth, 3)}`}
                      style={{
                        position: "absolute",
                        top: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                        width: "100%",
                        height: ROW_HEIGHT,
                      }}
                      onClick={() => onToggleExpand?.(flatRow.key)}
                    >
                      {/* Dedicated Group column */}
                      <div
                        className="dg-cell dg-pivot-group-cell"
                        style={{
                          width: groupColWidth,
                          paddingLeft: indent,
                        }}
                      >
                        <Icon
                          icon={flatRow.expanded ? "chevron-down" : "chevron-right"}
                          size={14}
                          className="dg-pivot-expand-icon"
                        />
                        <span
                          className="dg-pivot-group-value"
                          title={String(flatRow.groupValue ?? "")}
                        >
                          {formatCell(flatRow.groupValue)}
                        </span>
                        <span className="dg-pivot-group-count">
                          ({flatRow.groupCount?.toLocaleString()})
                        </span>
                      </div>
                      {/* Data columns: show aggregates if available */}
                      {dataColumns.map((col) => {
                        const cellText = getAggValue(flatRow.aggregates, col);
                        return (
                          <div
                            key={col}
                            className={`dg-cell${cellText ? " dg-pivot-agg-value" : ""}`}
                            style={{ width: columnWidths[col] ?? 150 }}
                          >
                            {cellText}
                          </div>
                        );
                      })}
                    </div>
                  );
                }

                // Data row within expanded group
                const rowData = flatRow.data;
                const loaded = rowData !== null && rowData !== undefined;
                return (
                  <div
                    key={virtualRow.index}
                    className="dg-row dg-pivot-data-row"
                    style={{
                      position: "absolute",
                      top: 0,
                      transform: `translateY(${virtualRow.start}px)`,
                      width: "100%",
                      height: ROW_HEIGHT,
                    }}
                  >
                    {/* Empty Group column for data rows */}
                    <div
                      className="dg-cell dg-pivot-data-group-cell"
                      style={{ width: groupColWidth }}
                    />
                    {/* Data columns: show actual cell values */}
                    {dataColumns.map((col) => {
                      const cellText = loaded ? formatCell(rowData[col]) : "...";
                      return (
                        <div
                          key={col}
                          className={[
                            "dg-cell",
                            selected.has(cellKey(virtualRow.index, col))
                              ? "cell-selected"
                              : "",
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
                              handleCellMouseEnter(e, String(rowData[col] ?? ""));
                          }}
                          onMouseLeave={handleCellMouseLeave}
                        >
                          {cellText}
                        </div>
                      );
                    })}
                  </div>
                );
              }

              // Normal (flat) mode rendering
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

          {/* Grand total row — at the bottom, after virtual rows */}
          {pivotMode && showGrandTotal && grandTotals && (
            <div className="dg-pivot-grand-total-row">
              {/* Group column: Total label */}
              <div
                className="dg-cell dg-pivot-group-cell"
                style={{ width: groupColWidth, paddingLeft: 16 }}
              >
                <span className="dg-pivot-group-value">
                  Total
                </span>
                <span className="dg-pivot-group-count">
                  ({formatCell(grandTotals.__count)})
                </span>
              </div>
              {/* Data columns: show aggregates if available */}
              {dataColumns.map((col) => {
                const cellText = getAggValue(grandTotals, col);
                return (
                  <div
                    key={col}
                    className={`dg-cell${cellText ? " dg-pivot-agg-value" : ""}`}
                    style={{ width: columnWidths[col] ?? 150 }}
                  >
                    {cellText}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {tooltip && (
        <div
          ref={tooltipRef}
          className={`dg-tooltip${tooltipFlipped ? " dg-tooltip-below" : ""}`}
          style={{
            left: tooltip.x,
            top: tooltipFlipped ? tooltip.y + tooltip.cellHeight : tooltip.y,
          }}
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
        >
          <div className="dg-tooltip-body">
            <TooltipContent text={tooltip.text} />
          </div>
          <button
            className={`dg-tooltip-copy${copied ? " copied" : ""}`}
            onClick={handleCopyTooltip}
            title="Copy to clipboard"
          >
            <Icon icon={copied ? "tick" : "clipboard"} size={12} />
          </button>
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

// URL regex for detecting links in tooltip text
const URL_RE = /https?:\/\/[^\s<>"'`,;)}\]]+/g;

function TooltipContent({ text }: { text: string }): React.ReactElement {
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    parts.push(
      <a
        key={match.index}
        className="dg-tooltip-link"
        href="#"
        onClick={(e) => {
          e.preventDefault();
          (window as any).api.openExternal(url);
        }}
      >
        {url}
      </a>
    );
    lastIndex = URL_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }
  return <>{parts}</>;
}
