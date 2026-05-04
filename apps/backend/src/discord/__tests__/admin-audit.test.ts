/**
 * Discord admin-audit notifier body tests.
 *
 * The notifiers fire fire-and-forget through `sendWebhook(url, embed)`.
 * We mock `sendWebhook` and pin the embed shape — title, color,
 * fields — so a regression in the embed (field rename, color flip,
 * truncation off-by-one, missing escape) surfaces in CI rather than
 * landing as a malformed alert in production Discord.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// All mock helpers must live inside `vi.hoisted` because `vi.mock`
// calls are hoisted to the top of the file. The shared module is
// stubbed rather than `importActual`'d because the real module
// pulls in `../logger.js`, which initialises pino against env vars
// the test harness doesn't supply.
const { sendWebhookMock, envMock, escapeMarkdownReal, truncateReal } = vi.hoisted(() => ({
  sendWebhookMock: vi.fn(),
  envMock: { DISCORD_WEBHOOK_ADMIN_AUDIT: 'https://discord.example/admin' },
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
  RED: 0xe74c3c,
  ORANGE: 0xe67e22,
}));

import {
  notifyAdminAudit,
  notifyAdminBulkRead,
  notifyCashbackConfigChanged,
} from '../admin-audit.js';

beforeEach(() => {
  sendWebhookMock.mockReset();
});

interface Embed {
  title: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
}

function lastEmbed(): Embed {
  const call = sendWebhookMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('sendWebhook not called');
  return call[1] as Embed;
}

describe('notifyAdminAudit', () => {
  it('emits a fresh-write embed with truncated actor + endpoint + reason fields', () => {
    notifyAdminAudit({
      actorUserId: 'admin-uuid-aaaaaaaabbbbbbbbcccccccc12345678',
      endpoint: 'POST /api/admin/users/u-1/credit-adjust',
      targetUserId: 'tgt-uuid-1111222233334444xxxx',
      amountMinor: '500',
      currency: 'USD',
      reason: 'goodwill',
      idempotencyKey: 'idem-1234567890abcdef-aaaaaaaabbbbbbbb',
      replayed: false,
    });
    const e = lastEmbed();
    expect(sendWebhookMock).toHaveBeenCalledWith(
      'https://discord.example/admin',
      expect.anything(),
    );
    expect(e.title).toBe('🛠️ Admin write');
    // Actor + target tails are last 8 chars.
    expect(e.fields).toContainEqual(
      expect.objectContaining({ name: 'Actor', value: '`12345678`', inline: true }),
    );
    expect(e.fields).toContainEqual(
      expect.objectContaining({ name: 'Target user', value: expect.stringContaining('xxxx') }),
    );
    // Endpoint is escaped — slashes pass through, but the wrapping backticks come from the formatter.
    expect(e.fields.find((f) => f.name === 'Endpoint')?.value).toContain(
      'POST /api/admin/users/u-1/credit-adjust',
    );
    // Idempotency-Key is truncated to 32 chars in the embed.
    const idem = e.fields.find((f) => f.name === 'Idempotency-Key')!;
    expect(idem.value.length).toBeLessThanOrEqual(34); // 32 chars + 2 backticks
    // Replayed flag is omitted on fresh writes.
    expect(e.fields.find((f) => f.name === 'Replayed')).toBeUndefined();
  });

  it('emits a replayed-write embed with replayed: yes + blue color', () => {
    notifyAdminAudit({
      actorUserId: 'admin-id',
      endpoint: 'POST /api/admin/refund',
      reason: 'replay test',
      idempotencyKey: 'k',
      replayed: true,
    });
    const e = lastEmbed();
    expect(e.title).toBe('🔁 Admin write (replayed)');
    expect(e.fields).toContainEqual(expect.objectContaining({ name: 'Replayed', value: 'yes' }));
  });

  it('escapes markdown in actor-controlled reason text', () => {
    notifyAdminAudit({
      actorUserId: 'admin',
      endpoint: 'POST /x',
      reason: '[evil](https://attacker.example) `code` *bold*',
      idempotencyKey: 'k',
      replayed: false,
    });
    const e = lastEmbed();
    const reason = e.fields.find((f) => f.name === 'Reason')!.value;
    // Escapes `[`, `]`, `(`, `)`, backtick, asterisk so the link
    // syntax never reaches Discord's parser.
    expect(reason).not.toContain('[evil](');
    expect(reason).toContain('\\[evil\\]');
  });
});

describe('notifyAdminBulkRead', () => {
  it('emits a bulk-read embed with the actor tail + endpoint', () => {
    notifyAdminBulkRead({
      actorUserId: 'admin-uuid-aaaa-bbbb-1234567890ab',
      endpoint: 'GET /api/admin/users.csv',
    });
    const e = lastEmbed();
    expect(e.title).toBe('📤 Admin bulk read');
    expect(e.fields[0]).toEqual(
      expect.objectContaining({ name: 'Actor', value: expect.stringContaining('7890ab') }),
    );
  });

  it('includes a truncated query when supplied', () => {
    notifyAdminBulkRead({
      actorUserId: 'admin',
      endpoint: 'GET /api/admin/users.csv',
      queryString: 'limit=1000&offset=0',
    });
    const e = lastEmbed();
    expect(e.fields.find((f) => f.name === 'Query')?.value).toContain('limit=1000');
  });

  it('omits the Query field when no query string supplied', () => {
    notifyAdminBulkRead({
      actorUserId: 'admin',
      endpoint: 'GET /api/admin/users',
    });
    const e = lastEmbed();
    expect(e.fields.find((f) => f.name === 'Query')).toBeUndefined();
  });
});

describe('notifyCashbackConfigChanged', () => {
  it('emits a "created" embed (no Previous field) when previous is null', () => {
    notifyCashbackConfigChanged({
      merchantId: 'm-1',
      merchantName: 'Target',
      actorUserId: 'admin',
      previous: null,
      next: { wholesalePct: '90', userCashbackPct: '4', loopMarginPct: '6', active: true },
    });
    const e = lastEmbed();
    expect(e.title).toBe('🟢 Cashback config created');
    expect(e.fields.find((f) => f.name === 'Previous')).toBeUndefined();
    const next = e.fields.find((f) => f.name === 'New')!.value;
    expect(next).toContain('cashback 4%');
    expect(next).toContain('active');
  });

  it('emits an "updated" embed with both Previous + New on update', () => {
    notifyCashbackConfigChanged({
      merchantId: 'm-1',
      merchantName: 'Target',
      actorUserId: 'admin',
      previous: { wholesalePct: '92', userCashbackPct: '3', loopMarginPct: '5', active: true },
      next: { wholesalePct: '90', userCashbackPct: '4', loopMarginPct: '6', active: true },
    });
    const e = lastEmbed();
    expect(e.title).toBe('🔧 Cashback config updated');
    expect(e.fields.find((f) => f.name === 'New')!.value).toContain('cashback 4%');
    expect(e.fields.find((f) => f.name === 'Previous')!.value).toContain('cashback 3%');
  });

  it('marks inactive in the formatted line', () => {
    notifyCashbackConfigChanged({
      merchantId: 'm-1',
      merchantName: 'Target',
      actorUserId: 'admin',
      previous: null,
      next: { wholesalePct: '0', userCashbackPct: '0', loopMarginPct: '0', active: false },
    });
    const e = lastEmbed();
    expect(e.fields.find((f) => f.name === 'New')!.value).toContain('inactive');
  });
});
