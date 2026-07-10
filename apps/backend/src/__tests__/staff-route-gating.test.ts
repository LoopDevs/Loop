/**
 * ADR 037 — staff-tier route gating, end-to-end through the real
 * Hono app (mocked auth + DB edges).
 *
 * Three things are proven here:
 *
 *   1. **Tier behaviour** — a support user can read the dashboard
 *      surfaces but gets the uniform 404 on every money write, CSV
 *      export, Discord-config surface, role-management endpoint,
 *      and the step-up mint; an admin (legacy is_admin shim, no
 *      staff_roles row) reaches everything; a non-staff user gets
 *      404 across the namespace.
 *   2. **Default-deny inventory** — every concrete /api/admin mount
 *      must either carry an explicit `requireStaff('admin')` /
 *      `requireStaff('support')` gate or be a blanket-riding
 *      support read, in which case it MUST match the ADR 037
 *      matrix shape: GET, not `.csv`, not a Discord surface. A new
 *      POST/PUT/DELETE or CSV mount without an explicit tier fails
 *      this test.
 *   3. **Money-write pinning** — the step-up/money surfaces each
 *      carry the explicit admin gate.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../env.js', () => ({
  env: {
    PORT: '8080',
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GIFT_CARD_API_BASE_URL: 'http://test-upstream.local',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
    CTX_CLIENT_ID_WEB: 'loopweb',
    CTX_CLIENT_ID_IOS: 'loopios',
    CTX_CLIENT_ID_ANDROID: 'loopandroid',
    TRUST_PROXY: false,
  },
}));

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

vi.mock('../clustering/handler.js', () => ({
  clustersHandler: vi.fn(async (c: { json: (data: unknown) => Response }) =>
    c.json({ clusterPoints: [], locationPoints: [] }),
  ),
}));

vi.mock('../discord.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    notifyAdminAudit: vi.fn(),
    notifyAdminBulkRead: vi.fn(),
    notifyHealthChange: vi.fn(),
  };
});

/**
 * Minimal awaitable drizzle-ish query chain: every builder method
 * returns the chain; `await`ing it resolves to []. Enough for the
 * read handlers exercised here (staff list, watcher-skips, lookup).
 */
function makeChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {};
  for (const m of [
    'select',
    'from',
    'where',
    'orderBy',
    'limit',
    'leftJoin',
    'innerJoin',
    'set',
    'values',
    'returning',
  ]) {
    chain[m] = () => chain;
  }
  chain['then'] = (resolve: (rows: unknown[]) => void) => Promise.resolve(resolve([]));
  return chain;
}

vi.mock('../db/client.js', () => ({
  db: {
    execute: vi.fn(async () => []),
    select: () => makeChain(),
    update: () => makeChain(),
  },
  runMigrations: vi.fn(),
  closeDb: vi.fn(),
}));

// ─── Test identities ─────────────────────────────────────────────────────────

const ADMIN_ID = '00000000-0000-4000-8000-000000000001'; // legacy is_admin shim
const SUPPORT_ID = '00000000-0000-4000-8000-000000000002'; // staff_roles support row
const NOBODY_ID = '00000000-0000-4000-8000-000000000003'; // authenticated non-staff

const FIXTURE_USERS: Record<string, { id: string; email: string; isAdmin: boolean }> = {
  [ADMIN_ID]: { id: ADMIN_ID, email: 'admin@loop.test', isAdmin: true },
  [SUPPORT_ID]: { id: SUPPORT_ID, email: 'support@loop.test', isAdmin: false },
  [NOBODY_ID]: { id: NOBODY_ID, email: 'user@loop.test', isAdmin: false },
};

vi.mock('../db/users.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getUserById: vi.fn(async (id: string) => FIXTURE_USERS[id] ?? null),
  };
});

vi.mock('../db/staff-roles.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getStaffRole: vi.fn(async (id: string) =>
      id === SUPPORT_ID
        ? {
            userId: id,
            role: 'support',
            grantedAt: new Date(),
            grantedByUserId: null,
            reason: null,
          }
        : null,
    ),
  };
});

// Replace requireAuth with a header-driven test double: the
// `x-test-user` header IS the loop-verified identity. Everything
// downstream (requireStaff resolution, handlers) is real.
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

function asUser(id: string, init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: { 'x-test-user': id, ...(init?.headers as Record<string, string> | undefined) },
  };
}

beforeEach(() => {
  __resetRateLimitsForTests();
});

// Every admin-only surface a support user must NOT see (404). Money
// writes, CSV exports, Discord config, role management, step-up.
const ADMIN_ONLY_PROBES: Array<[string, string]> = [
  ['POST', `/api/admin/users/${NOBODY_ID}/credit-adjustments`],
  ['POST', `/api/admin/users/${NOBODY_ID}/refunds`],
  ['POST', `/api/admin/users/${NOBODY_ID}/emissions`],
  ['POST', `/api/admin/users/${NOBODY_ID}/home-currency`],
  ['POST', `/api/admin/users/${NOBODY_ID}/revoke-sessions`],
  ['POST', '/api/admin/deposits/op-123/refund'],
  ['POST', '/api/admin/payouts/00000000-0000-4000-8000-00000000aaaa/retry'],
  ['POST', '/api/admin/payouts/00000000-0000-4000-8000-00000000aaaa/compensate'],
  ['POST', `/api/admin/orders/${NOBODY_ID}/redrive`],
  ['PUT', '/api/admin/merchant-cashback-configs/some-merchant'],
  ['POST', '/api/admin/merchants/resync'],
  ['POST', '/api/admin/step-up'],
  ['GET', '/api/admin/discord/config'],
  ['GET', '/api/admin/discord/notifiers'],
  ['POST', '/api/admin/discord/test'],
  ['GET', '/api/admin/payouts.csv'],
  ['GET', '/api/admin/orders.csv'],
  ['GET', '/api/admin/user-credits.csv'],
  ['GET', '/api/admin/audit-tail.csv'],
  ['GET', '/api/admin/treasury.csv'],
  ['GET', '/api/admin/staff'],
  ['PUT', `/api/admin/staff/${NOBODY_ID}/role`],
  ['DELETE', `/api/admin/staff/${NOBODY_ID}/role`],
];

describe('ADR 037 tier behaviour', () => {
  it('support can read a dashboard surface (200), non-staff cannot (404)', async () => {
    const ok = await app.request('/api/admin/merchant-stats', asUser(SUPPORT_ID));
    expect(ok.status).toBe(200);

    const denied = await app.request('/api/admin/merchant-stats', asUser(NOBODY_ID));
    expect(denied.status).toBe(404);

    const unauthed = await app.request('/api/admin/merchant-stats');
    expect(unauthed.status).toBe(401);
  });

  // A5-6: stuck-orders/stuck-payouts triage is the concrete surface
  // support needs to do the ADR 037 "find → explain → unstick" job —
  // an operator can't point a customer at an A5-1 re-drive or a
  // payout retry without first SEEING the row is stuck. Both mounts
  // are blanket riders (no explicit requireStaff gate — see
  // admin-dashboard.ts), so this pins the tier explicitly rather
  // than leaving it to the generic "riders" bucket count below.
  it('support can read stuck-orders and stuck-payouts (A5-6)', async () => {
    const orders = await app.request('/api/admin/stuck-orders', asUser(SUPPORT_ID));
    expect(orders.status).toBe(200);
    expect(await orders.json()).toEqual({ thresholdMinutes: 5, rows: [] });

    const payouts = await app.request('/api/admin/stuck-payouts', asUser(SUPPORT_ID));
    expect(payouts.status).toBe(200);
    expect(await payouts.json()).toEqual({ thresholdMinutes: 5, rows: [] });

    const ordersDenied = await app.request('/api/admin/stuck-orders', asUser(NOBODY_ID));
    expect(ordersDenied.status).toBe(404);

    const payoutsDenied = await app.request('/api/admin/stuck-payouts', asUser(NOBODY_ID));
    expect(payoutsDenied.status).toBe(404);
  });

  it('support can use the new ADR 037 surfaces', async () => {
    const skips = await app.request('/api/admin/watcher-skips', asUser(SUPPORT_ID));
    expect(skips.status).toBe(200);
    expect(await skips.json()).toEqual({ rows: [] });

    // 400 (not 404) proves the support tier passed the gate and
    // reached the handler's own validation.
    const lookup = await app.request('/api/admin/lookup?q=%21%21', asUser(SUPPORT_ID));
    expect(lookup.status).toBe(400);

    const reopen = await app.request(
      '/api/admin/watcher-skips/12345/reopen',
      asUser(SUPPORT_ID, { method: 'POST' }),
    );
    expect(reopen.status).toBe(400); // missing Idempotency-Key — gate passed

    const refetch = await app.request(
      `/api/admin/orders/${NOBODY_ID}/refetch-redemption`,
      asUser(SUPPORT_ID, { method: 'POST' }),
    );
    expect(refetch.status).toBe(400); // missing Idempotency-Key — gate passed
  });

  it.each(ADMIN_ONLY_PROBES)('support gets 404 on %s %s', async (method, path) => {
    const res = await app.request(path, asUser(SUPPORT_ID, { method }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND'); // uniform concealment envelope
  });

  it.each(ADMIN_ONLY_PROBES)('admin is NOT masked on %s %s', async (method, path) => {
    const res = await app.request(path, asUser(ADMIN_ID, { method }));
    // Anything but the concealment 404: 200 for reads, 400/401/503
    // for writes missing idempotency/step-up. (USER_NOT_FOUND 404s
    // would carry a different code; none of these probes hit one —
    // the write edges reject before target resolution.)
    expect(res.status).not.toBe(404);
  });

  it('admin reaches the staff list (legacy is_admin shim, no staff row)', async () => {
    const res = await app.request('/api/admin/staff', asUser(ADMIN_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staff: [] });
  });
});

describe('ADR 037 mount inventory (default-deny)', () => {
  interface Group {
    method: string;
    path: string;
    gates: string[];
    handlerCount: number;
  }

  function adminRouteGroups(): Group[] {
    const groups = new Map<string, Group>();
    for (const r of app.routes) {
      if (!r.path.startsWith('/api/admin')) continue;
      if (r.path.includes('*')) continue; // namespace blanket middleware
      const key = `${r.method} ${r.path}`;
      const g = groups.get(key) ?? { method: r.method, path: r.path, gates: [], handlerCount: 0 };
      g.handlerCount++;
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
      // ADR 037 matrix: GET, not a CSV export, not Discord config.
      if (
        g.method !== 'GET' ||
        g.path.endsWith('.csv') ||
        g.path.startsWith('/api/admin/discord')
      ) {
        offenders.push(`${g.method} ${g.path}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('pins the tier split so silent re-tiering shows up in review', () => {
    const groups = adminRouteGroups();
    const adminTier = groups.filter((g) => g.gates.includes('requireStaff(admin)'));
    const supportExplicit = groups.filter(
      (g) => !g.gates.includes('requireStaff(admin)') && g.gates.includes('requireStaff(support)'),
    );
    const riders = groups.length - adminTier.length - supportExplicit.length;
    // 38 = 23 CSV exports + 10 non-CSV admin writes (3 credit writes,
    //      home-currency, cashback-config PUT, merchants/resync,
    //      B4 revoke-sessions, A6 deposit-refund, R3-1 operator-float
    //      baseline/manual explanations) + payout retry/compensate
    //      + A5-1 order redrive + 3 Discord surfaces + step-up
    //      mint... see the mount-by-mount table in the PR; the exact
    //      membership is pinned by the matrix test above and the
    //      money-write list below.
    expect(adminTier).toHaveLength(38);
    // 7 = lookup, watcher-skips ×3, wallet ×2, refetch-redemption.
    expect(supportExplicit).toHaveLength(7);
    expect(riders).toBeGreaterThanOrEqual(50);
  });

  it('every money write carries the explicit admin gate', () => {
    const mustBeAdmin = [
      'POST /api/admin/users/:userId/credit-adjustments',
      'POST /api/admin/users/:userId/refunds',
      'POST /api/admin/users/:userId/emissions',
      'POST /api/admin/users/:userId/home-currency',
      'POST /api/admin/payouts/:id/retry',
      'POST /api/admin/payouts/:id/compensate',
      'POST /api/admin/orders/:orderId/redrive',
      'PUT /api/admin/merchant-cashback-configs/:merchantId',
      'POST /api/admin/operator-float/baselines',
      'POST /api/admin/operator-float/manual-movements',
      'POST /api/admin/step-up',
      'PUT /api/admin/staff/:userId/role',
      'DELETE /api/admin/staff/:userId/role',
    ];
    const groups = new Map(adminRouteGroups().map((g) => [`${g.method} ${g.path}`, g]));
    for (const key of mustBeAdmin) {
      const g = groups.get(key);
      expect(g, `${key} is mounted`).toBeDefined();
      expect(g?.gates, `${key} carries requireStaff(admin)`).toContain('requireStaff(admin)');
    }
  });

  it('every destructive write carries its correctly-SCOPED step-up gate (ADR 028 / CF-08)', () => {
    // Hardening B1: this is the structural half the tier inventory
    // couldn't see — `requireAdminStepUp` used to return an anonymous
    // closure, so a new money write mounted with `requireStaff(admin)`
    // but WITHOUT step-up passed every test. The scope is pinned per
    // route: merge history has already produced both failure modes
    // this guards (a route losing its step-up gate entirely, and a
    // route keeping the gate but losing its CF-08 scope binding).
    const mustCarryStepUp: Record<string, string> = {
      'POST /api/admin/users/:userId/credit-adjustments': 'requireAdminStepUp(credit-adjustment)',
      'POST /api/admin/users/:userId/refunds': 'requireAdminStepUp(refund)',
      'POST /api/admin/users/:userId/emissions': 'requireAdminStepUp(emission)',
      'POST /api/admin/users/:userId/home-currency': 'requireAdminStepUp(home-currency)',
      'POST /api/admin/payouts/:id/retry': 'requireAdminStepUp(payout-retry)',
      'POST /api/admin/payouts/:id/compensate': 'requireAdminStepUp(payout-compensation)',
      // A5-1: re-driving a stuck order can submit a real outbound Stellar payment to CTX.
      'POST /api/admin/orders/:orderId/redrive': 'requireAdminStepUp(order-redrive)',
      'PUT /api/admin/staff/:userId/role': 'requireAdminStepUp(staff-role-grant)',
      'DELETE /api/admin/staff/:userId/role': 'requireAdminStepUp(staff-role-revoke)',
      // Sets future emission rates — see the route mount's comment.
      'PUT /api/admin/merchant-cashback-configs/:merchantId': 'requireAdminStepUp(cashback-config)',
      // A6: submits an outbound Stellar refund from the operator account.
      'POST /api/admin/deposits/:paymentId/refund': 'requireAdminStepUp(deposit-refund)',
      // R3-1: changes the baseline/explanation set for the operator float invariant.
      'POST /api/admin/operator-float/baselines': 'requireAdminStepUp(operator-float)',
      'POST /api/admin/operator-float/manual-movements': 'requireAdminStepUp(operator-float)',
    };
    const groups = new Map(adminRouteGroups().map((g) => [`${g.method} ${g.path}`, g]));
    for (const [key, gate] of Object.entries(mustCarryStepUp)) {
      const g = groups.get(key);
      expect(g, `${key} is mounted`).toBeDefined();
      expect(g?.gates, `${key} carries ${gate}`).toContain(gate);
    }
  });

  it('default-deny: a NEW admin-tier write must declare step-up or join the explicit exempt list', () => {
    // The strongest form of the B1 guarantee: any non-GET mount gated
    // `requireStaff(admin)` either carries a named step-up gate or is
    // listed here WITH its reason. Adding a destructive admin write
    // without step-up now requires editing this list — which is
    // exactly the review conversation ADR 028 wants to force.
    const STEP_UP_EXEMPT = new Set<string>([
      // Mints the step-up token itself — gating it on step-up would
      // be circular; it re-authenticates via a fresh OTP instead.
      'POST /api/admin/step-up',
      // Catalog refresh: no money path, reversible, rate-limited.
      'POST /api/admin/merchants/resync',
      // Sends a test embed to the configured Discord webhook — no
      // state change beyond the outbound message.
      'POST /api/admin/discord/test',
      // B4: admin session revocation — a reversible incident-response
      // action (the user just signs back in), moves no value, and
      // step-up friction during a fast security response is
      // counterproductive.
      'POST /api/admin/users/:userId/revoke-sessions',
      // ADR 037 support-tier delivery-unsticking actions: reversible
      // re-drives of existing intents (no new value creation), scoped
      // to the support remit on purpose — adding step-up would move
      // them back to admin-only.
      'POST /api/admin/watcher-skips/:paymentId/reopen',
      'POST /api/admin/users/:userId/wallet/reprovision',
      'POST /api/admin/orders/:orderId/refetch-redemption',
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
