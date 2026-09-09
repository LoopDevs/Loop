/**
 * ADR 037 — staff-tier route gating, end-to-end through the real Hono
 * app (mocked boot edges, real store, real middleware).
 *
 * Three things are proven here:
 *
 *   1. **Tier behaviour** — a support user gets the uniform 404 on
 *      every admin-tier mount; an admin (allowlist shim, no
 *      `staff_roles` row) reaches them; a non-staff authenticated
 *      user gets 404 across the namespace; an unauthenticated one
 *      gets 401.
 *   2. **Default-deny inventory** — every concrete `/api/admin` mount
 *      must either carry an explicit `requireStaff('admin')` /
 *      `requireStaff('support')` gate or be a blanket-riding support
 *      read, which per the ADR 037 matrix means a non-CSV GET. A new
 *      POST/PUT/DELETE or CSV mount without an explicit tier fails.
 *   3. **Step-up pinning** — every non-GET admin-tier mount carries a
 *      correctly-SCOPED `requireAdminStepUp(...)` gate or sits on an
 *      explicit exempt list with its reason. This is the structural
 *      half the tier inventory can't see: without it a new money write
 *      mounted `requireStaff('admin')` but WITHOUT step-up would pass
 *      every other test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../config/index.js';

vi.mock('../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      // The step-up gates short-circuit to 503 when no signing key is
      // configured, which would mask the 404-vs-not-404 tier signal
      // this file is about. Pin a key so they take their real path.
      admin: {
        ...actual.config.admin,
        stepUp: {
          signingKey: 'staff-route-gating-step-up-key-32ch',
          previousSigningKey: undefined,
        },
      },
    },
  };
});

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

vi.mock('../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

vi.mock('../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

vi.mock('../discord.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, notifyAdminAudit: vi.fn(), notifyAdminBulkRead: vi.fn() };
});

// Replace requireAuth with a header-driven test double: the
// `x-test-user` header IS the loop-verified identity. Everything
// downstream (requireStaff resolution, the handlers, the real store)
// is the production code path.
vi.mock('../auth/handler.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    requireAuth: async (
      c: {
        req: { header: (k: string) => string | undefined };
        set: (k: string, v: unknown) => void;
        json: (b: unknown, s?: number) => Response;
      },
      next: () => Promise<void>,
    ): Promise<Response | undefined> => {
      const id = c.req.header('x-test-user');
      if (id === undefined) {
        return c.json({ code: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
      }
      c.set('auth', { kind: 'loop', userId: id, email: 'x@loop.test', bearerToken: 't' });
      await next();
      return undefined;
    },
  };
});

import { app, __resetRateLimitsForTests } from '../app.js';
import { db, __resetDbForTests } from '../db/client.js';
import type { UserDoc } from '../db/types.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001'; // allowlist shim, no row
const SUPPORT_ID = '00000000-0000-4000-8000-000000000002'; // staff_roles support row
const NOBODY_ID = '00000000-0000-4000-8000-000000000003'; // authenticated non-staff
const ORDER_ID = '00000000-0000-4000-8000-0000000000aa';

function user(id: string, email: string, isAdmin: boolean): UserDoc {
  const now = new Date();
  return {
    id,
    ctxUserId: null,
    email,
    tokenVersion: 0,
    homeCurrency: 'USD',
    isAdmin,
    createdAt: now,
    updatedAt: now,
  };
}

beforeEach(async () => {
  __resetRateLimitsForTests();
  __resetDbForTests();
  await db.collection('users').insertOne(user(ADMIN_ID, 'admin@loop.test', true));
  await db.collection('users').insertOne(user(SUPPORT_ID, 'support@loop.test', false));
  await db.collection('users').insertOne(user(NOBODY_ID, 'user@loop.test', false));
  await db.collection('staff_roles').insertOne({
    userId: SUPPORT_ID,
    role: 'support',
    grantedAt: new Date(),
    grantedByUserId: null,
    reason: null,
  });
});

function asUser(id: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { 'x-test-user': id, ...(init?.headers as Record<string, string> | undefined) },
  };
}

/** Every admin-only surface a support user must NOT see (404). */
const ADMIN_ONLY_PROBES: Array<[string, string]> = [
  ['GET', '/api/admin/staff'],
  ['PUT', `/api/admin/staff/${NOBODY_ID}/role`],
  ['DELETE', `/api/admin/staff/${NOBODY_ID}/role`],
  ['POST', '/api/admin/step-up'],
  ['POST', `/api/admin/users/${NOBODY_ID}/revoke-sessions`],
  ['POST', `/api/admin/users/${NOBODY_ID}/clear-otp-lockout`],
  ['POST', `/api/admin/users/${NOBODY_ID}/home-currency`],
  ['POST', `/api/admin/orders/${ORDER_ID}/redrive`],
  ['PUT', '/api/admin/merchant-cashback-configs/some-merchant'],
  ['POST', '/api/admin/merchants/resync'],
  ['GET', '/api/admin/discord/config'],
  ['POST', '/api/admin/discord/test'],
  ['GET', '/api/admin/orders.csv'],
  ['GET', '/api/admin/merchant-cashback-configs.csv'],
  ['GET', '/api/admin/merchants-catalog.csv'],
  ['GET', '/api/admin/audit-tail'],
  ['GET', '/api/admin/audit-tail.csv'],
];

/** Surfaces a support user MUST be able to reach (ADR 037 §3). */
const SUPPORT_VISIBLE_PROBES: Array<[string, string]> = [
  ['GET', '/api/admin/users'],
  ['GET', '/api/admin/users?q=loop'],
  ['GET', '/api/admin/users/search?q=loop'],
  ['GET', `/api/admin/users/${NOBODY_ID}`],
  ['GET', `/api/admin/users/${NOBODY_ID}/auth-state`],
  ['GET', '/api/admin/orders'],
  ['GET', '/api/admin/orders-activity'],
  ['GET', '/api/admin/stuck-orders'],
  ['GET', '/api/admin/merchant-cashback-configs'],
  ['GET', '/api/admin/merchant-stats'],
];

describe('ADR 037 tier behaviour', () => {
  it('unauthenticated requests get 401, not the staff concealment 404', async () => {
    const res = await app.request('/api/admin/staff');
    expect(res.status).toBe(401);
  });

  it('an authenticated non-staff user gets the concealment 404', async () => {
    const res = await app.request('/api/admin/staff', asUser(NOBODY_ID));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it.each(ADMIN_ONLY_PROBES)('support gets 404 on %s %s', async (method, path) => {
    const res = await app.request(path, asUser(SUPPORT_ID, { method }));
    expect(res.status).toBe(404);
    // Uniform concealment envelope — a support user must not be able
    // to tell an admin-only mount from one that doesn't exist.
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
  });

  it.each(ADMIN_ONLY_PROBES)('admin is NOT masked on %s %s', async (method, path) => {
    const res = await app.request(path, asUser(ADMIN_ID, { method }));
    // Anything but the concealment 404: 200 for the read, 400/401 for
    // writes missing an Idempotency-Key or a step-up header.
    expect(res.status).not.toBe(404);
  });

  it('admin reaches the staff list via the allowlist shim, with no staff_roles row of their own', async () => {
    const res = await app.request('/api/admin/staff', asUser(ADMIN_ID));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { staff: Array<Record<string, unknown>> };
    // The support row, plus the shim admin who has no row.
    expect(body.staff).toHaveLength(2);
    expect(body.staff.map((s) => s['source']).sort()).toEqual(['legacy_is_admin', 'staff_roles']);
  });

  it.each(SUPPORT_VISIBLE_PROBES)('support can read %s %s', async (_method, path) => {
    const res = await app.request(path, asUser(SUPPORT_ID));
    expect(res.status).toBe(200);
  });

  it.each(SUPPORT_VISIBLE_PROBES)(
    'a non-staff user is still concealed from %s %s',
    async (_method, path) => {
      const res = await app.request(path, asUser(NOBODY_ID));
      expect(res.status).toBe(404);
    },
  );

  // The support-tier delivery unstick: a 400 for the missing
  // Idempotency-Key proves the gate passed and the handler's own
  // validation is what answered, which a 404 would not.
  it('support can reach the redemption re-fetch past the gate', async () => {
    const res = await app.request(
      `/api/admin/orders/${ORDER_ID}/refetch-redemption`,
      asUser(SUPPORT_ID, { method: 'POST' }),
    );
    expect(res.status).toBe(400);
  });

  it('the step-up gate fires before the handler on a staff-role write', async () => {
    const res = await app.request(
      `/api/admin/staff/${NOBODY_ID}/role`,
      asUser(ADMIN_ID, {
        method: 'PUT',
        headers: { 'idempotency-key': 'x'.repeat(24), 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'support', reason: 'because' }),
      }),
    );
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
  });
});

describe('ADR 037 mount inventory (default-deny)', () => {
  interface Group {
    method: string;
    path: string;
    gates: string[];
  }

  function adminRouteGroups(): Group[] {
    const groups = new Map<string, Group>();
    for (const r of app.routes) {
      if (!r.path.startsWith('/api/admin')) continue;
      if (r.path.includes('*')) continue; // namespace blanket middleware
      const key = `${r.method} ${r.path}`;
      const g = groups.get(key) ?? { method: r.method, path: r.path, gates: [] };
      const name = (r.handler as { name?: string }).name ?? '';
      if (name.startsWith('requireStaff(') || name.startsWith('requireAdminStepUp(')) {
        g.gates.push(name);
      }
      groups.set(key, g);
    }
    return [...groups.values()];
  }

  it('every mount declares a tier or is a blanket-riding support read', () => {
    const offenders: string[] = [];
    for (const g of adminRouteGroups()) {
      if (g.gates.includes('requireStaff(admin)')) continue;
      if (g.gates.includes('requireStaff(support)')) continue;
      // Blanket rider — must be a support-readable surface per the
      // ADR 037 matrix: a GET, and not a bulk CSV export.
      if (g.method !== 'GET' || g.path.endsWith('.csv')) {
        offenders.push(`${g.method} ${g.path}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every destructive write carries its correctly-SCOPED step-up gate (ADR 028 / CF-08)', () => {
    // The scope is pinned per route, not merely its presence: merge
    // history has produced both failure modes this guards — a route
    // losing its step-up gate entirely, and a route keeping the gate
    // but losing its CF-08 scope binding.
    const mustCarryStepUp: Record<string, string> = {
      'PUT /api/admin/staff/:userId/role': 'requireAdminStepUp(staff-role-grant)',
      'DELETE /api/admin/staff/:userId/role': 'requireAdminStepUp(staff-role-revoke)',
      // ADR 015: re-denominates what the customer is quoted and charged.
      'POST /api/admin/users/:userId/home-currency': 'requireAdminStepUp(home-currency)',
      // A5-1: runs a real CTX sweep step that can move the order's state.
      'POST /api/admin/orders/:orderId/redrive': 'requireAdminStepUp(order-redrive)',
      // Hardening B1: sets the split FUTURE orders stamp at creation.
      'PUT /api/admin/merchant-cashback-configs/:merchantId': 'requireAdminStepUp(cashback-config)',
    };
    const groups = new Map(adminRouteGroups().map((g) => [`${g.method} ${g.path}`, g]));
    for (const [key, gate] of Object.entries(mustCarryStepUp)) {
      const g = groups.get(key);
      expect(g, `${key} is mounted`).toBeDefined();
      expect(g?.gates, `${key} carries ${gate}`).toContain(gate);
    }
  });

  it('default-deny: a NEW admin-tier write must declare step-up or join the explicit exempt list', () => {
    // Any non-GET admin mount either carries a named step-up gate or
    // is listed here WITH its reason. Adding a destructive admin write
    // without step-up requires editing this list — which is exactly
    // the review conversation ADR 028 wants to force.
    const STEP_UP_EXEMPT = new Set<string>([
      // Mints the step-up token itself — gating it on step-up would be
      // circular; it re-authenticates with a fresh OTP instead.
      'POST /api/admin/step-up',
      // B4 incident response: moves no value, and the user simply
      // signs back in. Step-up friction in the first minute of "their
      // laptop was stolen" is the wrong trade.
      'POST /api/admin/users/:userId/revoke-sessions',
      // A5-3: same rationale as revoke-sessions — clearing the counter
      // grants no access by itself, it only re-opens the guess budget,
      // and a wrong guess re-arms the lockout from a clean window. Its
      // own per-target velocity cap is what bounds abuse.
      'POST /api/admin/users/:userId/clear-otp-lockout',
      // ADR 037 support-tier delivery unstick: re-drives work the
      // customer already paid for and creates nothing. Adding step-up
      // would push it back to admin-only, which is the opposite of
      // what the tier is for.
      'POST /api/admin/orders/:orderId/refetch-redemption',
      // Catalog refresh: no money path, self-correcting (the worst
      // outcome is that the catalog matches CTX sooner), and already
      // the tightest rate limit on the surface.
      'POST /api/admin/merchants/resync',
      // Sends one test embed to an already-configured webhook — no
      // state change beyond the outbound message.
      'POST /api/admin/discord/test',
    ]);
    const offenders: string[] = [];
    for (const g of adminRouteGroups()) {
      if (g.method === 'GET') continue;
      const key = `${g.method} ${g.path}`;
      if (STEP_UP_EXEMPT.has(key)) continue;
      if (!g.gates.some((name) => name.startsWith('requireAdminStepUp('))) {
        offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
  });
});
