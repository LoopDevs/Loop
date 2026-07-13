/**
 * `sendWebhook` delivery-contract tests (FT-06 / A2 detectability).
 *
 * Load-bearing invariant: an UNSET webhook URL must report
 * NON-delivery (`false`), never a phantom success (`true`). A
 * delivery-tracked caller (the fire-once watchdogs in
 * `vault-watchdog-alert.ts` / `stuck-payout-watchdog.ts`) flips its
 * persisted `alert_active` only on a `true`; a phantom `true` on an
 * unset URL would latch a real money-integrity breach as
 * "delivered" and never re-fire it. See `shared.ts`'s `sendWebhook`
 * header. These tests import the REAL `sendWebhook` (unlike the
 * per-channel notifier tests, which mock it).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockLog = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { ...mockLog, child: () => mockLog },
}));

import { sendWebhook, __resetUnconfiguredWebhookWarningForTests } from '../shared.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const EMBED = { title: 'test', color: 0x000000 };

beforeEach(() => {
  mockFetch.mockReset();
  mockLog.warn.mockReset();
  __resetUnconfiguredWebhookWarningForTests();
});

describe('sendWebhook — unconfigured webhook contract (FT-06)', () => {
  it('resolves false (non-delivery), not a phantom true, when the URL is undefined', async () => {
    await expect(sendWebhook(undefined, EMBED)).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('resolves false when the URL is the empty string', async () => {
    await expect(sendWebhook('', EMBED)).resolves.toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('warns exactly once per process that the webhook is unconfigured (observable, not spammy)', async () => {
    await sendWebhook(undefined, EMBED);
    await sendWebhook(undefined, EMBED);
    await sendWebhook(undefined, EMBED);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockLog.warn).toHaveBeenCalledTimes(1);
    expect(mockLog.warn).toHaveBeenCalledWith(expect.stringContaining('not configured'));
  });
});
