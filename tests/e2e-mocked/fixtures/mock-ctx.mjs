#!/usr/bin/env node
/**
 * Mock CTX upstream server for deterministic end-to-end testing.
 *
 * Replaces https://spend.ctx.com for the duration of a test run. Implements
 * just enough of the real CTX surface to drive the Loop backend's auth,
 * merchant sync, order create, and order polling paths. Holds all state
 * in memory — starts fresh on every spawn.
 *
 * Deviation from real CTX:
 *   - OTP validation accepts a single hard-coded code ('123456'). Real CTX
 *     emails a random one.
 *   - Orders begin in status 'unpaid' and only transition to 'fulfilled'
 *     when a test calls POST /_test/mark-paid/:id. Real CTX flips on chain
 *     confirmation.
 *   - Merchant/location data is seeded with a small fixed catalog.
 *   - ctx-interop: every merchant carries a flat 2% operator-commission
 *     spread (MOCK_OPERATOR_COMMISSION_BPS) on top of its user discount;
 *     fulfilment accrues a commission entry, GET /companies/:id/commission
 *     (+ /settlements, /entries) reads the ledger, and
 *     POST /_test/settle-commission stands in for the real CTX
 *     `commission-settlement` system trigger. POST /users echoes an id so
 *     the act-as provisioning path works offline.
 *
 * Usage:
 *   node tests/e2e-mocked/fixtures/mock-ctx.mjs            # runs on :9091
 *   PORT=9099 node tests/e2e-mocked/fixtures/mock-ctx.mjs  # custom port
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9091);
const OTP = '123456';

// Q6-4 (loop-native purchase-through-the-UI e2e): the operator-side
// procurement worker (apps/backend/src/orders/procure-one.ts) parses
// this destination out of `paymentUrls.XLM` via `parseSep7PayUri` and
// hands it straight to `@stellar/stellar-sdk`'s `Operation.payment`,
// which throws on an invalid StrKey checksum. The legacy CTX-proxy
// flow (the only consumer before Q6-4) never validates this value —
// it just displays it to the end user as text — so a syntactically
// invalid placeholder was harmless there. A real, checksum-valid G...
// address (never funded, never used on any real network) keeps both
// consumers working from the same fixture.
const CTX_MOCK_DESTINATION = 'GAY6JKQ5XYKHLEM5QJU7P336Y675XAJKYH56HX3UHHCZO7KVWWAVYOKJ';

// ───────── Seed data ─────────────────────────────────────────────────

const merchants = [
  {
    id: 'mock-amazon',
    name: 'Amazon',
    enabled: true,
    savingsPercentage: 300,
    denominationsType: 'min-max',
    denominations: ['5', '500'],
    currency: 'USD',
    info: { description: 'Shop online.', instructions: 'Redeem at amazon.com.' },
  },
  {
    id: 'mock-target',
    name: 'Target',
    enabled: true,
    savingsPercentage: 200,
    denominationsType: 'fixed',
    denominations: ['10', '25', '50', '100'],
    currency: 'USD',
    info: { description: 'General retail.' },
  },
  {
    id: 'mock-starbucks',
    name: 'Starbucks',
    enabled: true,
    savingsPercentage: 100,
    denominationsType: 'fixed',
    denominations: ['5', '10', '25'],
    currency: 'USD',
  },
];

// ───────── In-memory state ───────────────────────────────────────────

/**
 * Order shape (JSDoc since this is a plain .mjs file):
 *   { id, merchantId, merchantName, cardFiatAmount, cardFiatCurrency,
 *     paymentCryptoAmount, paymentUrls: {XLM}, status, fulfilmentStatus,
 *     percentDiscount, redeemType?, redeemUrl?, redeemUrlChallenge?,
 *     redeemScripts?, created }
 *
 * status transitions: 'unpaid' → (POST /_test/mark-fulfilled) → 'fulfilled'.
 */
const orders = new Map();
const validRefreshTokens = new Set();

// ctx-interop: operator-commission ledger. Every fulfilled order
// accrues `fiat × MOCK_OPERATOR_COMMISSION_BPS / 10000` for the mock
// operator company; POST /_test/settle-commission groups unsettled
// entries into a settlement, mirroring the real CTX
// `commission-settlement` system trigger.
const MOCK_OPERATOR_COMMISSION_BPS = 200;
const MOCK_OPERATOR_COMPANY_ID = 'mock-loop-co';
const commissionEntries = [];
const commissionSettlements = [];
const provisionedUsers = new Map();

// ───────── Helpers ───────────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function makeTokens() {
  const accessToken = `mock-at-${randomUUID()}`;
  const refreshToken = `mock-rt-${randomUUID()}`;
  validRefreshTokens.add(refreshToken);
  return { accessToken, refreshToken };
}

// ───────── Request router ────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const parsed = new URL(url, `http://localhost:${PORT}`);
  const path = parsed.pathname;

  // ── Health / status ──
  if (method === 'GET' && path === '/status') {
    return json(res, 200, { status: 'ok' });
  }

  // ── Auth ──
  if (method === 'POST' && path === '/login') {
    const body = await readBody(req);
    if (!body.email) return json(res, 400, { error: 'email required' });
    return json(res, 200, { message: 'OTP sent' });
  }

  if (method === 'POST' && path === '/verify-email') {
    const body = await readBody(req);
    if (!body.email || !body.code) return json(res, 400, { error: 'email and code required' });
    if (body.code !== OTP) return json(res, 401, { error: 'invalid code' });
    return json(res, 200, makeTokens());
  }

  if (method === 'POST' && path === '/refresh-token') {
    const body = await readBody(req);
    if (!body.refreshToken || !validRefreshTokens.has(body.refreshToken)) {
      return json(res, 401, { error: 'invalid refresh token' });
    }
    validRefreshTokens.delete(body.refreshToken);
    return json(res, 200, makeTokens());
  }

  if (method === 'POST' && path === '/logout') {
    const body = await readBody(req);
    if (body.refreshToken) validRefreshTokens.delete(body.refreshToken);
    return json(res, 200, { message: 'ok' });
  }

  // ── Merchants ──
  if (method === 'GET' && path === '/merchants') {
    return json(res, 200, {
      pagination: { page: 1, pages: 1, perPage: 100, total: merchants.length },
      result: merchants,
    });
  }

  // ── Locations (empty; map testing not in scope) ──
  if (method === 'GET' && path === '/locations') {
    return json(res, 200, {
      pagination: { page: 1, pages: 1, perPage: 1000, total: 0 },
      result: [],
    });
  }

  // ── Orders ──
  if (method === 'POST' && path === '/gift-cards') {
    const body = await readBody(req);
    const merchant = merchants.find((m) => m.id === body.merchantId);
    if (!merchant) return json(res, 404, { error: 'merchant not found' });
    const id = randomUUID();
    const xlmAmount = (Number(body.fiatAmount) * 5).toFixed(4); // fake rate
    const memo = `ctx:${id.slice(0, 10)}`;
    // ctx-interop: operator discount = user discount + the mock
    // commission spread, mirroring the spend-api model at an implied
    // 100% profit share (real CTX: commission = spread × company
    // profit share; the spread is capped by the provider discount,
    // which the mock has no tier for). Surfaces the same fields the
    // real API added.
    const userDiscountBps = merchant.savingsPercentage ?? 0;
    const operatorDiscountBps = userDiscountBps + MOCK_OPERATOR_COMMISSION_BPS;
    const fiat = Number(body.fiatAmount);
    const operatorFiat = fiat * (1 - operatorDiscountBps / 10000);
    const order = {
      id,
      merchantId: merchant.id,
      merchantName: merchant.name,
      cardFiatAmount: body.fiatAmount,
      cardFiatCurrency: body.fiatCurrency ?? merchant.currency,
      paymentCryptoAmount: xlmAmount,
      paymentUrls: {
        XLM: `web+stellar:pay?destination=${CTX_MOCK_DESTINATION}&amount=${xlmAmount}&memo=${encodeURIComponent(memo)}`,
      },
      status: 'unpaid',
      fulfilmentStatus: 'pending',
      percentDiscount: ((merchant.savingsPercentage ?? 0) / 100).toFixed(2),
      operatorDiscount: operatorDiscountBps,
      operatorPercentDiscount: (operatorDiscountBps / 100).toFixed(2),
      operatorFiatAmount: operatorFiat.toFixed(2),
      operatorFiatCurrency: body.fiatCurrency ?? merchant.currency,
      operatorCryptoAmount: (Number(xlmAmount) * (operatorFiat / fiat || 0)).toFixed(4),
      operatorCryptoCurrency: 'XLM',
      ...(body.operatorReference ? { operatorReference: body.operatorReference } : {}),
      created: new Date().toISOString(),
    };
    orders.set(id, order);
    return json(res, 200, order);
  }

  if (method === 'GET' && path === '/gift-cards') {
    return json(res, 200, {
      pagination: { page: 1, pages: 1, perPage: 20, total: orders.size },
      result: [...orders.values()],
    });
  }

  const orderMatch = path.match(/^\/gift-cards\/([^/]+)$/);
  if (method === 'GET' && orderMatch) {
    const order = orders.get(orderMatch[1]);
    if (!order) return json(res, 404, { error: 'order not found' });
    return json(res, 200, order);
  }

  // ── Test-only endpoints (flip an order to fulfilled deterministically) ──
  const markPaidMatch = path.match(/^\/_test\/mark-fulfilled\/([^/]+)$/);
  if (method === 'POST' && markPaidMatch) {
    const order = orders.get(markPaidMatch[1]);
    if (!order) return json(res, 404, { error: 'order not found' });
    const body = await readBody(req);
    order.status = 'fulfilled';
    order.fulfilmentStatus = 'completed';
    // ctx-interop: accrue the operator commission on fulfilment,
    // idempotent per gift card like the real flow's unique index.
    if (!commissionEntries.some((entry) => entry.giftCardId === order.id)) {
      commissionEntries.push({
        id: randomUUID(),
        companyId: MOCK_OPERATOR_COMPANY_ID,
        type: 'commission',
        direction: 'credit',
        amount: ((Number(order.cardFiatAmount) * MOCK_OPERATOR_COMMISSION_BPS) / 10000).toFixed(2),
        currency: order.cardFiatCurrency,
        giftCardId: order.id,
        ...(order.operatorReference ? { operatorReference: order.operatorReference } : {}),
        settlementId: '',
        created: new Date().toISOString(),
      });
    }
    // Default: URL-based redemption (PurchaseContainer will transition to
    // the 'redeem' step). Tests can override via `?type=barcode` to hit
    // the giftCardCode path if the backend ever passes those through.
    if (body.type === 'barcode') {
      order.redeemType = 'barcode';
    } else {
      order.redeemType = 'url';
      order.redeemUrl = 'https://redeem.test/mock';
      order.redeemUrlChallenge = 'MOCK-CHALLENGE-' + order.id.slice(0, 6);
    }
    return json(res, 200, order);
  }

  // ── ctx-interop: operator identity (company id is evaluated from
  // /me under API-key auth, never configured) ──
  if (method === 'GET' && path === '/me') {
    return json(res, 200, {
      user: { id: 'mock-api-user', email: 'api@loop.test' },
      company: { id: MOCK_OPERATOR_COMPANY_ID, name: 'Loop', type: 'operator' },
    });
  }

  // ── ctx-interop: user provisioning (act-as) ──
  if (method === 'POST' && path === '/users') {
    const body = await readBody(req);
    if (!body.email) return json(res, 400, { error: 'email required' });
    const existing = provisionedUsers.get(body.email);
    if (existing) return json(res, 400, { error: 'user already exists' });
    const user = { id: randomUUID(), email: body.email, operatorUserId: body.operatorUserId ?? '' };
    provisionedUsers.set(body.email, user);
    return json(res, 201, { id: user.id });
  }

  // ── ctx-interop: operator commission ──
  const commissionMatch = path.match(/^\/companies\/([^/]+)\/commission$/);
  if (method === 'GET' && commissionMatch) {
    const unsettled = commissionEntries.filter((entry) => entry.settlementId === '');
    const byCurrency = new Map();
    for (const entry of unsettled) {
      const sum = byCurrency.get(entry.currency) ?? { amount: 0, entryCount: 0 };
      sum.amount += Number(entry.amount) * (entry.direction === 'debit' ? -1 : 1);
      sum.entryCount += 1;
      byCurrency.set(entry.currency, sum);
    }
    const rsp = {
      companyId: commissionMatch[1],
      balances: [...byCurrency.entries()].map(([currency, sum]) => ({
        currency,
        amount: sum.amount.toFixed(2),
        entryCount: sum.entryCount,
      })),
    };
    const latest = commissionSettlements[commissionSettlements.length - 1];
    if (latest) {
      rsp.lastSettlementAt = latest.created;
      rsp.lastSettlementId = latest.id;
    }
    return json(res, 200, rsp);
  }

  const settlementsMatch = path.match(/^\/companies\/([^/]+)\/commission\/settlements$/);
  if (method === 'GET' && settlementsMatch) {
    const result = [...commissionSettlements].reverse();
    return json(res, 200, {
      pagination: { page: 1, pages: 1, perPage: 25, total: result.length },
      result,
    });
  }

  const entriesMatch = path.match(/^\/companies\/([^/]+)\/commission\/entries$/);
  if (method === 'GET' && entriesMatch) {
    const result = [...commissionEntries].reverse();
    return json(res, 200, {
      pagination: { page: 1, pages: 1, perPage: 25, total: result.length },
      result,
    });
  }

  // ── ctx-interop test-only: run a commission settlement ──
  if (method === 'POST' && path === '/_test/settle-commission') {
    const unsettled = commissionEntries.filter((entry) => entry.settlementId === '');
    const settlements = [];
    const byCurrency = new Map();
    for (const entry of unsettled) {
      const bucket = byCurrency.get(entry.currency) ?? [];
      bucket.push(entry);
      byCurrency.set(entry.currency, bucket);
    }
    for (const [currency, bucket] of byCurrency) {
      const settlement = {
        id: randomUUID(),
        companyId: MOCK_OPERATOR_COMPANY_ID,
        amount: bucket
          .reduce(
            (sum, entry) => sum + Number(entry.amount) * (entry.direction === 'debit' ? -1 : 1),
            0,
          )
          .toFixed(2),
        currency,
        periodStart: bucket[0].created,
        periodEnd: new Date().toISOString(),
        giftCardIds: bucket.map((entry) => entry.giftCardId).filter(Boolean),
        entryIds: bucket.map((entry) => entry.id),
        entryCount: bucket.length,
        created: new Date().toISOString(),
      };
      for (const entry of bucket) entry.settlementId = settlement.id;
      commissionSettlements.push(settlement);
      settlements.push(settlement);
    }
    return json(res, 200, { result: settlements, count: settlements.length });
  }

  if (method === 'POST' && path === '/_test/reset') {
    orders.clear();
    validRefreshTokens.clear();
    commissionEntries.length = 0;
    commissionSettlements.length = 0;
    provisionedUsers.clear();
    return json(res, 200, { message: 'reset' });
  }

  return json(res, 404, { error: `unknown route ${method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`[mock-ctx] listening on :${PORT}`);
});

// Graceful shutdown so Playwright's webServer can stop cleanly.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
