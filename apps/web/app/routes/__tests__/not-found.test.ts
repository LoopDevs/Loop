/**
 * A2-1111: splat `*` route should return HTTP 404, not a soft-404.
 * The SSR build wires the splat to `not-found-ssr.tsx`, whose loader
 * unconditionally throws a Response with status 404 — RR v7
 * propagates it through entry.server.tsx so the HTTP response carries
 * the right status. The mobile build (`not-found.tsx`) is a pure
 * component because SPA mode rejects `loader` exports; nothing to
 * test there beyond what already lives in render-tree tests.
 */
import { describe, it, expect } from 'vitest';
import { loader } from '../not-found-ssr';

describe('A2-1111 — splat route returns HTTP 404 in SSR', () => {
  it('throws a 404 Response from the SSR loader', () => {
    let thrown: unknown;
    try {
      // @ts-expect-error — args shape doesn't matter for the throw
      loader({});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
    expect((thrown as Response).statusText).toBe('Not Found');
  });
});
