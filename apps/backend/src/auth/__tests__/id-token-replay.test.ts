import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { db, __resetDbForTests } from '../../db/client.js';
import { consumeIdToken } from '../id-token-replay.js';

// A2-566 social-login id-token replay guard
beforeEach(() => {
  __resetDbForTests();
});

describe('consumeIdToken', () => {
  it('returns true on fresh insert (no prior consumption)', async () => {
    const ok = await consumeIdToken({
      token: 'eyJhbGciOiJSUzI1NiJ9.payload.sig',
      provider: 'google',
      expSeconds: 1_700_000_000,
    });
    expect(ok).toBe(true);
    // Hash persisted, not raw token (defence-in-depth)
    const rows = await db.collection('social_id_token_uses').findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('google');
    expect(rows[0]!.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(rows[0]!.tokenHash).not.toContain('payload');
    expect(rows[0]!.expiresAt.getTime()).toBe(1_700_000_000_000);
  });

  it('returns false on a replay of the same token (unique-spec hit)', async () => {
    const args = { token: 'eyJ.replay.sig', provider: 'apple' as const, expSeconds: 1_700_000_999 };
    expect(await consumeIdToken(args)).toBe(true);
    expect(await consumeIdToken(args)).toBe(false);
    expect(await db.collection('social_id_token_uses').count()).toBe(1);
  });

  it('hashes the same token to the same value (deterministic dedup)', async () => {
    expect(await consumeIdToken({ token: 'tok', provider: 'google', expSeconds: 0 })).toBe(true);
    expect(await consumeIdToken({ token: 'tok', provider: 'google', expSeconds: 0 })).toBe(false);
  });

  it('different tokens produce different hashes (both admitted)', async () => {
    expect(await consumeIdToken({ token: 'A', provider: 'google', expSeconds: 0 })).toBe(true);
    expect(await consumeIdToken({ token: 'B', provider: 'google', expSeconds: 0 })).toBe(true);
    const rows = await db.collection('social_id_token_uses').findMany();
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tokenHash).not.toBe(rows[1]!.tokenHash);
  });

  it('rethrows DB errors (caller fails closed; attacker cannot ride store blips)', async () => {
    const uses = db.collection('social_id_token_uses');
    vi.spyOn(uses, 'insertOne').mockRejectedValueOnce(new Error('connection refused'));
    await expect(consumeIdToken({ token: 'x', provider: 'google', expSeconds: 0 })).rejects.toThrow(
      /connection refused/,
    );
  });
});
