// sendWebhook delivery-contract tests (FT-06 / A2 detectability)
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

import {
  sendWebhook,
  formatMinorAmount,
  __resetUnconfiguredWebhookWarningForTests,
} from '../shared.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const EMBED = { title: 'test', color: 0x000000 };

beforeEach(() => {
  mockFetch.mockReset();
  mockLog.warn.mockReset();
  __resetUnconfiguredWebhookWarningForTests();
});

describe('formatMinorAmount — BigInt-safe money display (MNY-05)', () => {
  it('renders a > 2^53 minor amount with no precision loss (no Number cast)', () => {
    const out = formatMinorAmount('900719925474099300', 'USD');
    expect(out).toContain('9,007,199,254,740,993.00');
    expect(out).not.toContain('740,992');
  });

  it('renders a normal amount with narrow symbol, grouping, and the code suffix', () => {
    expect(formatMinorAmount('250000', 'GBP')).toBe('£2,500.00 GBP');
  });

  it('renders negative amounts with a leading minus', () => {
    expect(formatMinorAmount('-4200', 'USD')).toBe('-$42.00 USD');
  });

  it('pads sub-major amounts to two fraction digits', () => {
    expect(formatMinorAmount('5', 'USD')).toBe('$0.05 USD');
  });
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
