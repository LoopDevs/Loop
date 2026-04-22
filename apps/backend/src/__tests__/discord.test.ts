import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  GIFT_CARD_API_BASE_URL: 'https://upstream.local',
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DISCORD_WEBHOOK_ORDERS: 'https://discord.test/orders-hook',
  DISCORD_WEBHOOK_MONITORING: 'https://discord.test/monitoring-hook',
}));

vi.mock('../env.js', () => ({ env: mockEnv }));

const mockLog = vi.hoisted(() => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    ...mockLog,
    child: () => mockLog,
  },
}));

import {
  notifyOrderCreated,
  notifyOrderFulfilled,
  notifyHealthChange,
  notifyCircuitBreaker,
  notifyAdminCreditAdjustment,
} from '../discord.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockLog.warn.mockReset();
  mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
});

function lastBody(): { embeds: Array<Record<string, unknown>> } {
  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as { embeds: Array<Record<string, unknown>> };
}

describe('notifyOrderCreated', () => {
  it('skips silently when no webhook is configured', async () => {
    mockEnv.DISCORD_WEBHOOK_ORDERS = '';
    notifyOrderCreated('o1', 'Acme', 25, 'USD', '100.5');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).not.toHaveBeenCalled();
    mockEnv.DISCORD_WEBHOOK_ORDERS = 'https://discord.test/orders-hook';
  });

  it('sends an embed with formatted amount and XLM', async () => {
    notifyOrderCreated('order-xyz', 'Acme Corp', 25, 'USD', '100.50000');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(byName.Amount).toBe('$25.00 USD');
    expect(byName.XLM).toBe('100.50000');
    expect(byName.Merchant).toBe('Acme Corp');
    expect(byName['Order ID']).toBe('`order-xyz`');
  });

  it('escapes markdown in merchant name to prevent embed formatting breakage', async () => {
    notifyOrderCreated('o1', 'Evil`Name*With_Markdown', 10, 'USD', '1');
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const merchant = embed.fields.find((f) => f.name === 'Merchant');
    expect(merchant?.value).toBe('Evil\\`Name\\*With\\_Markdown');
  });

  it('truncates excessively long field values (>1024 chars)', async () => {
    const longName = 'a'.repeat(2000);
    notifyOrderCreated('o1', longName, 10, 'USD', '1');
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const merchant = embed.fields.find((f) => f.name === 'Merchant')!;
    expect(merchant.value.length).toBe(1024);
    expect(merchant.value.endsWith('…')).toBe(true);
  });
});

describe('notifyOrderFulfilled', () => {
  it('formats EUR amounts with the euro symbol, not a dollar sign', async () => {
    notifyOrderFulfilled('o1', 'Acme', 25, 'EUR', 'barcode');
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const amount = embed.fields.find((f) => f.name === 'Amount');
    expect(amount?.value).toBe('€25.00 EUR');
  });

  it('formats unknown currencies with the code only (no symbol)', async () => {
    notifyOrderFulfilled('o1', 'Acme', 25, 'NOK', 'barcode');
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const amount = embed.fields.find((f) => f.name === 'Amount');
    expect(amount?.value).toBe('25.00 NOK');
  });
});

describe('notifyAdminCreditAdjustment', () => {
  it('fires to the monitoring webhook with credit-coloured title on positive amounts', async () => {
    notifyAdminCreditAdjustment({
      targetUserId: 'user-aaaaaaaa-bbbb',
      adminId: 'admin-11111111-2222',
      currency: 'GBP',
      amountMinor: '500',
      newBalanceMinor: '1500',
      note: 'goodwill credit after support chat',
    });
    await new Promise((r) => setTimeout(r, 10));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.test/monitoring-hook');
    const body = JSON.parse(init.body as string) as {
      embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }>;
    };
    const embed = body.embeds[0]!;
    expect(embed.title).toMatch(/Admin Credit$/);
    const amount = embed.fields.find((f) => f.name === 'Amount')?.value;
    expect(amount).toBe('£5.00 GBP');
    const balance = embed.fields.find((f) => f.name === 'New balance')?.value;
    expect(balance).toBe('£15.00 GBP');
    const note = embed.fields.find((f) => f.name === 'Note')?.value;
    expect(note).toBe('goodwill credit after support chat');
  });

  it('uses a debit title + orange colour on negative amounts', async () => {
    notifyAdminCreditAdjustment({
      targetUserId: 'user-x',
      adminId: 'admin-y',
      currency: 'USD',
      amountMinor: '-1000',
      newBalanceMinor: '500',
      note: 'clawback',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { title: string; color: number; fields: unknown[] };
    expect(embed.title).toMatch(/Debit/);
    // ORANGE colour code from discord.ts
    expect(embed.color).toBe(16753920);
  });

  it('truncates admin + user ids to first 8 chars for log-friendly display', async () => {
    notifyAdminCreditAdjustment({
      targetUserId: 'aaaaaaaa-bbbb-cccc-dddd',
      adminId: 'eeeeeeee-ffff-gggg-hhhh',
      currency: 'GBP',
      amountMinor: '100',
      newBalanceMinor: '100',
      note: 'test',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const admin = embed.fields.find((f) => f.name === 'Admin')?.value;
    expect(admin).toBe('`eeeeeeee…`');
    const target = embed.fields.find((f) => f.name === 'Target user')?.value;
    expect(target).toBe('`aaaaaaaa…`');
  });

  it('escapes markdown in the note so support chat excerpts cannot break the embed', async () => {
    notifyAdminCreditAdjustment({
      targetUserId: 'u',
      adminId: 'a',
      currency: 'GBP',
      amountMinor: '1',
      newBalanceMinor: '1',
      note: 'note with `backticks` and _underscores_',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const note = embed.fields.find((f) => f.name === 'Note')?.value;
    expect(note).toBe('note with \\`backticks\\` and \\_underscores\\_');
  });
});

describe('notifyCircuitBreaker', () => {
  it('includes the cooldown seconds from the caller (not hardcoded 30)', async () => {
    notifyCircuitBreaker('open', 7, 60);
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { description: string };
    expect(embed.description).toContain('7 consecutive failures');
    expect(embed.description).toContain('60s');
  });

  it('defaults cooldown to 30s when not passed', async () => {
    notifyCircuitBreaker('open', 5);
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { description: string };
    expect(embed.description).toContain('30s');
  });
});

describe('notifyHealthChange', () => {
  it('truncates description past 4096 chars', async () => {
    const big = 'x'.repeat(5000);
    notifyHealthChange('degraded', big);
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { description: string };
    expect(embed.description.length).toBe(4096);
    expect(embed.description.endsWith('…')).toBe(true);
  });
});

describe('mention injection defense', () => {
  it('sets allowed_mentions.parse=[] so upstream names cannot ping @everyone', async () => {
    notifyOrderCreated('o1', '@everyone nice try', 25, 'USD', '1');
    await new Promise((r) => setTimeout(r, 10));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });

  it('applies allowed_mentions on monitoring webhooks too', async () => {
    notifyCircuitBreaker('open', 5, 30);
    await new Promise((r) => setTimeout(r, 10));
    const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(payload.allowed_mentions).toEqual({ parse: [] });
  });
});

describe('sendWebhook error handling', () => {
  it('logs a warning with response body when Discord returns non-success', async () => {
    mockFetch.mockResolvedValueOnce(new Response('bad payload', { status: 400 }));
    notifyOrderCreated('o1', 'Acme', 25, 'USD', '1');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, body: 'bad payload' }),
      expect.stringContaining('non-success'),
    );
  });

  it('logs a warning when fetch rejects (network/timeout)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    notifyOrderCreated('o1', 'Acme', 25, 'USD', '1');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed'),
    );
  });

  it('does not throw from notify functions even when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    // This must not throw — callers are sync `void sendWebhook(...)`.
    expect(() => notifyOrderCreated('o1', 'm', 1, 'USD', '1')).not.toThrow();
  });
});
