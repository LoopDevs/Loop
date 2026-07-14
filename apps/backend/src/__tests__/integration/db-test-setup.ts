/**
 * Real-postgres integration-test harness (A2-1705 closure infra).
 *
 * Connects to the `loop_test` database that `docker-compose up -d db`
 * provisions locally, runs the checked-in migrations against it, and
 * exposes a per-test `truncateAllTables()` so each test starts from a
 * clean schema state.
 *
 * Gated on `LOOP_E2E_DB=1` so unit-test runs (which use placeholder
 * DATABASE_URL + per-file mocks) don't accidentally pull in a real
 * connection. The companion `vitest.integration.config.ts` sets that
 * env var and an explicit DATABASE_URL pointing at `loop_test`.
 *
 * Why a separate helper rather than reusing `db/client.ts`: the
 * production client memo-caches a postgres-js pool at module load, so
 * importing it here means the test pool stays alive for the whole
 * process and `closeDb()` works on shutdown. The migration step uses
 * the same pool so DDL + DML go through one connection.
 *
 * Tables are truncated in dependency order with `RESTART IDENTITY` +
 * `CASCADE` so per-row sequences reset and FK chains tear cleanly. The
 * `migrations` schema row stays untouched — drizzle's migrator no-ops
 * when the journal is up-to-date, so we don't pay for re-applying.
 */
import { and, eq, sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { db } from '../../db/client.js';
import type { DB } from '../../db/client.js';
import { creditTransactions, userCredits } from '../../db/schema.js';

/**
 * Tables in the order they should be truncated. Listed dependency-
 * children-first; CASCADE handles any FK we miss but explicit order
 * keeps the truncation deterministic.
 */
export const TABLES_TO_TRUNCATE = [
  'asset_drift_state',
  // ADR 031 §D3/D9 (V1 foundation, migration 0060): the vault registry
  // + share-price snapshot tables. No FK to users/orders, but listed
  // explicitly so `loop-vaults.test.ts` gets a clean slate per test
  // like every other suite here.
  'loop_vaults',
  'vault_share_price_snapshots',
  // ADR 031 §D5 (V3, migration 0061): the vault cashback-emission
  // state-machine table. References orders/users/pending_payouts —
  // CASCADE sweeps it transitively, listed explicitly for the same
  // self-documenting reason as its V1 siblings above.
  'vault_emissions',
  // ADR 031 §D6 (V4, migration 0062): the vault-share REDEMPTION
  // state machine + its hot-float ledger. `vault_redemptions`
  // references users/pending_payouts (CASCADE sweeps it transitively,
  // same self-documenting reasoning as `vault_emissions` above), but
  // `vault_hot_float` has NO foreign key to anything else in this list
  // (it's a standalone per-(asset_code, network) ledger row) — without
  // listing it explicitly here, CASCADE would never reach it and a
  // seeded float balance would leak across tests within this file.
  'vault_redemptions',
  'vault_hot_float',
  // ADR 031 §D4 (V5, migration 0063): the vault-aware hot-float
  // reconciliation's audit trail. No FK to anything else in this
  // list (a standalone per-(asset_code, network, tick) run row) —
  // same "CASCADE never reaches it" reasoning as `vault_hot_float`.
  'vault_float_reconciliation_runs',
  'interest_pool_alert_state',
  'watchdog_alert_state',
  'otp_attempt_counters',
  'ctx_settlements',
  // The operator-wallet float-reconciliation subsystem (migration
  // 0052). None of these have an FK PATH that CASCADE reaches from the
  // roots below, so — like `vault_hot_float` /
  // `vault_float_reconciliation_runs` above — they were NEVER cleared
  // and latent-leaked across tests until listed explicitly here:
  //   • `operator_float_reconciliation_runs` references
  //     `operator_wallet_baselines` (its only FK, ON DELETE SET NULL —
  //     which TRUNCATE CASCADE ignores anyway), so it's a child of a
  //     table nothing truncates; and
  //   • `operator_wallet_baselines` / `operator_manual_movements` are
  //     pure PARENTS. The one child that references them
  //     (`operator_wallet_movements`) IS swept transitively via
  //     `orders` below, but CASCADE flows parent→child, so truncating
  //     that child never reaches these parents.
  // Listed children-first (runs → baselines) for the same
  // deterministic-order reasoning as the rest of this list; CASCADE
  // makes the exact order immaterial for correctness.
  'operator_float_reconciliation_runs',
  'operator_wallet_baselines',
  'operator_manual_movements',
  // The CTX gift-card catalog-snapshot cache (migration 0053). A
  // standalone table with NO foreign key to anything — same "CASCADE
  // never reaches it" gap as the operator-float rows above, so seeded
  // snapshots leaked across tests until listed here.
  'ctx_catalog_snapshots',
  // Q6-6: the interest-mint integration suite writes here directly.
  // Not previously listed — CASCADE from `users` below already swept
  // it transitively (interest_mint_snapshots.user_id references
  // users.id), but listing it explicitly keeps the truncation order
  // self-documenting per this file's own stated intent.
  'interest_mint_snapshots',
  'pending_payouts',
  'payment_watcher_skips',
  'credit_transactions',
  'user_credits',
  'orders',
  'merchant_cashback_config_history',
  'merchant_cashback_configs',
  'admin_idempotency_keys',
  'social_id_token_uses',
  'user_identities',
  'user_favorite_merchants',
  'refresh_tokens',
  'otps',
  // SEC-02-stepup (migration 0065): the admin step-up single-use
  // ledger. No FK to anything in this list (an ephemeral per-`jti`
  // marker), so — like `otp_attempt_counters` / `vault_hot_float`
  // above — CASCADE never reaches it and a consumed-jti row would leak
  // across tests unless truncated explicitly.
  'admin_step_up_consumptions',
  'users',
  'watcher_cursors',
] as const;

let migrationsApplied = false;

/**
 * Ensures the test DB schema is up-to-date. Idempotent — drizzle's
 * migrator no-ops once the journal is current. Call once per test
 * file (Vitest re-uses the worker process across tests in the same
 * file, so we only pay for this on cold start).
 */
export async function ensureMigrated(): Promise<void> {
  if (migrationsApplied) return;
  await migrate(db, { migrationsFolder: new URL('../../db/migrations', import.meta.url).pathname });
  migrationsApplied = true;
}

/**
 * Truncates every table touched by the integration suite. Run in
 * `beforeEach` so each test starts on a deterministic state. Uses a
 * single statement so postgres folds it into one txn and the
 * truncates land atomically.
 */
export async function truncateAllTables(): Promise<void> {
  const tableList = TABLES_TO_TRUNCATE.map((t) => `"${t}"`).join(', ');
  await db.execute(sql.raw(`TRUNCATE ${tableList} RESTART IDENTITY CASCADE`));
}

/**
 * DAT-01-inv1 mirror-invariant seed helpers (migration 0066).
 *
 * 0066 fences `user_credits.balance_minor == COALESCE(SUM(
 * credit_transactions.amount_minor), 0)` per (user, currency) with a
 * `DEFERRABLE INITIALLY DEFERRED` constraint trigger, checked at COMMIT.
 * Before it, integration fixtures routinely seeded a balance-only
 * `user_credits` row (or a ledger with no balance) in its own autocommit
 * — a one-sided mirror state that is now rejected as the drift it models.
 * These helpers seed the mirror CONSISTENTLY (both sides, one txn) so the
 * fixture matches how a real writer maintains the invariant. They are the
 * fixture-side companion to the migration, NOT a weakening of it.
 *
 * `DB | Tx` first arg: pass the module `db`; the helper opens its own
 * transaction so the two sides land in ONE commit (the deferred trigger
 * tolerates the transient intermediate imbalance and only asserts the
 * committed end-state). Passing a caller's `tx` nests via a savepoint.
 */
type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
type SeedDb = DB | Tx;

/**
 * Seeds a `(user, currency)` balance row PLUS a single backing
 * opening-balance ledger row (`amount_minor === balanceMinor`) in ONE
 * transaction, leaving the mirror EQUAL.
 *
 * Default `type` is `'adjustment'` — the only ledger kind whose
 * `credit_transactions_amount_sign` CHECK admits any amount (including a
 * seed of 0), and the natural type for a seeded opening balance. It
 * satisfies 0064 immutability (a fresh INSERT is always allowed) and does
 * not participate in 0044 emission conservation (that trigger is on
 * `pending_payouts`). Callers that need the backing row to carry a
 * specific type/reference (e.g. a cashback-derived balance) override
 * `type`/`referenceType`/`referenceId` — for a non-`adjustment` type the
 * `balanceMinor` must satisfy that type's sign CHECK (e.g. `cashback` > 0).
 *
 * Use this wherever a fixture previously seeded a balance-only
 * `user_credits` row that the test does not otherwise back with ledger.
 * It adds exactly ONE ledger row, so do NOT use it where the test asserts
 * on the exact ledger contents/row-count (use
 * `seedLedgerRowsWithMirrorBalance` for those).
 */
export async function seedUserCreditsWithBackingLedger(
  dbOrTx: SeedDb,
  opts: {
    userId: string;
    currency: string;
    balanceMinor: bigint;
    type?: 'adjustment' | 'cashback' | 'interest' | 'refund';
    reason?: string | null;
    referenceType?: string | null;
    referenceId?: string | null;
    periodCursor?: string | null;
  },
): Promise<void> {
  const {
    userId,
    currency,
    balanceMinor,
    type = 'adjustment',
    reason = 'DAT-01-inv1 opening-balance fixture',
    referenceType = null,
    referenceId = null,
    periodCursor = null,
  } = opts;
  await dbOrTx.transaction(async (tx) => {
    await tx.insert(creditTransactions).values({
      userId,
      type,
      amountMinor: balanceMinor,
      currency,
      referenceType,
      referenceId,
      reason,
      periodCursor,
    });
    await tx.insert(userCredits).values({ userId, currency, balanceMinor });
  });
}

/**
 * Seeds an EXPLICIT set of `credit_transactions` rows and then upserts
 * each touched `(user, currency)` balance to the real `SUM(amount_minor)`
 * — all in ONE transaction, so the mirror is EQUAL at commit.
 *
 * For fixtures whose ledger rows are load-bearing (a history endpoint
 * asserts the exact rows / count / ordering), where the single opening
 * row `seedUserCreditsWithBackingLedger` adds would corrupt the assertion.
 * The balance is derived from the actual post-insert ledger sum, so it is
 * correct for multi-row, multi-user and multi-currency seeds.
 */
export async function seedLedgerRowsWithMirrorBalance(
  dbOrTx: SeedDb,
  rows: Array<typeof creditTransactions.$inferInsert>,
): Promise<void> {
  await dbOrTx.transaction(async (tx) => {
    await tx.insert(creditTransactions).values(rows);
    const keys = new Map<string, { userId: string; currency: string }>();
    for (const r of rows) keys.set(`${r.userId}:${r.currency}`, { userId: r.userId, currency: r.currency });
    for (const { userId, currency } of keys.values()) {
      const [summed] = await tx
        .select({ sum: sql<bigint>`COALESCE(SUM(${creditTransactions.amountMinor}), 0)` })
        .from(creditTransactions)
        .where(and(eq(creditTransactions.userId, userId), eq(creditTransactions.currency, currency)));
      const balanceMinor = summed?.sum ?? 0n;
      await tx
        .insert(userCredits)
        .values({ userId, currency, balanceMinor })
        .onConflictDoUpdate({
          target: [userCredits.userId, userCredits.currency],
          set: { balanceMinor },
        });
    }
  });
}

/**
 * Runs `seed` with the mirror-invariant (and other origin-role) triggers
 * SUPPRESSED, for fixtures that DELIBERATELY construct a one-sided /
 * mismatched mirror state to exercise a DIFFERENT invariant (e.g. the
 * drift detector's own mismatch-detection path). The `loop` test role is
 * a superuser, so `SET LOCAL session_replication_role = 'replica'`
 * suppresses non-system triggers — including 0066's `DEFERRABLE` mirror
 * constraint trigger, which is never QUEUED for statements issued in
 * replica mode and therefore does not fire at COMMIT. This models
 * PRE-0066 historical rows that predate the constraint.
 *
 * `SET LOCAL` is scoped to (and auto-reset at the end of) the wrapping
 * transaction, so the suppression cannot leak past the seed: every
 * subsequent statement — including the operation actually under test —
 * runs with all triggers ENABLED. It does NOT disable or drop any trigger
 * globally. Reserve this for genuinely-intentional drift; prefer the
 * consistent-mirror helpers above wherever the fixture CAN be made
 * consistent without changing what it tests.
 */
export async function seedWithMirrorTriggersSuppressed(
  dbOrTx: SeedDb,
  seed: (tx: Tx) => Promise<void>,
): Promise<void> {
  await dbOrTx.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL session_replication_role = 'replica'`);
    await seed(tx);
  });
}
