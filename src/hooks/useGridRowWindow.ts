import { RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { boundedRowWindow, clampGridRow, rowWindowContaining, rowWindowNearEdge, rowWindowScrollOffset } from "../utils/gridRowWindow";

interface PendingScroll {
  context: string;
  base: number;
  row: number;
  /** Anchors retain the partial row offset; navigation instead reveals the entire row. */
  fraction?: number;
  waitForRows?: boolean;
}

interface ViewportSnapshot {
  context: string;
  base: number;
  totalRows: number;
  rowHeight: number;
  scrollTop: number;
}

/** Logical row numbers never become DOM offsets for the entire dataset. */
export function useGridRowWindow(totalRows: number, rowHeight: number, context: string, scrollRef: RefObject<HTMLDivElement>) {
  const [windowState, setWindowState] = useState({ context, base: 0 });
  const window = boundedRowWindow(totalRows, windowState.context === context ? windowState.base : 0);
  const pendingScroll = useRef<PendingScroll | null>(null);
  const previousViewport = useRef<ViewportSnapshot | null>(null);
  // Recalculate fixed-size measurements when row height changes; keys stay logical.
  const getItemKey = useCallback((index: number) => window.base + index, [window.base, rowHeight]);
  const virtualizer = useVirtualizer({
    count: window.count,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => rowHeight,
    overscan: 20,
  });

  const scrollToLogicalRow = useCallback((row: number) => {
    // Find may finish before the separate count query. Keep its logical target
    // until rows become available, rather than clamping a late match to row zero.
    const target = totalRows > 0 ? clampGridRow(row, totalRows) : Math.max(0, Math.floor(row));
    const next = rowWindowContaining(totalRows, target, window.base);
    pendingScroll.current = { context, base: next.base, row: target, waitForRows: totalRows === 0 };
    // Even an in-window seek is applied after the new render. This also supersedes
    // an earlier queued seek without scrolling against the earlier window.
    setWindowState({ context, base: next.base });
  }, [context, totalRows, window.base]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const previous = previousViewport.current;
    const saveViewport = () => {
      previousViewport.current = { context, base: window.base, totalRows, rowHeight, scrollTop: element.scrollTop };
      // Persist a count clamp so a later growth cannot resurrect an obsolete base.
      if (windowState.context !== context || windowState.base !== window.base) setWindowState({ context, base: window.base });
    };
    const applyScroll = (pending: PendingScroll) => {
      const offset = pending.fraction === undefined
        ? rowWindowScrollOffset(window, pending.row, rowHeight, element.scrollTop, element.clientHeight, element.querySelector<HTMLElement>(".dg-header")?.offsetHeight ?? 0)
        : (pending.row - window.base + pending.fraction) * rowHeight;
      virtualizer.scrollToOffset(offset);
      saveViewport();
    };

    if (!previous || previous.context !== context) {
      pendingScroll.current = null;
      virtualizer.scrollToOffset(0);
      saveViewport();
      return;
    }

    const pending = pendingScroll.current;
    if (pending) {
      if (pending.context === context && pending.waitForRows && totalRows === 0) {
        saveViewport();
        return;
      }
      pendingScroll.current = null;
      if (pending.context === context) {
        // A new count may have clamped a queued window before it was committed.
        const row = clampGridRow(pending.row, totalRows);
        const next = rowWindowContaining(totalRows, row, window.base);
        if (next.base !== window.base) {
          pendingScroll.current = { ...pending, row, base: next.base, waitForRows: false };
          setWindowState({ context, base: next.base });
          return;
        }
        applyScroll({ ...pending, row });
        return;
      }
    }

    if (previous.rowHeight !== rowHeight || previous.totalRows !== totalRows || previous.base !== window.base) {
      // Read the saved offset: DOM height changes can clamp scrollTop during commit.
      const previousLocalRow = Math.floor(previous.scrollTop / previous.rowHeight);
      const row = clampGridRow(previous.base + previousLocalRow, totalRows);
      const fraction = (previous.scrollTop % previous.rowHeight) / previous.rowHeight;
      const next = rowWindowContaining(totalRows, row, window.base);
      const anchor = { context, base: next.base, row, fraction };
      if (next.base !== window.base) {
        pendingScroll.current = anchor;
        setWindowState({ context, base: next.base });
      } else {
        applyScroll(anchor);
      }
      return;
    }

    const localRow = Math.floor(element.scrollTop / rowHeight);
    const row = clampGridRow(window.base + localRow, totalRows);
    const next = rowWindowNearEdge(totalRows, window.base, row, Math.ceil(element.clientHeight / rowHeight));
    if (next.base !== window.base) {
      pendingScroll.current = { context, base: next.base, row, fraction: (element.scrollTop % rowHeight) / rowHeight };
      setWindowState({ context, base: next.base });
      return;
    }
    saveViewport();
  });

  return {
    virtualizer,
    windowBase: window.base,
    scrollToLogicalRow,
    virtualRows: virtualizer.getVirtualItems().map(item => ({ ...item, index: window.base + item.index })),
  };
}
