import { describe, it, expect } from 'vitest';
import { loader, meta } from '../not-found-ssr';
import type { Route } from '../+types/not-found-ssr';

// A2-1111: the SSR splat loader must throw a real 404 Response so RR v7
// propagates the status to the HTTP layer (crawlers see HTTP 404, not a
// soft-404). C3 — route loader logic previously excluded from coverage.
describe('not-found-ssr loader', () => {
  it('throws a 404 Response (not a soft 404)', () => {
    let thrown: unknown;
    try {
      loader({} as unknown as Route.LoaderArgs);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('meta sets the 404 page title', () => {
    const d = meta() as Array<Record<string, string>>;
    expect(d.some((m) => m.title === 'Page not found — Loop')).toBe(true);
  });
});
