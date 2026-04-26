/**
 * A2-1111: splat `*` route should return HTTP 404, not a soft-404.
 * The loader throws a Response with status 404 when running server-
 * side (typeof window === 'undefined'), which RR v7 propagates to the
 * SSR HTTP response. Client-side it's a no-op so navigation to a bad
 * URL renders the component normally.
 */
import { describe, it, expect } from 'vitest';
import { loader } from '../not-found';

describe('A2-1111 — splat route returns HTTP 404 in SSR', () => {
  it('throws a 404 Response when window is undefined (SSR path)', () => {
    const originalWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      let thrown: unknown;
      try {
        // @ts-expect-error — args shape doesn't matter for the guard
        loader({});
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(404);
    } finally {
      (globalThis as { window?: unknown }).window = originalWindow;
    }
  });

  it('returns null when window is defined (client path)', () => {
    (globalThis as { window?: unknown }).window = (globalThis as { window?: unknown }).window ?? {};
    // @ts-expect-error — args shape doesn't matter for the guard
    expect(loader({})).toBeNull();
  });
});
