/**
 * NS-13 — missing-CTX-settlement reconciliation watchdog (real postgres).
 *
 * The sibling stuck watchdog catches settlements that EXIST but never
 * confirmed. This is the other half: a fulfilled order that legitimately
 * SHOULD have a `ctx_settlements` row but has NONE. Every order reaches
 * `fulfilled` only through `payCtxOrder`, which writes the settlement row
 * BEFORE fulfillment, so a fulfilled on-chain order with no row is a silent
 * money-out / reconciliation gap.
 *
 * Two classes are EXEMPT and must never page (owner's decided baseline):
 * credit-funded fulfillments (no on-chain settlement leg) and pre-cutover
 * orders (created before the settlement system went live — before the
 * earliest `ctx_settlements.created_at`, or before
 * `LOOP_SETTLEMENT_RECONCILE_SINCE` when set).
 *
 * Driven against real postgres + `watchdog_alert_state`; only the Discord
 * delivery is stubbed to `true` (the sibling
 * `ctx-settlement-stuck-watchdog.test.ts` pattern). `LOOP_E2E_DB=1` gate,
 * same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

const { sendWebhookMock } = vi.hoisted(() => ({ sendWebhookMock: vi.fn(async () => true) }));
vi.mock('../../discord/shared.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, sendWebhook: sendWebhookMock };
});

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { orders, ctxSettlements, watchdogAlertState } from '../../db/schema.js';
import { findOrCreateUserByEmail } from '../../db/users.js';
import {
  runCtxSettlementReconcileWatchdog,
  listMissingCtxSettlements,
} from '../../orders/ctx-settlement-reconcile-watchdog.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const CTX_DEST = 'GCTXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

type PaymentMethod = 'xlm' | 'usdc' | 'loop_asset' | 'credit';

async function seedOrder(args: {
  userId: string;
  state: 'paid' | 'procuring' | 'fulfilled' | 'failed';
  paymentMethod: PaymentMethod;
  createdAgoMs: number;
}): Promise<string> {
  const [row] = await db
    .insert(orders)
    .values({
      userId: args.userId,
      merchantId: 'amazon',
      faceValueMinor: 2500n,
      currency: 'USD',
      chargeMinor: 2500n,
      chargeCurrency: 'USD',
      paymentMethod: args.paymentMethod,
      // On-chain methods require a payment_memo (orders_payment_memo_coherence
      // CHECK); credit-funded orders carry none.
      paymentMemo: args.paymentMethod === 'credit' ? null : `ns13r-memo-${Date.now()}`,
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: args.state,
      paidAt: new Date(),
      createdAt: new Date(Date.now() - args.createdAgoMs),
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error('seed: orders insert returned no row');
  return row.id;
}

async function seedSettlement(args: {
  orderId: string;
  createdAgoMs: number;
  confirmed?: boolean;
}): Promise<void> {
  await db.insert(ctxSettlements).values({
    orderId: args.orderId,
    destination: CTX_DEST,
    memoText: `ns13r-${args.orderId.slice(-8)}`,
    amountStroops: 1_000_000n,
    txHash: 'landed-tx',
    confirmedAt: args.confirmed === false ? null : new Date(),
    createdAt: new Date(Date.now() - args.createdAgoMs),
  });
}

async function alertActive(): Promise<boolean | undefined> {
  const [row] = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, 'ctx-settlement-reconcile-watchdog'));
  return row?.alertActive;
}

/**
 * Anchors the cutover: a fully-reconciled on-chain order whose settlement
 * `created_at` is the earliest — so `min(ctx_settlements.created_at)` (the
 * default cutover) is this timestamp. Returns nothing; its only job is to
 * pin the baseline and to be a row that must never be flagged (it HAS a
 * settlement).
 */
async function seedCutoverAnchor(userId: string, settlementAgoMs: number): Promise<void> {
  const anchor = await seedOrder({
    userId,
    state: 'fulfilled',
    paymentMethod: 'xlm',
    createdAgoMs: settlementAgoMs,
  });
  await seedSettlement({ orderId: anchor, createdAgoMs: settlementAgoMs, confirmed: true });
}

const CUTOVER_AGO_MS = 180 * 60 * 1000; // anchor settlement 3h ago → cutover
const POST_CUTOVER_AGO_MS = 60 * 60 * 1000; // 1h ago → after cutover (flagged)
const PRE_CUTOVER_AGO_MS = 300 * 60 * 1000; // 5h ago → before cutover (exempt)

describeIf('NS-13 missing CTX-settlement reconciliation watchdog (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
    sendWebhookMock.mockReset().mockResolvedValue(true);
  });

  it('does not page when every fulfilled on-chain order already has a settlement', async () => {
    const user = await findOrCreateUserByEmail('ns13r-clean@test.local');
    // Anchor (has settlement) plus a second fully-reconciled on-chain order.
    await seedCutoverAnchor(user.id, CUTOVER_AGO_MS);
    const reconciled = await seedOrder({
      userId: user.id,
      state: 'fulfilled',
      paymentMethod: 'usdc',
      createdAgoMs: POST_CUTOVER_AGO_MS,
    });
    await seedSettlement({ orderId: reconciled, createdAgoMs: POST_CUTOVER_AGO_MS });

    const summary = await listMissingCtxSettlements(db);
    expect(summary.total).toBe(0);

    const r = await runCtxSettlementReconcileWatchdog();
    expect(r).toEqual({ skippedLocked: false, notified: false, missing: 0 });
    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(await alertActive()).toBeUndefined();
  });

  it('detects + pages once for an on-chain post-cutover order with no settlement, dedups the repeat, and re-arms when reconciled', async () => {
    const user = await findOrCreateUserByEmail('ns13r-missing@test.local');
    await seedCutoverAnchor(user.id, CUTOVER_AGO_MS);
    // The genuine gap: a fulfilled, on-chain-funded, post-cutover order with
    // NO ctx_settlements row at all.
    const missingOrder = await seedOrder({
      userId: user.id,
      state: 'fulfilled',
      paymentMethod: 'xlm',
      createdAgoMs: POST_CUTOVER_AGO_MS,
    });

    // First tick: detects + pages once + latches.
    const first = await runCtxSettlementReconcileWatchdog();
    expect(first.notified).toBe(true);
    expect(first.missing).toBe(1);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Second tick, same backlog: no re-page (fire-once).
    const second = await runCtxSettlementReconcileWatchdog();
    expect(second.notified).toBe(false);
    expect(second.missing).toBe(1);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Operator re-records the lost settlement: the backlog clears and the
    // watchdog re-arms.
    await seedSettlement({ orderId: missingOrder, createdAgoMs: POST_CUTOVER_AGO_MS });
    const third = await runCtxSettlementReconcileWatchdog();
    expect(third.notified).toBe(false);
    expect(third.missing).toBe(0);
    expect(await alertActive()).toBe(false);
  });

  it('exempts credit-funded and pre-cutover orders with no settlement (never pages)', async () => {
    const user = await findOrCreateUserByEmail('ns13r-exempt@test.local');
    await seedCutoverAnchor(user.id, CUTOVER_AGO_MS);

    // Credit-funded, fulfilled, post-cutover, NO settlement — exempt (no
    // on-chain settlement leg).
    await seedOrder({
      userId: user.id,
      state: 'fulfilled',
      paymentMethod: 'credit',
      createdAgoMs: POST_CUTOVER_AGO_MS,
    });

    // On-chain, fulfilled, but created BEFORE the cutover, NO settlement —
    // exempt (settled through the legacy pre-A4 path).
    await seedOrder({
      userId: user.id,
      state: 'fulfilled',
      paymentMethod: 'xlm',
      createdAgoMs: PRE_CUTOVER_AGO_MS,
    });

    const summary = await listMissingCtxSettlements(db);
    expect(summary.total).toBe(0);

    const r = await runCtxSettlementReconcileWatchdog();
    expect(r.notified).toBe(false);
    expect(r.missing).toBe(0);
    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(await alertActive()).toBeUndefined();
  });

  it('reconciles only fulfilled orders — an in-flight order without a settlement does not page', async () => {
    const user = await findOrCreateUserByEmail('ns13r-inflight@test.local');
    await seedCutoverAnchor(user.id, CUTOVER_AGO_MS);
    // A still-procuring on-chain order legitimately may not have paid CTX
    // yet — only FULFILLED orders are guaranteed to have a settlement.
    await seedOrder({
      userId: user.id,
      state: 'procuring',
      paymentMethod: 'xlm',
      createdAgoMs: POST_CUTOVER_AGO_MS,
    });

    const summary = await listMissingCtxSettlements(db);
    expect(summary.total).toBe(0);
    const r = await runCtxSettlementReconcileWatchdog();
    expect(r.missing).toBe(0);
    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it('surfaces the oldest offending order and its payment method as the drill-down example', async () => {
    const user = await findOrCreateUserByEmail('ns13r-example@test.local');
    await seedCutoverAnchor(user.id, CUTOVER_AGO_MS);
    const older = await seedOrder({
      userId: user.id,
      state: 'fulfilled',
      paymentMethod: 'loop_asset',
      createdAgoMs: 120 * 60 * 1000,
    });
    await seedOrder({
      userId: user.id,
      state: 'fulfilled',
      paymentMethod: 'usdc',
      createdAgoMs: POST_CUTOVER_AGO_MS,
    });

    const summary = await listMissingCtxSettlements(db);
    expect(summary.total).toBe(2);
    expect(summary.oldestOrderId).toBe(older);
    expect(summary.oldestPaymentMethod).toBe('loop_asset');
    expect(summary.oldestAgeMinutes).toBeGreaterThanOrEqual(119);
  });

  it('does not latch when the Discord delivery fails (at-least-once retry)', async () => {
    const user = await findOrCreateUserByEmail('ns13r-atleastonce@test.local');
    await seedCutoverAnchor(user.id, CUTOVER_AGO_MS);
    await seedOrder({
      userId: user.id,
      state: 'fulfilled',
      paymentMethod: 'xlm',
      createdAgoMs: POST_CUTOVER_AGO_MS,
    });

    sendWebhookMock.mockResolvedValueOnce(false);
    const firstResult = await runCtxSettlementReconcileWatchdog();
    expect(firstResult.notified).toBe(false);
    expect(await alertActive()).toBeUndefined(); // never persisted

    const secondResult = await runCtxSettlementReconcileWatchdog();
    expect(secondResult.notified).toBe(true);
    expect(await alertActive()).toBe(true);
  });
});
