import React, { useState, useEffect, useMemo } from "react";
import {
  Alert,
  Button,
  Checkbox,
  Icon,
  Intent,
} from "@blueprintjs/core";
import { Popover2, PopupKind, Tooltip2 } from "@blueprintjs/popover2";
import { LoadedTable, ColumnInfo, SortColumn, PivotViewConfig, DocumentWorkspaceFileActions, DatasetOverview, ColumnStatsTopValue } from "../types";
import { SearchInput } from "./SearchInput";
import { DatasetOverviewPanel } from "./DatasetOverviewPanel";

interface SidebarProps {
  tables: LoadedTable[];
  activeTable: string | null;
  schema: ColumnInfo[];
  visibleColumns: string[];
  columnOrder: string[];
  sortColumns: SortColumn[];
  onSelectTable: (tableName: string) => void;
  onToggleColumn: (colName: string) => void;
  onSetVisibleColumns: (cols: string[]) => void;
  onReorderColumns: (newOrder: string[]) => void;
  onSort: (column: string, addLevel: boolean) => void;
  onClearSort: () => void;
  pivotConfig: PivotViewConfig | null;
  onPivotGroup: (column: string, addLevel: boolean) => void;
  onClearPivotGroups: () => void;
  onDeleteTable: (tableName: string) => void;
  onCombine: (selectedNames: string[]) => void;
  onOpenFiles: () => void;
  onOpenHelp: () => void;
  onHide: () => void;
  onGetDatasetOverview: () => Promise<DatasetOverview>;
  onGetOverviewTopValues: (column: string) => Promise<ColumnStatsTopValue[]>;
  jsonWorkspaceActive?: boolean;
  markdownWorkspaceActive?: boolean;
  pdfWorkspaceActive?: boolean;
  documentFileActions?: DocumentWorkspaceFileActions | null;
  onPdfNavigationHostChange?: (host: HTMLDivElement | null) => void;
}

interface FileContextMenuState {
  table: LoadedTable;
  x: number;
  y: number;
}

type FileListIcon = {
  icon: "array" | "document" | "panel-table" | "th-derived";
  className: string;
};

const FILE_CONTEXT_MENU_WIDTH = 168;
const FILE_CONTEXT_MENU_HEIGHT = 36;
const FILE_CONTEXT_MENU_MARGIN = 8;
const FILE_PATH_HOVER_DELAY = 700;

function getFileExtension(filePath: string): string {
  return filePath.split(".").pop()?.toLowerCase() || "";
}

function isJsonTable(table: LoadedTable): boolean {
  const extension = getFileExtension(table.filePath);
  return extension === "json" || extension === "jsonl" || extension === "ndjson";
}

function isMarkdownTable(table: LoadedTable): boolean {
  const extension = getFileExtension(table.filePath);
  return extension === "md" || extension === "markdown";
}

function isPdfTable(table: LoadedTable): boolean {
  return getFileExtension(table.filePath) === "pdf";
}

function isDocumentWorkspaceTable(table: LoadedTable): boolean {
  return isJsonTable(table) || isMarkdownTable(table) || isPdfTable(table);
}

function getFileListIcon(table: LoadedTable): FileListIcon {
  if (table.filePath.startsWith("(")) {
    return { icon: "th-derived", className: "table-icon-generated" };
  }

  const extension = getFileExtension(table.filePath);
  if (extension === "json" || extension === "jsonl" || extension === "ndjson") {
    return { icon: "array", className: "table-icon-json" };
  }
  if (extension === "md" || extension === "markdown") {
    return { icon: "document", className: "table-icon-markdown" };
  }
  if (extension === "pdf") {
    return { icon: "document", className: "table-icon-pdf" };
  }

  return { icon: "panel-table", className: "table-icon-tabular" };
}

function getFileMetricLabel(table: LoadedTable): string {
  if (isMarkdownTable(table)) {
    return `${table.rowCount.toLocaleString()} line${table.rowCount === 1 ? "" : "s"}`;
  }
  if (isPdfTable(table)) {
    return table.rowCount > 0
      ? `${table.rowCount.toLocaleString()} page${table.rowCount === 1 ? "" : "s"}`
      : "PDF";
  }
  return `${table.rowCount.toLocaleString()} rows`;
}

function getFileListLabel(table: LoadedTable): string {
  if (!table.filePath.startsWith("(")) {
    const name = table.filePath.split(/[/\\]/).pop() || table.tableName;
    return table.importOptions?.excelSheet ? `${name} · ${table.importOptions.excelSheet}` : name;
  }
  return table.tableName;
}

function FilePathDialog({ table }: { table: LoadedTable }): React.ReactElement {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const copyStatusTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current);
  }, []);

  const copyFilePath = async () => {
    if (copyStatusTimerRef.current) clearTimeout(copyStatusTimerRef.current);
    try {
      await navigator.clipboard.writeText(table.filePath);
      setCopyStatus("copied");
    } catch (err) {
      console.warn("Failed to copy file path:", err);
      setCopyStatus("error");
    }
    copyStatusTimerRef.current = setTimeout(() => {
      setCopyStatus("idle");
      copyStatusTimerRef.current = null;
    }, 1600);
  };

  return (
    <div className="file-path-dialog" role="dialog" aria-label={`Full path for ${table.tableName}`}>
      <div className="file-path-dialog-heading">
        <Icon icon="path" size={13} />
        <span>Full path</span>
      </div>
      <div className="file-path-dialog-path" title={table.filePath}>
        {table.filePath}
      </div>
      <button
        type="button"
        className={`file-path-dialog-copy${copyStatus === "copied" ? " copied" : ""}${copyStatus === "error" ? " error" : ""}`}
        onClick={() => {
          void copyFilePath();
        }}
        aria-live="polite"
      >
        <Icon icon={copyStatus === "copied" ? "tick" : copyStatus === "error" ? "warning-sign" : "clipboard"} size={12} />
        <span>{copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : "Copy path"}</span>
      </button>
    </div>
  );
}

function getDocumentExportDisabledReason(actions: DocumentWorkspaceFileActions): string | null {
  if (actions.canExport ?? actions.canExportCsv) return null;
  if (actions.exportingPdf) return actions.exportDisabledReason ?? "Preparing PDF...";
  if (actions.exporting) return actions.exportDisabledReason ?? "Exporting...";
  if (actions.exportDisabledReason) return actions.exportDisabledReason;
  if (!actions.isValid) {
    return actions.workspaceKind === "json"
      ? "Fix the JSON before exporting CSV."
      : "Fix the document before exporting.";
  }
  if (actions.isTableView === false) return "Switch Parsed view to table to export CSV.";
  return "No flattened table data to export.";
}

export function Sidebar({
  tables,
  activeTable,
  schema,
  visibleColumns,
  columnOrder,
  sortColumns,
  onSelectTable,
  onToggleColumn,
  onSetVisibleColumns,
  onReorderColumns,
  onSort,
  onClearSort,
  pivotConfig,
  onPivotGroup,
  onClearPivotGroups,
  onDeleteTable,
  onCombine,
  onOpenFiles,
  onOpenHelp,
  onHide,
  onGetDatasetOverview,
  onGetOverviewTopValues,
  jsonWorkspaceActive = false,
  markdownWorkspaceActive = false,
  pdfWorkspaceActive = false,
  documentFileActions = null,
  onPdfNavigationHostChange,
}: SidebarProps): React.ReactElement {
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selectedForCombine, setSelectedForCombine] = useState<Set<string>>(new Set());
  const [columnSearch, setColumnSearch] = useState("");
  const [tableSearch, setTableSearch] = useState("");
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [sidebarView, setSidebarView] = useState<"columns" | "overview">("columns");
  const sidebarRef = React.useRef<HTMLDivElement>(null);
  const fileContextMenuRef = React.useRef<HTMLDivElement>(null);

  // Drag-and-drop state
  const dragColumnRef = React.useRef<string | null>(null);
  const dropTargetRef = React.useRef<{ index: number; position: "top" | "bottom" } | null>(null);
  const dragCleanupRef = React.useRef<(() => void) | null>(null);
  const dragGhostRef = React.useRef<HTMLDivElement>(null);
  const columnsScrollRef = React.useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<{ index: number; position: "top" | "bottom" } | null>(null);
  const [draggingColumn, setDraggingColumn] = useState<string | null>(null);
  React.useEffect(() => () => dragCleanupRef.current?.(), []);
  const documentWorkspaceActive = jsonWorkspaceActive || markdownWorkspaceActive || pdfWorkspaceActive;
  const workspaceLabel = pdfWorkspaceActive ? "PDF" : markdownWorkspaceActive ? "Markdown" : "JSON";
  const combinableTables = useMemo(() => tables.filter((table) => !isDocumentWorkspaceTable(table)), [tables]);
  const activeLoadedTable = useMemo(
    () => tables.find((table) => table.tableName === activeTable) ?? null,
    [activeTable, tables]
  );
  const combinableTableNames = useMemo(
    () => new Set(combinableTables.map((table) => table.tableName)),
    [combinableTables]
  );

  // Clean up stale or non-combinable selections when tables change
  useEffect(() => {
    setSelectedForCombine((prev) => {
      const cleaned = new Set([...prev].filter((n) => combinableTableNames.has(n)));
      return cleaned.size === prev.size ? prev : cleaned;
    });
  }, [combinableTableNames]);

  // Clear search when active table changes
  useEffect(() => {
    setColumnSearch("");
  }, [activeTable]);

  useEffect(() => {
    if (documentWorkspaceActive || !activeTable) setSidebarView("columns");
  }, [activeTable, documentWorkspaceActive]);

  // Filter tables by search
  const filteredTables = useMemo(() => {
    if (!tableSearch.trim()) return tables;
    const q = tableSearch.toLowerCase();
    return tables.filter((t) => getFileListLabel(t).toLowerCase().includes(q) || t.tableName.toLowerCase().includes(q));
  }, [tables, tableSearch]);

  const toggleCombineSelection = (tableName: string) => {
    if (documentWorkspaceActive) return;
    if (!combinableTableNames.has(tableName)) return;

    setSelectedForCombine((prev) => {
      const next = new Set(prev);
      if (next.has(tableName)) next.delete(tableName);
      else next.add(tableName);
      return next;
    });
  };

  const selectAllTablesForCombine = () => {
    setSelectedForCombine(new Set(combinableTables.map((t) => t.tableName)));
  };

  const deselectAllTablesForCombine = () => {
    setSelectedForCombine(new Set());
  };

  const openFileContextMenu = (event: React.MouseEvent<HTMLDivElement>, table: LoadedTable) => {
    event.preventDefault();
    event.stopPropagation();

    const rect = sidebarRef.current?.getBoundingClientRect();
    const left = rect?.left ?? 0;
    const top = rect?.top ?? 0;
    const width = rect?.width ?? window.innerWidth;
    const height = rect?.height ?? window.innerHeight;
    const rowRect = event.currentTarget.getBoundingClientRect();
    const maxX = Math.max(FILE_CONTEXT_MENU_MARGIN, width - FILE_CONTEXT_MENU_WIDTH - FILE_CONTEXT_MENU_MARGIN);
    const maxY = Math.max(FILE_CONTEXT_MENU_MARGIN, height - FILE_CONTEXT_MENU_HEIGHT - FILE_CONTEXT_MENU_MARGIN);
    const x = Math.max(
      FILE_CONTEXT_MENU_MARGIN,
      Math.min(event.clientX - left, maxX)
    );
    const y = Math.max(
      FILE_CONTEXT_MENU_MARGIN,
      Math.min(rowRect.bottom - top + 4, maxY)
    );

    setFileContextMenu({ table, x, y });
  };

  const copyContextFilePath = async () => {
    if (!fileContextMenu || fileContextMenu.table.filePath.startsWith("(")) return;

    try {
      await navigator.clipboard.writeText(fileContextMenu.table.filePath);
    } catch (err) {
      console.warn("Failed to copy file path:", err);
    } finally {
      setFileContextMenu(null);
    }
  };

  useEffect(() => {
    if (!fileContextMenu) return;

    const isInsideMenu = (target: EventTarget | null): boolean => {
      return target instanceof Node && !!fileContextMenuRef.current?.contains(target);
    };

    const handlePointerDown = (event: PointerEvent) => {
      if (isInsideMenu(event.target)) return;
      setFileContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFileContextMenu(null);
    };
    const closeMenu = () => setFileContextMenu(null);

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", closeMenu);
    window.addEventListener("scroll", closeMenu, true);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", closeMenu);
      window.removeEventListener("scroll", closeMenu, true);
    };
  }, [fileContextMenu]);

  // Use columnOrder if available, otherwise fall back to schema order
  const orderedColumns = columnOrder.length > 0
    ? columnOrder.map((name) => schema.find((c) => c.column_name === name)).filter(Boolean) as ColumnInfo[]
    : schema;

  // Filter columns by search
  const filteredColumns = useMemo(() => {
    if (!columnSearch.trim()) return orderedColumns;
    const q = columnSearch.toLowerCase();
    return orderedColumns.filter((col) => col.column_name.toLowerCase().includes(q));
  }, [orderedColumns, columnSearch]);

  // Build a sort index map for quick lookup
  const sortIndexMap = useMemo(() => {
    const map = new Map<string, { index: number; direction: "ASC" | "DESC" }>();
    sortColumns.forEach((sc, i) => map.set(sc.column, { index: i + 1, direction: sc.direction }));
    return map;
  }, [sortColumns]);

  // Build a pivot group index map
  const pivotGroupIndexMap = useMemo(() => {
    const map = new Map<string, { index: number; direction: "ASC" | "DESC" }>();
    const groups = pivotConfig?.groupColumns ?? [];
    groups.forEach((gc, i) => map.set(gc.column, { index: i + 1, direction: gc.direction }));
    return map;
  }, [pivotConfig]);

  // Column reorder uses pointer events (not HTML5 drag-and-drop): under Tauri
  // the OS-level drag-drop handler swallows the webview's native drop events,
  // so HTML5 DnD never lands. Mirrors DataGrid's header reorder.
  const handleColumnPointerDown = (e: React.PointerEvent, column: string, fromHandle = false) => {
    if (
      e.button !== 0 ||
      (!fromHandle && (e.target as HTMLElement).closest(
        ".column-visibility-checkbox, .column-pivot-indicator, .column-sort-indicator, input, button"
      ))
    ) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    dragCleanupRef.current?.();
    dragColumnRef.current = column;
    setDraggingColumn(column);
    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    e.currentTarget.setPointerCapture(e.pointerId);

    let lastX = 0;
    let lastY = 0;
    let autoScrollRaf: number | null = null;
    const EDGE = 40; // px hot zone at top/bottom edge
    const MAX_SPEED = 14; // px per frame at the edge

    const setCurrentDropTarget = (
      next: { index: number; position: "top" | "bottom" } | null
    ) => {
      dropTargetRef.current = next;
      setDropTarget((prev) =>
        prev?.index === next?.index && prev?.position === next?.position ? prev : next
      );
    };

    const updateDropTarget = (clientX: number, clientY: number) => {
      const el = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-sidebar-column]");
      const targetColumn = el?.dataset.sidebarColumn;
      if (!el || !targetColumn || targetColumn === dragColumnRef.current) {
        setCurrentDropTarget(null);
        return;
      }
      const index = Number(el.dataset.sidebarColumnIndex);
      if (Number.isNaN(index)) {
        setCurrentDropTarget(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      setCurrentDropTarget({ index, position: clientY < midY ? "top" : "bottom" });
    };

    const autoScrollStep = () => {
      autoScrollRaf = null;
      const sc = columnsScrollRef.current;
      if (!sc || dragColumnRef.current === null) return;
      const rect = sc.getBoundingClientRect();
      let dy = 0;
      if (lastY < rect.top + EDGE) {
        dy = -Math.max(1, Math.round(((rect.top + EDGE - lastY) / EDGE) * MAX_SPEED));
      } else if (lastY > rect.bottom - EDGE) {
        dy = Math.max(1, Math.round(((lastY - (rect.bottom - EDGE)) / EDGE) * MAX_SPEED));
      }
      if (dy === 0) return;
      const before = sc.scrollTop;
      sc.scrollTop = before + dy;
      if (sc.scrollTop !== before) updateDropTarget(lastX, lastY);
      autoScrollRaf = requestAnimationFrame(autoScrollStep);
    };

    const maybeStartAutoScroll = () => {
      const sc = columnsScrollRef.current;
      if (!sc || autoScrollRaf !== null) return;
      const rect = sc.getBoundingClientRect();
      if (lastY < rect.top + EDGE || lastY > rect.bottom - EDGE) {
        autoScrollRaf = requestAnimationFrame(autoScrollStep);
      }
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (event.pointerId !== e.pointerId) return;
      event.preventDefault();
      lastX = event.clientX;
      lastY = event.clientY;
      if (dragGhostRef.current) {
        dragGhostRef.current.style.transform = `translate(${lastX + 14}px, ${lastY + 8}px)`;
        dragGhostRef.current.style.opacity = "1";
      }
      updateDropTarget(lastX, lastY);
      maybeStartAutoScroll();
    };

    const cleanup = () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerCancel);
      if (autoScrollRaf !== null) cancelAnimationFrame(autoScrollRaf);
      autoScrollRaf = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      dragColumnRef.current = null;
      dropTargetRef.current = null;
      dragCleanupRef.current = null;
      setDropTarget(null);
      setDraggingColumn(null);
    };

    const handlePointerUp = (event: PointerEvent) => {
      if (event.pointerId !== e.pointerId) return;
      const draggedColumn = dragColumnRef.current;
      const target = dropTargetRef.current;
      cleanup();
      if (!draggedColumn || !target) return;
      const targetColumn = filteredColumns[target.index]?.column_name;
      if (!targetColumn) return;

      const newOrder = [...orderedColumns.map((c) => c.column_name)];
      const fromIndex = newOrder.indexOf(draggedColumn);
      if (fromIndex < 0) return;
      const [moved] = newOrder.splice(fromIndex, 1);
      let toIndex = newOrder.indexOf(targetColumn);
      if (toIndex < 0) return;
      if (target.position === "bottom") toIndex++;
      newOrder.splice(toIndex, 0, moved);
      onReorderColumns(newOrder);
    };

    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId === e.pointerId) cleanup();
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerCancel);
    dragCleanupRef.current = cleanup;
  };

  const allColumnNames = orderedColumns.map((c) => c.column_name);
  const allVisible = visibleColumns.length === allColumnNames.length;
  const noneVisible = visibleColumns.length === 0;
  const visibleColumnCount = visibleColumns.length;
  const activeWorkspaceKind = pdfWorkspaceActive ? "pdf" : markdownWorkspaceActive ? "markdown" : jsonWorkspaceActive ? "json" : null;
  const activeDocumentFileActions = documentFileActions?.workspaceKind === activeWorkspaceKind
    ? documentFileActions
    : null;
  const documentExportAction = activeDocumentFileActions?.onExport ?? activeDocumentFileActions?.onExportCsv ?? null;
  const documentPdfAction = activeDocumentFileActions?.onExportPdf ?? null;
  const documentImagesAction = activeDocumentFileActions?.onExportImages ?? null;
  const documentCanExport = activeDocumentFileActions
    ? activeDocumentFileActions.canExport ?? activeDocumentFileActions.canExportCsv ?? false
    : false;
  const documentCanExportPdf = activeDocumentFileActions
    ? activeDocumentFileActions.canExportPdf ?? activeDocumentFileActions.isValid
    : false;
  const documentCanExportImages = activeDocumentFileActions?.canExportImages ?? false;
  const exportDisabledReason = activeDocumentFileActions
    ? getDocumentExportDisabledReason(activeDocumentFileActions)
    : null;
  const exportPdfDisabledReason = activeDocumentFileActions
    ? activeDocumentFileActions.exportPdfDisabledReason
      ?? (activeDocumentFileActions.exportingPdf ? "Preparing PDF..." : null)
      ?? (!documentCanExportPdf ? "PDF export is unavailable." : null)
    : null;
  const exportImagesDisabledReason = activeDocumentFileActions
    ? activeDocumentFileActions.exportImagesDisabledReason
      ?? (activeDocumentFileActions.exportingImages ? "Exporting images..." : null)
      ?? (!documentCanExportImages ? "Image export is unavailable." : null)
    : null;
  const combineSelectionDisabledReason = documentWorkspaceActive
    ? `Combine selection is unavailable in ${workspaceLabel} view.`
    : null;
  const combineDisabledReason = documentWorkspaceActive
    ? `Combine is unavailable in ${workspaceLabel} view. Switch to a tabular file to combine data files.`
    : combinableTables.length < 2
      ? "Open at least two tabular files to combine."
      : selectedForCombine.size < 2
        ? "Select at least two tabular files to combine."
        : null;
  const selectAllForCombineDisabled = !!combineSelectionDisabledReason
    || selectedForCombine.size === combinableTables.length;
  const deselectAllForCombineDisabled = !!combineSelectionDisabledReason
    || selectedForCombine.size === 0;

  return (
    <div ref={sidebarRef} className={`sidebar${documentWorkspaceActive ? " sidebar-document" : ""}${jsonWorkspaceActive ? " sidebar-json" : ""}${pdfWorkspaceActive ? " sidebar-pdf" : ""}`}>
      {draggingColumn && (
        <div ref={dragGhostRef} className="column-drag-ghost">
          <Icon icon="drag-handle-vertical" size={10} />
          <span>{draggingColumn}</span>
        </div>
      )}
      {/* Loaded files */}
      <div className="sidebar-section sidebar-section-tables">
        <div className="sidebar-section-header">
          <div className="sidebar-heading-block">
            <h4>Files</h4>
            <span className="sidebar-count">{tables.length}</span>
          </div>
          <div className="table-header-actions">
            <Button icon="folder-open" text="Open files" minimal small onClick={onOpenFiles} />
            <Button
              icon="help"
              minimal
              small
              onClick={onOpenHelp}
              title="Open Help Center (F1)"
              aria-label="Open Help Center"
            />
            <Button
              icon="chevron-left"
              minimal
              small
              onClick={onHide}
              title="Hide sidebar"
              aria-label="Hide sidebar"
              className="sidebar-hide-btn"
            />
          </div>
        </div>
        {tables.length > 8 && (
          <div className="table-search">
            <SearchInput
              placeholder="Search files..."
              value={tableSearch}
              onChange={setTableSearch}
              small
            />
          </div>
        )}
        {tables.length === 0 && (
          <div className="sidebar-empty sidebar-empty-action">
            <span>No files loaded</span>
            <Button
              icon="folder-open"
              text="Open files"
              small
              onClick={onOpenFiles}
            />
          </div>
        )}
        {tables.length > 0 && filteredTables.length === 0 && (
          <div className="sidebar-empty">No matching files</div>
        )}
        {filteredTables.map((t) => {
          const fileIcon = getFileListIcon(t);
          const fileLabel = getFileListLabel(t);
          const canCombineTable = combinableTableNames.has(t.tableName);
          const rowCombineSelectionDisabledReason = documentWorkspaceActive
            ? `Combine selection is unavailable in ${workspaceLabel} view.`
            : canCombineTable
              ? null
              : "Document workspace files cannot be selected for combine.";
          const combineCheckbox = (
            <Checkbox
              checked={selectedForCombine.has(t.tableName)}
              onChange={() => toggleCombineSelection(t.tableName)}
              className="table-combine-checkbox"
              aria-label={`Select ${fileLabel} for combine`}
              disabled={!!rowCombineSelectionDisabledReason}
            />
          );

          return (
            <Popover2
              key={t.tableName}
              content={<FilePathDialog table={t} />}
              disabled={t.filePath.startsWith("(")}
              interactionKind="hover"
              hoverOpenDelay={FILE_PATH_HOVER_DELAY}
              hoverCloseDelay={200}
              placement="right-start"
              popupKind={PopupKind.DIALOG}
              popoverClassName="file-path-popover"
              renderTarget={({ isOpen: _isOpen, ref, ...targetProps }) => (
                <div
                  {...targetProps}
                  ref={ref}
                  className={`table-list-item${t.tableName === activeTable ? " active" : ""}${selectedForCombine.has(t.tableName) ? " selected" : ""}${targetProps.className ? ` ${targetProps.className}` : ""}`}
                  onContextMenu={(event) => {
                    openFileContextMenu(event, t);
                    targetProps.onContextMenu?.(event);
                  }}
                >
                  {tables.length >= 2 && (
                    rowCombineSelectionDisabledReason ? (
                      <Tooltip2
                        content={rowCombineSelectionDisabledReason}
                        placement="top"
                        minimal
                        compact
                      >
                        <span className="table-combine-checkbox-tooltip">
                          {combineCheckbox}
                        </span>
                      </Tooltip2>
                    ) : combineCheckbox
                  )}
                  <button
                    type="button"
                    aria-pressed={t.tableName === activeTable}
                    aria-label={`Open ${fileLabel}`}
                    className="table-main"
                    onClick={() => onSelectTable(t.tableName)}
                    title={t.filePath.startsWith("(") ? fileLabel : undefined}
                  >
                    <span className={`table-icon ${fileIcon.className}`}>
                      <Icon icon={fileIcon.icon} size={12} />
                    </span>
                    <span className="table-text">
                      <span className="table-name">{fileLabel}</span>
                      <span className="row-count">
                        {getFileMetricLabel(t)}
                      </span>
                    </span>
                  </button>
                  <Button
                    aria-label={`Remove ${fileLabel} from session`}
                    title={`Remove ${fileLabel} from session`}
                    icon="cross"
                    minimal
                    small
                    className="table-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(t.tableName);
                    }}
                  />
                </div>
              )}
            />
          );
        })}
      </div>

      {/* Combine button */}
      {tables.length >= 2 && (
        <div className="sidebar-section sidebar-combine-bar">
          <div className="combine-meta">
            <span className="combine-title">Combine</span>
            <span className="combine-count">{selectedForCombine.size} selected</span>
          </div>
          <div className="combine-select-actions">
            <Tooltip2
              content={combineSelectionDisabledReason ?? "Select all tabular files"}
              disabled={!combineSelectionDisabledReason}
              placement="top"
              minimal
              compact
            >
              <span className="combine-select-action-tooltip">
                <Button
                  minimal
                  small
                  text="All"
                  title="Select all files for combine"
                  disabled={selectAllForCombineDisabled}
                  onClick={selectAllTablesForCombine}
                />
              </span>
            </Tooltip2>
            <Tooltip2
              content={combineSelectionDisabledReason ?? "Deselect all files"}
              disabled={!combineSelectionDisabledReason}
              placement="top"
              minimal
              compact
            >
              <span className="combine-select-action-tooltip">
                <Button
                  minimal
                  small
                  text="None"
                  title="Deselect all files"
                  disabled={deselectAllForCombineDisabled}
                  onClick={deselectAllTablesForCombine}
                />
              </span>
            </Tooltip2>
          </div>
          <Tooltip2
            content={combineDisabledReason ?? "Combine selected files"}
            disabled={!combineDisabledReason}
            placement="top"
            minimal
            compact
          >
            <span className="sidebar-combine-action-tooltip">
              <Button
                intent={Intent.PRIMARY}
                icon="merge-columns"
                text="Combine"
                onClick={() => onCombine([...selectedForCombine])}
                small
                fill
                disabled={!!combineDisabledReason}
              />
            </span>
          </Tooltip2>
        </div>
      )}

      {pdfWorkspaceActive && (
        <div
          ref={onPdfNavigationHostChange}
          className="sidebar-pdf-navigation"
        />
      )}

      {!documentWorkspaceActive && activeTable && schema.length > 0 && (
        <div
          className="sidebar-view-switch"
          role="tablist"
          aria-label="Sidebar view"
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "columns" : event.key === "End" ? "overview" : sidebarView === "columns" ? "overview" : "columns";
            setSidebarView(next);
            event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next === "columns" ? 0 : 1]?.focus();
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={sidebarView === "columns"}
            tabIndex={sidebarView === "columns" ? 0 : -1}
            className={sidebarView === "columns" ? "active" : ""}
            onClick={() => setSidebarView("columns")}
          >
            <Icon icon="column-layout" size={12} />
            <span>Columns</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sidebarView === "overview"}
            tabIndex={sidebarView === "overview" ? 0 : -1}
            className={sidebarView === "overview" ? "active" : ""}
            onClick={() => setSidebarView("overview")}
          >
            <Icon icon="grouped-bar-chart" size={12} />
            <span>Summary</span>
          </button>
        </div>
      )}

      {documentWorkspaceActive && activeDocumentFileActions && (
        <div className={`sidebar-section sidebar-file-actions sidebar-file-actions-${activeDocumentFileActions.workspaceKind}`}>
          <div className="sidebar-section-header">
            <div className="sidebar-heading-block">
              <h4>File Options</h4>
              {activeDocumentFileActions.isDirty && (
                <span className="sidebar-dirty-dot" title="Unsaved changes" />
              )}
            </div>
            <span className={`sidebar-file-state${activeDocumentFileActions.isDirty ? " is-dirty" : ""}`}>
              {activeDocumentFileActions.isDirty ? "Unsaved" : "Saved"}
            </span>
          </div>
          <div className="sidebar-file-action-grid">
            <Button
              icon="folder-open"
              text={activeDocumentFileActions.workspaceKind === "pdf" ? "Open file" : "Open"}
              title={activeDocumentFileActions.workspaceKind === "pdf" ? "Open another file" : undefined}
              onClick={activeDocumentFileActions.onOpenFiles}
              small
            />
            {activeDocumentFileActions.onSave && (
              <Button
                icon="floppy-disk"
                text={activeDocumentFileActions.saveLabel ?? "Save"}
                title={activeDocumentFileActions.saveTitle}
                intent={Intent.PRIMARY}
                onClick={activeDocumentFileActions.onSave}
                disabled={!activeDocumentFileActions.isDirty || !activeDocumentFileActions.isValid || activeDocumentFileActions.saving}
                loading={activeDocumentFileActions.saving}
                small
              />
            )}
            {activeDocumentFileActions.onSaveAs && (
              <Button
                icon="download"
                text="Save As"
                onClick={activeDocumentFileActions.onSaveAs}
                disabled={!activeDocumentFileActions.isValid || activeDocumentFileActions.saving}
                small
              />
            )}
            {activeDocumentFileActions.onToggleHistory && (
              <Button
                icon="history"
                text="History"
                active={activeDocumentFileActions.historyOpen}
                onClick={activeDocumentFileActions.onToggleHistory}
                small
              />
            )}
            {documentExportAction && (
              <Tooltip2
                content={exportDisabledReason ?? activeDocumentFileActions.exportTitle ?? "Export"}
                disabled={!exportDisabledReason}
                placement="top"
                minimal
              >
                <span className="sidebar-file-action-tooltip">
                  <Button
                    icon="export"
                    text={activeDocumentFileActions.exportLabel ?? "Export CSV"}
                    onClick={documentExportAction}
                    disabled={!documentCanExport}
                    loading={!!activeDocumentFileActions.exporting}
                    small
                    fill
                  />
                </span>
              </Tooltip2>
            )}
            {documentPdfAction && (
              <Tooltip2
                content={exportPdfDisabledReason ?? activeDocumentFileActions.exportPdfTitle ?? "Export PDF"}
                disabled={!exportPdfDisabledReason}
                placement="top"
                minimal
              >
                <span className="sidebar-file-action-tooltip">
                  <Button
                    icon="print"
                    text={activeDocumentFileActions.exportPdfLabel ?? "PDF"}
                    onClick={documentPdfAction}
                    disabled={!documentCanExportPdf}
                    loading={!!activeDocumentFileActions.exportingPdf}
                    small
                    fill
                  />
                </span>
              </Tooltip2>
            )}
            {documentImagesAction && (
              <Tooltip2
                content={exportImagesDisabledReason ?? activeDocumentFileActions.exportImagesTitle ?? "Export images"}
                disabled={!exportImagesDisabledReason}
                placement="top"
                minimal
              >
                <span className="sidebar-file-action-tooltip">
                  <Button
                    icon="media"
                    text={activeDocumentFileActions.exportImagesLabel ?? "Images"}
                    onClick={documentImagesAction}
                    disabled={!documentCanExportImages}
                    loading={!!activeDocumentFileActions.exportingImages}
                    small
                    fill
                  />
                </span>
              </Tooltip2>
            )}
            {activeDocumentFileActions.onCompare && (
              <Button
                icon="comparison"
                text="Compare"
                onClick={activeDocumentFileActions.onCompare}
                disabled={activeDocumentFileActions.canCompare === false}
                title={activeDocumentFileActions.compareTitle ?? (activeDocumentFileActions.canCompare ? "Compare with another loaded JSON" : "Open another JSON file to compare")}
                small
              />
            )}
            {activeDocumentFileActions.onToggleEdit && (
              <Button
                icon={activeDocumentFileActions.editActive ? "tick" : "edit"}
                text={activeDocumentFileActions.editLabel ?? (activeDocumentFileActions.editActive ? "Done" : "Edit")}
                intent={activeDocumentFileActions.editActive ? undefined : Intent.PRIMARY}
                onClick={activeDocumentFileActions.onToggleEdit}
                small
              />
            )}
          </div>
        </div>
      )}

      {/* Column visibility */}
      {!documentWorkspaceActive && schema.length > 0 && sidebarView === "columns" && (
        <div className="sidebar-section sidebar-section-columns" ref={columnsScrollRef}>
          <div className="column-header-row">
            <div className="sidebar-heading-block">
              <h4>Columns</h4>
              <span className="sidebar-count">{visibleColumnCount}/{allColumnNames.length}</span>
            </div>
            <div className="column-header-actions">
              <Button
                minimal
                small
                text="All"
                title="Show all columns"
                disabled={allVisible}
                onClick={() => onSetVisibleColumns(allColumnNames)}
                className="column-visibility-btn"
              />
              <Button
                minimal
                small
                text="None"
                title="Hide all columns"
                disabled={noneVisible}
                onClick={() => onSetVisibleColumns([])}
                className="column-visibility-btn"
              />
              {pivotConfig && pivotConfig.groupColumns.length > 0 && (
                <Button
                  minimal
                  small
                  icon="layers"
                  title="Clear all group levels"
                  onClick={onClearPivotGroups}
                  className="column-clear-pivot-btn"
                />
              )}
              {sortColumns.length > 0 && (
                <Button
                  minimal
                  small
                  icon="sort"
                  title="Clear all sorts"
                  onClick={onClearSort}
                  className="column-clear-sort-btn"
                />
              )}
            </div>
          </div>
          {orderedColumns.length > 8 && (
            <div className="column-search">
              <SearchInput
                placeholder="Search columns..."
                value={columnSearch}
                onChange={setColumnSearch}
                small
              />
            </div>
          )}
          {filteredColumns.map((col, index) => {
            const sortInfo = sortIndexMap.get(col.column_name);
            const pivotInfo = pivotGroupIndexMap.get(col.column_name);
            const isVisible = visibleColumns.includes(col.column_name);
            return (
              <div
                key={col.column_name}
                className={`column-item${isVisible ? "" : " column-hidden"}${
                  draggingColumn === col.column_name ? " dragging" : ""
                }${
                  dropTarget?.index === index
                    ? ` drag-over-${dropTarget.position}`
                    : ""
                }`}
                title={`${col.column_name} (${col.column_type})`}
                data-sidebar-column={col.column_name}
                data-sidebar-column-index={index}
                onPointerDown={(e) => handleColumnPointerDown(e, col.column_name)}
              >
                <button
                  type="button"
                  className="drag-handle"
                  aria-label={`Reorder ${col.column_name}. Use Arrow Up or Arrow Down to move the column.`}
                  title="Drag to reorder, or focus and use Arrow Up / Arrow Down"
                  onPointerDown={(e) => handleColumnPointerDown(e, col.column_name, true)}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
                    e.preventDefault();
                    const names = orderedColumns.map((column) => column.column_name);
                    const from = names.indexOf(col.column_name);
                    const to = from + (e.key === "ArrowUp" ? -1 : 1);
                    if (from < 0 || to < 0 || to >= names.length) return;
                    [names[from], names[to]] = [names[to], names[from]];
                    onReorderColumns(names);
                  }}
                >
                  <Icon icon="drag-handle-vertical" size={10} />
                </button>
                <Checkbox
                  checked={isVisible}
                  onChange={() => onToggleColumn(col.column_name)}
                  className="column-visibility-checkbox"
                  aria-label={`Show ${col.column_name}`}
                />
                <span className="column-meta">
                  <span className="column-name-text">{col.column_name}</span>
                  <span className="column-type">{col.column_type}</span>
                </span>
                <span className="column-tools">
                  {/* Group control (left, green) */}
                  <button
                    type="button"
                    aria-pressed={!!pivotInfo}
                    aria-label={`Group by ${col.column_name}${pivotInfo ? `, ${pivotInfo.direction === "ASC" ? "ascending" : "descending"}, level ${pivotInfo.index}` : ""}. Hold Shift to add a level.`}
                    className={`column-pivot-indicator${pivotInfo ? " active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onPivotGroup(col.column_name, e.shiftKey);
                    }}
                    title={
                      pivotInfo
                        ? `Group ${pivotInfo.index}: ${pivotInfo.direction}${pivotConfig?.groupSortMode ? ` (sorted by ${pivotConfig.groupSortMode === "count" ? "count" : "name"} ${pivotConfig.groupSortDirection})` : ""} (click to toggle, shift+click for multi-group)`
                        : "Click to group (shift+click for multi-group)"
                    }
                  >
                    {pivotInfo ? (
                      <>
                        <span className="column-pivot-number">{pivotInfo.index}</span>
                        <Icon icon={pivotInfo.direction === "ASC" ? "chevron-up" : "chevron-down"} size={10} />
                        {pivotConfig?.groupSortMode && (
                          <Icon
                            icon={pivotConfig.groupSortMode === "count" ? "sort-numerical" : "sort-alphabetical"}
                            size={9}
                            className="column-pivot-sort-mode"
                          />
                        )}
                      </>
                    ) : (
                      <Icon icon="layers" size={10} className="column-pivot-idle" />
                    )}
                  </button>
                  {/* Sort control (right, blue) */}
                  <button
                    type="button"
                    aria-pressed={!!sortInfo}
                    aria-label={`Sort by ${col.column_name}${sortInfo ? `, ${sortInfo.direction === "ASC" ? "ascending" : "descending"}, level ${sortInfo.index}` : ""}. Hold Shift to add a level.`}
                    className={`column-sort-indicator${sortInfo ? " active" : ""}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onSort(col.column_name, e.shiftKey);
                    }}
                    title={
                      sortInfo
                        ? `Sort ${sortInfo.index}: ${sortInfo.direction} (click to toggle, shift+click for multi-sort)`
                        : "Click to sort (shift+click for multi-sort)"
                    }
                  >
                    {sortInfo ? (
                      <>
                        <span className="column-sort-number">{sortInfo.index}</span>
                        <Icon icon={sortInfo.direction === "ASC" ? "chevron-up" : "chevron-down"} size={10} />
                      </>
                    ) : (
                      <Icon icon="double-caret-vertical" size={10} className="column-sort-idle" />
                    )}
                  </button>
                </span>
              </div>
            );
          })}
          {orderedColumns.length > 0 && filteredColumns.length === 0 && (
            <div className="sidebar-empty">No matching columns</div>
          )}
        </div>
      )}

      {!documentWorkspaceActive && activeLoadedTable && schema.length > 0 && sidebarView === "overview" && (
        <DatasetOverviewPanel
          table={activeLoadedTable}
          schema={schema}
          onGetOverview={onGetDatasetOverview}
          onGetTopValues={onGetOverviewTopValues}
        />
      )}

      {fileContextMenu && (
        <div
          ref={fileContextMenuRef}
          className="file-context-menu"
          style={{ left: fileContextMenu.x, top: fileContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button
            type="button"
            className="file-context-menu-item"
            disabled={fileContextMenu.table.filePath.startsWith("(")}
            title={fileContextMenu.table.filePath.startsWith("(") ? "No file path available" : "Copy full file path"}
            onClick={() => {
              void copyContextFilePath();
            }}
          >
            <Icon icon="path" size={13} />
            <span>Copy Full Path</span>
          </button>
        </div>
      )}

      <Alert
        isOpen={deleteTarget !== null}
        onConfirm={() => {
          if (deleteTarget) onDeleteTable(deleteTarget);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
        cancelButtonText="Cancel"
        confirmButtonText="Remove"
        intent={Intent.DANGER}
        icon="trash"
      >
        <p>Remove file <strong>{tables.find((table) => table.tableName === deleteTarget) ? getFileListLabel(tables.find((table) => table.tableName === deleteTarget)!) : deleteTarget}</strong>? This will drop it from the current session.</p>
      </Alert>

    </div>
  );
}
