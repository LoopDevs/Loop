/**
 * Load-test scenario: the full auth → order journey — request OTP, verify
 * OTP, create an order, poll it. Lower VU counts than browse.js since this
 * is the write-heavy / money-adjacent path.
 *
 * Mirrors tests/e2e-mocked/purchase-flow.test.ts's `signInInline()` +
 * order-creation flow, hitting the backend directly instead of driving the
 * UI:
 *   - POST /api/auth/request-otp   — apps/backend/src/auth/handler.ts
 *   - POST /api/auth/verify-otp    — apps/backend/src/auth/handler.ts
 *   - POST /api/orders             — apps/backend/src/orders/handler.ts
 *   - GET  /api/orders/:id         — apps/backend/src/orders/get-handler.ts
 *
 * Auth path: playwright.mocked.config.ts leaves LOOP_AUTH_NATIVE_ENABLED
 * unset on the backend it boots, so both POSTs above take the LEGACY
 * CTX-proxy branch (apps/backend/src/auth/handler.ts requestOtpHandler /
 * verifyOtpHandler) and forward to mock-ctx's POST /login + POST
 * /verify-email (tests/e2e-mocked/fixtures/mock-ctx.mjs). mock-ctx accepts
 * any email and the hardcoded OTP '123456' for all of them — real CTX
 * emails a random one per user, which is why this script still generates a
 * distinct email per iteration (below) even though the mock doesn't
 * require it: this script stays correct if pointed at a stack where that
 * matters.
 *
 * Run via tools/load-test/run-local.sh, or directly:
 *   k6 run -e BASE_URL=http://localhost:8081 tools/load-test/auth-order.js
 *
 * See docs/load-testing.md for the full harness writeup + measured
 * baselines.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';
import { BASE_URL, COMMON_THRESHOLDS, jsonHeaders, scaleStages } from './config.js';

const errorRate = new Rate('errors');
// Separate named Trend so the end-of-run summary prints order-create
// latency on its own line even without digging into the tagged
// http_req_duration sub-metrics.
const orderCreateDuration = new Trend('order_create_duration', true);

// mock-ctx's hardcoded OTP (tests/e2e-mocked/fixtures/mock-ctx.mjs) — valid
// for any email against the local mocked stack.
const OTP = '123456';

// mock-ctx seed catalog ids (tests/e2e-mocked/fixtures/mock-ctx.mjs). All
// three accept any amount in CreateOrderBody's 0.01–10,000 band — the mock
// doesn't enforce a merchant's own denomination list, so a flat $10 works
// across all of them.
const MERCHANT_IDS = ['mock-amazon', 'mock-target', 'mock-starbucks'];
const ORDER_AMOUNT = 10;

export const options = {
  scenarios: {
    auth_order: {
      executor: 'ramping-vus',
      startVUs: 0,
      // Scaled by VUS_SCALE (default 1) — see config.js::scaleStages.
      stages: scaleStages([
        { duration: '30s', target: 2 },
        { duration: '1m', target: 10 },
        { duration: '2m', target: 25 },
        { duration: '30s', target: 0 },
      ]),
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    ...COMMON_THRESHOLDS,
    // docs/slo.md: "/api/orders create p95 round-trip ≤ 1500ms".
    'http_req_duration{name:order_create}': ['p(95)<1500'],
  },
};

export default function () {
  // vu/iter/timestamp-derived email — unique per iteration so this script
  // stays correct against a backend that dedupes per-email side effects
  // (real CTX) or enforces per-email rate limiting later.
  const email = `k6-load-vu${__VU}-iter${__ITER}-${Date.now()}@load.test`;

  // 1. Request OTP.
  let res = http.post(
    `${BASE_URL}/api/auth/request-otp`,
    JSON.stringify({ email, platform: 'web' }),
    { headers: jsonHeaders(), tags: { name: 'request_otp' } },
  );
  if (!check(res, { 'request-otp: 200': (r) => r.status === 200 })) {
    errorRate.add(1);
    return;
  }

  // 2. Verify OTP — response is { accessToken, refreshToken } (see
  // VerifyOtpUpstreamResponse in apps/backend/src/auth/handler.ts).
  res = http.post(
    `${BASE_URL}/api/auth/verify-otp`,
    JSON.stringify({ email, otp: OTP, platform: 'web' }),
    { headers: jsonHeaders(), tags: { name: 'verify_otp' } },
  );
  const verifyOk = check(res, {
    'verify-otp: 200': (r) => r.status === 200,
    'verify-otp: has accessToken': (r) => !!r.json('accessToken'),
  });
  if (!verifyOk) {
    errorRate.add(1);
    return;
  }
  const accessToken = res.json('accessToken');
  const authHeaders = jsonHeaders({ Authorization: `Bearer ${accessToken}` });

  // 3. Create an order — legacy CTX-proxy path (CreateOrderBody in
  // apps/backend/src/orders/request-schemas.ts: merchantId + amount).
  // apps/backend/src/orders/handler.ts::createOrderHandler returns 201 with
  // `{ orderId, paymentUri, paymentAddress, xlmAmount, memo, expiresAt }` —
  // NOT `{ id }` (that shape is only the mock-ctx upstream's own record;
  // the backend reshapes it for the client before responding).
  const merchantId = MERCHANT_IDS[Math.floor(Math.random() * MERCHANT_IDS.length)];
  res = http.post(`${BASE_URL}/api/orders`, JSON.stringify({ merchantId, amount: ORDER_AMOUNT }), {
    headers: authHeaders,
    tags: { name: 'order_create' },
  });
  const createOk = check(res, {
    'order create: 201': (r) => r.status === 201,
    'order create: has orderId': (r) => !!r.json('orderId'),
  });
  if (!createOk) {
    errorRate.add(1);
    return;
  }
  orderCreateDuration.add(res.timings.duration);
  const orderId = res.json('orderId');

  // 4. Poll the order twice — mirrors the frontend's PaymentStep poll
  // cadence (tests/e2e-mocked/purchase-flow.test.ts comment: every 3s).
  // apps/backend/src/orders/get-handler.ts wraps the row in `{ order: {…} }`.
  for (let i = 0; i < 2; i++) {
    sleep(1);
    res = http.get(`${BASE_URL}/api/orders/${orderId}`, {
      headers: authHeaders,
      tags: { name: 'order_get' },
    });
    const getOk = check(res, {
      'order get: 200': (r) => r.status === 200,
      'order get: has order.id': (r) => !!r.json('order.id'),
    });
    if (!getOk) errorRate.add(1);
  }

  sleep(1);
}
