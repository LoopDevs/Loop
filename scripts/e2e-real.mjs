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
 *
 * Exit codes:
 *   0 on fulfilment, non-zero otherwise.
 */

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
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
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
  return data.accessToken;
}

async function pickMerchant(accessToken) {
  if (MERCHANT_ID) {
    log(`Using merchant from env: ${MERCHANT_ID}`);
    return MERCHANT_ID;
  }
  const data = await api('/api/merchants', { accessToken });
  const merchants = data?.merchants ?? [];
  // Prefer a min-max merchant so a flat $5 amount works for most cards.
  const firstMinMax = merchants.find(
    (m) =>
      m?.denominations?.type === 'minMax' && (m?.denominations?.min ?? 0) <= Number(AMOUNT_USD),
  );
  const chosen = firstMinMax ?? merchants[0];
  if (!chosen?.id) throw new Error('No merchants returned from /api/merchants');
  log(`Picked merchant: ${chosen.name} (${chosen.id})`);
  return chosen.id;
}

async function createOrder(accessToken, merchantId) {
  log(`Creating order for merchant ${merchantId}, $${AMOUNT_USD}`);
  const order = await api('/api/orders', {
    method: 'POST',
    accessToken,
    body: { merchantId, amount: Number(AMOUNT_USD) },
  });
  log('Order created', {
    orderId: order.orderId,
    paymentAddress: order.paymentAddress,
    xlmAmount: order.xlmAmount,
    memo: order.memo,
  });
  return order;
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
  const merchantId = await pickMerchant(accessToken);
  const order = await createOrder(accessToken, merchantId);
  await payOrder(order);
  await pollForFulfilment(accessToken, order.orderId);
  log('E2E real purchase flow succeeded');
}

main().catch((err) => {
  console.error(`[e2e-real] FAILED:`, err?.stack ?? err);
  process.exit(1);
});
