// admin surfaces — real Hono app, real in-memory store; only boot edges and auth bearer mocked
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    config: {
      ...actual.config,
      auth: {
        ...actual.config.auth,
        native: {
          ...actual.config.auth.native,
          jwt: { current: 'admin-surfaces-test-signing-key-32c', previous: undefined },
        },
      },
    },
  };
});

vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('../../clustering/data-store.js', () => ({
  startLocationRefresh: vi.fn(),
  getLocations: () => ({ locations: [], loadedAt: Date.now() }),
  isLocationLoading: () => false,
}));

const { merchantStore } = vi.hoisted(() => ({
  merchantStore: {
    merchants: [{ id: 'acme', name: 'Acme, Inc "Rewards"' }] as Array<{ id: string; name: string }>,
    merchantsById: new Map<string, { id: string; name: string }>([
      ['acme', { id: 'acme', name: 'Acme, Inc "Rewards"' }],
    ]),
    merchantsBySlug: new Map(),
    loadedAt: Date.now(),
  },
}));

vi.mock('../../merchants/sync.js', () => ({
  startMerchantRefresh: vi.fn(),
  getMerchants: () => merchantStore,
  forceRefreshMerchants: vi.fn(async () => ({ triggered: true })),
}));

vi.mock('../../images/proxy.js', async (importOriginal) => {
  const orig = await importOriginal();
  return { ...(orig as Record<string, unknown>), evictExpiredImageCache: vi.fn() };
});

vi.mock('../../discord.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, notifyAdminAudit: vi.fn(), notifyAdminBulkRead: vi.fn() };
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
      c.set('auth', { kind: 'loop', userId: id, email: 'admin@loop.test', bearerToken: 't' });
      await next();
      return undefined;
    },
  };
});

import { app, __resetRateLimitsForTests } from '../../app.js';
import { db, __resetDbForTests } from '../../db/client.js';
import type { OrderDoc, UserDoc } from '../../db/types.js';
import { signAdminStepUpToken, type AdminStepUpScope } from '../../auth/admin-step-up.js';

const ADMIN_ID = '00000000-0000-4000-8000-000000000001';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000002';
const ORDER_ID = '00000000-0000-4000-8000-0000000000aa';

function userDoc(id: string, email: string, isAdmin: boolean): UserDoc {
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

function orderDoc(overrides: Partial<OrderDoc> = {}): OrderDoc {
  const now = new Date();
  return {
    id: ORDER_ID,
    userId: CUSTOMER_ID,
    merchantId: 'acme',
    faceValueMinor: 5000,
    currency: 'USD',
    chargeMinor: 4750,
    chargeCurrency: 'USD',
    userCashbackMinor: 250,
    expectedCommissionMinor: 100,
    ctxOrderId: 'ctx-order-1',
    ctxPaymentId: 'ctx-pay-1',
    paymentCryptoCurrency: 'XLM',
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    redemptionBackfillAttempts: 0,
    redemptionBackfillLastAttemptAt: null,
    state: 'paid',
    failureReason: null,
    idempotencyKey: null,
    createdAt: now,
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
}

function adminWrite(body: unknown, stepUpScope?: AdminStepUpScope): RequestInit {
  const headers: Record<string, string> = {
    'x-test-user': ADMIN_ID,
    'idempotency-key': `k${Math.random().toString(36).slice(2)}`.padEnd(24, 'x'),
    'content-type': 'application/json',
  };
  if (stepUpScope !== undefined) {
    headers['x-admin-step-up'] = signAdminStepUpToken({
      sub: ADMIN_ID,
      email: 'admin@loop.test',
      scope: stepUpScope,
    }).token;
  }
  return { method: 'POST', headers, body: JSON.stringify(body) };
}

function asAdmin(init?: RequestInit): RequestInit {
  return { ...init, headers: { 'x-test-user': ADMIN_ID, ...(init?.headers as object) } };
}

beforeEach(async () => {
  __resetRateLimitsForTests();
  __resetDbForTests();
  await db.collection('users').insertOne(userDoc(ADMIN_ID, 'admin@loop.test', true));
  await db.collection('users').insertOne(userDoc(CUSTOMER_ID, 'customer@example.com', false));
});

describe('user search', () => {
  it('matches an email substring case-insensitively', async () => {
    const res = await app.request('/api/admin/users/search?q=EXAMPLE', asAdmin());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: Array<{ email: string }>; truncated: boolean };
    expect(body.users.map((u) => u.email)).toEqual(['customer@example.com']);
    expect(body.truncated).toBe(false);
  });

  it('treats the term as literal text, not a pattern', async () => {
    const res = await app.request('/api/admin/users/search?q=r.e', asAdmin());
    expect(((await res.json()) as { users: unknown[] }).users).toEqual([]);
  });

  it('rejects a one-character query rather than scanning for it', async () => {
    const res = await app.request('/api/admin/users/search?q=a', asAdmin());
    expect(res.status).toBe(400);
  });
});

describe('user drills', () => {
  it('resolves a user by exact email regardless of the case pasted in', async () => {
    const res = await app.request(
      '/api/admin/users/by-email?email=Customer@Example.COM',
      asAdmin(),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { id: string }).id).toBe(CUSTOMER_ID);
  });

  it('404s a miss rather than returning an empty row', async () => {
    const res = await app.request('/api/admin/users/by-email?email=nobody@example.com', asAdmin());
    expect(res.status).toBe(404);
  });

  it('reports auth state without ever echoing a code or a token hash', async () => {
    await db.collection('otps').insertOne({
      id: 'otp-1',
      email: 'customer@example.com',
      codeHash: 'THE-SECRET-HASH',
      expiresAt: new Date(Date.now() + 60_000),
      consumedAt: null,
      attempts: 0,
      createdAt: new Date(),
    });
    await db.collection('otp_attempt_counters').insertOne({
      email: 'customer@example.com',
      failedAttempts: 3,
      windowStartedAt: new Date(),
      lockedUntil: new Date(Date.now() + 60_000),
      updatedAt: new Date(),
    });

    const res = await app.request(`/api/admin/users/${CUSTOMER_ID}/auth-state`, asAdmin());
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('THE-SECRET-HASH');
    const body = JSON.parse(raw) as {
      otpLock: { locked: boolean; failedAttempts: number };
      lastOtpRequestedAt: string | null;
      activeSessionCount: number;
    };
    expect(body.otpLock).toMatchObject({ locked: true, failedAttempts: 3 });
    expect(body.lastOtpRequestedAt).toEqual(expect.any(String));
    expect(body.activeSessionCount).toBe(0);
  });
});

describe('orders', () => {
  beforeEach(async () => {
    await db.collection('orders').insertOne(orderDoc());
  });

  it('never exposes the redeem code, only whether one has landed', async () => {
    await db
      .collection('orders')
      .updateOne({ id: ORDER_ID }, { $set: { redeemCode: 'SPENDABLE-CODE', state: 'fulfilled' } });

    const list = await app.request('/api/admin/orders', asAdmin());
    const drill = await app.request(`/api/admin/orders/${ORDER_ID}`, asAdmin());
    const csv = await app.request('/api/admin/orders.csv', asAdmin());

    for (const res of [list, drill, csv]) {
      expect(await res.text()).not.toContain('SPENDABLE-CODE');
    }
    expect(
      (
        (await (await app.request(`/api/admin/orders/${ORDER_ID}`, asAdmin())).json()) as {
          hasRedemption: boolean;
        }
      ).hasRedemption,
    ).toBe(true);
  });

  it('filters by state and rejects one that is not an order state', async () => {
    const ok = await app.request('/api/admin/orders?state=fulfilled', asAdmin());
    expect(((await ok.json()) as { orders: unknown[] }).orders).toEqual([]);

    const bad = await app.request('/api/admin/orders?state=banana', asAdmin());
    expect(bad.status).toBe(400);
  });

  it('counts activity per state over the window', async () => {
    const res = await app.request('/api/admin/orders-activity?windowHours=24', asAdmin());
    const body = (await res.json()) as { counts: Record<string, number>; total: number };
    expect(body.counts['paid']).toBe(1);
    expect(body.counts['fulfilled']).toBe(0);
    expect(body.total).toBe(1);
  });

  it('lists a paid order as stuck once it is older than the threshold, oldest first', async () => {
    await db
      .collection('orders')
      .updateOne({ id: ORDER_ID }, { $set: { createdAt: new Date(Date.now() - 30 * 60_000) } });

    const res = await app.request('/api/admin/stuck-orders', asAdmin());
    const body = (await res.json()) as { rows: Array<{ id: string; ageMinutes: number }> };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]?.ageMinutes).toBeGreaterThanOrEqual(30);
  });

  it('excludes an unpaid order — that is waiting on the customer, not on us', async () => {
    await db
      .collection('orders')
      .updateOne(
        { id: ORDER_ID },
        { $set: { state: 'unpaid', createdAt: new Date(Date.now() - 30 * 60_000) } },
      );
    const res = await app.request('/api/admin/stuck-orders', asAdmin());
    expect(((await res.json()) as { rows: unknown[] }).rows).toEqual([]);
  });
});

describe('reverse lookup', () => {
  beforeEach(async () => {
    await db.collection('orders').insertOne(orderDoc());
  });

  it('resolves a Loop order id to the owning user', async () => {
    const res = await app.request(`/api/admin/lookup?q=${ORDER_ID}`, asAdmin());
    expect(await res.json()).toEqual({ kind: 'order', userId: CUSTOMER_ID, orderId: ORDER_ID });
  });

  it('resolves the CTX order id the customer sees on the card page', async () => {
    const res = await app.request('/api/admin/lookup?q=ctx-order-1', asAdmin());
    expect(((await res.json()) as { userId: string }).userId).toBe(CUSTOMER_ID);
  });

  it('404s something that is not ours rather than returning an empty result', async () => {
    const res = await app.request('/api/admin/lookup?q=not-an-order', asAdmin());
    expect(res.status).toBe(404);
  });
});

describe('cashback config', () => {
  const upsertPath = '/api/admin/merchant-cashback-configs/acme';

  it('writes the rate and a history entry recording what it was before', async () => {
    const first = await app.request(upsertPath, {
      ...adminWrite({ userCashbackPct: 5, reason: 'launch rate' }, 'cashback-config'),
      method: 'PUT',
    });
    expect(first.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 2));

    const second = await app.request(upsertPath, {
      ...adminWrite({ userCashbackPct: 2.5, reason: 'margin squeeze' }, 'cashback-config'),
      method: 'PUT',
    });
    expect(second.status).toBe(200);

    const live = await db.collection('merchant_cashback_configs').findOne({ merchantId: 'acme' });
    expect(live).toMatchObject({
      userCashbackPct: 2.5,
      active: true,
      updatedBy: 'admin@loop.test',
    });

    const res = await app.request(`${upsertPath}/history`, asAdmin());
    const body = (await res.json()) as {
      history: Array<{
        priorUserCashbackPct: number | null;
        newUserCashbackPct: number;
        reason: string;
      }>;
    };
    expect(body.history).toHaveLength(2);
    expect(body.history[0]).toMatchObject({
      priorUserCashbackPct: 5,
      newUserCashbackPct: 2.5,
      reason: 'margin squeeze',
    });
    expect(body.history[1]?.priorUserCashbackPct).toBeNull();
  });

  it('refuses the write without a step-up token', async () => {
    const res = await app.request(upsertPath, {
      ...adminWrite({ userCashbackPct: 5, reason: 'no step-up' }),
      method: 'PUT',
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('STEP_UP_REQUIRED');
  });

  it('refuses a step-up token minted for a different action class', async () => {
    const res = await app.request(upsertPath, {
      ...adminWrite({ userCashbackPct: 5, reason: 'wrong scope' }, 'staff-role-grant'),
      method: 'PUT',
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { code: string }).code).toBe('STEP_UP_PURPOSE_MISMATCH');
  });

  it('rejects a rate above 100% of face value', async () => {
    const res = await app.request(upsertPath, {
      ...adminWrite({ userCashbackPct: 150, reason: 'nope' }, 'cashback-config'),
      method: 'PUT',
    });
    expect(res.status).toBe(400);
  });
});

describe('CSV exports', () => {
  it('neutralises a formula-injection payload in a merchant name', async () => {
    merchantStore.merchants = [{ id: 'evil', name: '=HYPERLINK("http://evil/","click")' }];
    try {
      const res = await app.request('/api/admin/merchants-catalog.csv', asAdmin());
      const text = await res.text();
      expect(text).toContain(`"'=HYPERLINK(""http://evil/"",""click"")"`);
      expect(text).not.toMatch(/,=HYPERLINK/);
    } finally {
      merchantStore.merchants = [{ id: 'acme', name: 'Acme, Inc "Rewards"' }];
    }
  });

  it('flags a merchant with no cashback config, which is silently on the fallback split', async () => {
    const res = await app.request('/api/admin/merchants-catalog.csv', asAdmin());
    const text = await res.text();
    expect(text).toContain('has_cashback_config');
    expect(text.trim().split('\n')[1]).toContain('false');
  });
});

describe('audit tail', () => {
  it('records an applied admin write, resolving the actor email at read time', async () => {
    await app.request('/api/admin/merchant-cashback-configs/acme', {
      ...adminWrite({ userCashbackPct: 5, reason: 'launch rate' }, 'cashback-config'),
      method: 'PUT',
    });

    const res = await app.request('/api/admin/audit-tail', asAdmin());
    const body = (await res.json()) as {
      rows: Array<{ actorEmail: string | null; method: string; path: string; status: number }>;
    };
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({
      actorEmail: 'admin@loop.test',
      method: 'PUT',
      path: '/api/admin/merchant-cashback-configs/acme',
      status: 200,
    });
  });

  it('does not echo the stored response body', async () => {
    await db.collection('admin_idempotency_keys').insertOne({
      adminUserId: ADMIN_ID,
      key: 'k'.repeat(24),
      method: 'POST',
      path: '/api/admin/whatever',
      status: 200,
      responseBody: JSON.stringify({ secretInsideTheSnapshot: true }),
      createdAt: new Date(),
    });

    const res = await app.request('/api/admin/audit-tail', asAdmin());
    expect(await res.text()).not.toContain('secretInsideTheSnapshot');
  });
});

describe('discord wiring', () => {
  it('reports each channel as configured or missing, never the URL', async () => {
    const res = await app.request('/api/admin/discord/config', asAdmin());
    expect(await res.json()).toEqual({
      orders: 'missing',
      monitoring: 'missing',
      adminAudit: 'missing',
    });
  });

  it('409s a test ping at an unconfigured channel instead of silently succeeding', async () => {
    const res = await app.request('/api/admin/discord/test', {
      ...adminWrite({ channel: 'orders' }),
      method: 'POST',
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('WEBHOOK_NOT_CONFIGURED');
  });
});
