// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadImage } from '../share-image';

/**
 * jsdom never loads image resources, so an `Image` whose `src` is set
 * fires neither `onload` nor `onerror` — exactly the half-open
 * connection shape the timeout exists for (comprehensive-audit
 * 2026-06-11, P10).
 */
describe('loadImage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves null after the 8s timeout when the image never settles', async () => {
    const promise = loadImage('https://example.test/barcode.png');
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(promise).resolves.toBeNull();
  });

  it('does not resolve before the timeout elapses', async () => {
    let settled = false;
    void loadImage('https://example.test/barcode.png').then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Flush the resolved promise queue.
    await Promise.resolve();
    expect(settled).toBe(true);
  });
});
