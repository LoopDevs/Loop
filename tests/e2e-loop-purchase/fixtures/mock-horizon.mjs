#!/usr/bin/env node
/**
 * Mock Stellar Horizon server for the loop-native purchase-through-the-UI
 * e2e suite (Q6-4, docs/money-auth-worklist.md).
 *
 * Replaces `LOOP_STELLAR_HORIZON_URL` for the duration of the test run.
 * Implements just enough of the real Horizon REST surface for the two
 * backend consumers this suite exercises against a REAL browser-driven
 * order:
 *
 *   - `apps/backend/src/payments/horizon.ts` (`listAccountPayments`) —
 *     a hand-rolled `fetch` + Zod client the payment watcher polls to
 *     detect the user's deposit. Talks to `GET /accounts/:id/payments`.
 *   - `@stellar/stellar-sdk`'s `Horizon.Server` (via
 *     `apps/backend/src/payments/payout-submit.ts`) — used by the
 *     procurement worker's `payCtxOrder` hop to pay CTX's mock
 *     destination in XLM from the operator account. Needs
 *     `GET /accounts/:id` (`loadAccount`, only `account_id` + `sequence`
 *     are read — see `@stellar/stellar-sdk`'s `AccountResponse`
 *     constructor) and `POST /transactions` (`submitTransaction`; a
 *     response with no `result_xdr` short-circuits the SDK's XDR
 *     decoding, so a minimal `{hash, ledger, successful}` body is
 *     sufficient).
 *
 * Also serves a CoinGecko-shaped `/rates` endpoint for
 * `LOOP_XLM_PRICE_FEED_URL` (`apps/backend/src/payments/price-feed.ts`)
 * so the XLM/USD conversion used by both the order-create response
 * (`assetAmount`) and the payment-watcher's amount check
 * (`isAmountSufficient`) is a fixed, network-independent rate instead
 * of a real external feed — the whole point of a deterministic e2e.
 *
 * Deviations from real Horizon (all deliberate, scoped to this test):
 *   - `POST /transactions` never inspects the submitted XDR. It
 *     doesn't verify signatures, sequence numbers, or operation
 *     contents — it just returns a canned success. This suite is
 *     testing LOOP's client code (does it build/sign/submit at all,
 *     does the UI reflect the resulting state), not Horizon's own
 *     validation.
 *   - `GET /accounts/:id/payments` returns a single flat, in-memory
 *     list seeded only by `POST /_test/inject-payment` (the deposit
 *     the test simulates landing). Outbound payments (the operator's
 *     own CTX settlement) are never appended, so the idempotency
 *     memo-scan in `payments/horizon-find-outbound.ts` always sees an
 *     empty page and falls through to a fresh submit — correct for a
 *     single-pass test that never re-runs procurement for the same
 *     order.
 *   - No signature/account-existence validation on `GET /accounts/:id`
 *     — any account id gets the same fixed sequence number back. Fine
 *     because this suite only ever builds ONE transaction per run.
 *
 * Usage:
 *   node tests/e2e-loop-purchase/fixtures/mock-horizon.mjs            # :9094
 *   PORT=9099 node tests/e2e-loop-purchase/fixtures/mock-horizon.mjs  # custom port
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 9094);

// Fixed XLM/USD (and GBP/EUR, unused by this suite) rate — matches
// mock-ctx.mjs's own hardcoded "5 XLM per $1 fiat" conversion
// (`xlmAmount = fiatAmount * 5`) used for the CTX-side wholesale quote,
// so the R3-5 CTX-payment sanity band
// (`LOOP_CTX_PAYMENT_MAX_BPS_OF_EXPECTED`, apps/backend/src/orders/procure-one.ts)
// compares two numbers computed at the SAME effective rate instead of
// tripping on an arbitrary mismatch between two independent mocks.
// 1 XLM = $0.20 → $1 = 5 XLM.
const XLM_RATE = { usd: 0.2, gbp: 0.2, eur: 0.2 };

// ───────── In-memory state ────────────────────────────────────────────

/** Flat list of injected payment records, oldest-first. */
let payments = [];
let pagingCounter = 1;
/** Fixed sequence number every `GET /accounts/:id` reports. Only one
 * transaction is ever built per test run, so this never needs to move. */
const ACCOUNT_SEQUENCE = '1';

// ───────── Helpers ─────────────────────────────────────────────────────

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJsonBody(req) {
  const raw = await readBody(req);
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

/** Builds a Horizon-shaped `{_embedded, _links}` payments page. */
function paymentsPage(records, opts) {
  const body = { _embedded: { records } };
  const last = records[records.length - 1];
  if (last !== undefined) {
    body._links = {
      next: {
        href: `${opts.selfBase}?cursor=${encodeURIComponent(last.paging_token)}&limit=${opts.limit}&order=${opts.order}`,
      },
    };
  }
  return body;
}

// ───────── Request router ───────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  const parsed = new URL(url, `http://localhost:${PORT}`);
  const path = parsed.pathname;

  // ── Health ──
  if (method === 'GET' && path === '/status') {
    return json(res, 200, { status: 'ok' });
  }

  // ── XLM price feed (CoinGecko shape, LOOP_XLM_PRICE_FEED_URL) ──
  if (method === 'GET' && path === '/rates') {
    return json(res, 200, { stellar: XLM_RATE });
  }

  // ── Account load (stellar-sdk Horizon.Server#loadAccount) ──
  const accountMatch = path.match(/^\/accounts\/([^/]+)$/);
  if (method === 'GET' && accountMatch) {
    return json(res, 200, {
      id: accountMatch[1],
      account_id: accountMatch[1],
      sequence: ACCOUNT_SEQUENCE,
      subentry_count: 0,
      balances: [],
      signers: [],
      data: {},
      data_attr: {},
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    });
  }

  // ── Account payments (payment watcher's deposit poll + the
  //    outbound-payment idempotency memo-scan) ──
  const paymentsMatch = path.match(/^\/accounts\/([^/]+)\/payments$/);
  if (method === 'GET' && paymentsMatch) {
    const order = parsed.searchParams.get('order') === 'desc' ? 'desc' : 'asc';
    const limit = Number(parsed.searchParams.get('limit') ?? 50);
    const cursor = parsed.searchParams.get('cursor');
    let records = [...payments];
    if (order === 'desc') records.reverse();
    if (cursor !== null) {
      records =
        order === 'asc'
          ? records.filter((p) => Number(p.paging_token) > Number(cursor))
          : records.filter((p) => Number(p.paging_token) < Number(cursor));
    }
    records = records.slice(0, limit);
    return json(
      res,
      200,
      paymentsPage(records, { selfBase: `${parsed.origin}${path}`, limit, order }),
    );
  }

  // ── Transaction submit (stellar-sdk Horizon.Server#submitTransaction).
  //    Never inspects the XDR — see module doc. Deliberately omits
  //    `result_xdr` so the SDK returns `response.data` verbatim instead
  //    of attempting to decode a (fake) result. ──
  if (method === 'POST' && path === '/transactions') {
    // Drain the form-encoded body (`tx=<base64 xdr>`) — unused, but
    // must be consumed so the client's request completes cleanly.
    await readBody(req);
    return json(res, 200, {
      hash: randomUUID().replace(/-/g, ''),
      ledger: 1,
      successful: true,
    });
  }

  // ── Test-only: inject a payment record the watcher will see on its
  //    next `GET /accounts/:id/payments` poll. Mirrors the shape
  //    `apps/backend/src/payments/horizon.ts`'s `HorizonPayment` Zod
  //    schema expects. ──
  if (method === 'POST' && path === '/_test/inject-payment') {
    const body = await readJsonBody(req);
    const record = {
      id: randomUUID(),
      paging_token: String(pagingCounter++),
      type: 'payment',
      from: body.from ?? 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      to: body.to,
      asset_type: body.assetType ?? 'native',
      ...(body.assetCode !== undefined ? { asset_code: body.assetCode } : {}),
      ...(body.assetIssuer !== undefined ? { asset_issuer: body.assetIssuer } : {}),
      amount: body.amount,
      transaction_hash: randomUUID().replace(/-/g, ''),
      transaction_successful: true,
      transaction: {
        memo: body.memo,
        memo_type: 'text',
        successful: true,
      },
    };
    payments.push(record);
    return json(res, 200, record);
  }

  if (method === 'POST' && path === '/_test/reset') {
    payments = [];
    // Deliberately NOT resetting `pagingCounter`: the backend's
    // `watcher_cursors` row (real Postgres, not reset by this call)
    // persists whatever paging_token the payment watcher last saw. If
    // a retry (Playwright `retries: 2` in CI) reused paging_token "1"
    // for a freshly-injected deposit, the watcher's `cursor=1` filter
    // (`paging_token > cursor`) would silently exclude it — a real
    // deposit that never gets picked up, indistinguishable from a
    // genuine bug. Monotonic for the lifetime of this mock-horizon
    // process instead, so a re-run after a mid-test retry can never
    // collide with a stale cursor.
    return json(res, 200, { message: 'reset' });
  }

  return json(res, 404, { error: `unknown route ${method} ${path}` });
});

server.listen(PORT, () => {
  console.log(`[mock-horizon] listening on :${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
