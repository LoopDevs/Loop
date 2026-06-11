#!/usr/bin/env node
/**
 * Demo seed for the discount-vs-cashback recording (see LOOP_PHASE_1_ONLY).
 *
 * Discount vs cashback is one runtime flag, not two builds — so you record the
 * same app twice, flipping the flag between takes. The catch is that a fresh
 * account makes the *cashback* take look empty ($0 balance, no history). This
 * script seeds one demo user with a believable accrued balance + a spread of
 * fulfilled orders so the Phase-2 surfaces (balance card, monthly chart,
 * by-merchant, flywheel chip, order list) render populated.
 *
 * It writes the same rows `markOrderFulfilled` would have (orders +
 * credit_transactions + user_credits), pre-baked to a settled state — the same
 * recipe the flywheel e2e global-setup uses, fanned out across merchants/months.
 *
 * Usage (run with a local dev postgres up — `npm run dev` uses it):
 *   DATABASE_URL=postgres://loop:loop@localhost:5433/loop \
 *     node scripts/demo-seed.mjs --email demo@loopfinance.io --currency USD
 *
 * Then to record:
 *   - Discount video:  set LOOP_PHASE_1_ONLY=true  in apps/backend/.env, restart backend
 *   - Cashback video:  set LOOP_PHASE_1_ONLY=false in apps/backend/.env, restart backend
 *   Log in as the demo email via the normal OTP flow (loop-native OTP is in the
 *   `otps` table in dev; or run the backend with NODE_ENV=test to use the
 *   /__test__/mint-loop-token session minter).
 *
 * Re-running is safe: it clears this user's previously-seeded orders/credits
 * first, so the balance doesn't compound across runs.
 */
import postgres from 'postgres';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--'))
      acc.push([a.slice(2), arr[i + 1]?.startsWith('--') ? true : arr[i + 1]]);
    return acc;
  }, []),
);

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://loop:loop@localhost:5433/loop';
const email = args.email ?? 'demo@loopfinance.io';
const currency = (args.currency ?? 'USD').toUpperCase();
if (!['USD', 'GBP', 'EUR'].includes(currency)) {
  console.error(`--currency must be USD|GBP|EUR (got ${currency})`);
  process.exit(1);
}
// A plausible linked Stellar address so the wallet surfaces read as "connected"
// in the cashback take (display-only; never used to sign).
const STELLAR_ADDRESS = 'GDEMO5LOOPDEMO5LOOPDEMO5LOOPDEMO5LOOPDEMO5LOOPDEMO5LOOPX';

// Fulfilled orders to seed — recognisable brands, spread back over ~6 months so
// the monthly chart has bars and the by-merchant card has rows. faceMinor is in
// the home currency's minor units. Split is the standard 70/5/25 (wholesale /
// user-cashback / loop-margin), summing to face so any coherence check passes.
const ORDERS = [
  { merchant: 'amazon', face: 10000, monthsAgo: 0 },
  { merchant: 'starbucks', face: 2500, monthsAgo: 0 },
  { merchant: 'target', face: 5000, monthsAgo: 1 },
  { merchant: 'amazon', face: 7500, monthsAgo: 2 },
  { merchant: 'uber', face: 3000, monthsAgo: 3 },
  { merchant: 'nike', face: 12000, monthsAgo: 4 },
  { merchant: 'target', face: 4000, monthsAgo: 5 },
];
const USER_PCT = 5; // user cashback %
const WHOLESALE_PCT = 70;
const MARGIN_PCT = 25;

const sql = postgres(DATABASE_URL, { max: 1, types: { bigint: postgres.BigInt } });

try {
  // Upsert the demo user (loop-native: ctx_user_id NULL).
  const [user] = await sql`
    INSERT INTO users (email, home_currency, stellar_address)
    VALUES (${email}, ${currency}, ${STELLAR_ADDRESS})
    ON CONFLICT (LOWER(email)) WHERE ctx_user_id IS NULL
    DO UPDATE SET home_currency = EXCLUDED.home_currency,
                  stellar_address = EXCLUDED.stellar_address,
                  updated_at = NOW()
    RETURNING id
  `;
  const userId = user.id;

  // Clear prior seeded rows for this user so re-runs don't compound.
  await sql`DELETE FROM credit_transactions WHERE user_id = ${userId}`;
  await sql`DELETE FROM pending_payouts WHERE user_id = ${userId}`;
  await sql`DELETE FROM user_credits WHERE user_id = ${userId}`;
  await sql`DELETE FROM orders WHERE user_id = ${userId}`;

  let balanceMinor = 0n;
  const merchants = [...new Set(ORDERS.map((o) => o.merchant))];

  // Ensure a cashback config per demo merchant (the history trigger fires on
  // insert; ON CONFLICT keeps a re-run idempotent).
  for (const merchant of merchants) {
    await sql`
      INSERT INTO merchant_cashback_configs
        (merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct, active, updated_by)
      VALUES (${merchant}, ${`${WHOLESALE_PCT}.00`}, ${`${USER_PCT}.00`}, ${`${MARGIN_PCT}.00`}, true, 'demo-seed')
      ON CONFLICT (merchant_id) DO NOTHING
    `;
  }

  for (const o of ORDERS) {
    const face = BigInt(o.face);
    const userCashback = (face * BigInt(USER_PCT)) / 100n;
    const wholesale = (face * BigInt(WHOLESALE_PCT)) / 100n;
    const margin = face - wholesale - userCashback; // remainder → exact sum
    const ts = sql`NOW() - (${o.monthsAgo} || ' months')::interval`;

    const [order] = await sql`
      INSERT INTO orders
        (user_id, merchant_id, face_value_minor, currency, charge_minor, charge_currency,
         payment_method, wholesale_pct, user_cashback_pct, loop_margin_pct,
         wholesale_minor, user_cashback_minor, loop_margin_minor, state, created_at, fulfilled_at)
      VALUES
        (${userId}, ${o.merchant}, ${face}, ${currency}, ${face}, ${currency},
         'credit', ${`${WHOLESALE_PCT}.00`}, ${`${USER_PCT}.00`}, ${`${MARGIN_PCT}.00`},
         ${wholesale}, ${userCashback}, ${margin}, 'fulfilled', ${ts}, ${ts})
      RETURNING id
    `;

    await sql`
      INSERT INTO credit_transactions
        (user_id, type, amount_minor, currency, reference_type, reference_id, created_at)
      VALUES
        (${userId}, 'cashback', ${userCashback}, ${currency}, 'order', ${order.id}, ${ts})
    `;
    balanceMinor += userCashback;
  }

  await sql`
    INSERT INTO user_credits (user_id, currency, balance_minor)
    VALUES (${userId}, ${currency}, ${balanceMinor})
    ON CONFLICT (user_id, currency) DO UPDATE SET balance_minor = EXCLUDED.balance_minor, updated_at = NOW()
  `;

  const major = (Number(balanceMinor) / 100).toFixed(2);
  console.log(`✓ Seeded demo user ${email} (${userId})`);
  console.log(
    `  ${ORDERS.length} fulfilled orders across ${merchants.length} merchants, spread over 6 months`,
  );
  console.log(
    `  Cashback balance: ${major} ${currency}, linked wallet ${STELLAR_ADDRESS.slice(0, 8)}…`,
  );
  console.log('');
  console.log('Record:');
  console.log('  • Discount take  → LOOP_PHASE_1_ONLY=true  in apps/backend/.env, restart backend');
  console.log('  • Cashback take  → LOOP_PHASE_1_ONLY=false in apps/backend/.env, restart backend');
  console.log(`  • Log in as ${email} (OTP flow), then open Account → Cashback / Wallet.`);
} finally {
  await sql.end({ timeout: 5 });
}
