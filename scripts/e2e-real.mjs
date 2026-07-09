#!/usr/bin/env node
/**
 * Real end-to-end Tranche-1 purchase workflow.
 *
 * Drives the loop-native purchase chain end-to-end against a running
 * backend that is itself talking to real CTX upstream:
 *
 *   1. Refresh a Loop-native access token from E2E_REFRESH_TOKEN
 *   2. Pick a merchant — defaults to Aerie ($0.01 minimum, USD)
 *   3. POST /api/orders/loop with the chosen amount + payment method
 *   4. Pay the deposit address from the test Stellar wallet (XLM or USDC)
 *   5. Poll GET /api/orders/loop/:id until state='fulfilled' or timeout
 *
 * Loop is merchant of record (ADR 010): the user pays Loop's deposit
 * address; Loop's payment-watcher detects the on-chain credit, marks
 * the order paid, the procurement-worker pays CTX in XLM, and CTX
 * returns the gift-card code which Loop hands back to the user.
 *
 * The legacy CTX-proxy `POST /api/orders` flow is bootstrap-only and
 * is no longer exercised by this script — Tranche-1 onward is always
 * via the Loop-native path. The CTX-proxy endpoints still exist in
 * the backend for back-compat with old clients, but acceptance tests
 * target what users actually exercise.
 *
 * Backend prerequisites (env on the backend, not this script):
 *   LOOP_AUTH_NATIVE_ENABLED=true       (Loop mints HS256 JWTs)
 *   LOOP_WORKERS_ENABLED=true            (payment-watcher + procurement)
 *   LOOP_STELLAR_DEPOSIT_ADDRESS=G…       (where users send XLM/USDC)
 *   LOOP_STELLAR_OPERATOR_SECRET=S…       (procurement-worker signing key)
 *   LOOP_STELLAR_USDC_ISSUER=GA5ZSEJ…     (Centre USDC mainnet)
 *   DATABASE_URL=postgres://…             (orders ledger)
 *
 * Required env (this script):
 *   E2E_REFRESH_TOKEN        — Loop-native refresh token for the test
 *                              account. Bootstrap: complete one OTP
 *                              flow manually (request OTP → verify),
 *                              capture the refresh token from the
 *                              backend response, store as a repo
 *                              secret. Both Loop-native and CTX-proxy
 *                              rotate refresh tokens every call —
 *                              persist the new value via
 *                              NEW_REFRESH_TOKEN_OUT.
 *   STELLAR_TEST_SECRET_KEY  — secret key (S...) of the funded test
 *                              wallet. Mainnet wallet for real-money
 *                              tests; per `reference_test_wallet.md`.
 *
 * Optional env:
 *   LOOP_E2E_PAYMENT_METHOD  — 'xlm' (default) or 'usdc'. USDC requires
 *                              the test wallet to hold a USDC trustline +
 *                              balance against LOOP_STELLAR_USDC_ISSUER.
 *   LOOP_E2E_CURRENCY        — 'USD' (default) | 'GBP' | 'EUR'. Pins
 *                              the order's charge currency. Aerie is
 *                              USD-only so leave as USD when using the
 *                              default merchant.
 *   BACKEND_URL              — default http://localhost:8080. Point at
 *                              api.loopfinance.io for the deployed run.
 *   E2E_MERCHANT_ID          — default Aerie. Override for other merchants
 *                              (must be a min-max merchant whose currency
 *                              matches LOOP_E2E_CURRENCY).
 *   E2E_AMOUNT_USD           — default 0.02 (2 cents — Aerie min is $0.01,
 *                              the cents-precision floor of the order body
 *                              is enforced server-side). Empty/unset
 *                              defaults to 0.02. Variable name kept for
 *                              workflow compatibility — applies to any
 *                              currency, not just USD.
 *   POLL_TIMEOUT_MS          — total poll budget; default 600000 (10m)
 *   POLL_INTERVAL_MS         — poll cadence; default 5000 (5s)
 *   REDEMPTION_GRACE_MS      — C2-1 acceptance check (the 2026-05-14
 *                              fulfilled-but-redeemUrl/Code/Pin-all-null
 *                              bug): once the order reaches `fulfilled`,
 *                              how long to keep polling for a non-empty
 *                              redemption payload before failing the
 *                              run. Covers the case where
 *                              `waitForRedemption`'s budget exhausted
 *                              and the backend's redemption-backfill
 *                              sweeper (60s cadence) needs a tick or
 *                              two to recover it. Default 180000 (3m).
 *   NEW_REFRESH_TOKEN_OUT    — path to write the rotated refresh token
 *                              to. The workflow rotates the repo secret
 *                              from this file regardless of whether the
 *                              rest of the flow succeeds — the old
 *                              token is already dead by then.
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
// E2E_REFRESH_TOKEN is the canonical name; CTX_TEST_REFRESH_TOKEN is kept
// as an alias only so the existing GitHub workflow's `secrets.CTX_TEST_…`
// reference doesn't break before it's renamed in the workflow file.
const REFRESH_TOKEN = process.env.E2E_REFRESH_TOKEN ?? process.env.CTX_TEST_REFRESH_TOKEN;
const WALLET_SECRET = process.env.STELLAR_TEST_SECRET_KEY;
const PAYMENT_METHOD = (process.env.LOOP_E2E_PAYMENT_METHOD ?? 'xlm').toLowerCase();
const CURRENCY = (process.env.LOOP_E2E_CURRENCY ?? 'USD').toUpperCase();
const MERCHANT_ID = process.env.E2E_MERCHANT_ID;
const AMOUNT =
  process.env.E2E_AMOUNT_USD && process.env.E2E_AMOUNT_USD.trim() !== ''
    ? Number(process.env.E2E_AMOUNT_USD)
    : 0.02;
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS ?? 600_000);
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? 5_000);
const REDEMPTION_GRACE_MS = Number(process.env.REDEMPTION_GRACE_MS ?? 180_000);
const NEW_REFRESH_TOKEN_OUT = process.env.NEW_REFRESH_TOKEN_OUT;

// Aerie — $0.01 min, USD, 2% savings. Cheapest documented merchant on
// the deployed catalog. Default so the cost is ~2 cents per run.
const AERIE_MERCHANT_ID = 'a8f90501-c10a-4a14-adde-9a045b7ff1c6';

if (!['xlm', 'usdc'].includes(PAYMENT_METHOD)) {
  console.error(`Invalid LOOP_E2E_PAYMENT_METHOD: ${PAYMENT_METHOD}. Use 'xlm' or 'usdc'.`);
  process.exit(2);
}
if (!['USD', 'GBP', 'EUR'].includes(CURRENCY)) {
  console.error(`Invalid LOOP_E2E_CURRENCY: ${CURRENCY}. Use 'USD' | 'GBP' | 'EUR'.`);
  process.exit(2);
}
if (!Number.isFinite(AMOUNT) || AMOUNT <= 0) {
  console.error(`Invalid amount: ${AMOUNT}. Must be a positive number.`);
  process.exit(2);
}
if (!REFRESH_TOKEN || !WALLET_SECRET) {
  console.error('Missing E2E_REFRESH_TOKEN or STELLAR_TEST_SECRET_KEY');
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
  log('Refreshing Loop-native access token via backend');
  const data = await api('/api/auth/refresh', {
    method: 'POST',
    body: { refreshToken: REFRESH_TOKEN, platform: 'web' },
  });
  if (!data?.accessToken) throw new Error('No accessToken in refresh response');

  // Loop-native and CTX-proxy both rotate refresh tokens on every call.
  // Persist the new one to disk IMMEDIATELY so the workflow can rotate
  // the repo secret even if a later step fails.
  if (NEW_REFRESH_TOKEN_OUT !== undefined && NEW_REFRESH_TOKEN_OUT !== '') {
    if (data.refreshToken) {
      writeFileSync(NEW_REFRESH_TOKEN_OUT, data.refreshToken, { mode: 0o600 });
      log(`Wrote rotated refresh token to ${NEW_REFRESH_TOKEN_OUT}`);
    } else {
      log('Backend did not return a new refresh token — skipping rotation');
    }
  }

  return data.accessToken;
}

async function pickMerchant() {
  if (MERCHANT_ID) {
    log(`Using merchant from env: ${MERCHANT_ID}`);
    return { id: MERCHANT_ID, name: `(env override ${MERCHANT_ID})`, amount: AMOUNT };
  }
  log(`Default: Aerie ${AERIE_MERCHANT_ID} at ${CURRENCY} ${AMOUNT}`);
  return { id: AERIE_MERCHANT_ID, name: 'Aerie (default)', amount: AMOUNT };
}

async function createLoopOrder(accessToken, candidate) {
  // Major-unit float → minor-unit integer. Order body's `amountMinor`
  // is a bigint on the wire, but JS Number safely covers up to ~$9e13
  // — overkill for our $0.02 default. Math.round handles the IEEE-754
  // 0.02 → 0.020000000000000004 case so the integer is exact.
  const amountMinor = Math.round(candidate.amount * 100);
  if (amountMinor <= 0) {
    throw new Error(`Invalid amountMinor=${amountMinor} for candidate ${candidate.name}`);
  }
  log(
    `Creating loop-native order for ${candidate.name} (${candidate.id}), ${CURRENCY} ${candidate.amount} (paymentMethod=${PAYMENT_METHOD})`,
  );
  const order = await api('/api/orders/loop', {
    method: 'POST',
    accessToken,
    body: {
      merchantId: candidate.id,
      amountMinor,
      currency: CURRENCY,
      paymentMethod: PAYMENT_METHOD,
    },
  });
  if (!order?.payment?.stellarAddress || !order?.payment?.memo) {
    throw new Error(`Unexpected loop-native order response shape: ${JSON.stringify(order)}`);
  }
  log('Loop-native order created', {
    orderId: order.orderId,
    method: order.payment.method,
    stellarAddress: order.payment.stellarAddress,
    memo: order.payment.memo,
    assetAmount: order.payment.assetAmount,
  });
  return {
    orderId: order.orderId,
    paymentAddress: order.payment.stellarAddress,
    asset: order.payment.method,
    assetCode: order.payment.assetCode,
    assetIssuer: order.payment.assetIssuer,
    assetAmount: order.payment.assetAmount,
    memo: order.payment.memo,
  };
}

async function payOrder({ paymentAddress, asset, assetCode, assetIssuer, assetAmount, memo }) {
  const server = new Horizon.Server(HORIZON_URL);
  const kp = Keypair.fromSecret(WALLET_SECRET);

  let stellarAsset;
  if (asset === 'xlm') {
    stellarAsset = Asset.native();
  } else if (asset === 'usdc') {
    const issuer = assetIssuer || 'GA5ZSEJYB37JRC5AVCIA7VBRVRWWZBMXWXZAHYBRQHGSZHGCASCHV3VW';
    stellarAsset = new Asset(assetCode || 'USDC', issuer);
  } else if (asset === 'loop_asset') {
    if (!assetCode || !assetIssuer) {
      throw new Error(`loop_asset payment missing assetCode/assetIssuer in order response`);
    }
    stellarAsset = new Asset(assetCode, assetIssuer);
  } else {
    throw new Error(`Unsupported payment asset: ${asset}`);
  }

  log(
    `Paying ${assetAmount} ${stellarAsset.code} from ${kp.publicKey()} to ${paymentAddress} (memo=${memo})`,
  );
  const account = await server.loadAccount(kp.publicKey());
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
        asset: stellarAsset,
        amount: assetAmount,
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
    const codes = err?.response?.data?.extras?.result_codes;
    const detail = codes ? JSON.stringify(codes) : (err?.response?.data ?? err?.message);
    throw new Error(
      `Stellar submit failed: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`,
    );
  }
}

function hasRedemptionPayload(data) {
  return Boolean(data?.redeemUrl) || Boolean(data?.redeemCode) || Boolean(data?.redeemPin);
}

async function pollForFulfilment(accessToken, orderId) {
  // State machine: pending_payment → paid → procuring → fulfilled.
  // Terminal: expired (24h sweep). No `failed` state on this surface
  // — procurement-side failures keep the order in `paid`/`procuring`
  // and surface in admin only. The 10-minute poll budget covers the
  // expected end-to-end latency: payment-watcher detection (~10–30s),
  // procurement worker (~30–60s), CTX-side issuance (≤60s).
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastState = '';
  let data;
  while (Date.now() < deadline) {
    // `GET /api/orders/loop/:id` returns the flat `orderToView`
    // shape — no `{ order: ... }` wrapper. Earlier versions of this
    // script read `data.order.state` and looped on `undefined`.
    data = await api(`/api/orders/loop/${orderId}`, { accessToken });
    const state = data?.state;
    if (state !== lastState) {
      log(`Order state: ${state}`);
      lastState = state;
    }
    if (state === 'fulfilled') break;
    if (state === 'failed' || state === 'expired') {
      throw new Error(`Order reached terminal state: ${state}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  if (data?.state !== 'fulfilled') {
    throw new Error(`Order not fulfilled within ${POLL_TIMEOUT_MS}ms (last state: ${lastState})`);
  }
  return await waitForRedemptionPayload(accessToken, orderId, data);
}

/**
 * C2-1 acceptance check (the 2026-05-14 fulfilled-but-redeemUrl/Code/
 * Pin-all-null bug — see docs/readiness-backlog-2026-07-03.md §C2-1).
 * `waitForRedemption` (backend orders/procurement-redemption.ts) can
 * legitimately exhaust its 5-minute budget and let the order fulfil
 * with every redeem field null — by design, so a slow CTX issuance
 * never strands a paid order in limbo (procure-one.ts fulfils on
 * `ctxOrderId`, not on redemption data). The documented recovery path
 * is the redemption-backfill sweeper (orders/redemption-backfill.ts,
 * 60s cadence, gated on LOOP_WORKERS_ENABLED). Give that sweeper a
 * `REDEMPTION_GRACE_MS` window of re-polling before treating an empty
 * payload as a real regression — this is exactly the check that was
 * missing when the 2026-05-14 order fulfilled with nulls and nothing
 * caught it.
 */
async function waitForRedemptionPayload(accessToken, orderId, initialData) {
  let data = initialData;
  if (hasRedemptionPayload(data)) {
    log('Order fulfilled', {
      hasRedeemUrl: Boolean(data.redeemUrl),
      hasRedeemCode: Boolean(data.redeemCode),
      hasRedeemPin: Boolean(data.redeemPin),
      ctxOrderId: data.ctxOrderId,
    });
    return data;
  }
  log(
    'Order fulfilled but redemption payload is empty — waiting for the redemption-backfill sweep',
    {
      orderId,
      ctxOrderId: data.ctxOrderId,
      graceMs: REDEMPTION_GRACE_MS,
    },
  );
  const redemptionDeadline = Date.now() + REDEMPTION_GRACE_MS;
  while (Date.now() < redemptionDeadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    data = await api(`/api/orders/loop/${orderId}`, { accessToken });
    if (hasRedemptionPayload(data)) {
      log('Redemption payload recovered by the backfill sweep', {
        hasRedeemUrl: Boolean(data.redeemUrl),
        hasRedeemCode: Boolean(data.redeemCode),
        hasRedeemPin: Boolean(data.redeemPin),
      });
      return data;
    }
  }
  throw new Error(
    `C2-1 regression: order ${orderId} (ctxOrderId=${data.ctxOrderId}) fulfilled but ` +
      `redeemUrl/redeemCode/redeemPin are still all empty after a ${REDEMPTION_GRACE_MS}ms ` +
      'redemption-backfill grace window — see docs/runbooks/redemption-backfill-exhausted.md',
  );
}

async function main() {
  log(`Currency: ${CURRENCY} | Payment: ${PAYMENT_METHOD} | Backend: ${BACKEND_URL}`);
  const accessToken = await refreshAccessToken();
  const candidate = await pickMerchant();
  const order = await createLoopOrder(accessToken, candidate);
  await payOrder(order);
  await pollForFulfilment(accessToken, order.orderId);
  log('E2E real Tranche-1 purchase flow succeeded');
}

main().catch((err) => {
  console.error(`[e2e-real] FAILED:`, err?.stack ?? err);
  process.exit(1);
});
