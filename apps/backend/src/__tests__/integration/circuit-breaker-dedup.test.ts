/**
 * BK-cbdedup — circuit-breaker alert fleet-wide fire-once (real postgres).
 *
 * `notifyCircuitBreaker` now routes through the fleet-wide
 * `watchdog_alert_state` gate (`applyBinaryWatchdogAlert`) keyed
 * `circuit-breaker:<name>`, replacing the per-process dedup map that
 * re-paged once per machine on a shared outage. This drives the REAL
 * notifier against real postgres + `watchdog_alert_state`; only the
 * Discord delivery is stubbed to `true` (the vault-emissions.test.ts
 * pattern) so the persisted fire-once / dedup / re-arm is asserted.
 *
 * `notifyCircuitBreaker` is fire-and-forget (`void`), so each call is
 * followed by a short poll for the persisted state to settle.
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
import { watchdogAlertState } from '../../db/schema.js';
import { notifyCircuitBreaker } from '../../discord.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

const KEY = 'circuit-breaker:upstream:login';

async function alertActive(): Promise<boolean | undefined> {
  const [row] = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, KEY));
  return row?.alertActive;
}

/** Poll the persisted state until it reaches `want` (fire-and-forget settle). */
async function waitForAlert(want: boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await alertActive()) === want) return;
    if (Date.now() > deadline) throw new Error(`watchdog_alert_state did not reach ${want}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describeIf('BK-cbdedup circuit-breaker fleet-wide fire-once (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
    sendWebhookMock.mockReset().mockResolvedValue(true);
  });

  it('pages OPEN once, latches watchdog_alert_state, dedups the repeat, and re-arms on close', async () => {
    // First OPEN (e.g. machine A): fires + latches alert_active for the
    // circuit key.
    notifyCircuitBreaker('open', 7, 30, 'upstream:login');
    await waitForAlert(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);

    // Second OPEN for the SAME circuit (another machine on the same
    // outage): reads the persisted state and stays quiet.
    notifyCircuitBreaker('open', 7, 30, 'upstream:login');
    // Give the fire-and-forget a chance to (not) send.
    await new Promise((r) => setTimeout(r, 150));
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Recovery: fires the Closed embed once and re-arms.
    notifyCircuitBreaker('closed', 0, 30, 'upstream:login');
    await waitForAlert(false);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);
  });

  it('keys the fleet fired-state per circuit name (distinct circuits page independently)', async () => {
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await waitForAlert(true);
    notifyCircuitBreaker('open', 5, 30, 'upstream:merchants');
    // Both keys latch independently.
    const deadline = Date.now() + 2000;
    for (;;) {
      const [row] = await db
        .select({ alertActive: watchdogAlertState.alertActive })
        .from(watchdogAlertState)
        .where(eq(watchdogAlertState.watchdogName, 'circuit-breaker:upstream:merchants'));
      if (row?.alertActive === true) break;
      if (Date.now() > deadline) throw new Error('merchants circuit did not latch');
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);
  });
});
