/**
 * NS-12 — failed-payout backlog watchdog (real postgres).
 *
 * A terminally-FAILED `pending_payouts` row is paged once inline at
 * failure; if that page is lost, the owed cashback/interest was
 * invisible forever — the stuck-payout watchdog deliberately excludes
 * failed rows. This watchdog is the standing detector: it counts
 * uncompensated `state='failed'` rows and pages once per incident,
 * re-arming when the backlog clears. Driven against real postgres +
 * `watchdog_alert_state`; only the Discord delivery is stubbed to `true`
 * (the vault-emissions.test.ts pattern).
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

const { sendWebhookMock } = vi.hoisted(() => ({ sendWebhookMock: vi.fn(async () => true) }));
vi.mock('../../discord/shared.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, sendWebhook: sendWebhookMock };
});

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { users, pendingPayouts, watchdogAlertState } from '../../db/schema.js';
import {
  runFailedPayoutBacklogWatchdog,
  listFailedPayoutBacklog,
} from '../../payments/failed-payout-backlog-watchdog.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const ISSUER = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

async function seedUser(): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ email: `ns12-${crypto.randomUUID()}@test.local` })
    .returning({ id: users.id });
  return row!.id;
}

async function seedFailedPayout(args: {
  userId: string;
  kind: 'emission' | 'interest_mint';
  compensated?: boolean;
  failedAgoMs?: number;
}): Promise<void> {
  const failedAt = new Date(Date.now() - (args.failedAgoMs ?? 0));
  await db.insert(pendingPayouts).values({
    userId: args.userId,
    orderId: null, // emission / interest_mint are order-less
    kind: args.kind,
    assetCode: 'GBPLOOP',
    assetIssuer: ISSUER,
    toAddress: Keypair.random().publicKey(),
    amountStroops: 1_000n,
    memoText: 'ns12',
    state: 'failed',
    failedAt,
    ...(args.compensated ? { compensatedAt: new Date() } : {}),
  });
}

async function alertActive(): Promise<boolean | undefined> {
  const [row] = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, 'failed-payout-backlog-watchdog'));
  return row?.alertActive;
}

describeIf('NS-12 failed-payout backlog watchdog (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
    sendWebhookMock.mockReset().mockResolvedValue(true);
  });

  it('does not page when there is no failed-payout backlog', async () => {
    const r = await runFailedPayoutBacklogWatchdog();
    expect(r).toEqual({ skippedLocked: false, notified: false, backlog: 0 });
    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(await alertActive()).toBeUndefined();
  });

  it('pages once for a standing backlog, dedups the repeat, and re-arms when cleared', async () => {
    const userId = await seedUser();
    await seedFailedPayout({ userId, kind: 'emission', failedAgoMs: 90 * 60 * 1000 });
    await seedFailedPayout({ userId, kind: 'interest_mint' });

    // First tick: pages once + latches.
    const first = await runFailedPayoutBacklogWatchdog();
    expect(first.notified).toBe(true);
    expect(first.backlog).toBe(2);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Second tick, same backlog: no re-page (fire-once).
    const second = await runFailedPayoutBacklogWatchdog();
    expect(second.notified).toBe(false);
    expect(second.backlog).toBe(2);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Backlog cleared (rows retried/compensated → gone): re-arm.
    await db.delete(pendingPayouts);
    const third = await runFailedPayoutBacklogWatchdog();
    expect(third.notified).toBe(false);
    expect(third.backlog).toBe(0);
    expect(await alertActive()).toBe(false);
  });

  it('excludes CF-21 auto-compensated (made-whole) failed emissions from the backlog', async () => {
    const userId = await seedUser();
    await seedFailedPayout({ userId, kind: 'emission', compensated: true });

    const summary = await listFailedPayoutBacklog(db);
    expect(summary.total).toBe(0);

    const r = await runFailedPayoutBacklogWatchdog();
    expect(r.notified).toBe(false);
    expect(r.backlog).toBe(0);
    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it('breaks the backlog down by kind', async () => {
    const userId = await seedUser();
    await seedFailedPayout({ userId, kind: 'emission' });
    await seedFailedPayout({ userId, kind: 'interest_mint' });
    await seedFailedPayout({ userId, kind: 'interest_mint' });

    const summary = await listFailedPayoutBacklog(db);
    expect(summary.total).toBe(3);
    expect(summary.byKind).toEqual({ emission: 1, interest_mint: 2 });
  });

  it('does not latch when the Discord delivery fails (at-least-once retry)', async () => {
    const userId = await seedUser();
    await seedFailedPayout({ userId, kind: 'emission' });

    sendWebhookMock.mockResolvedValueOnce(false);
    const first = await runFailedPayoutBacklogWatchdog();
    expect(first.notified).toBe(false);
    expect(await alertActive()).toBeUndefined(); // never persisted

    const second = await runFailedPayoutBacklogWatchdog();
    expect(second.notified).toBe(true);
    expect(await alertActive()).toBe(true);
  });
});
