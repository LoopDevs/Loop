/**
 * Playwright globalSetup for the loop-native flywheel suite (A2-1705
 * phase A.3 closure).
 *
 * Mirrors `../e2e-mocked/global-setup.ts` for migration + truncate,
 * but seeds an already-fulfilled loop-native order with a cashback
 * credit_transactions row + user_credits balance — the test's job is
 * to verify the UI consumer surfaces (LoopOrdersList +
 * CashbackEarningsHeadline) after authenticating via the test-only
 * mint-token endpoint. Order CREATION through the UI is covered by
 * the existing mocked-e2e purchase flow; this suite closes the
 * round-trip "fulfilment writes → user sees cashback in /orders".
 *
 * The seeded user's email is pinned to `flywheel-walk@test.local` so
 * the test can mint a token for the same user later.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://loop:loop@localhost:5433/loop_test';

const TABLES_TO_TRUNCATE = [
  'pending_payouts',
  'credit_transactions',
  'user_credits',
  'orders',
  'merchant_cashback_config_history',
  'merchant_cashback_configs',
  'admin_idempotency_keys',
  'social_id_token_uses',
  'user_identities',
  'refresh_tokens',
  'otps',
  'users',
  'watcher_cursors',
];

export default async function globalSetup(): Promise<void> {
  const client = postgres(DATABASE_URL, { max: 1, types: { bigint: postgres.BigInt } });
  const db = drizzle(client);
  try {
    await migrate(db, {
      migrationsFolder: new URL('../../apps/backend/src/db/migrations', import.meta.url).pathname,
    });
    const tableList = TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ');
    await db.execute(sql.raw(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`));

    // Seed: cashback config (the merchant_cashback_config_history
    // trigger fires on insert).
    await db.execute(sql`
      INSERT INTO merchant_cashback_configs
        (merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct, active, updated_by)
      VALUES
        ('amazon', '70.00', '5.00', '25.00', true, 'flywheel-seed')
    `);

    // Seed: user with home_currency.
    await db.execute(sql`
      INSERT INTO users (email, home_currency)
      VALUES ('flywheel-walk@test.local', 'USD')
      RETURNING id
    `);
    const [u] = await db.execute<{ id: string }>(
      sql`SELECT id FROM users WHERE email = 'flywheel-walk@test.local'`,
    );
    if (u === undefined) throw new Error('seed: user insert returned no row');
    const userId = u.id;

    // Seed: fulfilled loop-native order (paymentMethod='credit'
    // skips the orders_payment_memo_coherence CHECK so we don't need
    // a chain-side memo). Pin amounts so the cashback summary asserts
    // are deterministic.
    const [orderRow] = await db.execute<{ id: string }>(
      sql`
        INSERT INTO orders
          (user_id, merchant_id, face_value_minor, currency, charge_minor, charge_currency,
           payment_method, wholesale_pct, user_cashback_pct, loop_margin_pct,
           wholesale_minor, user_cashback_minor, loop_margin_minor, state, fulfilled_at)
        VALUES
          (${userId}, 'amazon', 5000, 'USD', 5000, 'USD',
           'credit', '70.00', '5.00', '25.00',
           3500, 250, 1250, 'fulfilled', NOW())
        RETURNING id
      `,
    );
    if (orderRow === undefined) throw new Error('seed: orders insert returned no row');
    const orderId = orderRow.id;

    // Seed: cashback credit_transactions row + matching user_credits
    // balance. Mirrors what `markOrderFulfilled` would have done, but
    // pre-baked so the UI test starts from a settled state.
    await db.execute(sql`
      INSERT INTO credit_transactions
        (user_id, type, amount_minor, currency, reference_type, reference_id)
      VALUES
        (${userId}, 'cashback', 250, 'USD', 'order', ${orderId})
    `);
    await db.execute(sql`
      INSERT INTO user_credits (user_id, currency, balance_minor)
      VALUES (${userId}, 'USD', 250)
    `);
  } finally {
    await client.end({ timeout: 5 });
  }
}
