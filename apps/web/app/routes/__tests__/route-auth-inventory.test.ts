/**
 * Web route auth inventory (hardening C2, 2026-07 plan).
 *
 * The backend conceals the admin surface (requireStaff masks non-staff
 * as 404) and every authed API rejects missing bearers — but the WEB
 * side's gating was held only by convention: nothing failed CI when a
 * new `admin.*` route forgot the `<RequireAdmin>` wrapper (leaking the
 * admin shell's layout/queries to signed-out visitors before the API
 * 404s land), or when an authed surface forgot to handle the
 * signed-out state. Route modules are also excluded from unit
 * coverage (`vitest.config.ts`), so no incidental test would catch it.
 *
 * Static source scan, same spirit as the backend's route-inventory
 * tests: cheap, non-vacuous (floor asserts the walk found the real
 * route set), default-deny for the admin namespace.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.tsx'));
}

function source(file: string): string {
  return readFileSync(join(ROUTES_DIR, file), 'utf8');
}

describe('hardening C2 — admin routes are RequireAdmin-wrapped', () => {
  const adminRoutes = routeFiles().filter((f) => f.startsWith('admin.'));

  it('finds the real admin route set (walk is not vacuous)', () => {
    expect(adminRoutes.length).toBeGreaterThanOrEqual(15);
  });

  it.each(adminRoutes)('%s renders inside the staff gate', (file) => {
    // ADR 037 split the wrapper into <RequireAdmin> (admin tier) and
    // <RequireStaff minimum="support"> (support-readable surfaces) —
    // both live in RequireAdmin.tsx and both conceal the shell from
    // non-staff. Either satisfies the inventory; NO wrapper fails it.
    const src = source(file);
    expect(src, `${file} must import the staff gate`).toMatch(
      /import \{ Require(Admin|Staff) \} from '~\/components\/features\/admin\/RequireAdmin'/,
    );
    expect(src, `${file} must render <RequireAdmin> or <RequireStaff>`).toMatch(
      /<Require(Admin>|Staff[ >])/,
    );
  });
});

describe('hardening C2 — authed user surfaces handle the signed-out state', () => {
  /**
   * Route modules that render user-scoped data (orders, wallet,
   * cashback, privacy/DSR). Each must reference an auth-awareness
   * primitive — `useAuth()` / `isAuthenticated` — so a signed-out
   * visitor gets the sign-in affordance rather than a wall of failed
   * authed queries. Adding a new user-scoped route? Add it here.
   */
  const AUTHED_SURFACES = [
    'orders.tsx',
    'orders.$id.tsx',
    'settings.cashback.tsx',
    'settings.privacy.tsx',
    'settings.wallet.tsx',
    // NOT listed: trustlines.tsx — deliberately public SEO surface
    // (#659, unauthenticated by design).
  ];

  it.each(AUTHED_SURFACES)('%s references an auth-awareness primitive', (file) => {
    const src = source(file);
    expect(src, `${file} must gate on auth state`).toMatch(
      /isAuthenticated|useAuth\(|RequireAdmin/,
    );
  });

  it('the list stays honest — every listed file exists', () => {
    const files = new Set(routeFiles());
    for (const f of AUTHED_SURFACES) {
      expect(files.has(f), `${f} listed but not mounted`).toBe(true);
    }
  });
});
