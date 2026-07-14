import { describe, it, expect } from 'vitest';
import { computeGridWindow } from '../use-windowed-grid';

/**
 * FE-25-DESKTOP-GRID: the desktop directory grid shares the windowing math with
 * MobileHome via the extracted ./use-windowed-grid module, but runs it at
 * responsive column counts (3 at lg, 4 at xl) rather than the mobile grid's
 * fixed 2. These assert the shared `computeGridWindow` windows correctly for
 * those wider grids — a viewport-sized slice at the top, a window that advances
 * as the grid scrolls, full coverage of every item, and a bounded mount
 * regardless of catalog size.
 */
describe('computeGridWindow — desktop (responsive) column counts', () => {
  for (const columns of [3, 4]) {
    describe(`${columns} columns`, () => {
      const base = {
        itemCount: 982, // ~982 groups (ADR 032) — the real desktop catalog size
        columns,
        rowHeight: 320,
        viewportHeight: 900,
        overscanRows: 4,
      };

      it('mounts only a viewport-sized slice at the top of the list', () => {
        const w = computeGridWindow({ ...base, scrolledPastTop: 0 });
        expect(w.startIndex).toBe(0);
        expect(w.endIndex).toBeLessThan(base.itemCount);
        expect(w.topPad).toBe(0);
        expect(w.bottomPad).toBeGreaterThan(0);
        // Windows advance a whole row at a time, so the slice ends on a row
        // boundary (a multiple of the column count).
        expect(w.endIndex % columns).toBe(0);
      });

      it('advances the window as the grid scrolls above the viewport', () => {
        const top = computeGridWindow({ ...base, scrolledPastTop: 0 });
        const mid = computeGridWindow({ ...base, scrolledPastTop: 20 * base.rowHeight });
        expect(mid.startIndex).toBeGreaterThan(top.startIndex);
        expect(mid.topPad).toBeGreaterThan(0);
        expect(mid.bottomPad).toBeGreaterThan(0);
      });

      it('reaches the end of the list when fully scrolled', () => {
        const w = computeGridWindow({ ...base, scrolledPastTop: 1_000_000 });
        expect(w.endIndex).toBe(base.itemCount);
        expect(w.bottomPad).toBe(0);
      });

      it('exposes every item across the full scroll range (no gaps)', () => {
        const totalRows = Math.ceil(base.itemCount / columns);
        const covered = new Set<number>();
        for (let row = 0; row <= totalRows; row++) {
          const w = computeGridWindow({ ...base, scrolledPastTop: row * base.rowHeight });
          for (let i = w.startIndex; i < w.endIndex; i++) covered.add(i);
        }
        expect(covered.size).toBe(base.itemCount);
      });

      it('never mounts more than a bounded window regardless of dataset size', () => {
        const w = computeGridWindow({ ...base, itemCount: 100_000, scrolledPastTop: 0 });
        const visibleRows = Math.ceil(base.viewportHeight / base.rowHeight) + 1;
        const maxCells = (visibleRows + 2 * base.overscanRows) * columns;
        expect(w.endIndex - w.startIndex).toBeLessThanOrEqual(maxCells);
      });
    });
  }
});
