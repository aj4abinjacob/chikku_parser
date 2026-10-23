/** Keep physical scroll height below WebKit's limit, including the largest wrapped rows. */
export const GRID_ROW_WINDOW_SIZE = 100_000;
const WINDOW_EDGE_ROWS = 1_000;

export interface GridRowWindow {
  base: number;
  count: number;
}

export function clampGridRow(row: number, totalRows: number): number {
  return Math.max(0, Math.min(Math.floor(row), Math.max(0, totalRows - 1)));
}

export function boundedRowWindow(totalRows: number, requestedBase = 0): GridRowWindow {
  const count = Math.max(0, Math.min(GRID_ROW_WINDOW_SIZE, Math.floor(totalRows)));
  const base = Math.max(0, Math.min(Math.floor(requestedBase), Math.max(0, totalRows - count)));
  return { base, count };
}

/** Existing windows remain stable; distant seeks put the logical row near the middle. */
export function rowWindowContaining(totalRows: number, row: number, requestedBase = 0): GridRowWindow {
  const window = boundedRowWindow(totalRows, requestedBase);
  const target = clampGridRow(row, totalRows);
  if (target >= window.base && target < window.base + window.count) return window;
  return boundedRowWindow(totalRows, target - Math.floor(GRID_ROW_WINDOW_SIZE / 2));
}

/** Rebase before reaching a seam, leaving room to keep scrolling in either direction. */
export function rowWindowNearEdge(totalRows: number, base: number, firstVisibleRow: number, visibleRows: number): GridRowWindow {
  const window = boundedRowWindow(totalRows, base);
  const localRow = clampGridRow(firstVisibleRow, totalRows) - window.base;
  const nearStart = window.base > 0 && localRow < WINDOW_EDGE_ROWS;
  const nearEnd = window.base + window.count < totalRows && localRow + visibleRows >= window.count - WINDOW_EDGE_ROWS;
  return nearStart || nearEnd
    ? boundedRowWindow(totalRows, firstVisibleRow - Math.floor(GRID_ROW_WINDOW_SIZE / 2))
    : window;
}

/** Sticky headers take space from the viewport, rather than covering the sought cell. */
export function rowWindowScrollOffset(window: GridRowWindow, row: number, rowHeight: number, scrollTop: number, viewportHeight: number, headerHeight: number): number {
  const rowStart = (row - window.base) * rowHeight;
  const availableHeight = Math.max(rowHeight, viewportHeight - headerHeight);
  if (rowStart < scrollTop) return Math.max(0, rowStart);
  if (rowStart + rowHeight > scrollTop + availableHeight) return Math.max(0, rowStart + rowHeight - availableHeight);
  return scrollTop;
}
