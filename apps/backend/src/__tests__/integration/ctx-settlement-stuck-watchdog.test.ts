/**
 * NS-13 — stuck CTX-settlement watchdog (real postgres).
 *
 * `payCtxOrder` forwards user-paid XLM to CTX and records the attempt in
 * `ctx_settlements` (`confirmed_at` set only once Horizon shows the tx
 * landed). Unlike payouts / deposits / vault emissions, `ctx_settlements`
 * had NO standing watcher: once an order leaves `procuring` (fulfilled or
 * failed), the stuck-procurement sweep never inspects its settlement again,
 * so a settlement whose `confirmed_at` never gets set sits unconfirmed
 * forever — a silent money-in / reconciliation gap.
 *
 * This is that watchdog's detector: it counts `confirmed_at IS NULL` rows
 * older than the staleness threshold and pages once per incident, re-arming
 * when the backlog clears. Driven against real postgres + `watchdog_alert_state`;
 * only the Discord delivery is stubbed to `true` (the sibling
 * `failed-payout-backlog-watchdog.test.ts` pattern).
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
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
  runCtxSettlementStuckWatchdog,
  listStuckCtxSettlements,
} from '../../orders/ctx-settlement-stuck-watchdog.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const CTX_DEST = 'GCTXAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

async function seedOrder(args: {
  userId: string;
  state: 'paid' | 'procuring' | 'fulfilled' | 'failed';
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
      // 'credit' skips the orders_payment_memo_coherence CHECK that
      // requires a payment_memo for chain-paid methods.
      paymentMethod: 'credit',
      wholesalePct: '70.00',
      userCashbackPct: '5.00',
      loopMarginPct: '25.00',
      wholesaleMinor: 1750n,
      userCashbackMinor: 125n,
      loopMarginMinor: 625n,
      state: args.state,
      paidAt: new Date(),
    })
    .returning({ id: orders.id });
  if (row === undefined) throw new Error('seed: orders insert returned no row');
  return row.id;
}

async function seedSettlement(args: {
  orderId: string;
  createdAgoMs: number;
  confirmed?: boolean;
  txHash?: string | null;
}): Promise<void> {
  await db.insert(ctxSettlements).values({
    orderId: args.orderId,
    destination: CTX_DEST,
    memoText: `ns13-${args.orderId.slice(-8)}`,
    amountStroops: 1_000_000n,
    txHash: args.txHash ?? null,
    confirmedAt: args.confirmed ? new Date() : null,
    createdAt: new Date(Date.now() - args.createdAgoMs),
  });
}

async function alertActive(): Promise<boolean | undefined> {
  const [row] = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, 'ctx-settlement-stuck-watchdog'));
  return row?.alertActive;
}

describeIf('NS-13 stuck CTX-settlement watchdog (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
    sendWebhookMock.mockReset().mockResolvedValue(true);
  });

  it('does not page when there are no stuck settlements', async () => {
    const r = await runCtxSettlementStuckWatchdog();
    expect(r).toEqual({ skippedLocked: false, notified: false, stuck: 0 });
    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(await alertActive()).toBeUndefined();
  });

  it('detects + pages once for a stale unconfirmed settlement, dedups the repeat, and re-arms when cleared', async () => {
    const user = await findOrCreateUserByEmail('ns13-stuck@test.local');
    // The exact undetected gap: the ORDER moved on to `fulfilled` (so the
    // stuck-procurement sweep never looks at it again) but its settlement
    // never confirmed and is well past the 15-min window.
    const orderId = await seedOrder({ userId: user.id, state: 'fulfilled' });
    await seedSettlement({
      orderId,
      createdAgoMs: 90 * 60 * 1000,
      confirmed: false,
      txHash: 'submitted-but-unconfirmed',
    });

    // First tick: detects + pages once + latches.
    const first = await runCtxSettlementStuckWatchdog();
    expect(first.notified).toBe(true);
    expect(first.stuck).toBe(1);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Second tick, same backlog: no re-page (fire-once).
    const second = await runCtxSettlementStuckWatchdog();
    expect(second.notified).toBe(false);
    expect(second.stuck).toBe(1);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Settlement confirms (Horizon lookup landed → confirmed_at set):
    // the backlog clears and the watchdog re-arms.
    await db
      .update(ctxSettlements)
      .set({ confirmedAt: new Date() })
      .where(eq(ctxSettlements.orderId, orderId));
    const third = await runCtxSettlementStuckWatchdog();
    expect(third.notified).toBe(false);
    expect(third.stuck).toBe(0);
    expect(await alertActive()).toBe(false);
  });

  it('does NOT page a healthy confirmed settlement, nor a recent unconfirmed one within the window', async () => {
    const user = await findOrCreateUserByEmail('ns13-healthy@test.local');

    // Confirmed long ago — healthy, must never page.
    const confirmedOrder = await seedOrder({ userId: user.id, state: 'fulfilled' });
    await seedSettlement({
      orderId: confirmedOrder,
      createdAgoMs: 90 * 60 * 1000,
      confirmed: true,
      txHash: 'landed-tx',
    });

    // Unconfirmed but only 2 min old — inside the 15-min window, still
    // healthy (a settlement confirms within seconds normally).
    const recentOrder = await seedOrder({ userId: user.id, state: 'procuring' });
    await seedSettlement({
      orderId: recentOrder,
      createdAgoMs: 2 * 60 * 1000,
      confirmed: false,
      txHash: 'just-submitted',
    });

    const summary = await listStuckCtxSettlements(db);
    expect(summary.total).toBe(0);

    const r = await runCtxSettlementStuckWatchdog();
    expect(r.notified).toBe(false);
    expect(r.stuck).toBe(0);
    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(await alertActive()).toBeUndefined();
  });

  it('breaks the backlog into submitted (has tx_hash) vs unsubmitted (intent only)', async () => {
    const user = await findOrCreateUserByEmail('ns13-breakdown@test.local');
    const submittedOrder = await seedOrder({ userId: user.id, state: 'fulfilled' });
    const intentOrder = await seedOrder({ userId: user.id, state: 'procuring' });
    await seedSettlement({
      orderId: submittedOrder,
      createdAgoMs: 60 * 60 * 1000,
      txHash: 'submitted-tx',
    });
    await seedSettlement({
      orderId: intentOrder,
      createdAgoMs: 20 * 60 * 1000,
      txHash: null, // never got past intent (crash before onSigned)
    });

    const summary = await listStuckCtxSettlements(db);
    expect(summary.total).toBe(2);
    expect(summary.submitted).toBe(1);
    expect(summary.unsubmitted).toBe(1);
    // Oldest row is the 60-min submitted one, and it surfaces as the example.
    expect(summary.oldestAgeMinutes).toBeGreaterThanOrEqual(59);
    expect(summary.oldestOrderId).toBe(submittedOrder);
  });

  it('does not latch when the Discord delivery fails (at-least-once retry)', async () => {
    const user = await findOrCreateUserByEmail('ns13-atleastonce@test.local');
    const orderId = await seedOrder({ userId: user.id, state: 'fulfilled' });
    await seedSettlement({ orderId, createdAgoMs: 30 * 60 * 1000, txHash: 'tx' });

    sendWebhookMock.mockResolvedValueOnce(false);
    const firstResult = await runCtxSettlementStuckWatchdog();
    expect(firstResult.notified).toBe(false);
    expect(await alertActive()).toBeUndefined(); // never persisted

    const secondResult = await runCtxSettlementStuckWatchdog();
    expect(secondResult.notified).toBe(true);
    expect(await alertActive()).toBe(true);
  });
});
