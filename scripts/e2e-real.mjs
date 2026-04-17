#!/usr/bin/env node
/**
 * Real end-to-end purchase workflow.
 *
 * Talks to a running backend (default http://localhost:8080) which itself
 * talks to the real CTX upstream. Drives the full flow:
 *
 *   1. Refresh an access token from CTX_TEST_REFRESH_TOKEN
 *   2. Pick a merchant from /api/merchants
 *   3. Create an order via POST /api/orders
 *   4. Pay the order from the test Stellar wallet
 *   5. Poll GET /api/orders/:id until status === 'completed' or timeout
 *
 * Required env:
 *   CTX_TEST_REFRESH_TOKEN   — upstream refresh token for the test account
 *   STELLAR_TEST_SECRET_KEY  — secret key (S...) of the funded test wallet
 *
 * Optional env:
 *   BACKEND_URL              — defaults to http://localhost:8080
 *   E2E_MERCHANT_ID          — merchant id to buy from; defaults to first
 *                              min-max merchant in the catalog
 *   E2E_AMOUNT_USD           — USD amount to purchase; defaults to '5'
 *   POLL_TIMEOUT_MS          — total poll budget; defaults to 600000 (10m)
 *   POLL_INTERVAL_MS         — poll cadence; defaults to 5000 (5s)
 *   NEW_REFRESH_TOKEN_OUT    — path to write the rotated refresh token to.
 *                              CTX rotates on every /refresh-token call, so
 *                              the workflow must persist the new value back
 *                              to the CTX_TEST_REFRESH_TOKEN secret before
 *                              the next run. Written immediately after the
 *                              refresh succeeds so a failure later in the
 *                              flow still allows the rotation step to run.
 *
 * Exit codes:
 *   0 on fulfilment, non-zero otherwise.
 */

import { writeFileSync } from 'node:fs';
import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Horizon,
  Memo,
} from '@stellar/stellar-sdk';

const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:8080';
const HORIZON_URL = process.env.HORIZON_URL ?? 'https://horizon.stellar.org';
const REFRESH_TOKEN = process.env.CTX_TEST_REFRESH_TOKEN;
const WALLET_SECRET = process.env.STELLAR_TEST_SECRET_KEY;
const MERCHANT_ID = process.env.E2E_MERCHANT_ID;
// Undefined means "use each candidate merchant's own `min` denomination" —
// buys the cheapest possible card so CI runs don't waste real money. Set
// the env var to force a specific amount (e.g. to reproduce a user's order).
const AMOUNT_USD = process.env.E2E_AMOUNT_USD;
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 600_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5_000);
const NEW_REFRESH_TOKEN_OUT = process.env.NEW_REFRESH_TOKEN_OUT;

if (!REFRESH_TOKEN || !WALLET_SECRET) {
  console.error('Missing CTX_TEST_REFRESH_TOKEN or STELLAR_TEST_SECRET_KEY');
  process.exit(2);
}

function log(msg, data) {
  const stamp = new Date().toISOString();
  if (data === undefined) console.log(`[${stamp}] ${msg}`);
  else console.log(`[${stamp}] ${msg}`, data);
}

async function api(path, { method = 'GET', body, accessToken } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
    // CTX binds the access token to the clientId used at auth. Omitting
    // X-Client-Id on authenticated requests causes upstream to 401 even
    // though the bearer token is otherwise valid.
    headers['X-Client-Id'] = 'loopweb';
  }
  const res = await fetch(`${BACKEND_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} → ${res.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`,
    );
  }
  return json;
}

async function refreshAccessToken() {
  log('Refreshing access token via backend');
  const data = await api('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: REFRESH_TOKEN, platform: 'web' },
  });
  if (!data?.accessToken) throw new Error('No accessToken in refresh response');

  // CTX rotates refresh tokens on every /refresh-token call — the token we
  // just used is now dead. Persist the new one to disk IMMEDIATELY so the
  // workflow can rotate the repo secret even if a later step fails. If
  // upstream ever stops returning a new token, skip silently (the old one
  // is still valid).
  if (NEW_REFRESH_TOKEN_OUT !== undefined && NEW_REFRESH_TOKEN_OUT !== '') {
    if (data.refreshToken) {
      writeFileSync(NEW_REFRESH_TOKEN_OUT, data.refreshToken, { mode: 0o600 });
      log(`Wrote rotated refresh token to ${NEW_REFRESH_TOKEN_OUT}`);
    } else {
      log('Upstream did not return a new refresh token — skipping rotation');
    }
  }

  return data.accessToken;
}

/**
 * Returns candidate merchants to try, in priority order. If E2E_MERCHANT_ID
 * is set we trust it and return only that one.
 *
 * Otherwise: min-max merchants whose range covers AMOUNT_USD and that report
 * `enabled: true`. Even enabled-in-cache merchants can report "merchant
 * disabled" at order time (CTX's order API enforces stricter state than
 * the catalog), so the caller retries down the list.
 */
async function pickMerchantCandidates(accessToken) {
  if (MERCHANT_ID) {
    log(`Using merchant from env: ${MERCHANT_ID}`);
    const amount = AMOUNT_USD !== undefined ? Number(AMOUNT_USD) : undefined;
    return [{ id: MERCHANT_ID, name: `(env override ${MERCHANT_ID})`, amount }];
  }
  // GET /api/merchants paginates (max 100 per page) — fetch every page so
  // the candidate list covers the whole catalog, not just the first 20.
  const merchants = [];
  for (let page = 1; ; page++) {
    const data = await api(`/api/merchants?page=${page}&limit=100`, { accessToken });
    merchants.push(...(data?.merchants ?? []));
    if (!data?.pagination?.hasNext) break;
  }
  // If AMOUNT_USD is set, require the merchant's range to cover it. Otherwise
  // buy at the merchant's own minimum — cheapest possible card per run.
  const filtered = merchants.filter((m) => {
    if (m?.enabled !== true) return false;
    if (m?.denominations?.type !== 'min-max') return false;
    if (AMOUNT_USD !== undefined) {
      const amount = Number(AMOUNT_USD);
      return (m.denominations.min ?? 0) <= amount && (m.denominations.max ?? Infinity) >= amount;
    }
    return m.denominations.min !== undefined && m.denominations.min > 0;
  });
  if (filtered.length === 0) {
    throw new Error(
      `No enabled min-max merchant${AMOUNT_USD !== undefined ? ` covers $${AMOUNT_USD}` : ''} (of ${merchants.length} merchants returned)`,
    );
  }
  // When buying at min, try the cheapest merchants first so a wallet with
  // limited funds goes further.
  const sorted =
    AMOUNT_USD !== undefined
      ? filtered
      : [...filtered].sort((a, b) => (a.denominations.min ?? 0) - (b.denominations.min ?? 0));
  log(`Found ${sorted.length} candidate merchants; first few:`, {
    merchants: sorted.slice(0, 5).map((m) => `${m.name} (min $${m.denominations.min})`),
  });
  return sorted.map((m) => ({
    id: m.id,
    name: m.name,
    amount: AMOUNT_USD !== undefined ? Number(AMOUNT_USD) : m.denominations.min,
  }));
}

/**
 * Tries each candidate in order; returns the first order that's successfully
 * created. CTX occasionally flags merchants as disabled at order time even
 * when they look fine in the catalog, so we treat "merchant disabled" and
 * any 502 as retry-worthy rather than a hard failure.
 */
async function createOrderWithFallback(accessToken, candidates) {
  const errors = [];
  for (const candidate of candidates.slice(0, 10)) {
    log(`Creating order for ${candidate.name} (${candidate.id}), $${candidate.amount}`);
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        accessToken,
        body: { merchantId: candidate.id, amount: candidate.amount },
      });
      log('Order created', {
        orderId: order.orderId,
        paymentAddress: order.paymentAddress,
        xlmAmount: order.xlmAmount,
        memo: order.memo,
      });
      return order;
    } catch (err) {
      const msg = err?.message ?? String(err);
      errors.push(`${candidate.name}: ${msg}`);
      // Retry on 502 UPSTREAM_ERROR (covers "merchant disabled" and other
      // upstream rejections). Any other error — 401, 400 validation, etc. —
      // is a problem with our request, not the specific merchant.
      if (!/→ 502:/.test(msg)) throw err;
      log(`Order attempt failed, trying next merchant`);
    }
  }
  throw new Error(`All ${errors.length} merchant candidates failed:\n  ${errors.join('\n  ')}`);
}

async function payOrder({ paymentAddress, xlmAmount, memo }) {
  const server = new Horizon.Server(HORIZON_URL);
  const kp = Keypair.fromSecret(WALLET_SECRET);
  log(`Paying ${xlmAmount} XLM from ${kp.publicKey()} to ${paymentAddress} (memo=${memo})`);
  const account = await server.loadAccount(kp.publicKey());
  // Fetch the current network fee stats and use the p70 fee so we're above
  // whatever is currently required — a static 100 stroops (the historic
  // minimum) has been rejected as tx_insufficient_fee in the past.
  let fee = '1000';
  try {
    const stats = await server.feeStats();
    fee = stats?.fee_charged?.p70 ?? stats?.last_ledger_base_fee ?? fee;
  } catch (e) {
    log(`Could not fetch fee stats (${e?.message ?? e}); using fallback fee ${fee}`);
  }
  const tx = new TransactionBuilder(account, {
    fee: String(fee),
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.payment({
        destination: paymentAddress,
        asset: Asset.native(),
        amount: xlmAmount,
      }),
    )
    .addMemo(new Memo('text', memo))
    .setTimeout(120)
    .build();
  tx.sign(kp);
  try {
    const result = await server.submitTransaction(tx);
    log(`Stellar tx submitted: ${result.hash}`);
    return result.hash;
  } catch (err) {
    // Horizon returns the useful detail in response.data.extras.result_codes;
    // the default AxiosError toString is just "Request failed with status
    // code 400" which tells us nothing.
    const codes = err?.response?.data?.extras?.result_codes;
    const detail = codes ? JSON.stringify(codes) : (err?.response?.data ?? err?.message);
    throw new Error(
      `Stellar submit failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
    );
  }
}

async function pollForFulfilment(accessToken, orderId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastStatus = '';
  while (Date.now() < deadline) {
    const data = await api(`/api/orders/${orderId}`, { accessToken });
    const status = data?.order?.status;
    if (status !== lastStatus) {
      log(`Order status: ${status}`);
      lastStatus = status;
    }
    if (status === 'completed') {
      log('Order fulfilled', {
        redeemType: data.order.redeemType,
        hasRedeemUrl: Boolean(data.order.redeemUrl),
        hasChallenge: Boolean(data.order.redeemChallengeCode),
      });
      return data.order;
    }
    if (status === 'failed' || status === 'expired') {
      throw new Error(`Order reached terminal state: ${status}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Order not fulfilled within ${POLL_TIMEOUT_MS}ms (last status: ${lastStatus})`);
}

async function main() {
  const accessToken = await refreshAccessToken();
  const candidates = await pickMerchantCandidates(accessToken);
  const order = await createOrderWithFallback(accessToken, candidates);
  await payOrder(order);
  await pollForFulfilment(accessToken, order.orderId);
  log('E2E real purchase flow succeeded');
}

main().catch((err) => {
  console.error(`[e2e-real] FAILED:`, err?.stack ?? err);
  process.exit(1);
});
