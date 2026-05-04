/**
 * Bodies of `notifyStuckProcurementSwept`, `notifyPaymentWatcherStuck`,
 * `notifyStuckPayouts`. Pin embed shapes so a regression in field
 * naming, color, or "stuck-for-N-min" math surfaces in CI.
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
  ORANGE: 0xe67e22,
  RED: 0xe74c3c,
}));

import {
  notifyStuckProcurementSwept,
  notifyPaymentWatcherStuck,
  notifyStuckPayouts,
} from '../monitoring-stuck-sweepers.js';

beforeEach(() => sendWebhookMock.mockReset());

interface Embed {
  title: string;
  description?: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
}

function lastEmbed(): Embed {
  const call = sendWebhookMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('sendWebhook not called');
  return call[1] as Embed;
}

describe('notifyStuckProcurementSwept', () => {
  it('emits per-row drilldown with stuck-for-N-min computed from procuredAtMs', () => {
    const procuredAtMs = Date.now() - 11 * 60 * 1000; // 11 min ago
    notifyStuckProcurementSwept({
      orderId: 'order-uuid-1',
      userId: 'user-uuid-1',
      merchantId: 'amazon',
      chargeMinor: '1000',
      chargeCurrency: 'USD',
      ctxOperatorId: 'op-1',
      procuredAtMs,
    });
    const e = lastEmbed();
    expect(e.title).toBe('🟡 Stuck Procuring Order Swept to Failed');
    expect(e.color).toBe(0xe67e22);
    const stuckFor = e.fields.find((f) => f.name === 'Stuck for (min)')!.value;
    expect(['10', '11', '12']).toContain(stuckFor); // tolerate clock drift
    expect(e.fields.find((f) => f.name === 'Order')!.value).toBe('`order-uuid-1`');
    expect(e.fields.find((f) => f.name === 'Charge')!.value).toBe('1000 USD');
  });

  it('renders _none_ when ctxOperatorId is null', () => {
    notifyStuckProcurementSwept({
      orderId: 'o-2',
      userId: 'u-2',
      merchantId: 'amazon',
      chargeMinor: '500',
      chargeCurrency: 'USD',
      ctxOperatorId: null,
      procuredAtMs: Date.now(),
    });
    expect(lastEmbed().fields.find((f) => f.name === 'Operator')!.value).toBe('_none_');
  });
});

describe('notifyPaymentWatcherStuck', () => {
  it('emits red incident with cursor-age in minutes + ISO last-updated timestamp', () => {
    notifyPaymentWatcherStuck({
      cursorAgeMs: 12 * 60 * 1000,
      lastCursor: '12345-67890',
      lastUpdatedAtMs: 1_700_000_000_000,
    });
    const e = lastEmbed();
    expect(e.title).toBe('🔴 Payment Watcher Cursor Stuck');
    expect(e.color).toBe(0xe74c3c);
    expect(e.fields.find((f) => f.name === 'Cursor age (min)')!.value).toBe('12');
    expect(e.fields.find((f) => f.name === 'Last cursor')!.value).toContain('12345-67890');
    expect(e.fields.find((f) => f.name === 'Last updated')!.value).toBe(
      new Date(1_700_000_000_000).toISOString(),
    );
  });
});

describe('notifyStuckPayouts', () => {
  it('summarises pending+submitted counts + threshold + oldest age', () => {
    notifyStuckPayouts({
      rowCount: 5,
      thresholdMinutes: 10,
      oldestAgeMinutes: 18,
      pendingCount: 2,
      submittedCount: 3,
      payoutId: 'p-1',
      assetCode: 'USDLOOP',
    });
    const e = lastEmbed();
    expect(e.title).toBe('🔴 Stuck Payout Backlog Detected');
    expect(e.fields.find((f) => f.name === 'Rows')!.value).toBe('5');
    expect(e.fields.find((f) => f.name === 'Pending')!.value).toBe('2');
    expect(e.fields.find((f) => f.name === 'Submitted')!.value).toBe('3');
    expect(e.fields.find((f) => f.name === 'Oldest age (min)')!.value).toBe('18');
    expect(e.fields.find((f) => f.name === 'Example payout')!.value).toBe('`p-1`');
    expect(e.fields.find((f) => f.name === 'Example asset')!.value).toBe('USDLOOP');
  });

  it('falls back to _none_ / _unknown_ when example payout/asset are absent', () => {
    notifyStuckPayouts({
      rowCount: 0,
      thresholdMinutes: 5,
      oldestAgeMinutes: 0,
      pendingCount: 0,
      submittedCount: 0,
      payoutId: null,
      assetCode: null,
    });
    const e = lastEmbed();
    expect(e.fields.find((f) => f.name === 'Example payout')!.value).toBe('_none_');
    expect(e.fields.find((f) => f.name === 'Example asset')!.value).toBe('_unknown_');
  });
});
