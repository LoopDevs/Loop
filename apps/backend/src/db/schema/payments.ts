/**
 * Drizzle schema — payments domain (hardening D2 split).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  integer,
  index,
  check,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { orders } from './orders.js';
import { users } from './users.js';

/**
 * Cursor persistence for long-running background watchers (ADR 010
 * payment watcher is the first user). One row per watcher; the
 * watcher reads its cursor at tick start and writes the new cursor
 * at tick end. A crashed tick keeps the prior cursor so the next
 * tick reprocesses any unconsumed records — safe because every
 * transition is idempotent.
 */
export const watcherCursors = pgTable('watcher_cursors', {
  name: text('name').primaryKey(),
  cursor: text('cursor'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Deposits the payment watcher skipped (comprehensive-audit
 * 2026-06-11, CRIT #1/#2). The watcher cursor advances past every
 * record on a Horizon page — a payment rejected for a transient
 * reason (oracle outage, A4-110 missing credit row, an unexpected
 * `markOrderPaid` error) would otherwise never be re-scanned. Each
 * skip is persisted here BEFORE the cursor advances; the sweep in
 * `payments/skipped-payments.ts` re-evaluates pending rows each tick.
 *
 * `payment` snapshots the parsed Horizon record (jsonb) so the retry
 * replays the exact matching/validation logic without a Horizon
 * round-trip. `order_id` is informational (no FK — the skip row is
 * operational telemetry and must survive any order lifecycle).
 */
export const paymentWatcherSkips = pgTable(
  'payment_watcher_skips',
  {
    /** Horizon operation id — stable replay key. */
    paymentId: text('payment_id').primaryKey(),
    memo: text('memo').notNull(),
    orderId: uuid('order_id'),
    reason: text('reason').notNull(),
    payment: jsonb('payment').notNull(),
    attempts: integer('attempts').notNull().default(1),
    lastError: text('last_error'),
    status: text('status')
      .notNull()
      .default('pending')
      .$type<'pending' | 'resolved' | 'abandoned' | 'refunding' | 'refunded'>(),
    // Hardening A6: Stellar tx hash of the admin-mediated refund-to-
    // sender, set (via the CF-18 onSigned hook, before submit) when an
    // operator refunds an abandoned late deposit back to its sender.
    refundTxHash: text('refund_tx_hash'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'payment_watcher_skips_reason_known',
      sql`${t.reason} IN ('asset_mismatch', 'amount_insufficient', 'missing_credit_row', 'processing_error', 'order_gone', 'unrecognized_deposit')`,
    ),
    check(
      'payment_watcher_skips_status_known',
      sql`${t.status} IN ('pending', 'resolved', 'abandoned', 'refunding', 'refunded')`,
    ),
    index('payment_watcher_skips_status_created').on(t.status, t.createdAt),
  ],
);

/**
 * External identity links for a Loop user (ADR 014 — social login).
 *
 * One row per provider identity per user. A user can link multiple
 * providers over time (sign up via OTP, later also add Google); a
 * provider's stable `sub` id resolves back to that same user.
 *
 * Deliberately distinct from `users.ctx_user_id` (ADR 013's
 * transitional CTX link) — CTX isn't a social provider and its
 * mapping follows a different legacy / migration path.
 *
 * `email_at_link` snapshots the email the provider reported when
 * the link was first written. The authoritative email stays on
 * `users.email`; this column exists so support / ops can tell
 * which email a user supplied at which provider without forcing a
 * JOIN with provider-specific user metadata.
 */
export const userIdentities = pgTable(
  'user_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerSub: text('provider_sub').notNull(),
    emailAtLink: text('email_at_link').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The same (provider, provider_sub) pair can only resolve to
    // one Loop user — without this a second sign-in via the same
    // Google account could spawn a duplicate user row.
    uniqueIndex('user_identities_provider_sub').on(t.provider, t.providerSub),
    index('user_identities_user').on(t.userId),
    // A2-712: pin provider to the supported set. App-layer zod
    // (SOCIAL_PROVIDERS) gates writes from the social-login handler;
    // the DB CHECK is the defence-in-depth gate against an admin DB
    // shell or a future writer that bypasses the validator. Adding a
    // fourth provider is a deliberate migration touching this CHECK.
    check('user_identities_provider_known', sql`${t.provider} IN ('google', 'apple')`),
  ],
);

export const SOCIAL_PROVIDERS = ['google', 'apple'] as const;

export type SocialProvider = (typeof SOCIAL_PROVIDERS)[number];

/**
 * Outbound Stellar cashback payouts (ADR 015 flow 2).
 *
 * Written at `markOrderFulfilled` when `buildPayoutIntent` returns
 * `{ kind: 'pay', ... }`. A separate submit worker reads the
 * `pending` rows, signs + submits a Stellar Payment via the
 * @stellar/stellar-sdk (landing in a follow-up slice), and
 * transitions each row through `pending → submitted → confirmed`
 * (or `failed`).
 *
 * Why persist the intent rather than submitting inline:
 *   - Retries — a transient Horizon 503 shouldn't lose the payout.
 *   - Admin visibility — ops can see "3 payouts stuck in submitted"
 *     at a glance and decide whether to resubmit / refund / escalate.
 *   - Idempotency — the order → payout row is 1:1, so a re-enter of
 *     markOrderFulfilled (shouldn't happen, but is defense-in-depth)
 *     surfaces as a unique-violation on `order_id` rather than a
 *     double-send.
 */
export const pendingPayouts = pgTable(
  'pending_payouts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    // A2-901 / ADR-024 §2: nullable for emission payouts. Order-
    // fulfilment (`kind='order_cashback'`) and redemption burns
    // (`kind='burn'`) keep populating this; emission rows leave it
    // NULL. The shape CHECK below pins the per-kind invariant.
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    // Discriminator for the three payout flows this table serves
    // (A2-901 / ADR-024 §2, re-scoped by ADR 036):
    //   - 'order_cashback' — fulfilment-time cashback payout to the user.
    //   - 'emission' — admin-mediated emission (ex-ADR-024 "withdrawal"):
    //     backfill of the on-chain half of an existing user_credits
    //     liability. Never debits the mirror (ADR 036). Pre-ADR-036
    //     rows (migration 0038 relabelled 'withdrawal' → 'emission')
    //     DID debit at send-time; their `credit_transactions` debit row
    //     (`type='withdrawal'`, reference_id=payout id) survives and
    //     marks them as legacy/compensable.
    //   - 'burn' — redemption issuer-return: forwards LOOP received at
    //     the deposit account back to the asset's issuer (native
    //     Stellar burn) after a loop_asset deposit pays an order.
    //   - 'interest_mint' — ADR 031 / ADR 036 Phase D nightly interest:
    //     an on-chain mint (payment FROM the issuer account) to the
    //     user's activated embedded wallet, enqueued in the same txn
    //     as the `credit_transactions type='interest'` mirror credit.
    //     Signed with the per-asset issuer keypair, not the operator.
    // Default 'order_cashback' preserves the backfill semantics for
    // pre-0018 rows. `.$type` narrows the TypeScript side to the same
    // literal set the SQL CHECK enforces.
    kind: text('kind')
      .notNull()
      .default('order_cashback')
      .$type<'order_cashback' | 'emission' | 'burn' | 'interest_mint'>(),
    // The LOOP asset + issuer pinned at write-time. If an operator
    // changes the issuer env var later, in-flight rows still reference
    // the issuer at the time the intent was built — otherwise a rotate
    // could retarget a mid-flight payment to a different asset.
    assetCode: text('asset_code').notNull(),
    assetIssuer: text('asset_issuer').notNull(),
    // Destination + amount pinned at write-time. The user updating
    // their `stellar_address` after the row lands shouldn't redirect
    // the payment — the commitment was to the address they had when
    // the order fulfilled.
    toAddress: text('to_address').notNull(),
    amountStroops: bigint('amount_stroops', { mode: 'bigint' }).notNull(),
    memoText: text('memo_text').notNull(),

    state: text('state').notNull().default('pending'),
    /** Stellar transaction hash, set once submit() succeeds. */
    txHash: text('tx_hash'),
    /** Error message from the most recent failed submit attempt. Bounded. */
    lastError: text('last_error'),
    attempts: integer('attempts').notNull().default(0),
    // ADR-024 §5 / A3-006: compensation is an operator-only overlay
    // on a failed legacy (pre-ADR-036, at-send-debited) emission
    // payout. Keep the public state enum
    // stable (`failed`) and record compensation separately so retry
    // can refuse already-compensated rows without widening every
    // payout-state consumer to a fifth value.
    compensatedAt: timestamp('compensated_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    failedAt: timestamp('failed_at', { withTimezone: true }),
  },
  (t) => [
    // One *cashback* payout per order — the idempotency guard for a
    // re-run of markOrderFulfilled. Partial since migration 0038 so a
    // redeemed order can also carry its `kind='burn'` row (which has
    // its own per-order fence below).
    uniqueIndex('pending_payouts_order_unique')
      .on(t.orderId)
      .where(sql`${t.kind} = 'order_cashback'`),
    // One burn per order — the idempotency fence for the redemption
    // issuer-return enqueued by markOrderPaid (ADR 036).
    uniqueIndex('pending_payouts_burn_order_unique')
      .on(t.orderId)
      .where(sql`${t.kind} = 'burn'`),
    // Worker picks up pending rows in FIFO order on each tick.
    index('pending_payouts_state_created').on(t.state, t.createdAt),
    // CF-29 / PERF-006: payouts-by-asset does `GROUP BY asset_code,
    // state` over the full table with no asset_code index. (The audit's
    // `INCLUDE (amount_stroops)` is omitted — drizzle 0.45's index DSL
    // can't represent INCLUDE and the migration↔schema parity gate would
    // flag the drift; the composite still serves the grouped scan.)
    // (Migration 0036.)
    index('pending_payouts_asset_state').on(t.assetCode, t.state),
    // CF-29 / PERF-006: settlement-lag / payouts-activity filter
    // `state='confirmed' AND confirmed_at >= since` with no confirmed_at
    // index. Partial scoped to confirmed rows keeps it small.
    // (Migration 0036.)
    index('pending_payouts_confirmed_at')
      .on(t.confirmedAt)
      .where(sql`${t.state} = 'confirmed'`),
    // A2-716: composite (user_id, created_at desc) so
    // `listPayoutsForUser` (admin user-detail page) gets an index-
    // only scan + sort. Replaces the prior single-column
    // `pending_payouts_user` index — the composite covers every
    // single-column lookup as well.
    index('pending_payouts_user_created').on(t.userId, t.createdAt),
    // A3-007: "same semantic emission twice" must not create a
    // second active payout row just because the new request gets a
    // fresh UUID. Confirmed payouts are excluded so a later
    // legitimate repeat emission can happen; compensated failures
    // are excluded so support can deliberately re-issue after making
    // the user whole.
    uniqueIndex('pending_payouts_active_emission_unique')
      .on(t.userId, t.assetCode, t.assetIssuer, t.toAddress, t.amountStroops)
      .where(
        sql`${t.kind} = 'emission' AND ${t.state} IN ('pending', 'submitted', 'failed') AND ${t.compensatedAt} IS NULL`,
      ),
    check(
      'pending_payouts_state_known',
      sql`${t.state} IN ('pending', 'submitted', 'confirmed', 'failed')`,
    ),
    check('pending_payouts_amount_positive', sql`${t.amountStroops} > 0`),
    // A2-715: pin Stellar pubkey shape at the DB layer. App-layer
    // regex validation already exists at the API boundary, but a
    // direct INSERT (admin shell, future writers) without going
    // through the validator could land a malformed address that
    // the submit worker would later round-trip into Horizon and
    // fail loudly. CHECK pins the 56-char `G…` base32 pattern at
    // the column.
    check('pending_payouts_to_address_format', sql`${t.toAddress} ~ '^G[A-Z2-7]{55}$'`),
    check('pending_payouts_attempts_non_negative', sql`${t.attempts} >= 0`),
    // A2-901 / ADR-024 §2 + ADR 036: discriminator + per-kind shape
    // invariants. Emissions are user-addressed with no source order;
    // burns reference the redeemed order and target the issuer;
    // interest mints (ADR 031 Phase D) are user-addressed with no
    // source order — their idempotency fence is the same-txn
    // `credit_transactions` period-cursor unique index, traceable via
    // the `interest_mint_snapshots` audit table.
    check(
      'pending_payouts_kind_known',
      sql`${t.kind} IN ('order_cashback', 'emission', 'burn', 'interest_mint')`,
    ),
    check(
      'pending_payouts_kind_shape',
      sql`
        (${t.kind} = 'order_cashback' AND ${t.orderId} IS NOT NULL)
        OR (${t.kind} = 'emission' AND ${t.orderId} IS NULL)
        OR (${t.kind} = 'burn' AND ${t.orderId} IS NOT NULL)
        OR (${t.kind} = 'interest_mint' AND ${t.orderId} IS NULL)
      `,
    ),
    // A4-027: pin asset_code + asset_issuer at the DB layer. The app
    // pins the LOOP-asset code set in payout-builder, but a direct
    // INSERT (admin shell, future writer that drifts) could land
    // 'BADASSET' which the submit worker would round-trip into
    // Horizon and either silently mis-send or fail unclassified.
    // The matching env vars (LOOP_STELLAR_*_ISSUER) all carry
    // Stellar pubkeys, so the asset_issuer regex matches the
    // to_address regex above (56-char base32 G-prefix).
    check(
      'pending_payouts_asset_code_known',
      sql`${t.assetCode} IN ('USDLOOP', 'GBPLOOP', 'EURLOOP')`,
    ),
    check('pending_payouts_asset_issuer_format', sql`${t.assetIssuer} ~ '^G[A-Z2-7]{55}$'`),
    // 2026-06-15 cold audit v-wallet P0 follow-up: the app-layer
    // allowlist (ONCHAIN_MINT_ELIGIBLE_ASSETS in credits/interest-mint.ts)
    // is the only thing stopping a future writer from enqueuing an
    // `interest_mint` row for USDLOOP/EURLOOP (unbacked vault-share
    // mint) if that writer bypasses mintOneUser. Pin the pairing at
    // the DB layer too, so a drifting writer fails loudly instead of
    // silently minting. Widen alongside the allowlist once vault-share
    // accounting exists.
    check(
      'pending_payouts_interest_mint_asset_pinned',
      sql`${t.kind} != 'interest_mint' OR ${t.assetCode} = 'GBPLOOP'`,
    ),
  ],
);

// Payout state enum lives in `@loop/shared` (ADR 019) — the CHECK
// literal above and the filter chips on `/admin/payouts` + state pill
// on `/settings/cashback` all read from the same tuple. Re-exported
// here for import-graph stability.
export { PAYOUT_STATES, type PayoutState } from '@loop/shared';
