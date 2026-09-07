/**
 * CONV-WATCH-02 — health-change page fire-once.
 *
 * The health-change Discord page is routed through the fire-once/
 * re-arm gate (`routeHealthChangeNotify` → `applyBinaryWatchdogAlert`,
 * now an in-process latch — the old Postgres-backed
 * `watchdog_alert_state` table's successor) so a continuing outage
 * pages ONCE and re-arms on recovery, instead of once per tick. This
 * drives the REAL gate; only the Discord delivery is stubbed to `true`
 * so the fire-once / dedup / re-arm transitions are what's actually
 * asserted (NO real Discord call happens).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Post-FT-06 an unset webhook makes `sendWebhook` report NON-delivery
// (false), which would never latch the gate. Stub it to a confirmed
// delivery so the fire-once contract is what's exercised. Every other
// `discord/shared.js` export (colours, truncate) stays real via
// `...actual`.
const { sendWebhookMock } = vi.hoisted(() => ({ sendWebhookMock: vi.fn(async () => true) }));
vi.mock('../../discord/shared.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, sendWebhook: sendWebhookMock };
});

import { routeHealthChangeNotify } from '../../health.js';
import { __resetWatchdogAlertStateForTests } from '../../discord/watchdog-alert.js';

describe('CONV-WATCH-02 health-change fire-once', () => {
  beforeEach(() => {
    __resetWatchdogAlertStateForTests();
    sendWebhookMock.mockReset().mockResolvedValue(true);
  });

  it('pages once on the first degraded flip, dedups the repeat, and re-arms on recovery', async () => {
    // First healthy→degraded flip: fires + latches the alert.
    const first = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(first).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);

    // A second degraded report on the SAME continuing outage: reads the
    // latched state and stays quiet — the N→1 dedup.
    const second = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(second).toBe(false);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1); // no second page

    // Recovery re-arms: fires the healthy embed once and clears the
    // latch so the NEXT distinct outage pages fresh.
    const recovered = await routeHealthChangeNotify('healthy', 'All systems operational');
    expect(recovered).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);

    // Proof of the re-arm: a fresh outage pages again.
    const freshOutage = await routeHealthChangeNotify('degraded', 'DB unreachable again');
    expect(freshOutage).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(3);
  });

  it('does not latch (leaves the alert un-fired) when the Discord delivery fails', async () => {
    // FT-06 at-least-once: an undelivered page must NOT latch the gate
    // — the next tick retries.
    sendWebhookMock.mockResolvedValueOnce(false);
    const fired = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(fired).toBe(false);

    // A later attempt (delivery now succeeds) fires and latches…
    const retried = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(retried).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);

    // …and the latch holds: a further report of the same outage dedups.
    const third = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(third).toBe(false);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);
  });
});
