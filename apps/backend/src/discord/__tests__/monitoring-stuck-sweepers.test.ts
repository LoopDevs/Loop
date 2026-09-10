// Pin embed shapes so a regression in field naming, color, or "stuck-for-N-min" math surfaces in CI.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

const { sendWebhookMock, discordMock, escapeMarkdownReal, truncateReal } = vi.hoisted(() => ({
  sendWebhookMock: vi.fn(),
  discordMock: { monitoringWebhook: 'https://discord.example/monitoring' as string | undefined },
  escapeMarkdownReal: (v: string): string => v.replace(/([\\`*_~|>[\]()])/g, '\\$1'),
  truncateReal: (v: string, max: number): string =>
    v.length <= max ? v : `${v.slice(0, max - 1)}…`,
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        observability: { ...actual.config.observability, discord: discordMock },
      };
    },
  };
});

vi.mock('../shared.js', () => ({
  sendWebhook: (url: string | undefined, embed: unknown) => sendWebhookMock(url, embed),
  escapeMarkdown: escapeMarkdownReal,
  truncate: truncateReal,
  FIELD_VALUE_MAX: 1024,
  DESCRIPTION_MAX: 4096,
  ORANGE: 0xe67e22,
  RED: 0xe74c3c,
}));

import { notifyStuckPayouts } from '../monitoring-stuck-sweepers.js';

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
