/**
 * Admin emission writer (A2-901 / ADR-024, re-scoped by ADR 036).
 *
 * Queues an on-chain LOOP-asset payment to a user **without touching
 * the off-chain `user_credits` mirror**. Under ADR 036 the on-chain
 * LOOP in the user's wallet IS their balance and `user_credits` is
 * Loop's liability mirror: the mirror is credited when value is
 * created (cashback fulfilment, nightly interest) and debited only
 * when tokens *return* (redemption). Emitting tokens to a user merely
 * materialises the on-chain half of a liability that already exists —
 * e.g. backfilling a missed/failed cashback payout — so it must NOT
 * debit. (The pre-ADR-036 version of this module was the ADR-024
 * "withdrawal writer" and debited at send-time; that contradiction is
 * exactly what ADR 036 §Context removes.)
 *
 * This module is the queue primitive only — admin handler + Discord
 * fanout + idempotency wrapper live in `admin/emissions.ts`.
 *
 * Semantics:
 *
 *   1. SELECT ... FOR UPDATE on user_credits — lock + read the mirror.
 *   2. Reject with InsufficientBalanceError if mirror < amount (fast
 *      per-call guard).
 *   3. Hardening A1 — conservation check: reject with
 *      EmissionExceedsUnemittedBalanceError unless the amount fits in
 *      the UN-EMITTED portion of the liability (balance minus what
 *      prior payouts/emissions already materialised on-chain, net of
 *      burns). The per-call guard alone was the unbacked-mint hole:
 *      emission never debits, so repeated emissions each passed it. A
 *      DB trigger (migration 0044) enforces the same rule against any
 *      future writer that bypasses this module.
 *   4. Hardening A1 — fleet-wide daily value cap per currency
 *      (ADMIN_DAILY_WITHDRAWAL_CAP_MINOR — ADM-01's cap for the
 *      pre-ADR-036 withdrawal writer, orphaned by the emission
 *      re-scope and revived here), advisory-lock-serialised like the
 *      compensation cap.
 *   5. Reject with EmissionAlreadyIssuedError if a matching active
 *      emission intent already exists (semantic uniqueness fence
 *      `pending_payouts_active_emission_unique` + pre-check).
 *   6. INSERT pending_payouts (kind='emission', order_id NULL,
 *      asset_code/issuer/to/memo from intent) RETURNING id.
 *
 * No `credit_transactions` row, no `user_credits` write — the ledger
 * trail for an emission is the `pending_payouts` row itself plus the
 * ADR-017 admin audit envelope. (Pre-ADR-036 'withdrawal' rows DID
 * write a negative `type='withdrawal'` ledger row; that ledger row is
 * what marks them as legacy/compensable — see payout-compensation.)
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { pendingPayouts, userCredits } from '../db/schema.js';
import { env } from '../env.js';
import {
  InsufficientBalanceError,
  DailyAdjustmentLimitError,
  adjustmentCapLockKey,
} from './adjustments.js';

export class EmissionAlreadyIssuedError extends Error {
  constructor(public readonly payoutId: string) {
    super(`A matching active emission already exists for payout ${payoutId}`);
    this.name = 'EmissionAlreadyIssuedError';
  }
}

/**
 * Hardening A1 (2026-07 plan): the emission would materialise more
 * on-chain LOOP than the un-emitted portion of the user's mirror
 * liability. The per-call `balance >= amount` guard alone was the
 * unbacked-mint hole two cold audits flagged: emission never debits,
 * so REPEATED emissions each passed the guard while cumulatively
 * minting multiples of the liability. See `emittedNetMinorFor` for
 * the conservation accounting.
 */
export class EmissionExceedsUnemittedBalanceError extends Error {
  constructor(
    public readonly currency: string,
    public readonly balanceMinor: bigint,
    public readonly alreadyEmittedMinor: bigint,
    public readonly requestedMinor: bigint,
  ) {
    super(
      `Emission of ${requestedMinor} minor would exceed the un-emitted liability: ` +
        `mirror balance ${balanceMinor} minus ${alreadyEmittedMinor} already materialised on-chain ` +
        `leaves ${balanceMinor - alreadyEmittedMinor < 0n ? 0n : balanceMinor - alreadyEmittedMinor} available`,
    );
    this.name = 'EmissionExceedsUnemittedBalanceError';
  }
}

/**
 * Advisory-lock scope for the fleet-wide emission daily cap — same
 * derivation as the compensation cap (`payout-compensation.ts`), so
 * concurrent emissions in the same (currency, UTC day) bucket
 * serialise on one lock and cannot jointly exceed the cap.
 */
const EMISSION_CAP_LOCK_SCOPE = 'emission';

/** 1e5 stroops per minor unit — LOOP assets are 1:1 with fiat at 7 decimals. */
const STROOPS_PER_MINOR = 100_000n;

/**
 * Conservation accounting (hardening A1): net minor units already
 * materialised on-chain for this (user, asset).
 *
 * The invariant every money flow preserves is
 * `mintedNet ≤ mirror balance`:
 *
 *   - cashback payout / interest mint: +m on-chain AND +m mirror, in
 *     one txn → both sides move together.
 *   - redemption: −s mirror (spend debit) AND the user's tokens left
 *     their wallet for the deposit account (`kind='burn'` row) → both
 *     sides move together.
 *   - emission: +e on-chain, mirror UNCHANGED — the one flow that
 *     consumes headroom, so it must check `e ≤ balance − mintedNet`.
 *
 * Counted as minted: `order_cashback` / `emission` / `interest_mint`
 * rows in any non-`failed` state (failed = never materialised; an
 * ops retry flips the row back to pending, where it counts again),
 * excluding compensated rows and legacy pre-ADR-036 withdrawal-era
 * emissions (those debited the mirror at send, so counting them here
 * would double-subtract — the discriminator is their at-send
 * `type='withdrawal'` ledger row, same rule as payout-compensation).
 * Counted as burned: every `kind='burn'` row regardless of state —
 * the user's tokens left their wallet when they paid, whether or not
 * the issuer-return has confirmed.
 *
 * Runs inside the caller's transaction AFTER the `user_credits` row
 * lock: every writer that moves both sides does so atomically under
 * the same row lock, so the sums read here cannot interleave with a
 * half-applied flow.
 *
 * Known residual (accepted): the accounting trusts row STATE, not the
 * chain. A `submitted` row marked `failed` whose transaction actually
 * landed (the CF-18 stuck-submitted ambiguity class) frees headroom
 * that is backed by real on-chain tokens — a subsequent emission
 * would then pass both fences while being genuinely unbacked. The
 * payout worker's authoritative-hash re-check (CF-18/CF2-07) makes
 * this window small, and the asset-drift watcher's failed-rows
 * dimension (hardening A2) keeps any such rows loudly visible until
 * resolved.
 *
 * Lock ordering note: this module takes the user_credits row lock
 * FIRST, then the daily-cap advisory lock; adjustments/compensation
 * take advisory first. No deadlock today because the sha256-derived
 * advisory keys differ per scope ('emission' vs adminUserId vs
 * 'payout-compensation') — do NOT unify the scopes without also
 * unifying the acquisition order.
 */
async function emittedNetMinorFor(
  tx: Pick<typeof db, 'execute'>,
  args: { userId: string; assetCode: string },
): Promise<bigint> {
  const result = await tx.execute<{ minted: string; burned: string }>(sql`
    SELECT
      COALESCE(SUM(amount_stroops) FILTER (
        WHERE kind IN ('order_cashback', 'emission', 'interest_mint')
          AND state != 'failed'
          AND compensated_at IS NULL
          AND (
            kind != 'emission'
            OR NOT EXISTS (
              SELECT 1 FROM credit_transactions ct
              WHERE ct.type = 'withdrawal'
                AND ct.reference_type = 'payout'
                AND ct.reference_id = pending_payouts.id::text
            )
          )
      ), 0)::text AS minted,
      COALESCE(SUM(amount_stroops) FILTER (WHERE kind = 'burn'), 0)::text AS burned
    FROM pending_payouts
    WHERE user_id = ${args.userId}
      AND asset_code = ${args.assetCode}
  `);
  const rows = Array.isArray(result)
    ? (result as Array<{ minted: string; burned: string }>)
    : ((result as { rows?: Array<{ minted: string; burned: string }> }).rows ?? []);
  const mintedStroops = BigInt(rows[0]?.minted ?? '0');
  const burnedStroops = BigInt(rows[0]?.burned ?? '0');
  const netStroops = mintedStroops - burnedStroops;
  // Clamp at zero: a user who received LOOP externally and redeemed it
  // with us can have burns exceeding our mints; that must not inflate
  // emission headroom beyond the mirror balance itself.
  const clamped = netStroops < 0n ? 0n : netStroops;
  // Ceil-divide so a sub-minor stroop remainder counts against
  // headroom rather than rounding it away.
  return (clamped + STROOPS_PER_MINOR - 1n) / STROOPS_PER_MINOR;
}

export interface EmissionIntent {
  /** LOOP asset code being emitted on-chain — `USDLOOP`, `GBPLOOP`, `EURLOOP`. */
  assetCode: string;
  /** Issuer pinned at write-time so a later issuer rotate doesn't redirect in-flight payouts. */
  assetIssuer: string;
  /** Destination Stellar address — the user's linked wallet. */
  toAddress: string;
  /** Amount in stroops (7-decimal Stellar minor unit). */
  amountStroops: bigint;
  /** Memo text for the on-chain payment (~28 ASCII chars). */
  memoText: string;
}

export interface EmissionResult {
  /** pending_payouts.id of the queued on-chain emission. */
  payoutId: string;
  userId: string;
  currency: string;
  /** Unsigned magnitude in minor units. The mirror is NOT debited (ADR 036). */
  amountMinor: bigint;
  /** The user's mirror balance at queue time — unchanged by this write. */
  balanceMinor: bigint;
  createdAt: Date;
}

/**
 * Queue an admin-initiated emission: an on-chain LOOP payment that
 * backfills the on-chain half of an existing `user_credits` liability.
 * The mirror is read (and guarded) but never written.
 *
 * Throws:
 *   - `InsufficientBalanceError` — mirror balance < requested amount
 *     (would emit unbacked LOOP; see module header).
 *   - `EmissionAlreadyIssuedError` — a matching active emission
 *     already exists for the same user/asset/address/amount.
 *   - generic Error — `Emission amount must be positive` if the
 *     caller passes 0 or negative; the schema CHECK enforces this
 *     too but we fail fast with a typed message.
 */
export async function applyAdminEmission(args: {
  userId: string;
  currency: string;
  amountMinor: bigint;
  intent: EmissionIntent;
}): Promise<EmissionResult> {
  if (args.amountMinor <= 0n) {
    throw new Error('Emission amount must be positive');
  }

  try {
    return await db.transaction(async (tx) => {
      // Lock the (userId, currency) mirror row before the sanity
      // read. A concurrent admin adjustment / accrual cannot race
      // past this point until the txn commits.
      const [existing] = await tx
        .select()
        .from(userCredits)
        .where(and(eq(userCredits.userId, args.userId), eq(userCredits.currency, args.currency)))
        .for('update');

      const balance = existing?.balanceMinor ?? 0n;
      if (balance < args.amountMinor) {
        throw new InsufficientBalanceError(args.currency, balance, args.amountMinor);
      }

      // Hardening A1 — conservation check: the emission must fit in
      // the UN-EMITTED portion of the liability, not merely under the
      // balance. Without this, repeated emissions each pass the
      // balance guard while cumulatively minting unbacked LOOP (the
      // exact finding two cold audits flagged; a DB trigger enforces
      // the same rule as defense-in-depth — migration 0044).
      const alreadyEmittedMinor = await emittedNetMinorFor(tx, {
        userId: args.userId,
        assetCode: args.intent.assetCode,
      });
      if (alreadyEmittedMinor + args.amountMinor > balance) {
        throw new EmissionExceedsUnemittedBalanceError(
          args.currency,
          balance,
          alreadyEmittedMinor,
          args.amountMinor,
        );
      }

      // Hardening A1 — fleet-wide daily value cap, parity with the
      // adjustment/refund/compensation caps (emissions previously had
      // NONE beyond the 10M-minor per-request cap + rate limit). Same
      // advisory-lock serialisation as payout-compensation: without
      // it two concurrent emissions in the same (currency, day)
      // bucket both read the same `used` total and jointly exceed the
      // cap. Lock held to commit.
      // ADM-01's dedicated cap for the value-leaves-the-system writer
      // (declared for the pre-ADR-036 withdrawal writer, orphaned by
      // the emission re-scope, revived here — hardening A1/C5).
      const capMinor = env.ADMIN_DAILY_WITHDRAWAL_CAP_MINOR;
      if (capMinor > 0n) {
        const dayStart = new Date();
        dayStart.setUTCHours(0, 0, 0, 0);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${adjustmentCapLockKey(EMISSION_CAP_LOCK_SCOPE, args.currency, dayStart)})`,
        );
        const [dayRow] = await tx
          .select({
            usedStroops: sql<string>`COALESCE(SUM(${pendingPayouts.amountStroops}), 0)::text`,
          })
          .from(pendingPayouts)
          .where(
            and(
              eq(pendingPayouts.kind, 'emission'),
              eq(pendingPayouts.assetCode, args.intent.assetCode),
              sql`${pendingPayouts.createdAt} >= ${dayStart.toISOString()}`,
            ),
          );
        const usedMinor = BigInt(dayRow?.usedStroops ?? '0') / STROOPS_PER_MINOR;
        if (usedMinor + args.amountMinor > capMinor) {
          throw new DailyAdjustmentLimitError(
            args.currency,
            dayStart,
            usedMinor,
            capMinor,
            args.amountMinor,
          );
        }
      }

      const [priorPayout] = await tx
        .select({ id: pendingPayouts.id })
        .from(pendingPayouts)
        .where(
          and(
            eq(pendingPayouts.userId, args.userId),
            eq(pendingPayouts.kind, 'emission'),
            eq(pendingPayouts.assetCode, args.intent.assetCode),
            eq(pendingPayouts.assetIssuer, args.intent.assetIssuer),
            eq(pendingPayouts.toAddress, args.intent.toAddress),
            eq(pendingPayouts.amountStroops, args.intent.amountStroops),
            sql`${pendingPayouts.state} IN ('pending', 'submitted', 'failed')`,
            sql`${pendingPayouts.compensatedAt} IS NULL`,
          ),
        )
        .limit(1);
      if (priorPayout !== undefined) {
        throw new EmissionAlreadyIssuedError(priorPayout.id);
      }

      // Queue the on-chain emission. `kind='emission'` + `order_id`
      // NULL — schema CHECK rejects the wrong combinations. This is
      // the ONLY write: per ADR 036 emission never debits the mirror.
      const [payout] = await tx
        .insert(pendingPayouts)
        .values({
          userId: args.userId,
          kind: 'emission',
          assetCode: args.intent.assetCode,
          assetIssuer: args.intent.assetIssuer,
          toAddress: args.intent.toAddress,
          amountStroops: args.intent.amountStroops,
          memoText: args.intent.memoText,
        })
        .returning();
      if (payout === undefined) {
        throw new Error('pending_payouts insert returned no row');
      }

      return {
        payoutId: payout.id,
        userId: args.userId,
        currency: args.currency,
        amountMinor: args.amountMinor,
        balanceMinor: balance,
        createdAt: payout.createdAt,
      };
    });
  } catch (err) {
    if (isDuplicateEmission(err)) {
      const existingPayoutId = await findMatchingActiveEmission({
        userId: args.userId,
        intent: args.intent,
      });
      throw new EmissionAlreadyIssuedError(existingPayoutId ?? '<unknown>');
    }
    throw err;
  }
}

/**
 * Best-effort detection of the unique-violation path that should
 * surface as EMISSION_ALREADY_ISSUED. postgres-js surfaces a
 * Postgres error with `code='23505'` (unique_violation) and
 * `constraint_name` populated. Drizzle wraps `PostgresError` in
 * `DrizzleQueryError`; walk the cause chain to find the underlying
 * postgres-js error — without this the duplicate-emission attempt
 * 500s instead of surfacing as 409 EMISSION_ALREADY_ISSUED.
 */
function isDuplicateEmission(err: unknown): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < 4 && cur instanceof Error; depth++) {
    const e = cur as Error & { code?: string; constraint_name?: string };
    if (e.code === '23505' && e.constraint_name === 'pending_payouts_active_emission_unique') {
      return true;
    }
    cur = (e as { cause?: unknown }).cause;
  }
  return false;
}

async function findMatchingActiveEmission(args: {
  userId: string;
  intent: EmissionIntent;
}): Promise<string | null> {
  const [row] = await db
    .select({ id: pendingPayouts.id })
    .from(pendingPayouts)
    .where(
      and(
        eq(pendingPayouts.userId, args.userId),
        eq(pendingPayouts.kind, 'emission'),
        eq(pendingPayouts.assetCode, args.intent.assetCode),
        eq(pendingPayouts.assetIssuer, args.intent.assetIssuer),
        eq(pendingPayouts.toAddress, args.intent.toAddress),
        eq(pendingPayouts.amountStroops, args.intent.amountStroops),
        sql`${pendingPayouts.state} IN ('pending', 'submitted', 'failed')`,
        sql`${pendingPayouts.compensatedAt} IS NULL`,
      ),
    )
    .limit(1);
  return row?.id ?? null;
}
