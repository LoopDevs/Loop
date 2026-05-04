/**
 * `notifyAssetDrift` / `notifyAssetDriftRecovered` body tests.
 * Pins title / color / direction-flip / field set so a regression
 * surfaces in CI rather than landing as a malformed alert in
 * production Discord.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendWebhookMock, envMock, escapeMarkdownReal } = vi.hoisted(() => ({
  sendWebhookMock: vi.fn(),
  envMock: { DISCORD_WEBHOOK_MONITORING: 'https://discord.example/monitoring' },
  escapeMarkdownReal: (v: string): string => v.replace(/([\\`*_~|>[\]()])/g, '\\$1'),
}));

vi.mock('../../env.js', () => ({
  get env() {
    return envMock;
  },
}));

vi.mock('../shared.js', () => ({
  sendWebhook: (url: string | undefined, embed: unknown) => sendWebhookMock(url, embed),
  escapeMarkdown: escapeMarkdownReal,
  GREEN: 0x2ecc71,
  ORANGE: 0xe67e22,
}));

import { notifyAssetDrift, notifyAssetDriftRecovered } from '../monitoring-asset-drift.js';

beforeEach(() => sendWebhookMock.mockReset());

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

describe('notifyAssetDrift', () => {
  it('reports "Over-minted" when drift is positive (issuer leaked supply)', () => {
    notifyAssetDrift({
      assetCode: 'USDLOOP',
      driftStroops: '5000000',
      thresholdStroops: '1000000',
      onChainStroops: '50000000',
      ledgerLiabilityMinor: '450',
    });
    const e = lastEmbed();
    expect(e.title).toBe('⚠️ Asset Drift Exceeded Threshold');
    expect(e.description).toContain('Over-minted');
    expect(e.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Asset', value: '`USDLOOP`' }),
        expect.objectContaining({ name: 'Drift (stroops)', value: '5000000' }),
        expect.objectContaining({ name: 'Threshold (stroops)', value: '1000000' }),
        expect.objectContaining({ name: 'On-chain (stroops)', value: '50000000' }),
        expect.objectContaining({ name: 'Ledger (minor)', value: '450' }),
      ]),
    );
  });

  it('reports "Settlement backlog" when drift is negative (off-chain ahead of on-chain)', () => {
    notifyAssetDrift({
      assetCode: 'GBPLOOP',
      driftStroops: '-9000000',
      thresholdStroops: '1000000',
      onChainStroops: '0',
      ledgerLiabilityMinor: '90',
    });
    expect(lastEmbed().description).toContain('Settlement backlog');
  });
});

describe('notifyAssetDriftRecovered', () => {
  it('emits the closed-incident embed with green color + recovery title', () => {
    notifyAssetDriftRecovered({
      assetCode: 'EURLOOP',
      driftStroops: '100',
      thresholdStroops: '1000000',
    });
    const e = lastEmbed();
    expect(e.title).toBe('🟢 Asset Drift Recovered');
    expect(e.color).toBe(0x2ecc71);
    expect(e.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Asset', value: '`EURLOOP`' }),
        expect.objectContaining({ name: 'Drift (stroops)', value: '100' }),
      ]),
    );
  });
});
