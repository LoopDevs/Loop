#!/usr/bin/env node
/**
 * Mock CTX upstream server for deterministic end-to-end testing.
 *
 * Replaces https://spend.ctx.com for the duration of a test run. Implements
 * just enough of the real CTX surface to drive the Loop backend's merchant
 * sync, user sign-in, order create, and order polling paths. Holds all
 * state in memory — starts fresh on every spawn.
 *
 * Deviation from real CTX:
 *   - Orders begin in status 'unpaid' and only transition to 'fulfilled'
 *     when a test calls POST /_test/mark-paid/:id. Real CTX flips on chain
 *     confirmation.
 *   - Merchant/location data is seeded with a small fixed catalog.
 *   - ctx-interop: every merchant carries a flat 2% operator-commission
 *     spread (MOCK_OPERATOR_COMMISSION_BPS) on top of its user discount;
 *     fulfilment accrues a commission entry, GET /companies/:id/commission
 *     (+ /settlements, /entries) reads the ledger. GET /users (regex email
 *     filter), POST /users, GET /users/:id and POST /users/:id/status
 *     back sign-in.
 *
 * Usage:
 *   node tests/e2e-mocked/fixtures/mock-ctx.mjs            # runs on :9091
 *   PORT=9099 node tests/e2e-mocked/fixtures/mock-ctx.mjs  # custom port
 */
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9091);

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

// `updated` mirrors the real CTX field (bumped on every merchant edit) —
// Loop maps it to `Merchant.updatedAt` and uses it as the image-proxy
// cache-busting version.
const SEED_UPDATED = new Date().toISOString();
const merchants = [
  {
    id: 'mock-amazon',
    name: 'Amazon',
    enabled: true,
    updated: SEED_UPDATED,
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
    updated: SEED_UPDATED,
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
    updated: SEED_UPDATED,
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
 *     userDiscountBasisPoints, redeemType?, redeemUrl?, redeemUrlChallenge?,
 *     redeemScripts?, created }
 *
 * status transitions: 'unpaid' → (POST /_test/mark-fulfilled) → 'fulfilled'.
 */
const orders = new Map();

// ctx-interop: operator-commission ledger. Every fulfilled order
// accrues `fiat × MOCK_OPERATOR_COMMISSION_BPS / 10000` for the mock
// operator company.
const MOCK_OPERATOR_COMMISSION_BPS = 200;
const MOCK_OPERATOR_COMPANY_ID = 'mock-loop-co';
const commissionEntries = [];
const commissionSettlements = [];
const provisionedUsers = new Map();
const walletLinks = new Map();
const payouts = new Map();
// ctx-interop: savings positions per user, keyed `${userId}:${currency}`; deposits settle instantly like the ctxmock provider
const savingsPositions = new Map();
const savingsOperations = [];

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

function savingsPositionJson(position) {
  return {
    potId: `pot-ctxmock-${position.currency}`,
    owner: `system:account:user:${position.userId}:savings`,
    currency: position.currency,
    provider: 'ctxmock',
    principal: position.principal.toFixed(7),
    value: position.value.toFixed(7),
    earnt: (position.value - position.principal).toFixed(7),
    locked: '0.0000000',
    available: position.value.toFixed(7),
  };
}

function walletLinkJson(link) {
  return {
    id: link.id,
    chain: link.chain,
    address: link.address,
    autoPayout: link.autoPayout,
    status: link.status,
    created: link.created,
    ...(link.removedAt ? { removed: link.removedAt } : {}),
  };
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

  // ── Merchants ──
  if (method === 'GET' && path === '/merchants') {
    const perPage = Number(parsed.searchParams.get('perPage') ?? 100) || 100;
    return json(res, 200, {
      pagination: { page: 1, pages: 1, perPage, total: merchants.length },
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
      displayStatus: 'unpaid',
      fulfilmentStatus: 'pending',
      userDiscountBasisPoints: userDiscountBps,
      operatorDiscountBasisPoints: operatorDiscountBps,
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
    const statusFilter = parsed.searchParams.get('status');
    const statuses = statusFilter ? new Set(statusFilter.toLowerCase().split(',')) : null;
    const result = [...orders.values()].filter(
      (order) => statuses === null || statuses.has(order.displayStatus),
    );
    return json(res, 200, {
      pagination: { page: 1, pages: 1, perPage: 20, total: result.length },
      result,
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
    order.displayStatus = 'fulfilled';
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
    broadcastEvent('giftcard', 'system.giftcard.fulfilled', order);
    return json(res, 200, order);
  }

  // ── ctx-interop: operator identity (company id is evaluated from
  // /me under API-key auth, never configured) ──
  if (method === 'GET' && path === '/currencies') {
    return json(res, 200, {
      result: [
        { code: 'USD', name: 'US Dollar', decimals: 2, crypto: false },
        { code: 'GBP', name: 'British Pound', decimals: 2, crypto: false },
        { code: 'EUR', name: 'Euro', decimals: 2, crypto: false },
        { code: 'XLM', name: 'Stellar Lumens', decimals: 7, crypto: true, chain: 'XLM' },
        { code: 'XLM.USDC', name: 'USDC on Stellar', decimals: 7, crypto: true, chain: 'XLM' },
      ],
    });
  }

  if (method === 'GET' && path === '/me') {
    return json(res, 200, {
      user: { id: 'mock-api-user', email: 'api@loop.test' },
      company: {
        id: MOCK_OPERATOR_COMPANY_ID,
        name: 'Loop',
        type: 'operator',
        disableUserEmails: true,
        countries: ['US', 'GB', 'CA', 'DE', 'FR'],
        paymentCurrencies: ['XLM'],
        stableCurrencies: ['XLM.USDC'],
        profitShareBasisPoints: 5000,
      },
    });
  }

  // ── ctx-interop: user provisioning (act-as) ──
  // Mirrors the real CTX validation envelope on rejection
  // (`{ error: 'bad request', fields: { <field>: [msgs] } }`).
  if (method === 'POST' && path === '/users') {
    const body = await readBody(req);
    if (!body.email)
      return json(res, 400, { error: 'bad request', fields: { email: ['required'] } });
    const email = String(body.email).trim().toLowerCase();
    if (provisionedUsers.has(email))
      return json(res, 400, { error: 'bad request', fields: { email: ['already exists'] } });
    const user = {
      id: randomUUID(),
      email,
      type: body.type ?? 'customer',
      status: body.status === 'enabled' ? 'enabled' : 'email_unverified',
      stableCurrency: String(body.stableCurrency ?? 'XLM.USDC').toUpperCase(),
    };
    provisionedUsers.set(email, user);
    return json(res, 201, { id: user.id, stableCurrency: user.stableCurrency });
  }

  // Real CTX filters `email` as an unanchored case-insensitive regex.
  if (method === 'GET' && path === '/users') {
    const emailFilter = parsed.searchParams.get('email');
    let result = [...provisionedUsers.values()];
    if (emailFilter) {
      const re = new RegExp(emailFilter, 'i');
      result = result.filter((u) => re.test(u.email));
    }
    const typeFilter = parsed.searchParams.get('type');
    if (typeFilter) result = result.filter((u) => u.type === typeFilter);
    return json(res, 200, {
      result: result.map((u) => ({
        id: u.id,
        email: u.email,
        type: u.type,
        status: u.status,
        stableCurrency: u.stableCurrency,
      })),
      pagination: { page: 1, perPage: 50, total: result.length },
    });
  }

  const userStatusMatch = path.match(/^\/users\/([^/]+)\/status$/);
  if (method === 'POST' && userStatusMatch) {
    const target = [...provisionedUsers.values()].find((u) => u.id === userStatusMatch[1]);
    if (!target) return json(res, 404, { error: 'not found' });
    const body = await readBody(req);
    if (!['enabled', 'disabled', 'suspended'].includes(body.status))
      return json(res, 400, { error: 'bad request', fields: { status: ['invalid'] } });
    target.status = body.status;
    return json(res, 200, {
      id: target.id,
      email: target.email,
      type: target.type,
      status: target.status,
      stableCurrency: target.stableCurrency,
      cashbackDestination: target.cashbackDestination ?? 'account',
      roles: [],
    });
  }

  const userUpdateMatch = path.match(/^\/users\/([^/]+)$/);
  if (method === 'GET' && userUpdateMatch) {
    const target = [...provisionedUsers.values()].find((u) => u.id === userUpdateMatch[1]);
    if (!target) return json(res, 404, { error: 'not found' });
    return json(res, 200, {
      id: target.id,
      email: target.email,
      type: target.type,
      status: target.status,
      stableCurrency: target.stableCurrency,
      cashbackDestination: target.cashbackDestination ?? 'account',
      roles: [],
    });
  }
  if (method === 'PUT' && userUpdateMatch) {
    const target = [...provisionedUsers.values()].find((u) => u.id === userUpdateMatch[1]);
    if (!target) return json(res, 404, { error: 'not found' });
    const body = await readBody(req);
    if (body.stableCurrency !== undefined) {
      const stableCurrency = String(body.stableCurrency).toUpperCase();
      if (!['XLM.USDC', 'XLM.EURC', 'XLM.GBPLOOP'].includes(stableCurrency))
        return json(res, 400, {
          error: 'bad request',
          fields: { stableCurrency: ['not supported by company'] },
        });
      target.stableCurrency = stableCurrency;
    }
    if (body.cashbackDestination !== undefined) {
      const destination = String(body.cashbackDestination).toLowerCase();
      if (!['account', 'savings'].includes(destination))
        return json(res, 400, {
          error: 'bad request',
          fields: { cashbackDestination: ['must be account or savings'] },
        });
      target.cashbackDestination = destination;
    }
    return json(res, 200, {
      id: target.id,
      email: target.email,
      type: target.type,
      status: target.status,
      stableCurrency: target.stableCurrency,
      cashbackDestination: target.cashbackDestination ?? 'account',
    });
  }

  // ── ctx-interop: per-user account + wallet links (act-as) ──
  const accountMatch = path.match(/^\/users\/([^/]+)\/account$/);
  if (method === 'GET' && accountMatch) {
    const userId = accountMatch[1];
    const links = [...walletLinks.values()].filter((l) => l.userId === userId);
    const userPayouts = [...payouts.values()].filter((p) => p.userId === userId);
    const positions = [...savingsPositions.values()].filter((p) => p.userId === userId);
    return json(res, 200, {
      id: `acct-${userId}`,
      userId,
      wallet: [],
      savings: positions.map(savingsPositionJson),
      savingsPrincipal: positions.map((p) => ({
        currency: p.currency,
        amount: p.principal.toFixed(7),
      })),
      pendingOperations: [],
      linkedWallets: links.map(walletLinkJson),
      payouts: userPayouts,
      created: SEED_UPDATED,
      updated: new Date().toISOString(),
    });
  }

  const savingsMoveMatch = path.match(
    /^\/users\/([^/]+)\/account\/savings\/(deposits|withdrawals)$/,
  );
  if (method === 'POST' && savingsMoveMatch) {
    const [, userId, kind] = savingsMoveMatch;
    const body = await readBody(req);
    const currency = String(body.currency ?? '').toUpperCase();
    const amount = Number(body.amount);
    const fields = {};
    if (!['XLM.USDC', 'XLM.EURC', 'XLM.GBPLOOP'].includes(currency))
      fields.currency = ['savings are not available for this currency'];
    if (!Number.isFinite(amount) || amount <= 0) fields.amount = ['must be a positive number'];
    if (Object.keys(fields).length) return json(res, 400, { error: 'bad request', fields });
    const key = `${userId}:${currency}`;
    const position = savingsPositions.get(key) ?? { userId, currency, principal: 0, value: 0 };
    if (kind === 'withdrawals') {
      if (!savingsPositions.has(key))
        return json(res, 404, { error: 'no savings position for this currency' });
      if (amount > position.value) return json(res, 400, { error: 'insufficient balance' });
      const released = (position.principal * amount) / position.value;
      position.principal -= released;
      position.value -= amount;
      if (position.value <= 0) savingsPositions.delete(key);
    } else {
      position.principal += amount;
      position.value += amount;
      savingsPositions.set(key, position);
    }
    const operation = {
      id: `sop-${savingsOperations.length + 1}`,
      type: kind === 'deposits' ? 'deposit' : 'withdraw',
      potId: `pot-ctxmock-${currency}`,
      status: 'complete',
      currency,
      amount: amount.toFixed(7),
      created: new Date().toISOString(),
      finalisedAt: new Date().toISOString(),
    };
    savingsOperations.push(operation);
    return json(res, 201, operation);
  }

  const walletsMatch = path.match(/^\/users\/([^/]+)\/wallets$/);
  if (method === 'POST' && walletsMatch) {
    const userId = walletsMatch[1];
    const body = await readBody(req);
    const fields = {};
    if (body.chain !== 'XLM') fields.chain = ['unsupported chain'];
    if (!/^G[A-Z2-7]{55}$/.test(String(body.address ?? ''))) fields.address = ['invalid'];
    if (Object.keys(fields).length > 0) return json(res, 400, { error: 'bad request', fields });
    for (const link of walletLinks.values()) {
      if (link.userId === userId && link.chain === body.chain && link.status === 'active') {
        link.status = 'removed';
        link.removedAt = new Date().toISOString();
      }
    }
    const link = {
      id: randomUUID(),
      userId,
      chain: body.chain,
      address: body.address,
      autoPayout: body.autoPayout !== false,
      status: 'active',
      created: new Date().toISOString(),
      removedAt: '',
    };
    walletLinks.set(link.id, link);
    return json(res, 201, walletLinkJson(link));
  }
  if (method === 'GET' && walletsMatch) {
    const links = [...walletLinks.values()].filter((l) => l.userId === walletsMatch[1]);
    return json(res, 200, { result: links.map(walletLinkJson) });
  }

  const walletMatch = path.match(/^\/users\/([^/]+)\/wallets\/([^/]+)$/);
  if ((method === 'PUT' || method === 'DELETE') && walletMatch) {
    const link = walletLinks.get(walletMatch[2]);
    if (!link || link.userId !== walletMatch[1]) return json(res, 404, { error: 'not found' });
    if (method === 'PUT') {
      const body = await readBody(req);
      if (typeof body.autoPayout === 'boolean') link.autoPayout = body.autoPayout;
    } else {
      link.status = 'removed';
      link.removedAt = new Date().toISOString();
    }
    return json(res, 200, walletLinkJson(link));
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

  // ── ws-interop test-only: mutate a merchant + emit the ws event the
  // real CTX fires on merchant edits. Body: { id, ...fields } upserts
  // (created event when the id is new, updated otherwise, with `updated`
  // bumped like the real API); { id, _delete: true } removes and emits
  // the deleted event. Loop's backend maintains its merchant store from
  // these events (apps/backend/src/merchants/ws-maintainer.ts).
  if (method === 'POST' && path === '/_test/update-merchant') {
    const body = await readBody(req);
    if (!body.id) return json(res, 400, { error: 'id required' });
    const index = merchants.findIndex((m) => m.id === body.id);
    if (body._delete === true) {
      if (index === -1) return json(res, 404, { error: 'merchant not found' });
      const [removed] = merchants.splice(index, 1);
      broadcastMerchantEvent('system.merchant.deleted', removed);
      return json(res, 200, removed);
    }
    const { _delete, ...fields } = body;
    void _delete;
    const merchant = {
      ...(index === -1 ? { enabled: true, currency: 'USD' } : merchants[index]),
      ...fields,
      updated: new Date().toISOString(),
    };
    if (!merchant.name) return json(res, 400, { error: 'name required for a new merchant' });
    if (index === -1) {
      merchants.push(merchant);
      broadcastMerchantEvent('system.merchant.created', merchant);
    } else {
      merchants[index] = merchant;
      broadcastMerchantEvent('system.merchant.updated', merchant);
    }
    return json(res, 200, merchant);
  }

  if (method === 'POST' && path === '/_test/reset') {
    orders.clear();
    commissionEntries.length = 0;
    commissionSettlements.length = 0;
    provisionedUsers.clear();
    walletLinks.clear();
    payouts.clear();
    return json(res, 200, { message: 'reset' });
  }

  return json(res, 404, { error: `unknown route ${method} ${path}` });
});

// ───────── Websocket endpoint (GET /ws upgrade) ──────────────────────
//
// Minimal hand-rolled RFC 6455 server — enough for Loop's merchant-store
// maintainer: subscribe/unsubscribe commands in, `{type:'event'}` frames
// out. Mirrors the real spend-api /ws contract (http_ws.go):
//   client → {"action":"subscribe","topic":"merchant"}
//   server → {"type":"ok","action":"subscribe","subscriptions":[...]}
//   server → {"type":"event","topic":"merchant",
//             "event":"system.merchant.updated","data":{...merchant}}
// No auth check (consistent with the rest of the mock), no ping cadence
// (test runs are seconds long), no fragmented/binary frame support.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Set<{ socket, subscriptions: Set<string> }> */
const wsClients = new Set();

/** Builds an unmasked server→client text frame. */
function wsTextFrame(payload) {
  const data = Buffer.from(payload, 'utf8');
  let header;
  if (data.length < 126) {
    header = Buffer.from([0x81, data.length]);
  } else if (data.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  return Buffer.concat([header, data]);
}

function wsSend(client, message) {
  try {
    client.socket.write(wsTextFrame(JSON.stringify(message)));
  } catch {
    wsClients.delete(client);
  }
}

function broadcastEvent(topic, eventName, data) {
  for (const client of wsClients) {
    if (!client.subscriptions.has(topic)) continue;
    wsSend(client, { type: 'event', topic, event: eventName, data });
  }
}

function broadcastMerchantEvent(eventName, merchant) {
  broadcastEvent('merchant', eventName, merchant);
}

/**
 * Parses complete client→server frames out of `client.buffer`, handling
 * text commands, pings, and close. Client frames are always masked per
 * RFC 6455 §5.3.
 */
function wsConsumeFrames(client) {
  const { socket } = client;
  while (true) {
    const buf = client.buffer;
    if (buf.length < 2) return;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskLen = masked ? 4 : 0;
    if (buf.length < offset + maskLen + len) return;
    const mask = masked ? buf.subarray(offset, offset + 4) : null;
    const payload = buf.subarray(offset + maskLen, offset + maskLen + len);
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    client.buffer = buf.subarray(offset + maskLen + len);

    if (opcode === 0x8) {
      // close → echo close, drop
      try {
        socket.write(Buffer.from([0x88, 0x00]));
      } catch {
        /* already gone */
      }
      socket.destroy();
      wsClients.delete(client);
      return;
    }
    if (opcode === 0x9) {
      // ping → pong with same payload
      const pong = Buffer.concat([Buffer.from([0x8a, payload.length]), payload]);
      socket.write(pong);
      continue;
    }
    if (opcode !== 0x1) continue; // ignore pong/binary/continuation

    let command = {};
    try {
      command = JSON.parse(payload.toString('utf8'));
    } catch {
      command = {};
    }
    if (command.action === 'subscribe' && command.topic) {
      client.subscriptions.add(command.topic);
      wsSend(client, {
        type: 'ok',
        action: 'subscribe',
        subscriptions: [...client.subscriptions].sort(),
      });
    } else if (command.action === 'unsubscribe' && command.topic) {
      client.subscriptions.delete(command.topic);
      wsSend(client, {
        type: 'ok',
        action: 'unsubscribe',
        subscriptions: [...client.subscriptions].sort(),
      });
    } else if (command.action === 'list') {
      wsSend(client, {
        type: 'ok',
        action: 'list',
        subscriptions: [...client.subscriptions].sort(),
      });
    } else {
      wsSend(client, {
        type: 'error',
        action: command.action ?? '',
        error: 'unknown action, expected: subscribe, unsubscribe, or list',
      });
    }
  }
}

server.on('upgrade', (req, socket) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  const wsKey = req.headers['sec-websocket-key'];
  if (pathname !== '/ws' || !wsKey) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  const accept = createHash('sha1')
    .update(wsKey + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const client = { socket, subscriptions: new Set(), buffer: Buffer.alloc(0) };
  wsClients.add(client);
  socket.on('data', (chunk) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    wsConsumeFrames(client);
  });
  const drop = () => {
    wsClients.delete(client);
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

server.listen(PORT, () => {
  console.log(`[mock-ctx] listening on :${PORT}`);
});

// Graceful shutdown so Playwright's webServer can stop cleanly. Open ws
// sockets are hijacked from the http server, so `server.close()` alone
// would wait on them forever — destroy them first.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const client of wsClients) client.socket.destroy();
    wsClients.clear();
    server.close(() => process.exit(0));
  });
}
