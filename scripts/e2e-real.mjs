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
const AMOUNT_USD = process.env.E2E_AMOUNT_USD ?? '5';
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
    return [{ id: MERCHANT_ID, name: `(env override ${MERCHANT_ID})` }];
  }
  const data = await api('/api/merchants', { accessToken });
  const merchants = data?.merchants ?? [];
  const amount = Number(AMOUNT_USD);
  const candidates = merchants.filter(
    (m) =>
      m?.enabled === true &&
      m?.denominations?.type === 'min-max' &&
      (m.denominations.min ?? 0) <= amount &&
      (m.denominations.max ?? Infinity) >= amount,
  );
  if (candidates.length === 0) {
    throw new Error(
      `No enabled min-max merchant covers $${AMOUNT_USD} (of ${merchants.length} merchants returned)`,
    );
  }
  log(`Found ${candidates.length} candidate merchants; first few:`, {
    names: candidates.slice(0, 5).map((m) => m.name),
  });
  return candidates.map((m) => ({ id: m.id, name: m.name }));
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
    log(`Creating order for ${candidate.name} (${candidate.id}), $${AMOUNT_USD}`);
    try {
      const order = await api('/api/orders', {
        method: 'POST',
        accessToken,
        body: { merchantId: candidate.id, amount: Number(AMOUNT_USD) },
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
  const tx = new TransactionBuilder(account, {
    fee: '100',
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
  const result = await server.submitTransaction(tx);
  log(`Stellar tx submitted: ${result.hash}`);
  return result.hash;
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
