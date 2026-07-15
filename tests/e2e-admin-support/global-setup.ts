/**
 * Playwright globalSetup for the admin/support dashboard E2E smoke
 * (Q6-5, `docs/money-auth-worklist.md`).
 *
 * The admin surface got large this session (A5-1 redrive, A5-2
 * revoke-sessions, A5-3 auth-state/clear-lockout, A5-4 refund, A5-6
 * stuck-orders visibility, A5-7 audit timeline, A5-8 ledger browser)
 * with unit + staff-gating + component coverage, but nothing drove it
 * through a real browser as an authenticated staff user. This suite
 * closes that gap.
 *
 * Mirrors `../e2e-flywheel/global-setup.ts`'s migrate-then-truncate
 * shape, then seeds:
 *
 *   - Two staff sessions' worth of state: an `admin`-role user and a
 *     `support`-role user (`staff_roles` rows — the ADR 037 table),
 *     so the test can authenticate as each tier via the same
 *     `/__test__/mint-loop-token` endpoint the flywheel suite uses
 *     (that endpoint only mints a Loop-native session; it grants no
 *     role, so the role grant here is a direct SQL seed, same
 *     spirit as the flywheel suite's direct cashback-ledger seed).
 *   - One ordinary "customer" user (TARGET_USER_ID) with:
 *       - a `paid` order old enough to trip the stuck-orders SLO
 *         (`DEFAULT_THRESHOLD_MINUTES = 5`, `admin/stuck-orders.ts`)
 *         — this is also the order the redrive (A5-1) and refund
 *         (A5-4) panels operate on (both panels render for a `paid`
 *         order).
 *       - a `fulfilled` order + a matching `cashback` credit_transactions
 *         row + `user_credits` balance (same shape as the flywheel
 *         suite's seed), so the ledger browser (A5-8), the user-360
 *         credit-balance table, and the audit timeline (A5-7) all
 *         have real rows to render.
 *       - a live `otp_attempt_counters` lock (A5-3's "locked" state)
 *         and a live `refresh_tokens` row (so A5-2's revoke-sessions
 *         write has something real to revoke).
 *
 * All ids are fixed literals (not `defaultRandom()`) so the test file
 * can navigate straight to `/admin/orders/:id` and
 * `/admin/users/:id` without a UI search round-trip first — the goal
 * here is a deterministic smoke, not exercising the lookup search
 * (that has its own component test).
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';

const DATABASE_URL = process.env['DATABASE_URL'] ?? 'postgres://loop:loop@localhost:5433/loop_test';

export const ADMIN_USER_ID = '11111111-1111-1111-1111-111111111111';
export const SUPPORT_USER_ID = '22222222-2222-2222-2222-222222222222';
export const TARGET_USER_ID = '33333333-3333-3333-3333-333333333333';
export const STUCK_ORDER_ID = '44444444-4444-4444-4444-444444444444';
export const FULFILLED_ORDER_ID = '55555555-5555-5555-5555-555555555555';
export const REFRESH_TOKEN_JTI = '66666666-6666-6666-6666-666666666666';

export const ADMIN_EMAIL = 'admin-e2e@test.local';
export const SUPPORT_EMAIL = 'support-e2e@test.local';
export const TARGET_EMAIL = 'target-e2e@test.local';

const TABLES_TO_TRUNCATE = [
  'refresh_tokens',
  'otp_attempt_counters',
  'staff_roles',
  'pending_payouts',
  'credit_transactions',
  'user_credits',
  'orders',
  'merchant_cashback_config_history',
  'merchant_cashback_configs',
  'admin_idempotency_keys',
  'social_id_token_uses',
  'user_identities',
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
    // trigger fires on insert — same seed as the flywheel suite).
    await db.execute(sql`
      INSERT INTO merchant_cashback_configs
        (merchant_id, wholesale_pct, user_cashback_pct, loop_margin_pct, active, updated_by)
      VALUES
        ('amazon', '70.00', '5.00', '25.00', true, 'admin-e2e-seed')
    `);

    // Seed: three users with fixed ids so the test can navigate
    // directly. `is_admin` stays false on all three — the staff_roles
    // grants below are the authoritative ADR 037 role source, and
    // `findOrCreateUserByEmail` (which `/__test__/mint-loop-token`
    // calls) reconciles `is_admin` against the (unset, in this
    // harness) `ADMIN_EMAILS` allowlist on every mint, so seeding
    // `true` here would just get silently flipped back to `false` on
    // first mint — seeding `false` up front avoids that no-op write.
    await db.execute(sql`
      INSERT INTO users (id, email, home_currency, is_admin)
      VALUES
        (${ADMIN_USER_ID}, ${ADMIN_EMAIL}, 'USD', false),
        (${SUPPORT_USER_ID}, ${SUPPORT_EMAIL}, 'USD', false),
        (${TARGET_USER_ID}, ${TARGET_EMAIL}, 'USD', false)
    `);

    // Seed: ADR 037 staff-role grants — the piece
    // `/__test__/mint-loop-token` cannot do (it mints a session, not
    // a role).
    await db.execute(sql`
      INSERT INTO staff_roles (user_id, role, reason)
      VALUES
        (${ADMIN_USER_ID}, 'admin', 'e2e seed (Q6-5)'),
        (${SUPPORT_USER_ID}, 'support', 'e2e seed (Q6-5)')
    `);

    // Seed: a `paid` order old enough to be "stuck" (default SLO is 5
    // minutes — admin/stuck-orders.ts's DEFAULT_THRESHOLD_MINUTES) and
    // eligible for both the A5-1 redrive panel (requires state='paid')
    // and the A5-4 refund panel (REFUNDABLE_STATES includes 'paid').
    // payment_method='credit' sidesteps the orders_payment_memo_coherence
    // CHECK (on-chain rails require a memo; this order never needs one
    // since the step-up gate refuses both write attempts before any
    // handler logic runs).
    await db.execute(sql`
      INSERT INTO orders
        (id, user_id, merchant_id, face_value_minor, currency, charge_minor, charge_currency,
         payment_method, wholesale_pct, user_cashback_pct, loop_margin_pct,
         wholesale_minor, user_cashback_minor, loop_margin_minor, state, created_at, paid_at)
      VALUES
        (${STUCK_ORDER_ID}, ${TARGET_USER_ID}, 'amazon', 2000, 'USD', 2000, 'USD',
         'credit', '70.00', '5.00', '25.00',
         1400, 100, 500, 'paid', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes')
    `);

    // Seed: a fulfilled order + matching cashback ledger row + credit
    // balance (same shape as tests/e2e-flywheel/global-setup.ts) so
    // the ledger browser (A5-8), the user-360 credit-balance table,
    // and the audit timeline (A5-7) all have real, non-empty rows.
    await db.execute(sql`
      INSERT INTO orders
        (id, user_id, merchant_id, face_value_minor, currency, charge_minor, charge_currency,
         payment_method, wholesale_pct, user_cashback_pct, loop_margin_pct,
         wholesale_minor, user_cashback_minor, loop_margin_minor, state, fulfilled_at)
      VALUES
        (${FULFILLED_ORDER_ID}, ${TARGET_USER_ID}, 'amazon', 5000, 'USD', 5000, 'USD',
         'credit', '70.00', '5.00', '25.00',
         3500, 250, 1250, 'fulfilled', NOW())
    `);
    // Both writes MUST land in ONE transaction: migration 0066's
    // credit_transactions_mirror_invariant / user_credits_mirror_invariant
    // (CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED, INV-1) is checked
    // at COMMIT, so the ledger row and the mirrored balance must be
    // committed together — else the ledger-only commit trips
    // "balance_minor 0 <> ledger SUM 250". Same fix as the flywheel seed.
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        INSERT INTO credit_transactions
          (user_id, type, amount_minor, currency, reference_type, reference_id)
        VALUES
          (${TARGET_USER_ID}, 'cashback', 250, 'USD', 'order', ${FULFILLED_ORDER_ID})
      `);
      await tx.execute(sql`
        INSERT INTO user_credits (user_id, currency, balance_minor)
        VALUES (${TARGET_USER_ID}, 'USD', 250)
      `);
    });

    // Seed: A5-3's "locked" OTP state for the target user, so
    // AuthStatePanel has something to show besides the all-clear
    // default.
    await db.execute(sql`
      INSERT INTO otp_attempt_counters (email, failed_attempts, window_started_at, locked_until)
      VALUES (${TARGET_EMAIL}, 5, NOW(), NOW() + INTERVAL '10 minutes')
    `);

    // Seed: a live refresh-token row for the target user, so A5-2's
    // revoke-sessions write has a real row to revoke (and the
    // audit-timeline "session_revoked" source has something to pick
    // up after the test triggers it). token_hash is a placeholder —
    // this suite never presents the token as a bearer, it only
    // exercises the admin-side revoke.
    await db.execute(sql`
      INSERT INTO refresh_tokens (jti, user_id, token_hash, expires_at)
      VALUES (${REFRESH_TOKEN_JTI}, ${TARGET_USER_ID}, 'e2e-seed-placeholder-hash', NOW() + INTERVAL '1 day')
    `);
  } finally {
    await client.end({ timeout: 5 });
  }
}
