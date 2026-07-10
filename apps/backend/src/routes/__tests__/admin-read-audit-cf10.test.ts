/**
 * End-to-end proof of the A5-8 P2 fix: `GET /api/admin/ledger`'s
 * DEFAULT page (50 rows) must NOT trip the CF-10 bulk-read Discord
 * tripwire (`notifyAdminBulkRead`, `../admin.ts`'s read-audit
 * middleware), even though 50 rows equals the global
 * `BULK_LIST_ROW_THRESHOLD`. An explicit wide pull (200 rows, near
 * the endpoint's real `MAX_LIMIT`) still must trip it.
 *
 * Goes through the REAL `app` (same harness pattern as
 * `staff-route-gating.test.ts`) so the assertion exercises the actual
 * middleware wiring in `routes/admin.ts`, not just the pure
 * `bulkRowThresholdFor` / `countAdminListRows` composition (which
 * `admin/__tests__/read-audit.test.ts` already covers at the unit
 * level).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../env.js', () => ({
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

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => ({
    merchants: [],
    merchantsById: new Map(),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  }),
}));

vi.mock('../../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

const { notifyAdminBulkRead } = vi.hoisted(() => ({ notifyAdminBulkRead: vi.fn() }));

vi.mock('../../discord.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    notifyAdminAudit: vi.fn(),
    notifyAdminBulkRead,
    notifyHealthChange: vi.fn(),
  };
});

const SUPPORT_ID = '00000000-0000-4000-8000-000000000002';

vi.mock('../../db/users.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    getUserById: vi.fn(async (id: string) =>
      id === SUPPORT_ID ? { id, email: 'support@loop.test', isAdmin: false } : null,
    ),
  };
});

vi.mock('../../db/staff-roles.js', async (importOriginal) => {
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

vi.mock('../../auth/handler.js', async (importOriginal) => {
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

// Row count is the only thing this test varies — the ledger handler's
// own filter/index logic is covered by `admin/__tests__/ledger.test.ts`.
const state = vi.hoisted(() => ({ rowCount: 0 }));

function makeLedgerRow(i: number): Record<string, unknown> {
  return {
    id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
    userId: SUPPORT_ID,
    type: 'cashback',
    amountMinor: 100n,
    currency: 'USD',
    referenceType: null,
    referenceId: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  };
}

vi.mock('../../db/client.js', () => {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async (n: number) =>
      Array.from({ length: Math.min(n, state.rowCount) }, (_, i) => makeLedgerRow(i)),
  };
  return {
    db: { select: () => chain, execute: vi.fn(async () => []) },
    runMigrations: vi.fn(),
    closeDb: vi.fn(),
  };
});

import { app, __resetRateLimitsForTests } from '../../app.js';

function asSupport(init?: RequestInit): RequestInit {
  return {
    ...init,
    headers: {
      'x-test-user': SUPPORT_ID,
      ...(init?.headers as Record<string, string> | undefined),
    },
  };
}

beforeEach(() => {
  __resetRateLimitsForTests();
  notifyAdminBulkRead.mockClear();
});

describe('CF-10 / A5-8 P2 — /api/admin/ledger default page vs. the bulk-read tripwire', () => {
  it('a default-size page (50 rows, the handler default) does NOT trip notifyAdminBulkRead', async () => {
    state.rowCount = 50;
    const res = await app.request('/api/admin/ledger', asSupport());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: unknown[] };
    expect(body.transactions).toHaveLength(50);
    expect(notifyAdminBulkRead).not.toHaveBeenCalled();
  });

  it('an explicit wide page (200 rows, near MAX_LIMIT) still trips notifyAdminBulkRead', async () => {
    state.rowCount = 200;
    const res = await app.request('/api/admin/ledger?limit=200', asSupport());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { transactions: unknown[] };
    expect(body.transactions).toHaveLength(200);
    expect(notifyAdminBulkRead).toHaveBeenCalledTimes(1);
    expect(notifyAdminBulkRead).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'GET /api/admin/ledger', rowCount: 200 }),
    );
  });
});
