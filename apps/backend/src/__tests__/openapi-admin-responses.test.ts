/**
 * Doc-accuracy guards for the admin OpenAPI surface.
 *
 * The `/api/admin/*` namespace mounts a blanket `requireAuth` +
 * `requireStaff` gate (see routes/admin.ts) before every handler, and
 * the global `app.onError` maps any unhandled throw to a 500 envelope
 * (app.ts). So EVERY admin operation can emit:
 *   - 401 — unauthenticated / non-loop / invalid-or-expired token
 *           (require-auth.ts, require-staff.ts)
 *   - 500 — requireStaff's `getUserById` throwing, or app.onError
 *   - 404 — requireStaff masking non-staff / wrong-tier access
 * A spec that omits 401 or 500 documents a narrower contract than the
 * endpoint actually has (the 2026-07 API-03 finding). These tests pin
 * the middleware reality so a new admin path — or an edit that drops a
 * response — cannot silently under-document it. `check-openapi-parity`
 * enforces the same at the `npm run verify` gate; this is the unit-layer
 * twin that runs against the generated document.
 */
import { describe, it, expect } from 'vitest';
import { generateOpenApiSpec } from '../openapi.js';

type Operation = { responses?: Record<string, { description?: string }> };
type PathItem = Record<string, Operation>;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;

const spec = generateOpenApiSpec();
const paths = (spec.paths ?? {}) as Record<string, PathItem>;

function adminOperations(): Array<{ path: string; method: string; op: Operation }> {
  const out: Array<{ path: string; method: string; op: Operation }> = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!path.startsWith('/api/admin')) continue;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (op !== undefined) out.push({ path, method, op });
    }
  }
  return out;
}

describe('API-03: every /api/admin operation documents the auth-stack 401 + 500', () => {
  const ops = adminOperations();

  it('has admin operations to check (guards against an empty sweep)', () => {
    // Non-vacuity guard: if the spec ever registers zero admin paths the
    // per-op assertions below would trivially pass.
    expect(ops.length).toBeGreaterThan(50);
  });

  for (const { path, method, op } of ops) {
    it(`${method.toUpperCase()} ${path} declares 401 and 500`, () => {
      const responses = op.responses ?? {};
      expect(Object.keys(responses), `${method} ${path} missing 401`).toContain('401');
      expect(Object.keys(responses), `${method} ${path} missing 500`).toContain('500');
    });
  }
});

describe('DOC-03: admin per-user cashback-drill 429 documents the real 120/min limit', () => {
  // Both mounts use rateLimit(..., 120, 60_000) in
  // routes/admin-user-cluster.ts — 120 requests / 60s, NOT 60/min.
  const drillPaths = [
    '/api/admin/users/{userId}/cashback-by-merchant',
    '/api/admin/users/{userId}/cashback-summary',
  ];

  for (const path of drillPaths) {
    it(`GET ${path} 429 says 120/min, never the stale 60/min`, () => {
      const desc = paths[path]?.get?.responses?.['429']?.description ?? '';
      expect(desc).toContain('120/min');
      expect(desc).not.toContain('60/min');
    });
  }
});
