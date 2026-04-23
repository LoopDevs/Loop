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
  notifyOrderRefunded,
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

describe('notifyOrderRefunded', () => {
  it('fires to the orders webhook with formatted amount and truncated ids', async () => {
    notifyOrderRefunded({
      orderId: 'order-abcdef',
      targetUserId: 'user-uuid-1234-5678',
      adminId: 'admin-uuid-9999-0000',
      amountMinor: '2500',
      currency: 'GBP',
    });
    await new Promise((r) => setTimeout(r, 10));
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.test/orders-hook');
    const body = JSON.parse(init.body as string) as {
      embeds: Array<{ title: string; fields: Array<{ name: string; value: string }> }>;
    };
    const embed = body.embeds[0]!;
    expect(embed.title).toMatch(/Order Refunded/);
    const amount = embed.fields.find((f) => f.name === 'Amount')?.value;
    expect(amount).toBe('£25.00 GBP');
    const user = embed.fields.find((f) => f.name === 'User')?.value;
    expect(user).toBe('`user-uui…`');
    const admin = embed.fields.find((f) => f.name === 'Admin')?.value;
    expect(admin).toBe('`admin-uu…`');
    const orderId = embed.fields.find((f) => f.name === 'Order ID')?.value;
    expect(orderId).toBe('`order-abcdef`');
  });

  it('preserves bigint precision on large refund amounts', async () => {
    notifyOrderRefunded({
      orderId: 'o',
      targetUserId: 'u',
      adminId: 'a',
      amountMinor: '1234567',
      currency: 'USD',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const amount = embed.fields.find((f) => f.name === 'Amount')?.value;
    expect(amount).toBe('$12,345.67 USD');
  });

  it('falls back to code-only rendering for unknown currencies', async () => {
    notifyOrderRefunded({
      orderId: 'o',
      targetUserId: 'u',
      adminId: 'a',
      amountMinor: '500',
      currency: 'NOK',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const amount = embed.fields.find((f) => f.name === 'Amount')?.value;
    expect(amount).toBe('5.00 NOK');
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
