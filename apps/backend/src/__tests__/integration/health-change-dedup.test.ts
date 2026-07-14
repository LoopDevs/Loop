/**
 * CONV-WATCH-02 — health-change page fleet-wide fire-once (real postgres).
 *
 * `/health` flips per-machine, but the resulting Discord page is now
 * routed through the fleet-wide `watchdog_alert_state` dedup gate
 * (`routeHealthChangeNotify` → `applyBinaryWatchdogAlert`) so a SHARED
 * outage pages ONCE fleet-wide and re-arms on recovery, instead of once
 * per machine. This drives the REAL gate against real postgres +
 * `watchdog_alert_state`; only the Discord delivery is stubbed to `true`
 * (the vault-emissions.test.ts pattern) so the fire-once / dedup /
 * re-arm state transitions are what's actually asserted.
 *
 * `LOOP_E2E_DB=1` gate, same per-test truncate as the sibling suites.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const RUN_INTEGRATION = process.env['LOOP_E2E_DB'] === '1';

// Post-FT-06 an unset webhook makes `sendWebhook` report NON-delivery
// (false), which would never latch the gate. Stub it to a confirmed
// delivery so the persisted fire-once contract is what's exercised (NO
// real Discord call happens). Every other `discord/shared.js` export
// (colours, truncate) stays real via `...actual`.
const { sendWebhookMock } = vi.hoisted(() => ({ sendWebhookMock: vi.fn(async () => true) }));
vi.mock('../../discord/shared.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, sendWebhook: sendWebhookMock };
});

import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { watchdogAlertState } from '../../db/schema.js';
import { routeHealthChangeNotify } from '../../health.js';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';

const describeIf = RUN_INTEGRATION ? describe : describe.skip;

async function alertActive(): Promise<boolean | undefined> {
  const [row] = await db
    .select({ alertActive: watchdogAlertState.alertActive })
    .from(watchdogAlertState)
    .where(eq(watchdogAlertState.watchdogName, 'health-change'));
  return row?.alertActive;
}

describeIf('CONV-WATCH-02 health-change fleet-wide fire-once (real postgres)', () => {
  beforeAll(async () => {
    await ensureMigrated();
  });
  beforeEach(async () => {
    await truncateAllTables();
    sendWebhookMock.mockReset().mockResolvedValue(true);
  });

  it('pages once on the first degraded flip, dedups a second machine, and re-arms on recovery', async () => {
    // Machine A flips healthy→degraded: fires + latches alert_active.
    const first = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(first).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(await alertActive()).toBe(true);

    // Machine B flips degraded on the SAME shared outage: reads the
    // persisted alert_active=true and stays quiet — the N→1 fleet dedup.
    const second = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(second).toBe(false);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1); // no second page
    expect(await alertActive()).toBe(true);

    // Recovery re-arms: fires the healthy embed once, clears alert_active
    // so the NEXT distinct outage pages fresh.
    const recovered = await routeHealthChangeNotify('healthy', 'All systems operational');
    expect(recovered).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);
    expect(await alertActive()).toBe(false);
  });

  it('does not latch (leaves the alert un-fired) when the Discord delivery fails', async () => {
    // FT-06 at-least-once: an undelivered page must NOT persist
    // alert_active — the next machine/tick retries.
    sendWebhookMock.mockResolvedValueOnce(false);
    const fired = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(fired).toBe(false);
    expect(await alertActive()).toBeUndefined(); // no row written

    // A later attempt (delivery now succeeds) fires and latches.
    const retried = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(retried).toBe(true);
    expect(await alertActive()).toBe(true);
  });
});
