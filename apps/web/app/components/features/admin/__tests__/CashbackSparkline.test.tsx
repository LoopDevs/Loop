import { describe, it, expect } from 'vitest';
import { toPoints } from '../CashbackSparkline';

describe('toPoints', () => {
  it('returns empty string for empty input', () => {
    expect(toPoints([])).toBe('');
  });

  it('renders a single value centered on the x axis at baseline', () => {
    // One point: x=0, y at the top (2px padding).
    expect(toPoints([10])).toBe('0.0,2.0');
  });

  it('renders a flat series at the top when all values equal', () => {
    const pts = toPoints([5, 5, 5]);
    const ys = pts.split(' ').map((p) => Number(p.split(',')[1]));
    // Flat series: all ys should be identical.
    expect(new Set(ys).size).toBe(1);
  });

  it('zero anchors to the chart baseline', () => {
    const pts = toPoints([0, 10]);
    const [first, second] = pts.split(' ').map((p) => Number(p.split(',')[1]));
    // Zero should be at y = HEIGHT - 2 = 62 (well below the max-value y).
    expect(first).toBeGreaterThan((second ?? 0) + 10);
  });

  it('distributes x evenly across the width', () => {
    const pts = toPoints([1, 2, 3]).split(' ');
    const xs = pts.map((p) => Number(p.split(',')[0]));
    // 3 points: x=0, x=width/2, x=width.
    expect(xs[0]).toBe(0);
    expect(xs[2]).toBe(560);
    expect(xs[1]).toBe(280);
  });
});
