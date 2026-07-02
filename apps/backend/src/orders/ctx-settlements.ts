/**
 * Repo for the durable CTX-settlement record (hardening A4; ADR 010).
 * See the `ctx_settlements` table docstring in `db/schema.ts` — one
 * row per order, `tx_hash` persisted before the network submit so
 * `payCtxOrder`'s idempotency uses the authoritative Horizon point
 * lookup instead of depending on a bounded history scan.
 */
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { ctxSettlements } from '../db/schema.js';

export type CtxSettlement = typeof ctxSettlements.$inferSelect;

export async function getCtxSettlementByOrderId(orderId: string): Promise<CtxSettlement | null> {
  const [row] = await db
    .select()
    .from(ctxSettlements)
    .where(eq(ctxSettlements.orderId, orderId))
    .limit(1);
  return row ?? null;
}

/**
 * Creates the settlement intent row for an order, or returns the
 * existing one (the per-order unique index makes a concurrent-create
 * race converge on one row; procurement is already single-flighted
 * per order by the `markOrderProcuring` CAS, so the conflict path is
 * belt-and-braces).
 */
export async function getOrCreateCtxSettlement(args: {
  orderId: string;
  destination: string;
  memoText: string;
  amountStroops: bigint;
}): Promise<CtxSettlement> {
  const [inserted] = await db
    .insert(ctxSettlements)
    .values({
      orderId: args.orderId,
      destination: args.destination,
      memoText: args.memoText,
      amountStroops: args.amountStroops,
    })
    .onConflictDoNothing({ target: ctxSettlements.orderId })
    .returning();
  if (inserted !== undefined) return inserted;
  const existing = await getCtxSettlementByOrderId(args.orderId);
  if (existing === null) {
    throw new Error(`ctx_settlements insert conflicted but no row found for order ${args.orderId}`);
  }
  return existing;
}

/**
 * Persists the deterministic hash of the signed settlement tx —
 * called from `submitNativePayment`'s `onSigned` hook BEFORE the
 * network submit (CF-18 pattern), so a crash / lost response after
 * the tx lands is recoverable via the authoritative hash lookup.
 */
export async function recordCtxSettlementTxHash(args: {
  id: string;
  txHash: string;
}): Promise<void> {
  await db
    .update(ctxSettlements)
    .set({ txHash: args.txHash })
    .where(eq(ctxSettlements.id, args.id));
}

/** Marks the settlement confirmed once Horizon has shown the tx landed. */
export async function markCtxSettlementConfirmed(id: string): Promise<void> {
  await db
    .update(ctxSettlements)
    .set({ confirmedAt: sql`NOW()` })
    .where(eq(ctxSettlements.id, id));
}

/**
 * Backfills a settlement row for a payment discovered via the memo
 * scan (pre-A4 orders, or a crash between sign and persist on a row
 * that then landed). Confirmed immediately — the scan only returns
 * landed payments.
 */
export async function backfillCtxSettlementFromChain(args: {
  orderId: string;
  destination: string;
  memoText: string;
  amountStroops: bigint;
  txHash: string;
}): Promise<void> {
  await db
    .insert(ctxSettlements)
    .values({
      orderId: args.orderId,
      destination: args.destination,
      memoText: args.memoText,
      amountStroops: args.amountStroops,
      txHash: args.txHash,
      confirmedAt: sql`NOW()`,
    })
    .onConflictDoUpdate({
      target: ctxSettlements.orderId,
      set: { txHash: args.txHash, confirmedAt: sql`NOW()` },
    });
}
