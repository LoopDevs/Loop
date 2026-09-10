// CONV-WATCH-02 — health-change page fire-once
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
    const first = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(first).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);

    const second = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(second).toBe(false);
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);

    const recovered = await routeHealthChangeNotify('healthy', 'All systems operational');
    expect(recovered).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);

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

    const retried = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(retried).toBe(true);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);

    const third = await routeHealthChangeNotify('degraded', 'DB unreachable');
    expect(third).toBe(false);
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);
  });
});
