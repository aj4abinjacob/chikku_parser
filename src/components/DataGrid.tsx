import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button, ButtonGroup, Icon } from "@blueprintjs/core";
import { Popover2 } from "@blueprintjs/popover2";
import { SoftSelect } from "./SoftSelect";
import { TableFindBar } from "./TableFindBar";
import { useTableFind } from "../hooks/useTableFind";
import { FindCell, findTextMatches, findTextRanges, tableSearchContextKey, TableSearchScope } from "../utils/tableSearch";
import { useGridRowWindow } from "../hooks/useGridRowWindow";
import { SortColumn, PivotFlatRow, PivotGroupColumn, PivotGroupSortMode, PivotAggFunction, ColumnStats, ColumnStatsUniqueValue, ColOpStep, ColOpType, UndoStrategy, QcSession, INTERNAL_ROW_ID_VALUE, LinkPreviewMetadata } from "../types";
import { getEnabledLinkPreviewTarget } from "../utils/linkPreview";
import { buildCellRange, cellKey, getSelectionText } from "../utils/gridSelection";
import { CellInspection } from "../utils/cellEditor";
import { DEFAULT_COLUMN_WIDTH, ColumnFitState, fittedColumnWidth, gridEmptyState, gridRowNumberWidth, initialColumnWidth, moveGridCell, rawCellValue, toggleColumnFit } from "../utils/gridUX";

/** React escapes all original cell text; matching never changes values or copy data. */
export function highlightFindText(text: string, term: string): React.ReactNode {
  const ranges = findTextRanges(text, term);
  if (!ranges.length) return text;
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const range of ranges) {
    parts.push(text.slice(offset, range.start), <mark className="dg-find-mark" key={range.start}>{text.slice(range.start, range.end)}</mark>);
    offset = range.end;
  }
  parts.push(text.slice(offset));
  return parts;
}

const TOOLTIP_DELAY = 600; // ms before tooltip appears

const ROW_HEIGHT = 28;
const MIN_COLUMN_WIDTH = 50;
const PIVOT_GROUP_COL_WIDTH = 250;
const PIVOT_GROUP_COL_KEY = "__pivot_group__";

// Aggregate functions that work on any column type (others fall back to
// COUNT_DISTINCT for non-numeric columns — must match usePivotCache).
const UNIVERSAL_AGG_FNS = new Set(["COUNT", "COUNT_DISTINCT", "COUNT_NULL", "MIN", "MAX", "LIST"]);
const AGG_LABELS: Record<string, string> = {
  LIST: "list",
  SUM: "sum",
  COUNT: "count",
  COUNT_DISTINCT: "count distinct",
  COUNT_NULL: "nulls",
  AVG: "avg",
  MIN: "min",
  MAX: "max",
  MEDIAN: "median",
};

function getAggRawValue(aggregates: Record<string, any> | undefined, col: string): any | undefined {
  if (!aggregates) return undefined;
  const key = Object.keys(aggregates).find(key => key.startsWith(`${col}:`));
  return key === undefined ? undefined : aggregates[key];
}

type ColumnStatsPanelState = {
  column: string;
  view: "overview" | "uniques";
  status: "loading" | "ready" | "error";
  stats?: ColumnStats;
  error?: string;
  uniqueStatus?: "idle" | "loading" | "ready" | "error";
  uniqueValues?: ColumnStatsUniqueValue[];
  uniqueError?: string;
};

type NumberDisplayStyle = "standard" | "currency" | "percent" | "scientific";
type RoundingMethod = "half_up" | "truncate" | "floor" | "ceil";
type ColumnOpsTab = "format" | "clean";
type TextCleanOp = "trim" | "empty_to_null" | "placeholder_to_null";

interface ColumnDisplayFormat {
  decimalPlaces: number;
  numberStyle: NumberDisplayStyle;
  roundingMethod: RoundingMethod;
}

const NUMBER_STYLE_OPTIONS: { value: NumberDisplayStyle; label: string }[] = [
  { value: "standard", label: "Standard" },
  { value: "currency", label: "Currency" },
  { value: "percent", label: "Percent" },
  { value: "scientific", label: "Scientific" },
];

const ROUNDING_METHOD_OPTIONS: { value: RoundingMethod; label: string }[] = [
  { value: "half_up", label: "Round half up" },
  { value: "truncate", label: "Truncate" },
  { value: "floor", label: "Round down" },
  { value: "ceil", label: "Round up" },
];

const TEXT_PLACEHOLDER_VALUES = ["NA", "N/A", "NULL", "NONE"];

interface DataGridProps {
  totalRows: number;
  getRow: (absoluteIndex: number) => any | null;
  ensureRange: (startIndex: number, endIndex: number) => void;
  columns: string[];
  sortColumns: SortColumn[];
  onSort: (column: string, addLevel: boolean) => void;
  onReorderColumns?: (newOrder: string[]) => void;
  resetKey: number;
  viewContextKey?: string | null;
  pivotMode?: boolean;
  pivotFlatRows?: PivotFlatRow[];
  pivotGroupColumns?: PivotGroupColumn[];
  onToggleExpand?: (rowKey: string) => void;
  grandTotals?: Record<string, any> | null;
  showGrandTotal?: boolean;
  pivotAggFunction?: PivotAggFunction;
  numericColumns?: Set<string>;
  columnTypes?: Map<string, string>;
  onGetColumnStats?: (column: string) => Promise<ColumnStats>;
  onGetColumnUniques?: (column: string) => Promise<ColumnStatsUniqueValue[]>;
  colOpsSteps?: ColOpStep[];
  undoStrategy?: UndoStrategy;
  onColOpApply?: (opType: ColOpType, column: string, params: Record<string, string>) => Promise<void>;
  onColOpUndo?: () => Promise<void>;
  groupSortMode?: PivotGroupSortMode | null;
  groupSortDirection?: "ASC" | "DESC";
  onGroupSort?: (mode: PivotGroupSortMode, direction: "ASC" | "DESC" | null) => void;
  displayDecimalPlaces?: number;
  minDisplayDecimalPlaces?: number;
  maxDisplayDecimalPlaces?: number;
  onDisplayDecimalPlacesChange?: (places: number) => void;
  tableFontSize?: number;
  minTableFontSize?: number;
  maxTableFontSize?: number;
  defaultTableFontSize?: number;
  onTableFontSizeChange?: (fontSize: number) => void;
  qcSession?: QcSession | null;
  onQcCellChange?: (rowId: number, value: string | null) => void;
  onQcNoteChange?: (rowId: number, value: string | null) => void;
  rangeRefreshKey?: number;
  queryStatus?: "idle" | "loading" | "ready" | "error";
  queryError?: { scope: "count" | "chunk" | "pivot"; message: string } | null;
  onQueryRetry?: () => void;
  filtersActive?: boolean;
  onClearFilters?: () => void;
  onShowColumns?: () => void;
  linkPreviewsEnabled?: boolean;
  searchScope?: TableSearchScope;
  cellEditContext?: number;
  cellRevealRequest?: { key: number; row: number; tableName: string };
  onCellRevealAccepted?: (key: number) => void;
  onInspectCell?: (cell: CellInspection) => void;
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
  viewContextKey,
  pivotMode,
  pivotFlatRows,
  pivotGroupColumns,
  onToggleExpand,
  grandTotals,
  showGrandTotal,
  pivotAggFunction,
  numericColumns,
  columnTypes,
  onGetColumnStats,
  onGetColumnUniques,
  colOpsSteps = [],
  undoStrategy = "per-step",
  onColOpApply,
  onColOpUndo,
  groupSortMode,
  groupSortDirection,
  onGroupSort,
  displayDecimalPlaces = 4,
  minDisplayDecimalPlaces = 0,
  maxDisplayDecimalPlaces = 10,
  tableFontSize = 13,
  minTableFontSize = 11,
  maxTableFontSize = 24,
  defaultTableFontSize = 13,
  onTableFontSizeChange,
  qcSession,
  onQcCellChange,
  onQcNoteChange,
  rangeRefreshKey,
  queryStatus,
  queryError,
  onQueryRetry,
  filtersActive = false,
  onClearFilters,
  onShowColumns,
  linkPreviewsEnabled = true,
  searchScope,
  cellEditContext = 0,
  cellRevealRequest,
  onCellRevealAccepted,
  onInspectCell,
}: DataGridProps): React.ReactElement {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef<{ row: number; col: string } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [wrapText, setWrapText] = useState(false);
  const [activeCell, setActiveCell] = useState<{ row: number; col: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searchContextKey = tableSearchContextKey(searchScope, columns, resetKey, !!pivotMode) + JSON.stringify(sortColumns);
  useEffect(() => { setSearchOpen(false); }, [searchContextKey]);
  useEffect(() => {
    const handleFind = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "f" || event.altKey || event.defaultPrevented) return;
      if (document.querySelector(".bp4-dialog")) return;
      if (searchOpen) {
        event.preventDefault();
        document.getElementById("dg-search-term")?.focus();
        return;
      }
      if (!searchScope || pivotMode || !columns.length || document.querySelector(".bp4-dialog")) return;
      if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=true]")) return;
      event.preventDefault();
      setSearchOpen(true);
    };
    document.addEventListener("keydown", handleFind);
    return () => document.removeEventListener("keydown", handleFind);
  }, [searchOpen, searchScope, pivotMode, columns.length]);

  // ── Cell tooltip state ──
  const [tooltip, setTooltip] = useState<{
    text: string;
    x: number;
    y: number;
    cellHeight: number;
  } | null>(null);
  const [cellLinkPreview, setCellLinkPreview] = useState<LinkPreviewState | null>(null);
  const tooltipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tooltipHovered = useRef(false);
  const tooltipFocused = useRef(false);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [tooltipFlipped, setTooltipFlipped] = useState(false);
  const [columnDisplayFormats, setColumnDisplayFormats] = useState<Record<string, ColumnDisplayFormat>>({});
  const [previewColumnFormat, setPreviewColumnFormat] = useState<{ column: string; format: ColumnDisplayFormat } | null>(null);

  useEffect(() => {
    if (!linkPreviewsEnabled) {
      if (tooltipTimer.current) {
        clearTimeout(tooltipTimer.current);
        tooltipTimer.current = null;
      }
      setCellLinkPreview(null);
    }
  }, [linkPreviewsEnabled]);

  // ── Column stats rail state ──
  const [columnStatsPanel, setColumnStatsPanel] = useState<ColumnStatsPanelState | null>(null);
  const columnStatsRequestId = useRef(0);
  const columnUniquesRequestId = useRef(0);
  const suppressNextStatsResetClose = useRef(false);
  const defaultColumnFormat = useMemo<ColumnDisplayFormat>(() => ({
    decimalPlaces: displayDecimalPlaces,
    numberStyle: "standard",
    roundingMethod: "half_up",
  }), [displayDecimalPlaces]);

  const isColumnNumeric = useCallback(
    (column?: string): boolean => {
      if (!column) return false;
      if (numericColumns?.has(column)) return true;
      return isNumericColumnType(columnTypes?.get(column) ?? "");
    },
    [columnTypes, numericColumns]
  );

  // Effective aggregate label for a value column in pivot mode. Non-numeric
  // columns fall back to COUNT_DISTINCT for numeric-only aggregates (mirrors
  // usePivotCache) so the header reflects what the cells actually contain.
  const pivotAggLabelFor = useCallback(
    (column: string): string => {
      const fn = pivotAggFunction ?? "COUNT";
      const eff = isColumnNumeric(column) || UNIVERSAL_AGG_FNS.has(fn) ? fn : "COUNT_DISTINCT";
      return AGG_LABELS[eff] ?? eff.toLowerCase();
    },
    [pivotAggFunction, isColumnNumeric]
  );

  const getColumnFormat = useCallback(
    (column?: string): ColumnDisplayFormat => {
      if (!column) return defaultColumnFormat;
      return columnDisplayFormats[column] ?? defaultColumnFormat;
    },
    [columnDisplayFormats, defaultColumnFormat]
  );

  const setColumnFormat = useCallback(
    (column: string, nextFormat: ColumnDisplayFormat) => {
      setColumnDisplayFormats((prev) => {
        const isDefault =
          nextFormat.decimalPlaces === defaultColumnFormat.decimalPlaces
          && nextFormat.numberStyle === defaultColumnFormat.numberStyle
          && nextFormat.roundingMethod === defaultColumnFormat.roundingMethod;
        if (isDefault) {
          const { [column]: _removed, ...rest } = prev;
          return rest;
        }
        return { ...prev, [column]: nextFormat };
      });
    },
    [defaultColumnFormat]
  );

  const getEffectiveColumnFormat = useCallback(
    (column?: string): ColumnDisplayFormat => {
      if (column && previewColumnFormat?.column === column) {
        return previewColumnFormat.format;
      }
      return getColumnFormat(column);
    },
    [getColumnFormat, previewColumnFormat]
  );

  const previewFormatForColumn = useCallback((column: string, format: ColumnDisplayFormat) => {
    setPreviewColumnFormat({ column, format });
  }, []);

  const applyFormatForColumn = useCallback((column: string, format: ColumnDisplayFormat) => {
    setColumnFormat(column, format);
    setPreviewColumnFormat(null);
  }, [setColumnFormat]);

  const formatCellForColumn = useCallback(
    (value: any, column?: string): string => {
      const format = getEffectiveColumnFormat(column);
      const useNumericFormatting = isColumnNumeric(column);
      return formatCell(
        value,
        format.decimalPlaces,
        useNumericFormatting ? format.numberStyle : "standard",
        format.roundingMethod,
        useNumericFormatting
      );
    },
    [getEffectiveColumnFormat, isColumnNumeric]
  );

  const closeColumnStatsPanel = useCallback(() => {
    columnStatsRequestId.current += 1;
    columnUniquesRequestId.current += 1;
    setPreviewColumnFormat(null);
    setColumnStatsPanel(null);
  }, []);

  const requestColumnStats = useCallback(
    (column: string) => {
      if (!onGetColumnStats || pivotMode) return;
      const requestId = columnStatsRequestId.current + 1;
      columnStatsRequestId.current = requestId;
      setColumnStatsPanel((prev) => ({
        column,
        view: prev?.column === column ? prev.view : "overview",
        status: "loading",
        stats: prev?.column === column ? prev.stats : undefined,
        uniqueStatus: prev?.column === column ? prev.uniqueStatus : "idle",
        uniqueValues: prev?.column === column ? prev.uniqueValues : undefined,
        uniqueError: undefined,
      }));

      onGetColumnStats(column)
        .then((stats) => {
          if (columnStatsRequestId.current !== requestId) return;
          setColumnStatsPanel((prev) => {
            if (!prev || prev.column !== column) return prev;
            return {
              ...prev,
              column,
              status: "ready",
              stats,
            };
          });
        })
        .catch((err) => {
          if (columnStatsRequestId.current !== requestId) return;
          const error = err instanceof Error ? err.message : "Unable to load column stats";
          setColumnStatsPanel((prev) => {
            if (!prev || prev.column !== column) return prev;
            return {
              ...prev,
              column,
              status: "error",
              error,
            };
          });
        });
    },
    [onGetColumnStats, pivotMode]
  );

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
      if (tooltipHovered.current || tooltipFocused.current || hasTooltipSelection()) return;
      setTooltip(null);
      setCellLinkPreview(null);
      setCopied(false);
    }, delay);
  }, [clearDismissTimer, hasTooltipSelection]);

  const handleCellMouseEnter = useCallback(
    (e: React.MouseEvent, value: string) => {
      if (!value) return;
      // Cancel any pending dismiss when entering a new cell
      clearDismissTimer();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const previewTarget = getEnabledLinkPreviewTarget(value, linkPreviewsEnabled);
      tooltipTimer.current = setTimeout(() => {
        tooltipTimer.current = null;
        if (previewTarget) {
          setTooltip(null);
          setCellLinkPreview({
            ...previewTarget,
            ...getLinkPreviewPosition(rect),
          });
        } else {
          setCellLinkPreview(null);
          setTooltip({
            text: value,
            x: rect.left,
            y: rect.top,
            cellHeight: rect.height,
          });
        }
      }, TOOLTIP_DELAY);
    },
    [clearDismissTimer, linkPreviewsEnabled]
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
    if (tooltipTimer.current) {
      clearTimeout(tooltipTimer.current);
      tooltipTimer.current = null;
    }
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

  const handleTooltipFocus = useCallback(() => {
    tooltipFocused.current = true;
    clearDismissTimer();
  }, [clearDismissTimer]);

  const handleTooltipBlur = useCallback((event: React.FocusEvent<HTMLDivElement>) => {
    if (event.relatedTarget && event.currentTarget.contains(event.relatedTarget as Node)) return;
    tooltipFocused.current = false;
    scheduleDismiss(150);
  }, [scheduleDismiss]);

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
  const [columnFit, setColumnFit] = useState<ColumnFitState | null>(null);
  const [animatingWidths, setAnimatingWidths] = useState(false);
  const widthAnimationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // A single-column fit restores its actual previous width on the second click.
  const autoFittedCols = useRef<Map<string, number>>(new Map());
  const isDragging = useRef(false);
  const dragColRef = useRef<string | null>(null);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);

  const stopWidthAnimation = useCallback(() => {
    if (widthAnimationTimer.current) clearTimeout(widthAnimationTimer.current);
    widthAnimationTimer.current = null;
    setAnimatingWidths(false);
  }, []);

  const animateWidths = useCallback(() => {
    if (widthAnimationTimer.current) clearTimeout(widthAnimationTimer.current);
    setAnimatingWidths(true);
    widthAnimationTimer.current = setTimeout(() => {
      widthAnimationTimer.current = null;
      setAnimatingWidths(false);
    }, 200);
  }, []);

  useEffect(() => () => {
    if (widthAnimationTimer.current) clearTimeout(widthAnimationTimer.current);
  }, []);

  // ── Header drag-reorder state ──
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  const headerDragCol = useRef<string | null>(null);
  const headerDropTargetRef = useRef<{
    col: string;
    position: "left" | "right";
  } | null>(null);
  const headerDragCleanupRef = useRef<(() => void) | null>(null);
  const [headerDropTarget, setHeaderDropTarget] = useState<{
    col: string;
    position: "left" | "right";
  } | null>(null);

  // Effective row count
  const effectiveRowCount = pivotMode && pivotFlatRows ? pivotFlatRows.length : totalRows;
  const rowHeight = wrapText ? Math.ceil(tableFontSize * 1.4) * 3 + 12 : Math.max(ROW_HEIGHT, tableFontSize + 15);

  // A bounded physical window keeps late rows reachable beyond browser scroll limits.
  const rowWindowContext = JSON.stringify([viewContextKey, resetKey, !!pivotMode]);
  const { virtualizer, windowBase, scrollToLogicalRow, virtualRows } = useGridRowWindow(effectiveRowCount, rowHeight, rowWindowContext, scrollRef);

  // Notify chunk cache of visible range
  const rangeRef = useRef<{ start: number; end: number } | null>(null);

  // Reset range tracking when columns change so ensureRange re-fires after schema update
  const columnsKey = JSON.stringify(columns);
  // Sorting/filtering can reset the row range without changing the display widths.
  // A restored snapshot must never cross a table, schema, order, font, or pivot change.
  useEffect(() => {
    setColumnFit(null);
    autoFittedCols.current.clear();
    stopWidthAnimation();
  }, [columnsKey, pivotMode, viewContextKey, tableFontSize, stopWidthAnimation]);

  useEffect(() => {
    rangeRef.current = null;
  }, [columnsKey]);

  useEffect(() => {
    rangeRef.current = null;
  }, [rangeRefreshKey]);

  useEffect(() => {
    if (suppressNextStatsResetClose.current) {
      suppressNextStatsResetClose.current = false;
      return;
    }
    closeColumnStatsPanel();
  }, [columnsKey, closeColumnStatsPanel, pivotMode, resetKey]);

  useEffect(() => {
    const range = virtualizer.range;
    if (!range) return;
    const startIndex = windowBase + range.startIndex;
    const endIndex = windowBase + range.endIndex;
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

  // The row-window hook resets scroll before paint when the data context changes.
  useEffect(() => {
    setSelected(new Set());
    setActiveCell(null);
    anchor.current = null;
    rangeRef.current = null; // force ensureRange to re-fire
  }, [rowWindowContext]);

  // Calculate column widths — preserve existing widths, only assign fixed defaults for new columns
  useEffect(() => {
    if (columns.length === 0) return;
    setColumnWidths((prev) => {
      const widths: Record<string, number> = {};
      if (pivotMode) {
        widths[PIVOT_GROUP_COL_KEY] = prev[PIVOT_GROUP_COL_KEY] ?? PIVOT_GROUP_COL_WIDTH;
      }
      for (const col of columns) {
        widths[col] = prev[col] ?? initialColumnWidth(col, tableFontSize);
      }
      return widths;
    });
  }, [columns, pivotMode, tableFontSize]);

  // Total width of all columns for horizontal scroll
  const groupColWidth = pivotMode ? (columnWidths[PIVOT_GROUP_COL_KEY] ?? PIVOT_GROUP_COL_WIDTH) : gridRowNumberWidth(effectiveRowCount, tableFontSize);
  // Use dataColumns (excludes grouped cols) for pivot mode width
  const displayColumns = pivotMode ? dataColumns : columns;
  const selectionColumns = useMemo(
    () => pivotMode ? [PIVOT_GROUP_COL_KEY, ...displayColumns] : displayColumns,
    [pivotMode, displayColumns]
  );
  const totalWidth =
    groupColWidth + displayColumns.reduce((sum, col) => sum + (columnWidths[col] ?? DEFAULT_COLUMN_WIDTH), 0);

  // Document-level drag listeners for column resize
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragColRef.current) return;
      const delta = e.clientX - dragStartX.current;
      if (delta === 0) return;
      setColumnFit(null);
      autoFittedCols.current.clear();
      const newWidth = Math.max(MIN_COLUMN_WIDTH, dragStartWidth.current + delta);
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
  const handleHeaderPointerDown = useCallback(
    (e: React.PointerEvent<HTMLElement>, col: string) => {
      if (
        e.button !== 0 ||
        isDragging.current ||
        !onReorderColumns ||
        (e.target as HTMLElement).closest("button, .col-resize-handle")
      ) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();
      headerDragCleanupRef.current?.();
      headerDragCol.current = col;
      setDraggingColumn(col);
      setTooltip(null);
      setCellLinkPreview(null);
      setCopied(false);
      document.body.style.cursor = "grabbing";
      document.body.style.userSelect = "none";
      e.currentTarget.setPointerCapture(e.pointerId);

      const setCurrentDropTarget = (
        next: { col: string; position: "left" | "right" } | null
      ) => {
        headerDropTargetRef.current = next;
        setHeaderDropTarget((prev) =>
          prev?.col === next?.col && prev?.position === next?.position ? prev : next
        );
      };

      const handlePointerMove = (event: PointerEvent) => {
        if (event.pointerId !== e.pointerId) return;
        event.preventDefault();

        const target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest<HTMLElement>("[data-grid-column]");
        if (!target || !scrollRef.current?.contains(target)) {
          setCurrentDropTarget(null);
          return;
        }

        const targetColumn = target.dataset.gridColumn;
        if (!targetColumn || targetColumn === headerDragCol.current) {
          setCurrentDropTarget(null);
          return;
        }

        const rect = target.getBoundingClientRect();
        setCurrentDropTarget({
          col: targetColumn,
          position: event.clientX < rect.left + rect.width / 2 ? "left" : "right",
        });
      };

      const cleanup = () => {
        document.removeEventListener("pointermove", handlePointerMove);
        document.removeEventListener("pointerup", handlePointerUp);
        document.removeEventListener("pointercancel", handlePointerCancel);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        headerDragCol.current = null;
        headerDropTargetRef.current = null;
        headerDragCleanupRef.current = null;
        setDraggingColumn(null);
        setHeaderDropTarget(null);
      };

      const handlePointerUp = (event: PointerEvent) => {
        if (event.pointerId !== e.pointerId) return;
        const fromCol = headerDragCol.current;
        const target = headerDropTargetRef.current;
        cleanup();
        if (!fromCol || !target) return;

        const newOrder = [...displayColumns];
        const fromIndex = newOrder.indexOf(fromCol);
        if (fromIndex < 0) return;
        newOrder.splice(fromIndex, 1);
        let toIndex = newOrder.indexOf(target.col);
        if (toIndex < 0) return;
        if (target.position === "right") toIndex++;
        if (fromIndex === toIndex) return;
        newOrder.splice(toIndex, 0, fromCol);
        setColumnFit(null);
        autoFittedCols.current.clear();
        onReorderColumns(newOrder);
      };

      const handlePointerCancel = (event: PointerEvent) => {
        if (event.pointerId === e.pointerId) cleanup();
      };

      document.addEventListener("pointermove", handlePointerMove);
      document.addEventListener("pointerup", handlePointerUp);
      document.addEventListener("pointercancel", handlePointerCancel);
      headerDragCleanupRef.current = cleanup;
    },
    [displayColumns, onReorderColumns]
  );

  useEffect(() => () => headerDragCleanupRef.current?.(), []);

  const handleResizeStart = useCallback(
    (e: React.MouseEvent, col: string) => {
      e.preventDefault();
      e.stopPropagation();
      stopWidthAnimation();
      isDragging.current = true;
      dragColRef.current = col;
      dragStartX.current = e.clientX;
      dragStartWidth.current = columnWidths[col] ?? DEFAULT_COLUMN_WIDTH;
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [columnWidths, stopWidthAnimation]
  );

  // Canvas context for text measurement (reused across calls)
  const measureCtx = useRef<CanvasRenderingContext2D | null>(null);

  const measureColumn = useCallback(
    (col: string): number => {
      // Lazily create a measurement canvas
      if (!measureCtx.current) {
        const canvas = document.createElement("canvas");
        measureCtx.current = canvas.getContext("2d");
      }
      const ctx = measureCtx.current;
      if (!ctx) return initialColumnWidth(col, tableFontSize);

      // Measure header text (bold)
      ctx.font = `bold ${tableFontSize}px "SF Mono", Menlo, Monaco, monospace`;
      const headerWidth = ctx.measureText(col === PIVOT_GROUP_COL_KEY ? "Group By" : col).width;

      // Sample loaded first rows and the visible range, without fetching more data.
      ctx.font = `${tableFontSize}px "SF Mono", Menlo, Monaco, monospace`;
      const sampleRows = new Set(Array.from({ length: Math.min(100, effectiveRowCount) }, (_, index) => index));
      const range = virtualizer.range;
      if (range) {
        for (let i = range.startIndex; i <= range.endIndex; i++) sampleRows.add(windowBase + i);
      }
      const sampleWidths: number[] = [];
      for (const i of sampleRows) {
        let value: any;
        if (pivotMode && pivotFlatRows) {
          const pRow = pivotFlatRows[i];
          value = col === PIVOT_GROUP_COL_KEY
            ? (pRow?.type === "group" ? pRow.groupValue : "")
            : pRow?.type === "group" ? getAggRawValue(pRow.aggregates, col) : pRow?.data?.[col];
        } else {
          const row = getRow(i);
          if (row) value = row[col];
        }
        const text = formatCellForColumn(value, col);
        if (text) sampleWidths.push(ctx.measureText(text.slice(0, 300)).width);
      }

      return fittedColumnWidth(headerWidth, sampleWidths);
    },
    [virtualizer, windowBase, getRow, effectiveRowCount, pivotMode, pivotFlatRows, formatCellForColumn, tableFontSize]
  );

  const handleResizeDoubleClick = useCallback(
    (e: React.MouseEvent, col: string) => {
      e.preventDefault();
      e.stopPropagation();
      setColumnFit(null);
      animateWidths();
      const previousWidth = autoFittedCols.current.get(col);
      if (previousWidth !== undefined) {
        autoFittedCols.current.delete(col);
        setColumnWidths((prev) => ({ ...prev, [col]: previousWidth }));
        return;
      }
      const fitWidth = measureColumn(col);
      autoFittedCols.current.set(col, columnWidths[col] ?? DEFAULT_COLUMN_WIDTH);
      setColumnWidths((prev) => ({ ...prev, [col]: fitWidth }));
    },
    [animateWidths, columnWidths, measureColumn]
  );

  const toggleFitColumns = () => {
    // Undo needs no measurement; fitting only samples rows already in memory.
    const widths = columnFit ? {} : Object.fromEntries(selectionColumns.map(col => [col, measureColumn(col)]));
    const next = toggleColumnFit(columnWidths, columnFit, widths);
    autoFittedCols.current.clear();
    animateWidths();
    setColumnWidths(next.widths);
    setColumnFit(next.fit);
  };

  const handleHeaderStatsClick = useCallback(
    (e: React.MouseEvent, col: string) => {
      e.preventDefault();
      e.stopPropagation();
      if (!onGetColumnStats || pivotMode) return;
      setTooltip(null);
      setCellLinkPreview(null);
      setCopied(false);
      setPreviewColumnFormat(null);
      requestColumnStats(col);
      setColumnStatsPanel((prev) =>
        prev?.column === col ? { ...prev, view: "overview" } : prev
      );
    },
    [onGetColumnStats, pivotMode, requestColumnStats]
  );

  const requestColumnUniques = useCallback(
    (column: string) => {
      if (!onGetColumnUniques || pivotMode) return;
      const requestId = columnUniquesRequestId.current + 1;
      columnUniquesRequestId.current = requestId;

      setColumnStatsPanel((prev) => {
        if (!prev || prev.column !== column) return prev;
        return {
          ...prev,
          view: "uniques",
          uniqueStatus: "loading",
          uniqueError: undefined,
        };
      });

      onGetColumnUniques(column)
        .then((values) => {
          if (columnUniquesRequestId.current !== requestId) return;
          setColumnStatsPanel((prev) => {
            if (!prev || prev.column !== column) return prev;
            return {
              ...prev,
              view: "uniques",
              uniqueStatus: "ready",
              uniqueValues: values,
            };
          });
        })
        .catch((err) => {
          if (columnUniquesRequestId.current !== requestId) return;
          const uniqueError = err instanceof Error ? err.message : "Unable to load unique values";
          setColumnStatsPanel((prev) => {
            if (!prev || prev.column !== column) return prev;
            return {
              ...prev,
              view: "uniques",
              uniqueStatus: "error",
              uniqueError,
            };
          });
        });
    },
    [onGetColumnUniques, pivotMode]
  );

  const handleShowUniqueValues = useCallback(() => {
    if (!columnStatsPanel || !onGetColumnUniques) return;
    if (columnStatsPanel.uniqueStatus === "ready" && columnStatsPanel.uniqueValues) {
      setColumnStatsPanel((prev) => prev ? { ...prev, view: "uniques" } : prev);
      return;
    }
    requestColumnUniques(columnStatsPanel.column);
  }, [columnStatsPanel, onGetColumnUniques, requestColumnUniques]);

  const handleColumnStatsBack = useCallback(() => {
    setColumnStatsPanel((prev) => prev ? { ...prev, view: "overview" } : prev);
  }, []);

  const handleColumnStatsRefresh = useCallback(() => {
    if (!columnStatsPanel) return;
    if (columnStatsPanel.view === "uniques") {
      requestColumnUniques(columnStatsPanel.column);
      return;
    }
    requestColumnStats(columnStatsPanel.column);
  }, [columnStatsPanel, requestColumnStats, requestColumnUniques]);

  const handleColumnStatsCleanApply = useCallback(
    async (opType: ColOpType, column: string, params: Record<string, string>) => {
      if (!onColOpApply) return;
      suppressNextStatsResetClose.current = true;
      try {
        await onColOpApply(opType, column, { ...params, targetMode: "replace" });
        requestColumnStats(column);
      } catch (err) {
        suppressNextStatsResetClose.current = false;
        throw err;
      }
    },
    [onColOpApply, requestColumnStats]
  );

  const handleColumnStatsCleanUndo = useCallback(
    async (column: string) => {
      if (!onColOpUndo) return;
      suppressNextStatsResetClose.current = true;
      try {
        await onColOpUndo();
        requestColumnStats(column);
      } catch (err) {
        suppressNextStatsResetClose.current = false;
        throw err;
      }
    },
    [onColOpUndo, requestColumnStats]
  );

  // ── Click-drag selection state ──
  const dragSelecting = useRef(false);
  const dragBaseSelected = useRef<Set<string>>(new Set());

  const endDragSelection = useCallback(() => {
    dragSelecting.current = false;
    dragBaseSelected.current = new Set();
  }, []);

  const buildRange = useCallback(
    (
      fromRow: number,
      fromCol: string,
      toRow: number,
      toCol: string
    ): Set<string> => {
      return buildCellRange(selectionColumns, { row: fromRow, col: fromCol }, { row: toRow, col: toCol });
    },
    [selectionColumns]
  );

  const handleCellMouseDown = useCallback(
    (rowIdx: number, col: string, e: React.MouseEvent) => {
      // Only handle left button
      if (e.button !== 0) return;
      const meta = e.metaKey || e.ctrlKey;

      // Prevent text selection and focus the grid for keyboard copying.
      e.preventDefault();
      containerRef.current?.focus();
      setActiveCell({ row: rowIdx, col });

      if (e.shiftKey && anchor.current) {
        // Shift+click range — same behavior as before, no drag
        const range = buildRange(anchor.current.row, anchor.current.col, rowIdx, col);
        const next = meta ? new Set(selected) : new Set<string>();
        for (const k of range) next.add(k);
        setSelected(next);
        return;
      }

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
    [selected, buildRange]
  );

  const handleCellMouseEnterDrag = useCallback(
    (rowIdx: number, col: string, e: React.MouseEvent) => {
      if (!dragSelecting.current || !anchor.current) return;
      if ((e.buttons & 1) !== 1) {
        endDragSelection();
        return;
      }
      const range = buildRange(anchor.current.row, anchor.current.col, rowIdx, col);
      const next = new Set(dragBaseSelected.current);
      for (const k of range) next.add(k);
      setSelected(next);
    },
    [buildRange, endDragSelection]
  );

  // End drag selection on mouseup (document-level to catch releases outside grid)
  useEffect(() => {
    const onMouseUp = () => endDragSelection();
    const onMouseLeave = (e: MouseEvent) => {
      if (!e.relatedTarget) endDragSelection();
    };
    const onVisibilityChange = () => {
      if (document.hidden) endDragSelection();
    };
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("mouseleave", onMouseLeave);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", endDragSelection);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("mouseleave", onMouseLeave);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", endDragSelection);
    };
  }, [endDragSelection]);

  const inspectCell = useCallback((cell: { row: number; col: string } | null) => {
    if (!cell) return;
    let value: unknown;
    let physicalRowId: string | null = null;
    let readOnlyReason: string | null = pivotMode ? "Grouped, pivot and aggregate cells are read-only. Exit grouping to edit a source cell." : null;
    let column = cell.col === PIVOT_GROUP_COL_KEY ? "Group By" : cell.col;
    let aggregateLabel: string | null = null;
    if (pivotMode && pivotFlatRows) {
      const flatRow = pivotFlatRows[cell.row];
      if (!flatRow || (flatRow.type === "data" && !flatRow.data)) return;
      if (cell.col === PIVOT_GROUP_COL_KEY && flatRow.groupColumn) column = flatRow.groupColumn;
      if (cell.col !== PIVOT_GROUP_COL_KEY && flatRow.type === "group") aggregateLabel = pivotAggLabelFor(cell.col);
      value = cell.col === PIVOT_GROUP_COL_KEY
        ? (flatRow.type === "group" ? flatRow.groupValue : "")
        : flatRow.type === "group" ? getAggRawValue(flatRow.aggregates, cell.col) : flatRow.data?.[cell.col];
    } else {
      const row = getRow(cell.row);
      if (!row) return;
      value = row[cell.col];
      // Inspect staged QC edits rather than the previous committed value.
      const rowId = row[INTERNAL_ROW_ID_VALUE];
      physicalRowId = rowId == null ? null : String(rowId);
      if (physicalRowId === null) readOnlyReason = "The source row is unavailable. Reload the view before editing.";
      if (qcSession && (cell.col === qcSession.columnName || cell.col === qcSession.notesColumnName)) readOnlyReason = "This column is controlled by QC. Use the QC controls to change its values.";
      if (qcSession && !qcSession.done && rowId != null) {
        const stagedValue = qcSession.valuesByRowId[String(rowId)];
        const stagedNote = qcSession.notesByRowId[String(rowId)];
        if (cell.col === qcSession.columnName && stagedValue !== undefined) value = stagedValue;
        if (cell.col === qcSession.notesColumnName && stagedNote !== undefined) value = stagedNote;
      }
    }
    if (tooltipTimer.current) clearTimeout(tooltipTimer.current);
    setTooltip(null);
    setCellLinkPreview(null);
    const raw = rawCellValue(value);
    const columnType = aggregateLabel ? undefined : columnTypes?.get(column);
    // Transport may encode BIGINT/DECIMAL as strings to retain precision.
    const isBlank = value == null || value === "";
    const kind = aggregateLabel ? `${aggregateLabel} result · ${raw.kind}` : columnType ? `${columnType}${isBlank ? ` · ${raw.kind}` : ""}` : raw.kind;
    if (!viewContextKey || !onInspectCell) return;
    onInspectCell({ tableName: viewContextKey, columnName: column, rowId: physicalRowId, row: cell.row, cachedValue: value === null ? null : raw.text, columnType: columnType ?? kind, reason: readOnlyReason, context: cellEditContext });
  }, [getRow, pivotMode, pivotFlatRows, qcSession, columnTypes, pivotAggLabelFor, viewContextKey, onInspectCell, cellEditContext]);

  // Central row navigation hook: the bounded virtual-window layer can map this
  // logical row to a physical scroll offset without changing Find's contract.
  const navigateToRow = useCallback((row: number) => {
    ensureRange(row, row);
    scrollToLogicalRow(row);
  }, [ensureRange, scrollToLogicalRow]);

  const lastCellRevealKey = useRef<number | null>(null);
  useEffect(() => {
    if (!cellRevealRequest || cellRevealRequest.tableName !== viewContextKey || lastCellRevealKey.current === cellRevealRequest.key) return;
    lastCellRevealKey.current = cellRevealRequest.key;
    // Keep the surrounding position without selecting a different record after a sort/filter move.
    navigateToRow(cellRevealRequest.row);
    onCellRevealAccepted?.(cellRevealRequest.key);
  }, [cellRevealRequest, viewContextKey, navigateToRow, onCellRevealAccepted]);

  const lastRowHeight = useRef(rowHeight);
  useLayoutEffect(() => {
    if (lastRowHeight.current !== rowHeight && activeCell) navigateToRow(activeCell.row);
    lastRowHeight.current = rowHeight;
  }, [rowHeight, activeCell, navigateToRow]);

  const navigateToFoundCell = useCallback((cell: FindCell) => {
    setActiveCell(cell); setSelected(new Set([cellKey(cell.row, cell.col)])); anchor.current = cell;
    navigateToRow(cell.row);
    const scroll = scrollRef.current;
    if (!scroll) return;
    const column = displayColumns.indexOf(cell.col);
    const left = groupColWidth + displayColumns.slice(0, column).reduce((sum, name) => sum + (columnWidths[name] ?? DEFAULT_COLUMN_WIDTH), 0);
    const width = columnWidths[cell.col] ?? DEFAULT_COLUMN_WIDTH;
    if (left < scroll.scrollLeft) scroll.scrollLeft = left;
    else if (left + width > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = left + width - scroll.clientWidth;
  }, [navigateToRow, displayColumns, groupColWidth, columnWidths]);

  const find = useTableFind({ enabled: searchOpen && !pivotMode, contextKey: searchContextKey, scope: searchScope, columns, sortColumns, totalRows, onNavigate: navigateToFoundCell });
  const closeFind = useCallback(() => { find.changeTerm(""); setSearchOpen(false); containerRef.current?.focus(); }, [find.changeTerm]);
  useEffect(() => {
    if (!searchOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || document.querySelector(".bp4-dialog")) return;
      const displayOptions = document.querySelector<HTMLElement>(".dg-display-options-popover .dg-display-options");
      if (displayOptions?.getClientRects().length) return;
      if ((event.target as HTMLElement)?.closest("input, textarea, select, [contenteditable=true], [role=combobox]")) return;
      event.preventDefault(); closeFind();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [searchOpen, closeFind]);

  const handleGridKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // Nested controls and QC inputs retain their own keyboard behavior.
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      inspectCell(activeCell);
      return;
    }
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const next = moveGridCell(activeCell, event.key, selectionColumns, effectiveRowCount);
    if (!next) return;
    event.preventDefault();
    setActiveCell(next);
    if (event.shiftKey && anchor.current) setSelected(buildRange(anchor.current.row, anchor.current.col, next.row, next.col));
    else {
      anchor.current = next;
      setSelected(new Set([cellKey(next.row, next.col)]));
    }
    navigateToRow(next.row);
    const scroll = scrollRef.current;
    if (scroll) {
      const colIndex = displayColumns.indexOf(next.col);
      const left = next.col === PIVOT_GROUP_COL_KEY ? 0 : groupColWidth + displayColumns.slice(0, colIndex).reduce((sum, col) => sum + (columnWidths[col] ?? DEFAULT_COLUMN_WIDTH), 0);
      const width = next.col === PIVOT_GROUP_COL_KEY ? groupColWidth : columnWidths[next.col] ?? DEFAULT_COLUMN_WIDTH;
      if (left < scroll.scrollLeft) scroll.scrollLeft = left;
      else if (left + width > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = left + width - scroll.clientWidth;
    }
  };

  // Cmd/Ctrl+C copy — uses getRow instead of rows array
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select, [contenteditable=true], [role=combobox]")) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "c" && selected.size > 0) {
        const text = getSelectionText(selected, selectionColumns, (r, c) => {
          if (pivotMode && pivotFlatRows) {
            const flatRow = pivotFlatRows[r];
            if (!flatRow) return "";
            if (c === PIVOT_GROUP_COL_KEY) {
              if (flatRow.type !== "group") return "";
              return flatRow.groupValue == null ? "NULL" : formatCell(flatRow.groupValue, displayDecimalPlaces);
            }
            if (flatRow.type === "group") {
              return getAggValue(flatRow.aggregates, c);
            }
            return formatCellForColumn(flatRow.data?.[c], c);
          }
          return formatCellForColumn(getRow(r)?.[c], c);
        });

        e.preventDefault();
        navigator.clipboard.writeText(text);
      }
    };

    el.addEventListener("keydown", handler);
    return () => el.removeEventListener("keydown", handler);
  }, [selected, getRow, selectionColumns, pivotMode, pivotFlatRows, formatCellForColumn, displayDecimalPlaces]);

  const emptyState = gridEmptyState({ hasError: !!queryError || queryStatus === "error", columnCount: columns.length, rowCount: effectiveRowCount, loading: queryStatus === "loading", filtersActive });
  const pivotNeedsGroups = pivotMode && (!pivotGroupColumns || pivotGroupColumns.length === 0);

  const maxGroupDepth = pivotGroupColumns ? pivotGroupColumns.length - 1 : 0;
  const activeStatsColumn = columnStatsPanel?.column ?? null;
  const activeQcColumn = qcSession && !qcSession.done && !pivotMode ? qcSession.columnName : null;
  const activeQcNotesColumn = qcSession && !qcSession.done && !pivotMode ? qcSession.notesColumnName : null;

  const getQcCellValue = (row: any, rowId: number | null): string | null => {
    if (!qcSession) return null;
    if (rowId !== null) {
      const stagedValue = qcSession.valuesByRowId[String(rowId)];
      if (stagedValue !== undefined) return stagedValue;
    }
    return normalizeQcValue(row?.[qcSession.columnName]);
  };

  const getRowId = (row: any): number | null => {
    const value = row?.[INTERNAL_ROW_ID_VALUE];
    const rowId = Number(value);
    return Number.isFinite(rowId) ? rowId : null;
  };

  const renderQcCellContent = (row: any): React.ReactNode => {
    if (!qcSession || !onQcCellChange) return "";
    const rowId = getRowId(row);
    if (rowId === null) return "";
    const currentValue = getQcCellValue(row, rowId);
    const setValue = (value: string | null) => onQcCellChange(rowId, value);
    const stopControlMouse = (e: React.MouseEvent | React.ChangeEvent) => {
      e.stopPropagation();
    };

    if (qcSession.mode === "boolean") {
      const isTrue = currentValue === qcSession.trueValue;
      const isFalse = currentValue === qcSession.falseValue;
      return (
        <div className="dg-qc-bool-controls" role="group" aria-label={`QC ${qcSession.columnName}`}>
          <button
            type="button"
            className={`dg-qc-icon-btn dg-qc-accept${isTrue ? " active" : ""}`}
            title={qcSession.trueValue}
            aria-label={qcSession.trueValue}
            onMouseDown={(e) => {
              e.preventDefault();
              stopControlMouse(e);
            }}
            onClick={(e) => {
              stopControlMouse(e);
              setValue(isTrue ? null : qcSession.trueValue);
            }}
          >
            <Icon icon="tick" size={12} />
          </button>
          <button
            type="button"
            className={`dg-qc-icon-btn dg-qc-reject${isFalse ? " active" : ""}`}
            title={qcSession.falseValue}
            aria-label={qcSession.falseValue}
            onMouseDown={(e) => {
              e.preventDefault();
              stopControlMouse(e);
            }}
            onClick={(e) => {
              stopControlMouse(e);
              setValue(isFalse ? null : qcSession.falseValue);
            }}
          >
            <Icon icon="cross" size={12} />
          </button>
          <button
            type="button"
            className="dg-qc-icon-btn dg-qc-reset"
            title="Reset QC"
            aria-label="Reset QC"
            disabled={currentValue === null}
            onMouseDown={(e) => {
              e.preventDefault();
              stopControlMouse(e);
            }}
            onClick={(e) => {
              stopControlMouse(e);
              setValue(null);
            }}
          >
            <Icon icon="undo" size={12} />
          </button>
        </div>
      );
    }

    return (
      <SoftSelect
        className="dg-qc-select"
        aria-label={`QC ${qcSession.columnName}`}
        value={currentValue ?? ""}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          setValue(e.target.value === "" ? null : e.target.value);
        }}
      >
        <option value="">Blank</option>
        {qcSession.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SoftSelect>
    );
  };

  const getQcNoteValue = (row: any, rowId: number | null): string => {
    if (!qcSession?.notesColumnName) return "";
    if (rowId !== null) {
      const stagedNote = qcSession.notesByRowId[String(rowId)];
      if (stagedNote !== undefined) return stagedNote;
    }
    const raw = row?.[qcSession.notesColumnName];
    return raw === null || raw === undefined ? "" : String(raw);
  };

  const renderQcNoteCellContent = (row: any): React.ReactNode => {
    if (!qcSession?.notesColumnName || !onQcNoteChange) return "";
    const rowId = getRowId(row);
    if (rowId === null) return "";
    return (
      <QcNoteCell
        key={rowId}
        value={getQcNoteValue(row, rowId)}
        columnName={qcSession.notesColumnName}
        onCommit={(value) => onQcNoteChange(rowId, value)}
      />
    );
  };

  const getAggValue = (aggregates: Record<string, any> | undefined, col: string): string => {
    const value = getAggRawValue(aggregates, col);
    if (value === null || value === undefined) return "";
    return formatCellForColumn(value, col);
  };

  const viewSettingsMenu = onTableFontSizeChange ? (
    <Popover2
      content={(
        <div className="dg-view-settings" role="dialog" aria-label="Table view settings">
          <div className="dg-view-settings-title">
            <Icon icon="font" size={14} />
            <span>Table text size</span>
          </div>
          <div className="dg-font-size-control" role="group" aria-label="Table text size">
            <ButtonGroup>
              <Button
                icon="minus"
                small
                aria-label="Decrease table text size"
                title="Decrease table text size"
                disabled={tableFontSize <= minTableFontSize}
                onClick={() => onTableFontSizeChange(tableFontSize - 1)}
              />
              <output className="dg-font-size-value" aria-live="polite">
                {tableFontSize} px
              </output>
              <Button
                icon="plus"
                small
                aria-label="Increase table text size"
                title="Increase table text size"
                disabled={tableFontSize >= maxTableFontSize}
                onClick={() => onTableFontSizeChange(tableFontSize + 1)}
              />
            </ButtonGroup>
            <Button
              minimal
              small
              text="Reset"
              disabled={tableFontSize === defaultTableFontSize}
              onClick={() => onTableFontSizeChange(defaultTableFontSize)}
            />
          </div>
          <p>Changes table headers and cell values. Your choice is remembered.</p>
        </div>
      )}
      placement="bottom-start"
      popoverClassName="dg-view-settings-popover"
      minimal
    >
      <Button
        icon="cog"
        minimal
        small
        title="Table view settings"
        aria-label="Table view settings"
        aria-haspopup="dialog"
      />
    </Popover2>
  ) : null;

  const displayControls = <>
    <div className="dg-display-group" role="group" aria-label="Column width">
      <Button small minimal className="dg-display-toggle" icon="horizontal-distribution" text="Fit columns" aria-label="Fit columns" active={columnFit !== null} aria-pressed={columnFit !== null} onClick={toggleFitColumns} title={columnFit ? "Undo Fit columns and restore your previous widths" : "Fit headers and loaded row samples (maximum 420px). Click again to restore your previous widths"} disabled={!selectionColumns.length} />
    </div>
    <div className="dg-display-group" role="group" aria-label="Text layout">
      <Button small minimal className="dg-display-toggle dg-wrap-toggle" icon="new-text-box" text="Wrap text" aria-label="Wrap text" active={wrapText} aria-pressed={wrapText} onClick={() => setWrapText(value => !value)} title={wrapText ? "Turn wrapping off and return to single-line cells" : "Show up to three lines per cell. Click again for single-line cells"} />
    </div>
  </>;

  return (
    <div
      className={`data-grid-container${wrapText ? " dg-wrap-text" : ""}${animatingWidths ? " dg-animate-widths" : ""}`}
      ref={containerRef}
      tabIndex={0}
      role="region"
      aria-label="Data table. Use arrow keys to select a cell, Enter to inspect its full value, and Control or Command C to copy."
      onKeyDown={handleGridKeyDown}
      onDoubleClick={(event) => {
        if ((event.target as HTMLElement).closest("button, input, select, textarea, a, [contenteditable=true]")) return;
        const cell = (event.target as HTMLElement).closest<HTMLElement>("[data-grid-cell]");
        if (cell) inspectCell({ row: Number(cell.dataset.gridRowIndex), col: cell.dataset.gridCell! });
      }}
      style={{ "--table-font-size": `${tableFontSize}px`, "--grid-row-number-width": `${groupColWidth}px` } as React.CSSProperties}
    >
      <div className={`dg-view-toolbar${searchOpen ? " dg-view-toolbar-finding" : ""}`} role="toolbar" aria-label="Table display">
        <div className="dg-display-controls">{displayControls}</div>
        <div className="dg-display-overflow"><Popover2 placement="bottom-start" minimal usePortal={false} popoverClassName="dg-display-options-popover" content={<div className="dg-display-options" role="group" aria-label="Table display options">{displayControls}</div>}>
          <Button small minimal icon="more" aria-label="Table display options" title="Table display options" />
        </Popover2></div>
        <span className="dg-selection-hint" aria-live="polite" title={activeCell ? `Row ${activeCell.row + 1} · ${activeCell.col === PIVOT_GROUP_COL_KEY ? "Group By" : activeCell.col}` : "Select a cell, then press Enter or double-click to inspect its full value"}>
          {activeCell ? `Row ${activeCell.row + 1} · ${activeCell.col === PIVOT_GROUP_COL_KEY ? "Group By" : activeCell.col} · Enter to inspect/edit` : "Double-click a cell or press Enter to inspect/edit"}
        </span>
        <div className="dg-toolbar-search">
          <span className="dg-toolbar-separator" aria-hidden="true" />
          {searchOpen && searchScope && !pivotMode
            ? <TableFindBar term={find.term} onChange={find.changeTerm} status={find.status} loading={find.loading} canNavigate={find.canNavigate} onNavigate={find.navigate} onCancel={find.cancel} onClose={closeFind} />
            : <Button small minimal className="dg-display-toggle" icon="search" text="Search" aria-label="Search" aria-expanded={false} aria-controls="dg-find-panel" disabled={!searchScope || !!pivotMode || !columns.length} onClick={() => setSearchOpen(true)} title={pivotMode ? "Exit grouping to search the source table" : !columns.length ? "Show a column before searching" : "Search text in this table (Command / Control F)"} />}
        </div>
      </div>
      <div className="data-grid-body">
        <div className="data-grid-scroll" ref={scrollRef}>
          <div className="dg-width-canvas" style={{ width: totalWidth, minWidth: "100%" }}>
          {/* Sticky header */}
          <div className="dg-header">
            {pivotMode ? (
              <div className="dg-cell dg-pivot-group-header" style={{ width: groupColWidth }}>
                <span className="dg-header-text">Group By</span>
                <span className="dg-group-sort-controls">
                  <button
                    type="button"
                    className={`dg-group-sort-btn${groupSortMode === "alpha" ? " active" : ""}`}
                    title={groupSortMode === "alpha" ? `Alphabetical ${groupSortDirection} (click to toggle)` : "Sort alphabetically"}
                    aria-label={groupSortMode === "alpha" ? `Groups sorted alphabetically ${groupSortDirection === "ASC" ? "ascending. Sort descending" : "descending. Clear sort"}` : "Sort groups alphabetically ascending"}
                    disabled={!onGroupSort}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!onGroupSort) return;
                      if (groupSortMode === "alpha") {
                        if (groupSortDirection === "ASC") onGroupSort("alpha", "DESC");
                        else onGroupSort("alpha", null);
                      } else {
                        onGroupSort("alpha", "ASC");
                      }
                    }}
                  >
                    <Icon icon="sort-alphabetical" size={12} />
                    {groupSortMode === "alpha" && (
                      <Icon icon={groupSortDirection === "ASC" ? "chevron-up" : "chevron-down"} size={10} />
                    )}
                  </button>
                  <button
                    type="button"
                    className={`dg-group-sort-btn${groupSortMode === "count" ? " active" : ""}`}
                    title={groupSortMode === "count" ? `By count ${groupSortDirection} (click to toggle)` : "Sort by count"}
                    aria-label={groupSortMode === "count" ? `Groups sorted by count ${groupSortDirection === "ASC" ? "ascending. Sort descending" : "descending. Clear sort"}` : "Sort groups by count ascending"}
                    disabled={!onGroupSort}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!onGroupSort) return;
                      if (groupSortMode === "count") {
                        if (groupSortDirection === "ASC") onGroupSort("count", "DESC");
                        else onGroupSort("count", null);
                      } else {
                        onGroupSort("count", "ASC");
                      }
                    }}
                  >
                    <Icon icon="sort-numerical" size={12} />
                    {groupSortMode === "count" && (
                      <Icon icon={groupSortDirection === "ASC" ? "chevron-up" : "chevron-down"} size={10} />
                    )}
                  </button>
                </span>
                {viewSettingsMenu && (
                  <span className="dg-view-settings-trigger dg-pivot-view-settings-trigger">
                    {viewSettingsMenu}
                  </span>
                )}
                <div
                  className="col-resize-handle"
                  onMouseDown={(e) => handleResizeStart(e, PIVOT_GROUP_COL_KEY)}
                  onDoubleClick={(e) => handleResizeDoubleClick(e, PIVOT_GROUP_COL_KEY)}
                />
              </div>
            ) : (
              <div className={`dg-cell dg-row-num-cell dg-header-num${viewSettingsMenu ? " dg-view-settings-cell" : ""}`}>
                {viewSettingsMenu ? (
                  <span className="dg-view-settings-trigger">{viewSettingsMenu}</span>
                ) : "#"}
              </div>
            )}
            {displayColumns.map((col) => {
              const sortInfo = sortIndexMap.get(col);
              const hasStatsControl = !!onGetColumnStats && !pivotMode;
              return (
                <div
                  key={col}
                  className={[
                    "dg-cell dg-header-cell",
                    onReorderColumns && !pivotMode ? "reorder-enabled" : "",
                    hasStatsControl ? "has-stats-control" : "",
                    draggingColumn === col ? "column-dragging" : "",
                    activeStatsColumn === col ? "column-inspected" : "",
                    activeQcColumn === col || activeQcNotesColumn === col ? "qc-column-active" : "",
                    headerDropTarget?.col === col
                      ? `header-drop-${headerDropTarget.position}`
                      : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ width: columnWidths[col] ?? DEFAULT_COLUMN_WIDTH }}
                  aria-label={`Column header: ${col}`}
                  title={col}
                  data-grid-column={col}
                  onPointerDown={(e) => handleHeaderPointerDown(e, col)}
                >
                  {pivotMode && (
                    <span
                      className="dg-pivot-agg-badge"
                      title={`Cells show ${pivotAggLabelFor(col)} of ${col}`}
                    >
                      {pivotAggLabelFor(col)}
                    </span>
                  )}
                  <span
                    className="dg-header-text"
                    title={col}
                  >
                    {col}
                  </span>
                  <button
                    type="button"
                    className={`dg-header-sort-btn${sortInfo ? " active" : ""}`}
                    title={
                      sortInfo?.direction === "ASC"
                        ? `Sorted ${col} ascending. Click for descending`
                        : sortInfo?.direction === "DESC"
                          ? `Sorted ${col} descending. Click to clear`
                          : `Sort ${col} ascending`
                    }
                    aria-label={
                      sortInfo?.direction === "ASC"
                        ? `${col}: sorted ascending. Sort descending`
                        : sortInfo?.direction === "DESC"
                          ? `${col}: sorted descending. Clear sort`
                          : `Sort ${col} ascending`
                    }
                    draggable={false}
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSort(col, e.shiftKey);
                    }}
                  >
                    <span className="sort-indicator" aria-hidden="true">
                      {sortInfo && sortColumns.length > 1 && (
                        <span className="sort-indicator-number">{sortInfo.index}</span>
                      )}
                      <Icon icon="sort-alphabetical" size={12} />
                      {sortInfo && (
                        <Icon
                          icon={sortInfo.direction === "ASC" ? "chevron-up" : "chevron-down"}
                          size={10}
                        />
                      )}
                    </span>
                  </button>
                  {hasStatsControl && (
                    <button
                      type="button"
                      className={`dg-header-stats-btn${activeStatsColumn === col ? " active" : ""}`}
                      title="Show column stats"
                      aria-label={`Show stats for ${col}`}
                      draggable={false}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                      }}
                      onClick={(e) => handleHeaderStatsClick(e, col)}
                    >
                      <Icon icon="chart" size={12} />
                    </button>
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
                  const groupText = flatRow.groupValue == null ? "NULL" : formatCell(flatRow.groupValue, displayDecimalPlaces);
                  return (
                    <div
                      key={virtualRow.index}
                      className={`dg-row dg-pivot-group-row dg-pivot-depth-${Math.min(flatRow.depth, 3)}`}
                      style={{
                        position: "absolute",
                        top: 0,
                        transform: `translateY(${virtualRow.start}px)`,
                        width: "100%",
                        height: rowHeight,
                      }}
                    >
                      {/* Group values select like data cells; the arrow expands/collapses. */}
                      <div
                        className={`dg-cell dg-pivot-group-cell${selected.has(cellKey(virtualRow.index, PIVOT_GROUP_COL_KEY)) ? " cell-selected" : ""}`}
                        data-grid-cell={PIVOT_GROUP_COL_KEY}
                        data-grid-row-index={virtualRow.index}
                        style={{
                          width: groupColWidth,
                          paddingLeft: indent,
                        }}
                        onMouseDown={(e) => handleCellMouseDown(virtualRow.index, PIVOT_GROUP_COL_KEY, e)}
                        onMouseEnter={(e) => {
                          handleCellMouseEnterDrag(virtualRow.index, PIVOT_GROUP_COL_KEY, e);
                          if (!dragSelecting.current) handleCellMouseEnter(e, groupText);
                        }}
                        onMouseLeave={handleCellMouseLeave}
                      >
                        <button
                          type="button"
                          className="dg-pivot-expand-button"
                          aria-label={`${flatRow.expanded ? "Collapse" : "Expand"} group ${groupText}`}
                          aria-expanded={!!flatRow.expanded}
                          title={flatRow.expanded ? "Collapse group" : "Expand group"}
                          onMouseDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelected(new Set());
                            setActiveCell(null);
                            anchor.current = null;
                            endDragSelection();
                            onToggleExpand?.(flatRow.key);
                          }}
                        >
                          <Icon
                            icon={flatRow.expanded ? "chevron-down" : "chevron-right"}
                            size={14}
                            className="dg-pivot-expand-icon"
                          />
                        </button>
                        <span
                          className={`dg-pivot-group-value${flatRow.groupValue == null ? " dg-null-value" : ""}`}
                          title={flatRow.groupValue == null ? "NULL" : String(flatRow.groupValue)}
                        >
                          {groupText}
                        </span>
                        <span className="dg-pivot-group-count">
                          ({flatRow.groupCount?.toLocaleString()})
                        </span>
                      </div>
                      {/* Data columns: show aggregates — selectable with tooltip */}
                      {dataColumns.map((col) => {
                        const rawValue = getAggRawValue(flatRow.aggregates, col);
                        const cellText = rawValue === null || rawValue === undefined
                          ? ""
                          : formatCellForColumn(rawValue, col);
                        return (
                          <div
                            key={col}
                            data-grid-cell={col}
                            data-grid-row-index={virtualRow.index}
                            className={`dg-cell${cellText ? " dg-pivot-agg-value" : ""}${flatRow.expanded ? " dg-pivot-agg-faded" : ""}${activeStatsColumn === col ? " column-inspected" : ""}${
                              selected.has(cellKey(virtualRow.index, col)) ? " cell-selected" : ""
                            }`}
                            style={{ width: columnWidths[col] ?? DEFAULT_COLUMN_WIDTH }}
                            onMouseDown={(e) =>
                              handleCellMouseDown(virtualRow.index, col, e)
                            }
                            onMouseEnter={(e) => {
                              handleCellMouseEnterDrag(virtualRow.index, col, e);
                              if (cellText && !dragSelecting.current)
                                handleCellMouseEnter(e, cellText);
                            }}
                            onMouseLeave={handleCellMouseLeave}
                          >
                            <span className="dg-cell-value">{cellText}</span>
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
                      height: rowHeight,
                    }}
                  >
                    {/* Empty Group column for data rows */}
                    <div
                      className={`dg-cell dg-pivot-data-group-cell${selected.has(cellKey(virtualRow.index, PIVOT_GROUP_COL_KEY)) ? " cell-selected" : ""}`}
                      data-grid-cell={PIVOT_GROUP_COL_KEY}
                      data-grid-row-index={virtualRow.index}
                      style={{ width: groupColWidth }}
                      onMouseDown={(e) => handleCellMouseDown(virtualRow.index, PIVOT_GROUP_COL_KEY, e)}
                      onMouseEnter={(e) => handleCellMouseEnterDrag(virtualRow.index, PIVOT_GROUP_COL_KEY, e)}
                    />
                    {/* Data columns: show actual cell values */}
                    {dataColumns.map((col) => {
                      const cellText = loaded ? formatCellForColumn(rowData[col], col) : "...";
                      return (
                        <div
                          key={col}
                          data-grid-cell={col}
                          data-grid-row-index={virtualRow.index}
                          className={[
                            "dg-cell",
                            selected.has(cellKey(virtualRow.index, col))
                              ? "cell-selected"
                              : "",
                            activeStatsColumn === col ? "column-inspected" : "",
                            !loaded ? "loading-cell" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          style={{ width: columnWidths[col] ?? DEFAULT_COLUMN_WIDTH }}
                          onMouseDown={(e) =>
                            handleCellMouseDown(virtualRow.index, col, e)
                          }
                          onMouseEnter={(e) => {
                            handleCellMouseEnterDrag(virtualRow.index, col, e);
                            if (loaded && !dragSelecting.current)
                              handleCellMouseEnter(e, cellText);
                          }}
                          onMouseLeave={handleCellMouseLeave}
                        >
                          <span className="dg-cell-value">{cellText}</span>
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
                    height: rowHeight,
                  }}
                >
                  <div className="dg-cell dg-row-num-cell">
                    {virtualRow.index + 1}
                  </div>
                  {columns.map((col) => {
                    const isQcCell = !!activeQcColumn && col === activeQcColumn;
                    const isQcNoteCell = !!activeQcNotesColumn && col === activeQcNotesColumn;
                    const isQcEditableCell = isQcCell || isQcNoteCell;
                    const cellText = loaded && !isQcEditableCell ? formatCellForColumn(row[col], col) : loaded ? "" : "...";
                    const matchesFind = searchOpen && loaded && findTextMatches(row[col], find.term);
                    const currentFind = searchOpen && find.active?.row === virtualRow.index && find.active.col === col;

                    return (
                      <div
                        key={col}
                        data-grid-cell={col}
                        data-grid-row-index={virtualRow.index}
                          className={[
                            "dg-cell",
                            matchesFind ? "dg-find-cell" : "",
                            currentFind ? "dg-find-current" : "",
                            isQcEditableCell ? "dg-qc-cell" : "",
                            isQcNoteCell ? "dg-qc-note-cell" : "",
                            selected.has(cellKey(virtualRow.index, col))
                              ? "cell-selected"
                              : "",
                            draggingColumn === col ? "column-dragging" : "",
                            activeStatsColumn === col ? "column-inspected" : "",
                            !loaded ? "loading-cell" : "",
                          ]
                          .filter(Boolean)
                          .join(" ")}
                        style={{ width: columnWidths[col] ?? DEFAULT_COLUMN_WIDTH }}
                        onMouseDown={(e) => {
                          if (!isQcEditableCell) handleCellMouseDown(virtualRow.index, col, e);
                        }}
                        onMouseEnter={(e) => {
                          if (!isQcEditableCell) handleCellMouseEnterDrag(virtualRow.index, col, e);
                          if (loaded && !dragSelecting.current && !isQcEditableCell)
                            handleCellMouseEnter(e, cellText);
                        }}
                        onMouseLeave={handleCellMouseLeave}
                      >
                        {isQcCell && loaded
                          ? renderQcCellContent(row)
                          : isQcNoteCell && loaded
                            ? renderQcNoteCellContent(row)
                            : <span className="dg-cell-value">{matchesFind ? highlightFindText(cellText, find.term) : cellText}</span>}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* Grand total row — at the bottom, after virtual rows */}
          {pivotMode && showGrandTotal && grandTotals && (
            <div className="dg-pivot-grand-total-row" style={{ height: rowHeight }}>
              {/* Group column: Grand Total label */}
              <div
                className="dg-cell dg-pivot-group-cell"
                style={{ width: groupColWidth, paddingLeft: 16 }}
              >
                {/* Spacer matching the group chevron so "Grand Total" aligns with group values above */}
                <span style={{ width: 14, flexShrink: 0 }} aria-hidden="true" />
                <span className="dg-pivot-group-value">
                  Grand Total
                </span>
                <span className="dg-pivot-group-count">
                  ({formatCell(grandTotals.__count, displayDecimalPlaces)})
                </span>
              </div>
              {/* Data columns: show aggregates if available */}
              {dataColumns.map((col) => {
                const cellText = getAggValue(grandTotals, col);
                return (
                  <div
                    key={col}
                    className={`dg-cell${cellText ? " dg-pivot-agg-value" : ""}`}
                    style={{ width: columnWidths[col] ?? DEFAULT_COLUMN_WIDTH }}
                  >
                    <span className="dg-cell-value">{cellText}</span>
                  </div>
                );
              })}
            </div>
          )}
          </div>
        </div>
        {emptyState === "error" && (
          <div className="dg-query-state dg-query-error" role="alert">
            <Icon icon="warning-sign" size={20} />
            <div>
              <strong>{queryError?.scope === "count"
                ? "Unable to count rows"
                : queryError?.scope === "pivot"
                  ? "Unable to load pivot data"
                  : "Unable to load rows"}</strong>
              <span>{queryError?.message ?? "The data query failed. Retry to load this view."}</span>
            </div>
            {onQueryRetry && (
              <Button icon="refresh" text="Retry" onClick={onQueryRetry} />
            )}
          </div>
        )}
        {emptyState === "loading" && (
          <div className="dg-query-state" aria-live="polite">
            <Icon icon="refresh" size={18} />
            <strong>Loading data…</strong>
          </div>
        )}
        {emptyState === "filtered" && !pivotNeedsGroups && (
          <div className="dg-query-state">
            <Icon icon="filter-list" size={18} />
            <div><strong>No rows match the current filters</strong><span>Clear the filters to see the data again.</span></div>
            {onClearFilters && <Button text="Clear filters" icon="filter-remove" onClick={onClearFilters} />}
          </div>
        )}
        {emptyState === "hidden-columns" && (
          <div className="dg-query-state">
            <Icon icon="column-layout" size={18} />
            <div><strong>All columns are hidden</strong><span>Show columns to continue exploring this view.</span></div>
            {onShowColumns && <Button text="Show columns" onClick={onShowColumns} />}
          </div>
        )}
        {emptyState === "empty" && !pivotNeedsGroups && (
          <div className="dg-query-state" role="status">
            <Icon icon="document" size={18} />
            <div><strong>This file has no rows</strong><span>The column headers are available above.</span></div>
          </div>
        )}
        {pivotNeedsGroups && emptyState !== "error" && emptyState !== "loading" && emptyState !== "hidden-columns" && (
          <div className="dg-query-state">
            <Icon icon="group-objects" size={18} />
            <div><strong>Choose a column to group by</strong><span>Use the green group control beside a column in the sidebar. Shift+click adds more group levels.</span></div>
          </div>
        )}
        {columnStatsPanel && (
          <ColumnStatsRail
            panel={columnStatsPanel}
            fallbackType={columnTypes?.get(columnStatsPanel.column)}
            format={getEffectiveColumnFormat(columnStatsPanel.column)}
            appliedFormat={getColumnFormat(columnStatsPanel.column)}
            defaultFormat={defaultColumnFormat}
            minDecimalPlaces={minDisplayDecimalPlaces}
            maxDecimalPlaces={maxDisplayDecimalPlaces}
            onFormatPreview={(format) => previewFormatForColumn(columnStatsPanel.column, format)}
            onFormatChange={(format) => applyFormatForColumn(columnStatsPanel.column, format)}
            colOpsSteps={colOpsSteps}
            undoStrategy={undoStrategy}
            onCleanApply={handleColumnStatsCleanApply}
            onCleanUndo={handleColumnStatsCleanUndo}
            onShowUniques={handleShowUniqueValues}
            onBack={handleColumnStatsBack}
            onRefresh={handleColumnStatsRefresh}
            onClose={closeColumnStatsPanel}
          />
        )}
      </div>
      {tooltip && (
        <div
          ref={tooltipRef}
          className={[
            "dg-tooltip",
            tooltipFlipped ? "dg-tooltip-below" : "",
          ].filter(Boolean).join(" ")}
          style={{
            left: tooltip.x,
            top: tooltipFlipped ? tooltip.y + tooltip.cellHeight : tooltip.y,
          }}
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
        >
          <div className="dg-tooltip-body">
            <TooltipContent text={tooltip.text} linkPreviewsEnabled={linkPreviewsEnabled} />
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
      {cellLinkPreview && createPortal(
        <LinkPreviewCard
          preview={cellLinkPreview}
          onMouseEnter={handleTooltipMouseEnter}
          onMouseLeave={handleTooltipMouseLeave}
          onFocus={handleTooltipFocus}
          onBlur={handleTooltipBlur}
        />,
        document.body
      )}
    </div>
  );
}

interface ColumnStatsRailProps {
  panel: ColumnStatsPanelState;
  fallbackType?: string;
  format: ColumnDisplayFormat;
  appliedFormat: ColumnDisplayFormat;
  defaultFormat: ColumnDisplayFormat;
  minDecimalPlaces: number;
  maxDecimalPlaces: number;
  onFormatPreview: (format: ColumnDisplayFormat) => void;
  onFormatChange: (format: ColumnDisplayFormat) => void;
  colOpsSteps: ColOpStep[];
  undoStrategy: UndoStrategy;
  onCleanApply: (opType: ColOpType, column: string, params: Record<string, string>) => Promise<void>;
  onCleanUndo: (column: string) => Promise<void>;
  onShowUniques: () => void;
  onBack: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

function ColumnStatsRail({
  panel,
  fallbackType,
  format,
  appliedFormat,
  defaultFormat,
  minDecimalPlaces,
  maxDecimalPlaces,
  onFormatPreview,
  onFormatChange,
  colOpsSteps,
  undoStrategy,
  onCleanApply,
  onCleanUndo,
  onShowUniques,
  onBack,
  onRefresh,
  onClose,
}: ColumnStatsRailProps): React.ReactElement {
  const stats = panel.stats;
  const columnType = stats?.columnType ?? fallbackType ?? "Column";
  const filledCount = stats ? Math.max(0, stats.rowCount - stats.nullCount) : 0;
  const topMax = stats
    ? Math.max(1, ...stats.topValues.map((topValue) => topValue.count))
    : 1;
  const hasNumericStats = stats?.avgValue != null || stats?.medianValue != null;
  const isNumeric = isNumericColumnType(columnType);
  const isText = isTextColumnType(columnType);
  const hasTextProfile = isText && !!stats?.textStats;
  const uniqueSortLabel = isNumericColumnType(columnType)
    ? "Sorted numerically"
    : "Sorted A-Z, case-insensitive";

  return (
    <aside className="dg-column-stats-rail">
      <div className="dg-stats-header">
        <div className="dg-stats-heading">
          {panel.view === "uniques" && (
            <Button
              minimal
              small
              icon="arrow-left"
              className="dg-stats-back"
              title="Back to column stats"
              aria-label="Back to column stats"
              onClick={onBack}
            />
          )}
          <Icon icon={panel.view === "uniques" ? "list" : "chart"} size={16} />
          <div className="dg-stats-title-block">
            <span className="dg-stats-column" title={panel.column}>
              {panel.column}
            </span>
            <span className="dg-stats-type">{columnType}</span>
          </div>
        </div>
        <div className="dg-stats-actions">
          <Button
            minimal
            small
            icon="refresh"
            title="Refresh stats"
            aria-label="Refresh stats"
            disabled={panel.status === "loading"}
            onClick={onRefresh}
          />
          <Button
            minimal
            small
            icon="cross"
            title="Close stats"
            aria-label="Close stats"
            onClick={onClose}
          />
        </div>
      </div>

      <div className="dg-stats-context">
        <span>Current filter</span>
        <strong>
          {stats
            ? `${formatStatNumber(stats.rowCount)} of ${formatStatNumber(stats.totalRows)} rows`
            : "Loading"}
        </strong>
      </div>

      {panel.status === "loading" && !stats && (
        <div className="dg-stats-loading" aria-label="Loading column stats">
          <span />
          <span />
          <span />
        </div>
      )}

      {panel.status === "error" && (
        <div className="dg-stats-error">
          <Icon icon="warning-sign" size={14} />
          <span>{panel.error ?? "Unable to load column stats"}</span>
        </div>
      )}

      {stats && panel.view === "overview" && (
        <>
          <div className="dg-stats-metrics">
            <StatMetric
              label="Nulls"
              value={formatStatNumber(stats.nullCount)}
              detail={formatPercent(stats.nullCount, stats.rowCount)}
            />
            <StatMetric
              label="Unique"
              value={formatStatNumber(stats.uniqueCount)}
              detail={formatPercent(stats.uniqueCount, stats.rowCount)}
              onClick={onShowUniques}
              title="Show unique values"
            />
            <StatMetric
              label="Filled"
              value={formatStatNumber(filledCount)}
              detail={formatPercent(filledCount, stats.rowCount)}
            />
          </div>

          <div className="dg-stats-section">
            <div className="dg-stats-section-title">
              {hasTextProfile ? "Text profile" : hasNumericStats ? "Numeric summary" : "Range"}
            </div>
            <div className="dg-stats-kv">
              {hasTextProfile ? (
                <>
                  <StatsKeyValue
                    label="Shortest"
                    value={formatTextLength(stats.textStats?.minLength)}
                  />
                  <StatsKeyValue
                    label="Average"
                    value={formatTextLength(stats.textStats?.avgLength)}
                  />
                  <StatsKeyValue
                    label="Longest"
                    value={formatTextLength(stats.textStats?.maxLength)}
                  />
                </>
              ) : hasNumericStats && (
                <>
                  <StatsKeyValue
                    label="Median"
                    value={formatStatsValue(stats.medianValue, format, isNumeric)}
                  />
                  <StatsKeyValue
                    label="Average"
                    value={formatStatsValue(stats.avgValue, format, isNumeric)}
                  />
                </>
              )}
              {!hasTextProfile && (
                <>
                  <StatsKeyValue label="Min" value={formatStatsValue(stats.minValue, format, isNumeric)} />
                  <StatsKeyValue label="Max" value={formatStatsValue(stats.maxValue, format, isNumeric)} />
                </>
              )}
            </div>
          </div>

          <div className="dg-stats-section">
            <div className="dg-stats-section-title">Top values</div>
            {stats.topValues.length > 0 ? (
              <div className="dg-stats-top-values">
                {stats.topValues.map((topValue, idx) => {
                  const valueLabel = topValue.value === ""
                    ? "(empty)"
                    : formatStatsValue(topValue.value, format, isNumeric);
                  return (
                    <div className="dg-stats-top-row" key={`${topValue.value}:${idx}`}>
                      <div className="dg-stats-top-label" title={valueLabel}>
                        {valueLabel}
                      </div>
                      <div className="dg-stats-top-bar-track">
                        <span
                          className="dg-stats-top-bar"
                          style={{ width: `${Math.max(4, (topValue.count / topMax) * 100)}%` }}
                        />
                      </div>
                      <div className="dg-stats-top-count">
                        {formatStatNumber(topValue.count)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="dg-stats-empty">No non-null values</div>
            )}
          </div>

          <ColumnStatsOpsPanel
            columnType={columnType}
            stats={stats}
            format={format}
            appliedFormat={appliedFormat}
            defaultFormat={defaultFormat}
            minDecimalPlaces={minDecimalPlaces}
            maxDecimalPlaces={maxDecimalPlaces}
            onFormatPreview={onFormatPreview}
            onFormatChange={onFormatChange}
            colOpsSteps={colOpsSteps}
            undoStrategy={undoStrategy}
            onCleanApply={(opType, params) => onCleanApply(opType, stats.column, params)}
            onCleanUndo={() => onCleanUndo(stats.column)}
          />
        </>
      )}

      {stats && panel.view === "uniques" && (
        <div className="dg-stats-section dg-stats-uniques-section">
          <div className="dg-stats-section-heading">
            <div className="dg-stats-section-title">Unique values</div>
            <span>{uniqueSortLabel}</span>
          </div>

          {panel.uniqueStatus === "loading" && (
            <div className="dg-stats-loading" aria-label="Loading unique values">
              <span />
              <span />
              <span />
            </div>
          )}

          {panel.uniqueStatus === "error" && (
            <div className="dg-stats-error">
              <Icon icon="warning-sign" size={14} />
              <span>{panel.uniqueError ?? "Unable to load unique values"}</span>
            </div>
          )}

          {panel.uniqueStatus === "ready" && (
            panel.uniqueValues && panel.uniqueValues.length > 0 ? (
              <div className="dg-stats-unique-values">
                {panel.uniqueValues.map((uniqueValue, idx) => {
                  const valueLabel = uniqueValue.value === "" ? "(empty)" : uniqueValue.value;
                  return (
                    <div className="dg-stats-unique-row" key={`${uniqueValue.value}:${idx}`}>
                      <div className="dg-stats-unique-value" title={valueLabel}>
                        {valueLabel}
                      </div>
                      <div className="dg-stats-unique-count">
                        {formatStatNumber(uniqueValue.count)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="dg-stats-empty">No non-null unique values</div>
            )
          )}
        </div>
      )}
    </aside>
  );
}

function ColumnStatsOpsPanel({
  columnType,
  stats,
  format,
  appliedFormat,
  defaultFormat,
  minDecimalPlaces,
  maxDecimalPlaces,
  onFormatPreview,
  onFormatChange,
  colOpsSteps,
  undoStrategy,
  onCleanApply,
  onCleanUndo,
}: {
  columnType: string;
  stats: ColumnStats;
  format: ColumnDisplayFormat;
  appliedFormat: ColumnDisplayFormat;
  defaultFormat: ColumnDisplayFormat;
  minDecimalPlaces: number;
  maxDecimalPlaces: number;
  onFormatPreview: (format: ColumnDisplayFormat) => void;
  onFormatChange: (format: ColumnDisplayFormat) => void;
  colOpsSteps: ColOpStep[];
  undoStrategy: UndoStrategy;
  onCleanApply: (opType: ColOpType, params: Record<string, string>) => Promise<void>;
  onCleanUndo: () => Promise<void>;
}): React.ReactElement {
  const isNumeric = isNumericColumnType(columnType);
  const isText = isTextColumnType(columnType);
  const tabs: ColumnOpsTab[] = isNumeric ? ["format"] : ["clean"];
  const defaultCleanOp: TextCleanOp =
    (stats.textStats?.leadingTrailingSpaceCount ?? 0) > 0
      ? "trim"
      : (stats.textStats?.emptyStringCount ?? 0) > 0
        ? "empty_to_null"
        : "placeholder_to_null";
  const [activeTab, setActiveTab] = useState<ColumnOpsTab>(isNumeric ? "format" : "clean");
  const activeOpsTab = tabs.includes(activeTab) ? activeTab : tabs[0];
  const [draftFormat, setDraftFormat] = useState<ColumnDisplayFormat>(format);
  const [selectedCleanOp, setSelectedCleanOp] = useState<TextCleanOp>(defaultCleanOp);
  const [workingCleanOp, setWorkingCleanOp] = useState<TextCleanOp | "undo" | null>(null);
  const [cleanError, setCleanError] = useState<string | null>(null);
  const [cleanSuccess, setCleanSuccess] = useState<string | null>(null);
  const sampleValue = stats.medianValue ?? stats.avgValue ?? stats.minValue ?? stats.topValues[0]?.value ?? null;

  useEffect(() => {
    setDraftFormat(format);
  }, [format, stats.column]);

  useEffect(() => {
    setActiveTab(isNumeric ? "format" : "clean");
  }, [isNumeric, stats.column]);

  useEffect(() => {
    setSelectedCleanOp(defaultCleanOp);
    setCleanError(null);
    setCleanSuccess(null);
    setWorkingCleanOp(null);
  }, [defaultCleanOp, stats.column]);

  const updateDraft = (patch: Partial<ColumnDisplayFormat>) => {
    const nextFormat = { ...draftFormat, ...patch };
    setDraftFormat(nextFormat);
    onFormatPreview(nextFormat);
  };

  const isDirty =
    draftFormat.decimalPlaces !== appliedFormat.decimalPlaces
    || draftFormat.numberStyle !== appliedFormat.numberStyle
    || draftFormat.roundingMethod !== appliedFormat.roundingMethod;

  const stepDecimalPlaces = (delta: number) => {
    const next = Math.min(
      maxDecimalPlaces,
      Math.max(minDecimalPlaces, draftFormat.decimalPlaces + delta)
    );
    updateDraft({ decimalPlaces: next });
  };

  const renderFormatTab = () => {
    if (!isNumeric) {
      return null;
    }

    return (
      <>
        <div className="dg-stats-op-field">
          <div className="dg-stats-op-label-row">
            <span>Decimal places</span>
            <em>Preview: {formatStatsValue(sampleValue, draftFormat, true)}</em>
          </div>
          <ButtonGroup className="dg-stats-decimal-stepper">
            <Button
              icon="minus"
              aria-label="Decrease decimal places"
              disabled={draftFormat.decimalPlaces <= minDecimalPlaces}
              onClick={() => stepDecimalPlaces(-1)}
            />
            <span>{draftFormat.decimalPlaces}</span>
            <Button
              icon="plus"
              aria-label="Increase decimal places"
              disabled={draftFormat.decimalPlaces >= maxDecimalPlaces}
              onClick={() => stepDecimalPlaces(1)}
            />
          </ButtonGroup>
        </div>

        <div className="dg-stats-op-field">
          <div className="dg-stats-op-label-row">
            <span>Number style</span>
          </div>
          <div className="dg-stats-style-list" role="radiogroup" aria-label="Number style">
            {NUMBER_STYLE_OPTIONS.map((option) => {
              const selected = draftFormat.numberStyle === option.value;
              const optionFormat = { ...draftFormat, numberStyle: option.value };
              return (
                <button
                  type="button"
                  key={option.value}
                  className={`dg-stats-style-row${selected ? " active" : ""}`}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => updateDraft({ numberStyle: option.value })}
                >
                  <span className="dg-stats-radio-dot" aria-hidden="true" />
                  <span>{option.label}</span>
                  <em>{formatStatsValue(sampleValue, optionFormat, true)}</em>
                </button>
              );
            })}
          </div>
        </div>

        <div className="dg-stats-op-field">
          <div className="dg-stats-op-label-row">
            <span>Rounding method</span>
          </div>
          <SoftSelect
            value={draftFormat.roundingMethod}
            onChange={(e) => updateDraft({ roundingMethod: e.target.value as RoundingMethod })}
            fill
          >
            {ROUNDING_METHOD_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </SoftSelect>
          <div className="dg-stats-op-hint">Values are rounded for display only; underlying data is unchanged.</div>
        </div>

        <div className="dg-stats-live-preview">
          <div>
            <span>Before</span>
            <strong>{formatRawPreview(sampleValue)}</strong>
          </div>
          <Icon icon="arrow-right" size={18} />
          <div>
            <span>After</span>
            <strong>{formatStatsValue(sampleValue, draftFormat, true)}</strong>
          </div>
        </div>
      </>
    );
  };

  const renderComingSoonRows = (
    rows: { icon: string; title: string; detail: string }[]
  ) => (
    <div className="dg-stats-op-list">
      {rows.map((row) => (
        <div className="dg-stats-op-row" key={row.title}>
          <Icon icon={row.icon as any} size={14} />
          <div>
            <strong>{row.title}</strong>
            <span>{row.detail}</span>
          </div>
          <Button minimal small text="Soon" disabled />
        </div>
      ))}
    </div>
  );

  const renderTextCleanTab = () => {
    const textStats = stats.textStats;
    const whitespaceRows = textStats?.leadingTrailingSpaceCount ?? 0;
    const emptyStringRows = textStats?.emptyStringCount ?? 0;
    const placeholderLabel = TEXT_PLACEHOLDER_VALUES.join(", ");
    const selectedOp = selectedCleanOp;
    const hasPerStepUndo = undoStrategy === "per-step";
    const lastColOp = colOpsSteps[colOpsSteps.length - 1];
    const canUndo = lastColOp?.column === stats.column && hasPerStepUndo && !workingCleanOp;
    const signals = [
      {
        label: "Whitespace",
        detail: `${formatStatNumber(whitespaceRows)} ${whitespaceRows === 1 ? "row" : "rows"}`,
        route: "Detect",
        tone: whitespaceRows > 0 ? "warning" : "ok",
      },
      {
        label: "Empty strings",
        detail: `${formatStatNumber(emptyStringRows)} ${emptyStringRows === 1 ? "row" : "rows"}`,
        route: "Detect",
        tone: emptyStringRows > 0 ? "warning" : "ok",
      },
      {
        label: "Placeholders",
        detail: "Common tokens",
        route: "Quick",
        tone: "info",
      },
    ];
    const cleanOps: {
      id: TextCleanOp;
      opType: ColOpType;
      icon: string;
      title: string;
      detail: string;
      meta: string;
      params: Record<string, string>;
      disabled?: boolean;
    }[] = [
      {
        id: "trim",
        opType: "trim",
        icon: "alignment-vertical-center",
        title: "Trim whitespace",
        detail: "Remove leading and trailing spaces.",
        meta: whitespaceRows > 0 ? `${formatStatNumber(whitespaceRows)} rows` : "Clean",
        params: {},
        disabled: whitespaceRows === 0,
      },
      {
        id: "empty_to_null",
        opType: "empty_to_null",
        icon: "clean",
        title: "Empty strings to NULL",
        detail: "Convert blank text into true missing values.",
        meta: emptyStringRows > 0 ? `${formatStatNumber(emptyStringRows)} rows` : "None found",
        params: {},
        disabled: emptyStringRows === 0,
      },
      {
        id: "placeholder_to_null",
        opType: "placeholder_to_null",
        icon: "filter-remove",
        title: "Placeholders to NULL",
        detail: placeholderLabel,
        meta: "Apply if present",
        params: { placeholders: TEXT_PLACEHOLDER_VALUES.join("\n") },
      },
    ];
    const selectedCleanConfig = cleanOps.find((op) => op.id === selectedOp) ?? cleanOps[0];
    const applyDisabled = !!selectedCleanConfig.disabled || !!workingCleanOp;

    const handleApplyClean = async () => {
      if (!selectedCleanConfig || applyDisabled) return;
      setWorkingCleanOp(selectedCleanConfig.id);
      setCleanError(null);
      setCleanSuccess(null);
      try {
        await onCleanApply(selectedCleanConfig.opType, selectedCleanConfig.params);
        setCleanSuccess(`${selectedCleanConfig.title} applied`);
      } catch (err) {
        setCleanError(err instanceof Error ? err.message : "Unable to apply operation");
      } finally {
        setWorkingCleanOp(null);
      }
    };

    const handleUndoClean = async () => {
      if (!canUndo) return;
      setWorkingCleanOp("undo");
      setCleanError(null);
      setCleanSuccess(null);
      try {
        await onCleanUndo();
        setCleanSuccess("Last column operation undone");
      } catch (err) {
        setCleanError(err instanceof Error ? err.message : "Unable to undo operation");
      } finally {
        setWorkingCleanOp(null);
      }
    };

    return (
      <>
        <div className="dg-stats-quality-panel">
          <div className="dg-stats-quality-heading">
            <strong>Clean signals</strong>
            <span>{whitespaceRows + emptyStringRows > 0 ? `${formatStatNumber(whitespaceRows + emptyStringRows)} found` : "Ready"}</span>
          </div>
          <div className="dg-stats-quality-list">
            {signals.map((signal) => (
              <div className="dg-stats-quality-row" key={signal.label}>
                <span className={`dg-stats-signal-dot ${signal.tone}`} aria-hidden="true" />
                <span className="dg-stats-quality-label">{signal.label}</span>
                <span className="dg-stats-quality-detail">{signal.detail}</span>
                <span className={`dg-stats-quality-route ${signal.tone}`}>{signal.route}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="dg-stats-clean-panel">
          <div className="dg-stats-suggested-heading">Operations</div>
          <div className="dg-stats-clean-list" role="radiogroup" aria-label="Clean operations">
            {cleanOps.map((row) => {
              const selected = selectedCleanOp === row.id;
              return (
                <button
                  type="button"
                  className={`dg-stats-clean-row${selected ? " selected" : ""}${row.disabled ? " disabled" : ""}`}
                  key={row.id}
                  role="radio"
                  aria-checked={selected}
                  onClick={() => {
                    setSelectedCleanOp(row.id);
                    setCleanError(null);
                    setCleanSuccess(null);
                  }}
                  disabled={!!workingCleanOp}
                >
                  <span className="dg-stats-suggested-icon">
                    <Icon icon={row.icon as any} size={14} />
                  </span>
                  <span className="dg-stats-suggested-copy">
                    <strong>{row.title}</strong>
                    <span title={row.detail}>{row.detail}</span>
                  </span>
                  <span className={`dg-stats-clean-meta${row.disabled ? " muted" : ""}`}>{row.meta}</span>
                </button>
              );
            })}
          </div>
        </div>

        {(cleanError || cleanSuccess) && (
          <div className={`dg-stats-op-message${cleanError ? " error" : " success"}`}>
            <Icon icon={cleanError ? "error" : "tick"} size={14} />
            <span>{cleanError ?? cleanSuccess}</span>
          </div>
        )}

        <div className="dg-stats-op-footer">
          <Button
            icon="undo"
            text="Undo"
            disabled={!canUndo}
            loading={workingCleanOp === "undo"}
            title={
              colOpsSteps.length === 0
                ? "No column operations to undo"
                : !hasPerStepUndo
                  ? "Undo is unavailable while using snapshot history"
                  : lastColOp?.column === stats.column
                    ? "Undo last column operation"
                    : "Last column operation belongs to another column"
            }
            onClick={handleUndoClean}
          />
          <Button
            intent="primary"
            icon="tick"
            text="Apply"
            disabled={applyDisabled}
            loading={workingCleanOp !== null && workingCleanOp !== "undo"}
            onClick={handleApplyClean}
          />
        </div>
      </>
    );
  };

  const renderCleanTab = () => {
    if (isText) return renderTextCleanTab();
    return renderComingSoonRows([
      { icon: "clean", title: `Fill ${formatStatNumber(stats.nullCount)} nulls`, detail: "Replace missing values with a fixed value or NULL." },
      { icon: "filter-remove", title: "Replace invalid values", detail: "Normalize values that do not match the column dtype." },
      { icon: "exchange", title: "Cast type", detail: `Convert ${columnType.toUpperCase()} to another compatible dtype.` },
    ]);
  };

  return (
    <div className="dg-stats-ops">
      <div
        className="dg-stats-op-tabs"
        role="tablist"
        aria-label="Column operations"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((tab) => (
          <button
            type="button"
            key={tab}
            className={activeOpsTab === tab ? "active" : ""}
            role="tab"
            aria-selected={activeOpsTab === tab}
            onClick={() => setActiveTab(tab)}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="dg-stats-op-content">
        {activeOpsTab === "format" && renderFormatTab()}
        {activeOpsTab === "clean" && renderCleanTab()}
      </div>

      {activeOpsTab === "format" && isNumeric && (
        <div className="dg-stats-op-footer">
          <Button
            text="Reset"
            disabled={
              draftFormat.decimalPlaces === defaultFormat.decimalPlaces
              && draftFormat.numberStyle === defaultFormat.numberStyle
              && draftFormat.roundingMethod === defaultFormat.roundingMethod
            }
            onClick={() => {
              setDraftFormat(defaultFormat);
              onFormatPreview(defaultFormat);
            }}
          />
          <Button
            intent="primary"
            icon="tick"
            text={isDirty ? "Apply" : "Applied"}
            disabled={!isDirty || !isNumeric}
            onClick={() => onFormatChange(draftFormat)}
          />
        </div>
      )}
    </div>
  );
}

function StatMetric({
  label,
  value,
  detail,
  onClick,
  title,
}: {
  label: string;
  value: string;
  detail: string;
  onClick?: () => void;
  title?: string;
}): React.ReactElement {
  const content = (
    <>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{detail}</em>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className="dg-stats-metric dg-stats-metric-clickable"
        onClick={onClick}
        title={title}
      >
        {content}
      </button>
    );
  }

  return (
    <div className="dg-stats-metric">
      {content}
    </div>
  );
}

function StatsKeyValue({
  label,
  value,
}: {
  label: string;
  value: string;
}): React.ReactElement {
  return (
    <div className="dg-stats-kv-row">
      <span>{label}</span>
      <strong title={value}>{value || "-"}</strong>
    </div>
  );
}

function formatStatNumber(value: number): string {
  return value.toLocaleString();
}

function QcNoteCell({
  value,
  columnName,
  onCommit,
}: {
  value: string;
  columnName: string;
  onCommit: (value: string | null) => void;
}): React.ReactElement {
  const [draft, setDraft] = useState(value);
  const committedRef = useRef(value);

  useEffect(() => {
    if (value === committedRef.current) return;
    committedRef.current = value;
    setDraft(value);
  }, [value]);

  const commit = () => {
    if (draft === committedRef.current) return;
    committedRef.current = draft;
    onCommit(draft === "" ? null : draft);
  };

  return (
    <input
      type="text"
      className="dg-qc-note-input"
      value={draft}
      placeholder="Add note"
      title={draft}
      aria-label={`Note ${columnName}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          commit();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(committedRef.current);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function normalizeQcValue(value: any): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

function formatTextLength(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  const label = Number.isInteger(value) ? formatStatNumber(value) : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
  return `${label} ${Math.round(value) === 1 ? "char" : "chars"}`;
}

function formatPercent(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function formatStatsValue(value: any, format: ColumnDisplayFormat, isNumeric = false): string {
  if (value === null || value === undefined || value === "") return "-";
  return formatCell(value, format.decimalPlaces, isNumeric ? format.numberStyle : "standard", format.roundingMethod, isNumeric);
}

function isNumericColumnType(columnType: string): boolean {
  return /^(TINYINT|SMALLINT|INTEGER|INT|BIGINT|HUGEINT|FLOAT|REAL|DOUBLE|DECIMAL|NUMERIC)/i.test(columnType);
}

function isTextColumnType(columnType: string): boolean {
  return /^(VARCHAR|TEXT|CHAR|STRING|UUID)/i.test(columnType);
}

function parseNumericValue(value: any): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function roundForDisplay(value: number, decimalPlaces: number, roundingMethod: RoundingMethod): number {
  const factor = 10 ** decimalPlaces;
  const scaled = value * factor;
  switch (roundingMethod) {
    case "truncate":
      return Math.trunc(scaled) / factor;
    case "floor":
      return Math.floor(scaled) / factor;
    case "ceil":
      return Math.ceil(scaled) / factor;
    case "half_up":
    default:
      return Math.round(scaled) / factor;
  }
}

function formatRawPreview(value: any): string {
  if (value === null || value === undefined || value === "") return "-";
  const numeric = parseNumericValue(value);
  if (numeric === null) return String(value);
  return Number.isInteger(numeric) ? numeric.toString() : numeric.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export function formatCell(
  value: any,
  decimalPlaces: number,
  numberStyle: NumberDisplayStyle = "standard",
  roundingMethod: RoundingMethod = "half_up",
  forceNumeric = false
): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  if (forceNumeric && typeof value === "string" && isPrecisionSensitiveNumber(value)) {
    return value;
  }
  const numericValue = forceNumeric ? parseNumericValue(value) : (typeof value === "number" ? parseNumericValue(value) : null);
  if (numericValue !== null) {
    const rounded = roundForDisplay(numericValue, decimalPlaces, roundingMethod);
    if (!Number.isFinite(rounded)) return String(value);
    if (numberStyle === "currency") {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(rounded);
    }
    if (numberStyle === "percent") {
      return new Intl.NumberFormat("en-US", {
        style: "percent",
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(rounded);
    }
    if (numberStyle === "scientific") {
      return rounded.toExponential(decimalPlaces);
    }
    return Number.isInteger(numericValue) ? numericValue.toString() : rounded.toFixed(decimalPlaces);
  }
  return String(value);
}

function isPrecisionSensitiveNumber(value: string): boolean {
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return false;
  const significantDigits = trimmed
    .replace(/^[+-]/, "")
    .replace(/[eE].*$/, "")
    .replace(".", "")
    .replace(/^0+/, "");
  return significantDigits.length > 15;
}

// URL regex for detecting links in tooltip text
const URL_RE = /https?:\/\/[^\s<>"'`,;)}\]]+/g;

const LINK_PREVIEW_WIDTH = 344;
const LINK_PREVIEW_HEIGHT = 354;
const LINK_PREVIEW_MARGIN = 8;
const LINK_PREVIEW_GAP = 10;

interface LinkPreviewState {
  url: string;
  hostname: string;
  left: number;
  top: number;
}

type LinkPreviewLoadState =
  | { status: "loading" }
  | { status: "ready"; metadata: LinkPreviewMetadata }
  | { status: "unavailable" };

const LINK_PREVIEW_CACHE_LIMIT = 20;
const linkPreviewCache = new Map<string, Promise<LinkPreviewMetadata>>();

function requestLinkPreview(url: string): Promise<LinkPreviewMetadata> {
  const cached = linkPreviewCache.get(url);
  if (cached) return cached;
  if (linkPreviewCache.size >= LINK_PREVIEW_CACHE_LIMIT) {
    const oldestKey = linkPreviewCache.keys().next().value;
    if (oldestKey) linkPreviewCache.delete(oldestKey);
  }
  const request = window.api.fetchLinkPreview(url);
  linkPreviewCache.set(url, request);
  void request.catch(() => {
    window.setTimeout(() => {
      if (linkPreviewCache.get(url) === request) linkPreviewCache.delete(url);
    }, 30_000);
  });
  return request;
}

function getLinkPreviewPosition(rect: DOMRect): Pick<LinkPreviewState, "left" | "top"> {
  const availableWidth = Math.min(LINK_PREVIEW_WIDTH, window.innerWidth - LINK_PREVIEW_MARGIN * 2);
  const availableHeight = Math.min(LINK_PREVIEW_HEIGHT, window.innerHeight - LINK_PREVIEW_MARGIN * 2);
  const preferredLeft = rect.right + LINK_PREVIEW_GAP;
  const fallbackLeft = rect.left - availableWidth - LINK_PREVIEW_GAP;
  const left = preferredLeft + availableWidth <= window.innerWidth - LINK_PREVIEW_MARGIN
    ? preferredLeft
    : Math.max(LINK_PREVIEW_MARGIN, fallbackLeft);
  const top = Math.min(
    Math.max(LINK_PREVIEW_MARGIN, rect.top - 36),
    Math.max(LINK_PREVIEW_MARGIN, window.innerHeight - availableHeight - LINK_PREVIEW_MARGIN)
  );
  return { left, top };
}

interface LinkPreviewCardProps {
  preview: LinkPreviewState;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onFocus?: () => void;
  onBlur?: React.FocusEventHandler<HTMLDivElement>;
}

function LinkPreviewCard({
  preview,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
}: LinkPreviewCardProps): React.ReactElement {
  const [loadState, setLoadState] = useState<LinkPreviewLoadState>({ status: "loading" });
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  useEffect(() => {
    let active = true;
    setLoadState({ status: "loading" });
    setCopyState("idle");
    requestLinkPreview(preview.url)
      .then((metadata) => {
        if (active) setLoadState({ status: "ready", metadata });
      })
      .catch(() => {
        if (active) setLoadState({ status: "unavailable" });
      });
    return () => {
      active = false;
    };
  }, [preview.url]);

  const metadata = loadState.status === "ready" ? loadState.metadata : null;
  const hostname = metadata?.hostname || preview.hostname;
  const hasImage = !!metadata?.imageDataUrl;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(preview.url);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1500);
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div
      className={`dg-link-preview${hasImage ? " has-image" : ""}`}
      style={{ left: preview.left, top: preview.top }}
      role="dialog"
      aria-label={`Link preview for ${hostname}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="dg-link-preview-heading">
        <span className="dg-link-preview-favicon">
          {metadata?.faviconDataUrl ? (
            <img src={metadata.faviconDataUrl} alt="" />
          ) : (
            <Icon icon="link" size={14} />
          )}
        </span>
        <span className="dg-link-preview-identity">
          <span className="dg-link-preview-title">
            {metadata?.title || (loadState.status === "loading" ? "Loading preview…" : hostname)}
          </span>
          <span className="dg-link-preview-hostname">{hostname}</span>
        </span>
        <span className="dg-link-preview-actions">
          <button
            type="button"
            className={`dg-link-preview-action${copyState === "copied" ? " copied" : ""}${copyState === "error" ? " error" : ""}`}
            onClick={() => void copyUrl()}
            aria-label={copyState === "copied" ? "URL copied" : copyState === "error" ? "Copy failed" : "Copy full URL"}
            title={copyState === "copied" ? "Copied" : copyState === "error" ? "Copy failed" : "Copy full URL"}
          >
            <Icon icon={copyState === "copied" ? "tick" : copyState === "error" ? "warning-sign" : "clipboard"} size={13} />
          </button>
          <button
            type="button"
            className="dg-link-preview-action"
            onClick={() => void window.api.openExternal(preview.url)}
            aria-label="Open full URL in browser"
            title="Open full URL in browser"
          >
            <Icon icon="share" size={13} />
          </button>
          <span className="dg-link-preview-safe" title="Fetched without page scripts or cookies">
            <Icon icon="shield" size={13} />
          </span>
        </span>
      </div>

      <div className="dg-link-preview-url" title={preview.url}>{preview.url}</div>

      {loadState.status === "loading" && (
        <div className="dg-link-preview-loading" aria-hidden="true">
          <span className="dg-link-preview-skeleton dg-link-preview-skeleton-image" />
          <span className="dg-link-preview-skeleton dg-link-preview-skeleton-line" />
          <span className="dg-link-preview-skeleton dg-link-preview-skeleton-line short" />
        </div>
      )}

      {metadata && (
        <>
          {metadata.imageDataUrl && (
            <div className="dg-link-preview-media">
              <img src={metadata.imageDataUrl} alt="" />
            </div>
          )}
          {metadata.description && (
            <div className="dg-link-preview-description">{metadata.description}</div>
          )}
          {!metadata.imageDataUrl && !metadata.description && (
            <div className="dg-link-preview-message">Preview details are not available for this page.</div>
          )}
        </>
      )}

      {loadState.status === "unavailable" && (
        <div className="dg-link-preview-message">
          Preview unavailable for this URL.
        </div>
      )}
    </div>
  );
}

function TooltipContent({
  text,
  linkPreviewsEnabled,
}: {
  text: string;
  linkPreviewsEnabled: boolean;
}): React.ReactElement {
  const [preview, setPreview] = useState<LinkPreviewState | null>(null);
  const previewDismissTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPreviewDismissTimer = useCallback(() => {
    if (previewDismissTimer.current) {
      clearTimeout(previewDismissTimer.current);
      previewDismissTimer.current = null;
    }
  }, []);

  const schedulePreviewDismiss = useCallback(() => {
    clearPreviewDismissTimer();
    previewDismissTimer.current = setTimeout(() => {
      previewDismissTimer.current = null;
      setPreview(null);
    }, 200);
  }, [clearPreviewDismissTimer]);

  useEffect(() => {
    if (!linkPreviewsEnabled) setPreview(null);
  }, [linkPreviewsEnabled]);

  useEffect(() => () => clearPreviewDismissTimer(), [clearPreviewDismissTimer]);

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const url = match[0];
    const previewTarget = getEnabledLinkPreviewTarget(url, linkPreviewsEnabled);
    const showPreview = (element: HTMLAnchorElement) => {
      if (!previewTarget) return;
      clearPreviewDismissTimer();
      const rect = element.getBoundingClientRect();
      setPreview({ ...previewTarget, ...getLinkPreviewPosition(rect) });
    };
    parts.push(
      <a
        key={match.index}
        className="dg-tooltip-link"
        href="#"
        onMouseEnter={(event) => showPreview(event.currentTarget)}
        onMouseLeave={schedulePreviewDismiss}
        onFocus={(event) => showPreview(event.currentTarget)}
        onBlur={schedulePreviewDismiss}
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
  return (
    <>
      {parts}
      {linkPreviewsEnabled && preview && createPortal(
        <LinkPreviewCard
          preview={preview}
          onMouseEnter={clearPreviewDismissTimer}
          onMouseLeave={schedulePreviewDismiss}
          onFocus={clearPreviewDismissTimer}
          onBlur={schedulePreviewDismiss}
        />,
        document.body
      )}
    </>
  );
}
