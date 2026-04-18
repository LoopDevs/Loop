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
 *
 * Usage:
 *   node tests/e2e-mocked/fixtures/mock-ctx.mjs            # runs on :9091
 *   PORT=9099 node tests/e2e-mocked/fixtures/mock-ctx.mjs  # custom port
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9091);
const OTP = '123456';

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
    const order = {
      id,
      merchantId: merchant.id,
      merchantName: merchant.name,
      cardFiatAmount: body.fiatAmount,
      cardFiatCurrency: body.fiatCurrency ?? merchant.currency,
      paymentCryptoAmount: xlmAmount,
      paymentUrls: {
        XLM: `web+stellar:pay?destination=GMOCK0000000000000000000000000000000000000000000000000000&amount=${xlmAmount}&memo=${encodeURIComponent(memo)}`,
      },
      status: 'unpaid',
      fulfilmentStatus: 'pending',
      percentDiscount: ((merchant.savingsPercentage ?? 0) / 100).toFixed(2),
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

  if (method === 'POST' && path === '/_test/reset') {
    orders.clear();
    validRefreshTokens.clear();
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
