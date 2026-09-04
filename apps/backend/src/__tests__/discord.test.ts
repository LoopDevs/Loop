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

// BK-cbdedup: notifyCircuitBreaker now routes through the fleet-wide
// `watchdog_alert_state` fire-once gate. Emulate that gate in-memory
// (same false→true / true→false / confirmed-delivery contract as the
// real `applyBinaryWatchdogAlert` — see vault-watchdog-alert.test.ts) so
// these unit tests exercise the wiring without a DB. `circuitGateState`
// models the PERSISTED fired-state: it is deliberately NOT cleared by
// `__resetCircuitNotifyDedupForTests`, so the reset-survival test can
// prove the state is fleet-wide, not per-process. The real gate + real
// `watchdog_alert_state` are covered end-to-end by
// `__tests__/integration/circuit-breaker-dedup.test.ts`.
const { circuitGateState } = vi.hoisted(() => ({ circuitGateState: new Map<string, boolean>() }));
vi.mock('../credits/vaults/vault-watchdog-alert.js', () => ({
  applyBinaryWatchdogAlert: async (args: {
    watchdogName: string;
    shouldBeActive: boolean;
    notifyActive: () => Promise<boolean>;
    notifyRecovered: () => Promise<boolean>;
  }): Promise<boolean> => {
    const was = circuitGateState.get(args.watchdogName) ?? false;
    if (was === args.shouldBeActive) return false;
    const delivered = args.shouldBeActive
      ? await args.notifyActive()
      : await args.notifyRecovered();
    if (!delivered) return false;
    circuitGateState.set(args.watchdogName, args.shouldBeActive);
    return true;
  },
}));

import {
  notifyOrderCreated,
  notifyOrderFulfilled,
  notifyHealthChange,
  notifyCircuitBreaker,
  notifyPayoutFailed,
  notifyCtxSchemaDrift,
  __resetCircuitNotifyDedupForTests,
  __resetCtxSchemaDriftDedupForTests,
} from '../discord.js';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  mockFetch.mockReset();
  mockLog.warn.mockReset();
  mockFetch.mockResolvedValue(new Response(null, { status: 204 }));
  // Reset env to the default configured state. Individual tests may
  // override (e.g. `''` for the "skips silently when not configured"
  // branch); this resets so later siblings start clean regardless.
  mockEnv.DISCORD_WEBHOOK_ORDERS = 'https://discord.test/orders-hook';
  mockEnv.DISCORD_WEBHOOK_MONITORING = 'https://discord.test/monitoring-hook';
});

function lastBody(): { embeds: Array<Record<string, unknown>> } {
  const [, init] = mockFetch.mock.calls[0] as [string, RequestInit];
  return JSON.parse(init.body as string) as { embeds: Array<Record<string, unknown>> };
}

describe('notifyOrderCreated', () => {
  it('skips silently when no webhook is configured', async () => {
    mockEnv.DISCORD_WEBHOOK_ORDERS = '';
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: 'Acme',
      faceValueMinor: 2500n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).not.toHaveBeenCalled();
    mockEnv.DISCORD_WEBHOOK_ORDERS = 'https://discord.test/orders-hook';
  });

  it('sends an embed with formatted amount and XLM', async () => {
    notifyOrderCreated({
      orderId: 'order-xyz',
      merchantName: 'Acme Corp',
      faceValueMinor: 2500n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    expect(byName.Amount).toBe('$25.00 USD');
    expect(byName['Pays CTX in']).toBe('XLM');
    expect(byName.Merchant).toBe('Acme Corp');
    expect(byName['Order ID']).toBe('`order-xyz`');
  });

  it('escapes markdown in merchant name to prevent embed formatting breakage', async () => {
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: 'Evil`Name*With_Markdown',
      faceValueMinor: 1000n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const merchant = embed.fields.find((f) => f.name === 'Merchant');
    expect(merchant?.value).toBe('Evil\\`Name\\*With\\_Markdown');
  });

  it('A2-2004: neutralises Discord link-construction syntax in merchant name', async () => {
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: '[Click](https://evil.com)',
      faceValueMinor: 1000n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const merchant = embed.fields.find((f) => f.name === 'Merchant');
    expect(merchant?.value).toBe('\\[Click\\]\\(https://evil.com\\)');
  });

  it('A2-2004: strips bidi RTL override + zero-width chars before escaping', async () => {
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: 'Acme\u202Ereverse\u200B',
      faceValueMinor: 1000n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const merchant = embed.fields.find((f) => f.name === 'Merchant');
    expect(merchant?.value).toBe('Acmereverse');
    expect(merchant?.value).not.toContain('\u202E');
    expect(merchant?.value).not.toContain('\u200B');
  });

  it('truncates excessively long field values (>1024 chars)', async () => {
    const longName = 'a'.repeat(2000);
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: longName,
      faceValueMinor: 1000n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
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
    notifyOrderFulfilled({
      orderId: 'o1',
      merchantId: 'Acme',
      faceValueMinor: 2500n,
      currency: 'EUR',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const amount = embed.fields.find((f) => f.name === 'Amount');
    expect(amount?.value).toBe('€25.00 EUR');
  });

  it('A2-1522: Intl-backed symbol for currencies beyond the launch four (NOK → kr25.00 NOK)', async () => {
    notifyOrderFulfilled({
      orderId: 'o1',
      merchantId: 'Acme',
      faceValueMinor: 2500n,
      currency: 'NOK',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const amount = embed.fields.find((f) => f.name === 'Amount');
    // Intl.NumberFormat picks the correct symbol for NOK. The exact
    // symbol is `kr` on modern ICU; accept either `kr` or `Kr` to
    // stay robust against Node version drift in the ICU tables.
    expect(amount?.value).toMatch(/^[Kk]r25\.00 NOK$/);
  });

  it('A2-1522: falls back to code-only for truly invalid currency codes', async () => {
    notifyOrderFulfilled({
      orderId: 'o1',
      merchantId: 'Acme',
      faceValueMinor: 2500n,
      currency: 'ZZZ',
    });
    await new Promise((r) => setTimeout(r, 10));
    const body = lastBody();
    const embed = body.embeds[0] as { fields: Array<{ name: string; value: string }> };
    const amount = embed.fields.find((f) => f.name === 'Amount');
    // ZZZ is the ISO-4217 "no currency" code; Intl.NumberFormat
    // accepts it and returns 'ZZZ' as the symbol. Either branch of
    // the fallback (no symbol found) or symbol === code is fine —
    // the point is the method doesn't throw.
    expect(amount?.value).toMatch(/^(25\.00 ZZZ|ZZZ25\.00 ZZZ)$/);
  });
});

describe('notifyCircuitBreaker', () => {
  beforeEach(() => {
    // Clear the emulated FLEET fired-state between tests. (Within a
    // single test we never clear it — the reset-survival test relies on
    // it persisting across `__resetCircuitNotifyDedupForTests`.)
    circuitGateState.clear();
    __resetCircuitNotifyDedupForTests();
  });

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

  // BK-cbdedup: a repeat OPEN for the same circuit fires once (fleet-wide
  // fire-once via watchdog_alert_state), not once per call. The gate is
  // async (a DB read→send→persist), so we await each fire-and-forget
  // transition to settle before the next — real breaker transitions are
  // serialised by the breaker state machine (it won't re-fire 'open' for
  // an already-open circuit), so this models the real cadence.
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));
  it('dedups a repeat OPEN for the same circuit (fires once fleet-wide)', async () => {
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await flush();
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await flush();
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // BK-cbdedup PROVEN-RED: the fired-state is fleet-wide (persisted in
  // watchdog_alert_state), not a per-process map. A machine restart /
  // process reset (modelled by `__resetCircuitNotifyDedupForTests`, which
  // no longer clears any process-local dedup) must NOT re-page an
  // already-open circuit. Pre-fix the per-process map WAS cleared by the
  // reset, so the same OPEN re-paged — this asserted `1` call would then
  // see `2` and fail.
  it('does not re-page an open circuit after a per-process reset (fleet-wide fired-state)', async () => {
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);

    __resetCircuitNotifyDedupForTests(); // simulate a machine restart

    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1); // still 1 — persisted fleet state
  });

  it('distinguishes different names — "login open" and "merchants open" both fire', async () => {
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    notifyCircuitBreaker('open', 5, 30, 'upstream:merchants');
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('distinguishes the same name across states — "login open" then "login closed" both fire', async () => {
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await flush();
    notifyCircuitBreaker('closed', 0, 30, 'upstream:login');
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('an unnamed call shares the `unknown` bucket — flood protection on legacy callers', async () => {
    notifyCircuitBreaker('open', 5);
    await flush();
    notifyCircuitBreaker('open', 5);
    await flush();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('tags the embed description with the circuit name so ops knows which circuit', async () => {
    notifyCircuitBreaker('open', 5, 30, 'upstream:login');
    await new Promise((r) => setTimeout(r, 10));
    const embed = lastBody().embeds[0] as { description: string };
    expect(embed.description).toContain('`upstream:login`');
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
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: '@everyone nice try',
      faceValueMinor: 2500n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
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
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: 'Acme',
      faceValueMinor: 2500n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, body: 'bad payload' }),
      expect.stringContaining('non-success'),
    );
  });

  it('logs a warning when fetch rejects (network/timeout)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('timeout'));
    notifyOrderCreated({
      orderId: 'o1',
      merchantName: 'Acme',
      faceValueMinor: 2500n,
      currency: 'USD',
      cryptoCurrency: 'XLM',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed'),
    );
  });

  it('does not throw from notify functions even when fetch rejects', async () => {
    mockFetch.mockRejectedValueOnce(new Error('boom'));
    // This must not throw — callers are sync `void sendWebhook(...)`.
    expect(() =>
      notifyOrderCreated({
        orderId: 'o1',
        merchantName: 'm',
        faceValueMinor: 100n,
        currency: 'USD',
        cryptoCurrency: 'XLM',
      }),
    ).not.toThrow();
  });
});

describe('notifyPayoutFailed', () => {
  it('emits the failure embed with tail-8 ids (A2-1314)', async () => {
    notifyPayoutFailed({
      payoutId: 'p-aabbccdd11223344',
      userId: 'u-abcdef0123456789',
      orderId: 'o-1122334455667788',
      assetCode: 'USDLOOP',
      amount: '10.0000000',
      kind: 'terminal_no_trust',
      reason: 'op_no_trust',
      attempts: 3,
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const body = lastBody();
    const embed = body.embeds[0] as {
      title: string;
      fields: Array<{ name: string; value: string }>;
    };
    expect(embed.title).toBe('🔴 Stellar Payout Failed');
    expect(embed.fields.find((f) => f.name === 'User')?.value).toBe('`23456789`');
    expect(embed.fields.find((f) => f.name === 'Order')?.value).toBe('`55667788`');
    expect(embed.fields.find((f) => f.name === 'Payout')?.value).toBe('`11223344`');
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain('u-abcdef0123456789');
    expect(serialised).not.toContain('o-1122334455667788');
    expect(serialised).not.toContain('p-aabbccdd11223344');
  });

  it('renders "_emission_" for emission payouts (no order id)', async () => {
    notifyPayoutFailed({
      payoutId: 'p-a1b2c3d4e5f60000',
      userId: 'u-ffffeeeeddddcccc',
      orderId: null,
      assetCode: 'USDLOOP',
      amount: '5.0000000',
      kind: 'transient_horizon',
      reason: 'blip',
      attempts: 5,
    });
    await new Promise((r) => setTimeout(r, 10));
    const embed = lastBody().embeds[0] as {
      fields: Array<{ name: string; value: string }>;
    };
    expect(embed.fields.find((f) => f.name === 'Order')?.value).toBe('_emission_');
  });
});

// A2-1915: runtime CTX schema-drift notifier
describe('notifyCtxSchemaDrift', () => {
  beforeEach(() => {
    __resetCtxSchemaDriftDedupForTests();
  });

  it('posts an embed naming the surface and zod issues summary', async () => {
    notifyCtxSchemaDrift({
      surface: 'POST /verify-email',
      issuesSummary: '[accessToken] invalid_type: expected string, got undefined',
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const embed = lastBody().embeds[0] as {
      title: string;
      fields: Array<{ name: string; value: string }>;
    };
    expect(embed.title).toMatch(/CTX schema drift/i);
    expect(embed.fields.find((f) => f.name === 'Surface')?.value).toContain('POST /verify-email');
    expect(embed.fields.find((f) => f.name === 'Zod issues')?.value).toContain('accessToken');
  });

  it('dedups within the 10-minute window per surface', async () => {
    notifyCtxSchemaDrift({ surface: 'GET /merchants', issuesSummary: 'first' });
    notifyCtxSchemaDrift({ surface: 'GET /merchants', issuesSummary: 'second' });
    notifyCtxSchemaDrift({ surface: 'GET /merchants', issuesSummary: 'third' });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does NOT dedup across different surfaces', async () => {
    notifyCtxSchemaDrift({ surface: 'POST /gift-cards', issuesSummary: 'a' });
    notifyCtxSchemaDrift({ surface: 'GET /gift-cards/:id', issuesSummary: 'b' });
    notifyCtxSchemaDrift({ surface: 'POST /verify-email', issuesSummary: 'c' });
    await new Promise((r) => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});
