/**
 * Drizzle schema — admin domain (hardening D2 split).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  bigint,
  char,
  boolean,
  timestamp,
  integer,
  index,
  check,
  primaryKey,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

/**
 * NS-04 — durable, admin-toggleable runtime halt for the four money
 * rails (deposit / payout / vault / refund). One row per rail; `halted`
 * defaults FALSE (the "not halted" default is a PROTECTED CLASS). A
 * missing row is also read as "not halted"; the migration seeds all four
 * open. Enforcement reads this at each rail's entry point (block-new-only)
 * and fails CLOSED on a read error. The admin API (halt/resume/list) is
 * the only writer. See migration 0072 and
 * `docs/audit/audit-2026-07/ns-04-kill-switches-design.md`.
 *
 * Distinct from the env/secret kill switches in `../../kill-switches.ts`:
 * that names env subsystems flipped via Fly secrets; this names DB-backed
 * rails toggled via an admin API.
 */
export const railKillSwitches = pgTable(
  'rail_kill_switches',
  {
    rail: text('rail').primaryKey().$type<'deposit' | 'payout' | 'vault' | 'refund'>(),
    halted: boolean('halted').notNull().default(false),
    /** Operator-supplied reason for the current state; null when never toggled. */
    reason: text('reason'),
    /** Admin who last toggled this rail; null at seed / when never toggled. */
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'restrict' }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'rail_kill_switches_rail_known',
      sql`${t.rail} IN ('deposit', 'payout', 'vault', 'refund')`,
    ),
    // A halted switch MUST carry who + why (audit completeness); an open
    // switch may retain them from the last toggle, or be null at seed.
    check(
      'rail_kill_switches_halted_has_reason',
      sql`${t.halted} = false OR (${t.reason} IS NOT NULL AND ${t.actorUserId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Admin idempotency store (ADR 017). Each row is the snapshot of a
 * completed admin write, replayed on retry with the same
 * (admin_user_id, key) pair so a double-click can't produce a double
 * side-effect. 24h TTL enforced by a nightly cleanup sweep.
 */
export const adminIdempotencyKeys = pgTable(
  'admin_idempotency_keys',
  {
    adminUserId: uuid('admin_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    status: integer('status').notNull(),
    responseBody: text('response_body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // A2-701: match the actual constraint shape the migration
    // installs — `CONSTRAINT "admin_idempotency_keys_pk" PRIMARY KEY
    // ("admin_user_id", "key")` — instead of declaring a separate
    // uniqueIndex with a `_pk_idx` suffix. Earlier drift would have
    // made `drizzle-kit generate` emit a DROP-PK + ADD-uniqueIndex
    // on the next run, losing the PK metadata without any semantic
    // change on the uniqueness side.
    primaryKey({ columns: [t.adminUserId, t.key], name: 'admin_idempotency_keys_pk' }),
    index('admin_idempotency_keys_created_at').on(t.createdAt),
    check('admin_idempotency_keys_key_length', sql`char_length(${t.key}) BETWEEN 16 AND 128`),
    check('admin_idempotency_keys_status_valid', sql`${t.status} >= 100 AND ${t.status} < 600`),
  ],
);

/**
 * A2-566: social-login ID-token replay guard. Every successfully
 * verified Google / Apple id_token is recorded by its sha256 digest
 * before we mint a Loop session. A second attempt with the same token
 * hits the unique constraint and the handler rejects with 401.
 *
 * See `auth/id-token-replay.ts` for the consume helper and the
 * corresponding migration (`0019_social_id_token_replay_guard.sql`).
 */
export const socialIdTokenUses = pgTable(
  'social_id_token_uses',
  {
    tokenHash: text('token_hash').primaryKey(),
    provider: text('provider').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('social_id_token_uses_expires_at_idx').on(t.expiresAt)],
);

/**
 * Per-user merchant favourites (Tranche 2 user-value follow-on).
 *
 * Opt-in pin list a user maintains so the app can surface go-to
 * merchants on the home grid. Read-mostly and tiny per-user.
 *
 * `merchant_id` is `text` (not a foreign key) — the catalog itself
 * isn't a Postgres table; it's the in-memory `MerchantCatalogStore`
 * fed by upstream sync (ADR 021). A merchant temporarily disappearing
 * from the catalog must NOT cascade-delete the user's favourite — the
 * read-side hides the entry until the merchant returns. Permanently-
 * removed merchants leave dead rows that the eviction sweep mops up
 * (ADR 021 §eviction policy).
 *
 * Composite PK on `(user_id, merchant_id)` is the natural dedupe
 * boundary; the `(user_id, created_at DESC)` index covers the only
 * read shape ("this user's favourites, newest first"). See migration
 * `0032_user_favorite_merchants.sql` for the SQL + the rollback path.
 */
/**
 * Nightly interest-mint snapshots (ADR 031 / ADR 036 Phase D,
 * migration 0041). One row per (user, asset, UTC-day period) the
 * interest-mint worker processed — the auditable record of WHAT
 * on-chain balance the night's mint was computed from, and the
 * carry-accumulator that lets sub-penny accruals pay out exactly
 * over time.
 *
 * Math (all bigint):
 *
 *   accrual_stroops = floor(balance_stroops × apyBps / (10_000 × 365))

 *   payable         = carry_before_stroops + accrual_stroops
 *   minted_minor    = payable / 100_000        (1 minor unit = 1e5 stroops)

 *   carry_after     = payable % 100_000
 *
 * The carry exists because the `user_credits` mirror is integer
 * minor units (pence/cents) while Stellar amounts have 7 decimals:
 * minting the raw 7-decimal accrual would leave the mirror unable to
 * record the sub-minor fraction and the asset-drift equation would
 * diverge monotonically. Instead the on-chain mint and the mirror
 * credit are BOTH `minted_minor` (× 1e5 stroops on-chain) — always
 * equal, always drift-neutral — and the fractional remainder carries
 * forward here until it crosses a whole minor unit.
 *
 * Inserted in the SAME transaction as the `credit_transactions
 * type='interest'` row + `user_credits` bump + `pending_payouts
 * kind='interest_mint'` row, so the snapshot is also the per-user
 * idempotency fence for a re-run of the same period (unique below;
 * the period-cursor partial unique on credit_transactions is the
 * second, money-level fence).
 */
export const interestMintSnapshots = pgTable(
  'interest_mint_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    assetCode: text('asset_code').notNull(),
    assetIssuer: text('asset_issuer').notNull(),
    /** Fiat currency the mirror credit lands in (1:1 with assetCode). */
    currency: char('currency', { length: 3 }).notNull(),
    /** UTC calendar day, `YYYY-MM-DD` — same shape as credit_transactions.period_cursor. */
    periodCursor: text('period_cursor').notNull(),
    /** On-chain balance read from Horizon at snapshot time (stroops). */
    balanceStroops: bigint('balance_stroops', { mode: 'bigint' }).notNull(),
    /** This night's raw accrual, floored to 7 decimals (stroops). */
    accrualStroops: bigint('accrual_stroops', { mode: 'bigint' }).notNull(),
    /** Sub-minor remainder carried IN from the previous snapshot. */
    carryBeforeStroops: bigint('carry_before_stroops', { mode: 'bigint' }).notNull(),
    /** Sub-minor remainder carried OUT to the next snapshot (< 1e5). */
    carryAfterStroops: bigint('carry_after_stroops', { mode: 'bigint' }).notNull(),
    /**
     * The mirror credit / on-chain mint in minor units. 0 = the night
     * accrued into the carry only (no ledger or payout rows written).
     */
    mintedMinor: bigint('minted_minor', { mode: 'bigint' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Per-user-per-asset-per-night idempotency fence. Also serves the
    // "latest carry" lookup (max period_cursor per user+asset) as a
    // covering ordered scan.
    uniqueIndex('interest_mint_snapshots_user_asset_period_unique').on(
      t.userId,
      t.assetCode,
      t.periodCursor,
    ),
    // Pinned to GBPLOOP only (2026-06-15 cold audit v-wallet P0) — see
    // ONCHAIN_MINT_ELIGIBLE_ASSETS in credits/interest-mint.ts.
    check('interest_mint_snapshots_asset_code_known', sql`${t.assetCode} = 'GBPLOOP'`),
    check('interest_mint_snapshots_issuer_format', sql`${t.assetIssuer} ~ '^G[A-Z2-7]{55}$'`),
    check('interest_mint_snapshots_currency_known', sql`${t.currency} IN ('USD', 'GBP', 'EUR')`),
    check(
      'interest_mint_snapshots_non_negative',
      sql`
        ${t.balanceStroops} >= 0
        AND ${t.accrualStroops} >= 0
        AND ${t.carryBeforeStroops} >= 0
        AND ${t.mintedMinor} >= 0
      `,
    ),
    // The carry-out is by construction a modulo-1e5 remainder.
    check(
      'interest_mint_snapshots_carry_bounded',
      sql`${t.carryAfterStroops} >= 0 AND ${t.carryAfterStroops} < 100000`,
    ),
    // Value conservation: nothing is created or lost between the
    // accrual, the mint, and the carry. A violating write is a math
    // bug — fail at the DB layer.
    check(
      'interest_mint_snapshots_conservation',
      sql`${t.carryBeforeStroops} + ${t.accrualStroops} = ${t.mintedMinor} * 100000 + ${t.carryAfterStroops}`,
    ),
  ],
);
