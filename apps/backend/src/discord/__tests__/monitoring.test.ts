/**
 * `monitoring.ts` notifier-body tests. Covers the eight notifiers
 * defined in this file directly:
 *   - notifyHealthChange (status flip + color)
 *   - notifyPayoutFailed (last-8 redaction; emission vs order)
 *   - notifyInterestPoolLow / notifyInterestPoolRecovered (paired,
 *     dedup'd per asset)
 *   - notifyPegBreakOnFulfillment (cross-currency divergence)
 *   - notifyUsdcBelowFloor
 *   - notifyOperatorPoolExhausted
 *
 * Goal: pin embed shape so a future refactor can't silently rename
 * a field, drop a redaction, or flip a color without CI catching it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendWebhookMock, envMock, escapeMarkdownReal, truncateReal } = vi.hoisted(() => ({
  sendWebhookMock: vi.fn(),
  envMock: { DISCORD_WEBHOOK_MONITORING: 'https://discord.example/monitoring' },
  escapeMarkdownReal: (v: string): string => v.replace(/([\\`*_~|>[\]()])/g, '\\$1'),
  truncateReal: (v: string, max: number): string =>
    v.length <= max ? v : `${v.slice(0, max - 1)}…`,
}));

vi.mock('../../env.js', () => ({
  get env() {
    return envMock;
  },
}));

vi.mock('../shared.js', () => ({
  sendWebhook: (url: string | undefined, embed: unknown) => sendWebhookMock(url, embed),
  escapeMarkdown: escapeMarkdownReal,
  truncate: truncateReal,
  FIELD_VALUE_MAX: 1024,
  DESCRIPTION_MAX: 4096,
  GREEN: 0x2ecc71,
  BLUE: 0x3498db,
  ORANGE: 0xe67e22,
  RED: 0xe74c3c,
}));

// Sibling notifier modules imported by `monitoring.ts` for re-export.
// We don't exercise them here; stub so imports resolve.
vi.mock('../monitoring-asset-drift.js', () => ({
  notifyAssetDrift: vi.fn(),
  notifyAssetDriftRecovered: vi.fn(),
}));
vi.mock('../monitoring-stuck-sweepers.js', () => ({
  notifyStuckProcurementSwept: vi.fn(),
  notifyPaymentWatcherStuck: vi.fn(),
  notifyStuckPayouts: vi.fn(),
}));
vi.mock('../monitoring-ctx-schema-drift.js', () => ({
  notifyCtxSchemaDrift: vi.fn(),
  __resetCtxSchemaDriftDedupForTests: vi.fn(),
}));
vi.mock('../monitoring-circuit-breaker.js', () => ({
  notifyCircuitBreaker: vi.fn(),
  __resetCircuitNotifyDedupForTests: vi.fn(),
}));

import {
  notifyHealthChange,
  notifyGeoDbStale,
  notifyPayoutFailed,
  notifyInterestPoolLow,
  notifyInterestPoolRecovered,
  notifyPegBreakOnFulfillment,
  notifyUsdcBelowFloor,
  notifyOperatorPoolExhausted,
  notifyOperatorCredentialExpired,
  __resetOperatorCredentialDedupForTests,
} from '../monitoring.js';

beforeEach(() => {
  sendWebhookMock.mockReset();
  sendWebhookMock.mockResolvedValue(true);
  __resetOperatorCredentialDedupForTests();
});

interface Embed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}

function lastEmbed(): Embed {
  const call = sendWebhookMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('sendWebhook not called');
  return call[1] as Embed;
}

describe('notifyHealthChange', () => {
  it('green embed + "Service Healthy" title on transition to healthy', () => {
    notifyHealthChange('healthy', 'all good');
    const e = lastEmbed();
    expect(e.title).toBe('💚 Service Healthy');
    expect(e.color).toBe(0x2ecc71);
    expect(e.description).toBe('all good');
  });

  it('orange + degraded title on degraded', () => {
    notifyHealthChange('degraded', 'CTX pool down');
    const e = lastEmbed();
    expect(e.title).toBe('🟠 Service Degraded');
    expect(e.color).toBe(0xe67e22);
  });
});

describe('notifyGeoDbStale', () => {
  it('renders the age + build epoch when the db opened but is stale', () => {
    notifyGeoDbStale({ buildEpoch: '2026-01-01T00:00:00.000Z', ageDays: 100, thresholdDays: 45 });
    const e = lastEmbed();
    expect(e.title).toBe('🟡 GeoLite2 database stale');
    expect(e.color).toBe(0xe67e22);
    expect(e.description).toContain('100 day(s) ago');
    expect(e.description).toContain('45-day staleness threshold');
    expect(e.fields!.find((f) => f.name === 'Build epoch')!.value).toBe('2026-01-01T00:00:00.000Z');
    expect(e.fields!.find((f) => f.name === 'Age (days)')!.value).toBe('100');
    expect(e.fields!.find((f) => f.name === 'Threshold (days)')!.value).toBe('45');
  });

  it('renders the misconfigured-load-failure copy when buildEpoch is null', () => {
    notifyGeoDbStale({ buildEpoch: null, ageDays: null, thresholdDays: 45 });
    const e = lastEmbed();
    expect(e.description).toContain('failed to open');
    expect(e.fields!.find((f) => f.name === 'Build epoch')!.value).toBe('_open failed_');
    expect(e.fields!.find((f) => f.name === 'Age (days)')!.value).toBe('_n/a_');
  });
});

describe('notifyPayoutFailed', () => {
  it('redacts user/order/payout to last-8 (ADR-018 convention)', () => {
    notifyPayoutFailed({
      payoutId: 'payout-uuid-aaaaaaaabbbbbbbb12345678',
      userId: 'user-uuid-aaaaaaaabbbbbbbbcccccccc11111111',
      orderId: 'order-uuid-yyyyyyyy00000000',
      assetCode: 'USDLOOP',
      amount: '5000000',
      kind: 'op_no_trust',
      reason: 'destination has no USDLOOP trustline',
      attempts: 3,
    });
    const e = lastEmbed();
    expect(e.title).toBe('🔴 Stellar Payout Failed');
    expect(e.color).toBe(0xe74c3c);
    expect(e.fields!.find((f) => f.name === 'User')!.value).toBe('`11111111`');
    expect(e.fields!.find((f) => f.name === 'Order')!.value).toBe('`00000000`');
    expect(e.fields!.find((f) => f.name === 'Payout')!.value).toBe('`12345678`');
    // escapeMarkdown escapes underscores so the kind reads literal in
    // the channel rather than activating Discord's italic markdown.
    expect(e.fields!.find((f) => f.name === 'Kind')!.value).toBe('`op\\_no\\_trust`');
    expect(e.fields!.find((f) => f.name === 'Attempts')!.value).toBe('3');
  });

  it('renders _emission_ when orderId is null (kind=emission payouts)', () => {
    notifyPayoutFailed({
      payoutId: 'p-1',
      userId: 'u-1',
      orderId: null,
      assetCode: 'GBPLOOP',
      amount: '100',
      kind: 'op_underfunded',
      reason: 'operator out of GBPLOOP',
      attempts: 1,
    });
    expect(lastEmbed().fields!.find((f) => f.name === 'Order')!.value).toBe('_emission_');
  });
});

describe('notifyInterestPoolLow / notifyInterestPoolRecovered', () => {
  // C10a: dedup moved to `interest_pool_alert_state` (durable +
  // fleet-consistent + at-least-once). These notifiers are now PURE
  // SENDERS — every call sends and returns the delivery promise; the
  // watcher, not the notifier, decides WHEN to call based on persisted
  // transition state. (The old per-process Set silently dropped a
  // recovery close handled by a different machine than paged the low.)
  it('low: sends the low embed and returns the delivery promise', async () => {
    const p = notifyInterestPoolLow({
      assetCode: 'USDLOOP',
      poolStroops: '1000',
      dailyInterestStroops: '500',
      daysOfCover: 2,
      minDaysOfCover: 7,
    });
    expect(p).toBeInstanceOf(Promise);
    await p;
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    const e = lastEmbed();
    expect(e.title).toBe('🟠 Interest pool running low');
    expect(e.color).toBe(0xe67e22);
    expect(e.fields!.find((f) => f.name === 'Days of cover')!.value).toBe('2.00');
  });

  it('recovered: sends unconditionally (no per-process dedup gate)', async () => {
    // Under the old Set this no-op'd with no prior low on this process.
    await notifyInterestPoolRecovered({
      assetCode: 'USDLOOP',
      poolStroops: '999999999',
      daysOfCover: 100,
    });
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    const last = lastEmbed();
    expect(last.title).toBe('✅ Interest pool replenished');
    expect(last.color).toBe(0x2ecc71);
  });
});

describe('notifyPegBreakOnFulfillment', () => {
  it('emits the peg-break alert with both currencies + cashback amount', () => {
    notifyPegBreakOnFulfillment({
      orderId: 'o-1',
      userId: 'u-1',
      chargeCurrency: 'USD',
      userHomeCurrency: 'GBP',
      cashbackMinor: '500',
    });
    const e = lastEmbed();
    expect(e.title).toBe('🚨 LOOP-asset peg break on fulfillment');
    expect(e.color).toBe(0xe67e22);
    expect(e.fields!.find((f) => f.name === 'Charge ccy')!.value).toBe('USD');
    expect(e.fields!.find((f) => f.name === 'Home ccy')!.value).toBe('GBP');
    expect(e.fields!.find((f) => f.name === 'Cashback (minor)')!.value).toBe('500');
  });
});

describe('notifyUsdcBelowFloor', () => {
  it('embeds balance + floor + account in the field set', () => {
    notifyUsdcBelowFloor({
      balanceStroops: '5000000',
      floorStroops: '10000000',
      account: 'GAACCOUNT',
    });
    const e = lastEmbed();
    expect(e.title).toBe('🟡 USDC Reserve Below Floor');
    expect(e.fields!.find((f) => f.name === 'Balance (stroops)')!.value).toBe('5000000');
    expect(e.fields!.find((f) => f.name === 'Floor (stroops)')!.value).toBe('10000000');
    expect(e.description).toContain('GAACCOUNT');
  });
});

describe('notifyOperatorPoolExhausted', () => {
  it('emits red with pool size + last error', () => {
    notifyOperatorPoolExhausted({ poolSize: 3, reason: 'all 3 operators tripped' });
    const e = lastEmbed();
    expect(e.title).toBe('🔴 CTX Operator Pool Exhausted');
    expect(e.color).toBe(0xe74c3c);
    expect(e.fields!.find((f) => f.name === 'Pool size')!.value).toBe('3');
    expect(e.fields!.find((f) => f.name === 'Last error')!.value).toContain('all 3 operators');
  });
});

describe('notifyOperatorCredentialExpired (CF-13)', () => {
  it('emits red with operator id + pool size + failed-over flag', () => {
    notifyOperatorCredentialExpired({ operatorId: 'op-primary', poolSize: 2, failedOver: true });
    const e = lastEmbed();
    expect(e.title).toBe('🔴 CTX Operator Credential Expired (401)');
    expect(e.color).toBe(0xe74c3c);
    expect(e.fields!.find((f) => f.name === 'Operator')!.value).toContain('op-primary');
    expect(e.fields!.find((f) => f.name === 'Pool size')!.value).toBe('2');
    expect(e.fields!.find((f) => f.name === 'Failed over')!.value).toBe('yes');
    expect(e.description).toContain('healthy sibling');
  });

  it('says procurement is blocked when no sibling failover was possible', () => {
    notifyOperatorCredentialExpired({ operatorId: 'op-only', poolSize: 1, failedOver: false });
    const e = lastEmbed();
    expect(e.fields!.find((f) => f.name === 'Failed over')!.value).toBe('no');
    expect(e.description).toContain('procurement is blocked');
  });

  it('dedups per-operator within the 10-minute window', () => {
    notifyOperatorCredentialExpired({ operatorId: 'op-a', poolSize: 2, failedOver: true });
    notifyOperatorCredentialExpired({ operatorId: 'op-a', poolSize: 2, failedOver: true });
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    // A different operator is a distinct dedup key — fires independently.
    notifyOperatorCredentialExpired({ operatorId: 'op-b', poolSize: 2, failedOver: true });
    expect(sendWebhookMock).toHaveBeenCalledTimes(2);
  });
});
