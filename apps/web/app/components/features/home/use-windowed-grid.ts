import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * FE-25 (PRF) — directory-grid windowing.
 *
 * Both home directories map the full brand catalog (~1,134 listings → ~982
 * groups, ADR 032) into a CSS grid. Mounting every cell at once inflates the
 * DOM node count regardless of viewport, which janks first interaction and
 * bloats memory — worst inside the Capacitor native webview (the mobile
 * directory) and on the desktop "All merchants" grid. We window it: only the
 * rows in (or near) the viewport are mounted, with full-width spacer blocks
 * reserving the scroll height above and below so the scrollbar length and every
 * item's scroll position are unchanged.
 *
 * Neither grid is its own scroll container — both sit in the page flow below the
 * hero/quick-buy — so `scrolledPastTop` is derived from the container's
 * viewport-relative top (`-rect.top`, clamped at 0). No windowing library is in
 * the tree; the cells are uniform height and the grids only paint
 * post-hydration (the callers gate on a `hydrated` flag that keeps the list
 * empty on the server and first client render), which keeps the math simple and
 * SSR-safe.
 *
 * FE-25-DESKTOP-GRID: extracted from MobileHome so the desktop grid in
 * routes/home.tsx shares one windowing implementation. The mobile grid is a
 * fixed 2 columns; the desktop grid is responsive (2/3/4 cols across the Tailwind
 * md/lg/xl breakpoints), so `columns` accepts a resolver re-evaluated on resize.
 */

export interface GridWindow {
  /** First item index to mount (inclusive). */
  startIndex: number;
  /** One past the last item index to mount (exclusive). */
  endIndex: number;
  /** Height (px) of the spacer standing in for the un-mounted rows above. */
  topPad: number;
  /** Height (px) of the spacer standing in for the un-mounted rows below. */
  bottomPad: number;
}

/**
 * Pure windowing math (exported for unit tests — jsdom has no layout, so the
 * hook below feeds this measured/estimated numbers rather than pixel scroll).
 * Given the item count and how far the grid's top has scrolled above the
 * viewport top, returns the slice of items to mount plus the spacer heights
 * that preserve the full scroll height. Every item is reachable: as
 * `scrolledPastTop` grows the window advances, and the union of windows across
 * all scroll offsets covers `[0, itemCount)`.
 */
export function computeGridWindow({
  itemCount,
  columns,
  rowHeight,
  viewportHeight,
  scrolledPastTop,
  overscanRows,
}: {
  itemCount: number;
  columns: number;
  rowHeight: number;
  viewportHeight: number;
  /** Distance (px) the grid's top edge has scrolled above the viewport top; 0 while still below the fold. */
  scrolledPastTop: number;
  overscanRows: number;
}): GridWindow {
  if (itemCount <= 0 || rowHeight <= 0 || columns <= 0) {
    return { startIndex: 0, endIndex: Math.max(0, itemCount), topPad: 0, bottomPad: 0 };
  }
  const totalRows = Math.ceil(itemCount / columns);
  const firstVisibleRow = Math.floor(Math.max(0, scrolledPastTop) / rowHeight);
  // +1 so a viewport that straddles a row boundary still mounts the partial row.
  const visibleRows = Math.ceil(viewportHeight / rowHeight) + 1;
  const startRow = Math.max(0, firstVisibleRow - overscanRows);
  const endRow = Math.min(totalRows, firstVisibleRow + visibleRows + overscanRows);
  return {
    startIndex: startRow * columns,
    endIndex: Math.min(itemCount, endRow * columns),
    topPad: startRow * rowHeight,
    bottomPad: Math.max(0, (totalRows - endRow) * rowHeight),
  };
}

export interface WindowedGrid {
  containerRef: React.RefObject<HTMLDivElement | null>;
  gridWindow: GridWindow;
}

export interface WindowedGridOptions {
  /**
   * Grid column count. A constant for a fixed grid (the mobile directory is 2);
   * a resolver — re-evaluated on mount and every resize — for a responsive grid
   * whose column count tracks the viewport width (the desktop directory is
   * 2/3/4 across the md/lg/xl breakpoints). A resolver MUST be SSR-safe (guard
   * `typeof window`), since it runs during the server/first render too.
   */
  columns: number | (() => number);
  /** Row gap in px (the Tailwind `gap-*` between rows) added onto the measured/estimated cell height. */
  rowGapPx: number;
  /**
   * Fallback row pitch (one cell's height + the row gap) for the initial paint,
   * SSR, and layout-less test environments (jsdom reports 0 for
   * getBoundingClientRect). Replaced at runtime by a real measurement so
   * device/font-scale differences self-correct.
   */
  estimatedRowPitchPx: number;
  /**
   * Extra rows mounted above and below the viewport so a fast flick doesn't
   * expose an unpainted gap before the scroll handler catches up.
   */
  overscanRows: number;
  /**
   * CSS selector for a representative cell to measure the real row height from.
   * Defaults to `'a'` — both directories render each cell as a top-level link.
   */
  cellSelector?: string;
}

function resolveColumns(columns: number | (() => number)): number {
  return typeof columns === 'function' ? columns() : columns;
}

/**
 * Wires {@link computeGridWindow} to real page scroll. Derives `scrolledPastTop`
 * from the container's viewport-relative top (0 until the grid reaches the top of
 * the viewport, growing as it scrolls past). Scroll/resize are rAF-throttled; the
 * resize handler also re-resolves the column count so a responsive grid re-windows
 * when the breakpoint changes.
 */
export function useWindowedGrid(itemCount: number, options: WindowedGridOptions): WindowedGrid {
  const { estimatedRowPitchPx, overscanRows } = options;
  // Latest options behind a ref so the scroll/measure effects can read the
  // current resolver / gap / selector without re-subscribing every render (the
  // options object is typically a fresh literal each render).
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rowHeight, setRowHeight] = useState(estimatedRowPitchPx);
  const [viewportHeight, setViewportHeight] = useState(() =>
    typeof window === 'undefined' ? 800 : window.innerHeight,
  );
  const [scrolledPastTop, setScrolledPastTop] = useState(0);
  const [columnCount, setColumnCount] = useState(() => resolveColumns(options.columns));

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      const el = containerRef.current;
      if (el === null) return;
      const rect = el.getBoundingClientRect();
      setScrolledPastTop(Math.max(0, -rect.top));
      setViewportHeight(window.innerHeight);
      // Responsive grids re-resolve their column count at the current width.
      setColumnCount(resolveColumns(optionsRef.current.columns));
    };
    const schedule = (): void => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  // Measure a real cell's height once cells are mounted so the spacers track the
  // actual device/font-scaled row pitch. jsdom returns 0 (no layout) — the
  // estimate stands there, which is what makes the windowing unit-testable.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null || itemCount === 0) return;
    const { cellSelector = 'a', rowGapPx } = optionsRef.current;
    const cell = el.querySelector(cellSelector);
    const h = cell === null ? 0 : cell.getBoundingClientRect().height;
    if (h > 0) setRowHeight(Math.round(h) + rowGapPx);
  }, [itemCount]);

  const gridWindow = useMemo(
    () =>
      computeGridWindow({
        itemCount,
        columns: columnCount,
        rowHeight,
        viewportHeight,
        scrolledPastTop,
        overscanRows,
      }),
    [itemCount, columnCount, rowHeight, viewportHeight, scrolledPastTop, overscanRows],
  );

  return { containerRef, gridWindow };
}
