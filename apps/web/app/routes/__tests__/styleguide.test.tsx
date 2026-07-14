import { describe, it, expect, afterEach, vi } from 'vitest';
import { loader, meta } from '../styleguide';
import type { Route } from '../+types/styleguide';

/**
 * FE-24: `/styleguide` is an internal design-system surface that must not
 * be served in production. `noindex` is only a crawler hint, so the route
 * grew a loader gate that throws a real 404 in prod while staying reachable
 * in dev/local and explicitly-tagged staging deploys.
 *
 * Env is stubbed exactly as `native/__tests__/native-modules.test.ts` does
 * (`vi.stubEnv('PROD', …)` / `vi.stubEnv('VITE_LOOP_ENV', …)`), because
 * Vite inlines `import.meta.env.*` at build time and the loader reads it at
 * call time.
 */
const callLoader = (): unknown => loader({} as unknown as Route.LoaderArgs);

function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

describe('styleguide loader — production gate (FE-24)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('throws a 404 Response in a production build (VITE_LOOP_ENV=production)', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_LOOP_ENV', 'production');
    const thrown = thrownBy(callLoader);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('fails closed: 404s in a production build that shipped without VITE_LOOP_ENV', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_LOOP_ENV', '');
    const thrown = thrownBy(callLoader);
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(404);
  });

  it('renders (returns null, does not throw) in dev/local (PROD=false)', () => {
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_LOOP_ENV', '');
    let result: unknown;
    let thrown: unknown;
    try {
      result = callLoader();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(result).toBeNull();
  });

  it('stays reachable on an explicit staging deploy (PROD=true, VITE_LOOP_ENV=staging)', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_LOOP_ENV', 'staging');
    let result: unknown;
    let thrown: unknown;
    try {
      result = callLoader();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeUndefined();
    expect(result).toBeNull();
  });

  it('keeps the noindex belt-and-suspenders meta', () => {
    const d = meta();
    expect(d.some((m) => m.name === 'robots' && m.content === 'noindex, nofollow')).toBe(true);
  });
});
