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
 *   2. Reject with InsufficientBalanceError if mirror < amount. This
 *      is a *sanity guard*, not a debit: an emission larger than the
 *      user's mirrored liability would mint unbacked LOOP (the drift
 *      watcher would page, but refuse up-front). The lock keeps a
 *      concurrent adjustment from racing the read.
 *   3. Reject with EmissionAlreadyIssuedError if a matching active
 *      emission intent already exists (semantic uniqueness fence
 *      `pending_payouts_active_emission_unique` + pre-check).
 *   4. INSERT pending_payouts (kind='emission', order_id NULL,
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
import { InsufficientBalanceError } from './adjustments.js';

export class EmissionAlreadyIssuedError extends Error {
  constructor(public readonly payoutId: string) {
    super(`A matching active emission already exists for payout ${payoutId}`);
    this.name = 'EmissionAlreadyIssuedError';
  }
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
