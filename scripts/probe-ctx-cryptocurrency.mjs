#!/usr/bin/env node
/**
 * One-off probe: discover what `cryptoCurrency` value CTX's
 * production `POST /gift-cards` expects in 2026. Tries a series of
 * candidate formats against spend.ctx.com using a fresh user OTP
 * login. Records the response for each so we can pick the format
 * that comes back 2xx (or at least past the cryptoCurrency
 * validator).
 *
 * Usage:
 *   PROBE_EMAIL=ash+loopsystem@ashfrancis.com node scripts/probe-ctx-cryptocurrency.mjs request-otp
 *   PROBE_EMAIL=ash+loopsystem@ashfrancis.com PROBE_OTP=123456 node scripts/probe-ctx-cryptocurrency.mjs run
 *
 * Aerie merchant id is the default — the smallest-denomination card
 * we already know is reachable on the production catalog.
 */
const CTX = 'https://spend.ctx.com';
const AERIE_MERCHANT_ID = process.env.PROBE_MERCHANT_ID ?? 'b6c8c4a4-9af1-4858-9ec4-87cc9e0d44b6';
const FIAT_AMOUNT = process.env.PROBE_FIAT_AMOUNT ?? '0.02';
const FIAT_CURRENCY = process.env.PROBE_FIAT_CURRENCY ?? 'USD';

const CANDIDATES = [
  'XLM',
  'USDC',
  'stellar:XLM',
  'stellar:USDC',
  'XLM:stellar',
  'USDC:stellar',
  'stellar/XLM',
  'stellar/USDC',
  'XLM-stellar',
  'STELLAR_XLM',
  'STELLAR_USDC',
];

const CLIENT_ID = process.env.PROBE_CLIENT_ID ?? 'loopweb';

async function requestOtp(email) {
  const res = await fetch(`${CTX}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, clientId: CLIENT_ID }),
  });
  console.log(`[request-otp] status=${res.status}`);
  console.log(await res.text());
}

async function verifyOtp(email, code) {
  const res = await fetch(`${CTX}/verify-email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, code, clientId: CLIENT_ID }),
  });
  const json = await res.json();
  console.log(`[verify-otp] status=${res.status} keys=${Object.keys(json).join(',')}`);
  return json.accessToken;
}

async function probe(token) {
  for (const value of CANDIDATES) {
    const body = JSON.stringify({
      cryptoCurrency: value,
      fiatCurrency: FIAT_CURRENCY,
      fiatAmount: FIAT_AMOUNT,
      merchantId: AERIE_MERCHANT_ID,
    });
    const res = await fetch(`${CTX}/gift-cards`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body,
    });
    const text = await res.text();
    const truncated = text.length > 400 ? `${text.slice(0, 400)}...` : text;
    console.log(`[probe] cryptoCurrency=${JSON.stringify(value).padEnd(20)} → ${res.status} ${truncated.replace(/\s+/g, ' ')}`);
    // Small pause so we don't trip CTX rate limits
    await new Promise((r) => setTimeout(r, 250));
  }
}

const mode = process.argv[2] ?? 'request-otp';
const email = process.env.PROBE_EMAIL;
if (!email) {
  console.error('Set PROBE_EMAIL');
  process.exit(2);
}
if (mode === 'request-otp') {
  await requestOtp(email);
} else if (mode === 'run') {
  const code = process.env.PROBE_OTP;
  if (!code) {
    console.error('Set PROBE_OTP');
    process.exit(2);
  }
  const token = await verifyOtp(email, code);
  if (!token) {
    console.error('No accessToken returned');
    process.exit(1);
  }
  await probe(token);
} else {
  console.error(`Unknown mode: ${mode}`);
  process.exit(2);
}
