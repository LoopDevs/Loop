// A4-098: concurrent refresh rotation — CAS race window via barrier

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import type { Context } from 'hono';

interface StoreRow {
  jti: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  replacedByJti: string | null;
}

const { jwtState } = vi.hoisted(() => ({
  jwtState: {
    hs256: {
      current: 'jwt-test-signing-key-32-chars-min!!' as string | undefined,
      previous: undefined as string | undefined,
    },
    rs256: {
      current: undefined as string | undefined,
      previous: undefined as string | undefined,
    },
  },
}));

vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        auth: {
          ...actual.config.auth,
          native: { ...actual.config.auth.native, enabled: true, jwt: jwtState },
        },
      };
    },
  };
});

const fake = vi.hoisted(() => {
  const rows = new Map<string, StoreRow>();
  const hash = (token: string): string => `hashed:${token}`;

  let expectedReaders = 0;
  let parked: Array<() => void> = [];
  return {
    rows,
    hash,
    setReadBarrier(n: number): void {
      expectedReaders = n;
      parked = [];
    },
    arriveAndWait(): Promise<void> {
      if (expectedReaders <= 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        parked.push(resolve);
        if (parked.length === expectedReaders) {
          const release = parked;
          parked = [];
          expectedReaders = 0;
          for (const r of release) r();
        }
      });
    },
    reset(): void {
      rows.clear();
      expectedReaders = 0;
      parked = [];
    },
  };
});

vi.mock('../refresh-tokens.js', () => ({
  hashRefreshToken: (token: string) => fake.hash(token),
  recordRefreshToken: async (args: {
    jti: string;
    userId: string;
    token: string;
    expiresAt: Date;
  }): Promise<void> => {
    fake.rows.set(args.jti, {
      jti: args.jti,
      userId: args.userId,
      tokenHash: fake.hash(args.token),
      expiresAt: args.expiresAt,
      revokedAt: null,
      replacedByJti: null,
    });
  },
  findLiveRefreshToken: async (args: { jti: string; token: string }): Promise<StoreRow | null> => {
    const row = fake.rows.get(args.jti);
    // Snapshot liveness BEFORE parking on the barrier, so every
    // concurrent reader observes the pre-revoke world.
    const live =
      row !== undefined &&
      row.revokedAt === null &&
      row.expiresAt.getTime() > Date.now() &&
      row.tokenHash === fake.hash(args.token);
    const snapshot = live && row !== undefined ? { ...row } : null;
    await fake.arriveAndWait();
    return snapshot;
  },
  findRefreshTokenRecord: async (jti: string): Promise<StoreRow | null> =>
    fake.rows.get(jti) ?? null,
  // Same contract as the real conditional UPDATE: flips the row only
  // if it is still un-revoked, reporting whether THIS call did it.
  tryRevokeIfLive: async (args: { jti: string; replacedByJti?: string }): Promise<boolean> => {
    const row = fake.rows.get(args.jti);
    if (row === undefined || row.revokedAt !== null) return false;
    row.revokedAt = new Date();
    row.replacedByJti = args.replacedByJti ?? null;
    return true;
  },
  revokeRefreshToken: async (args: { jti: string; replacedByJti?: string }): Promise<void> => {
    const row = fake.rows.get(args.jti);
    if (row === undefined) return;
    row.revokedAt = new Date();
    row.replacedByJti = args.replacedByJti ?? null;
  },
  revokeAllRefreshTokensForUser: async (userId: string): Promise<void> => {
    for (const row of fake.rows.values()) {
      if (row.userId === userId && row.revokedAt === null) row.revokedAt = new Date();
    }
  },
}));
// NS-09: the refresh handler reads the user's current token_version to
// stamp the rotated access token. This suite is about the refresh-row
// CAS, not token_version — return a fixed 0 so the rotation mints a
// well-formed token without a live DB.
vi.mock('../../db/users.js', () => ({
  getUserTokenVersion: async (): Promise<number> => 0,
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

import { nativeRefreshHandler } from '../native.js';
import { signLoopToken } from '../tokens.js';

function makeCtx(body: unknown): Context {
  return {
    req: { json: async () => body },
    json: (b: unknown, status?: number) =>
      new Response(JSON.stringify(b), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  fake.reset();
});

describe('A4-098: concurrent refresh rotation against a stateful store', () => {
  it('two concurrent refreshes with the same token: exactly one wins and no orphaned live row remains', async () => {
    const { token, claims } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    expect(claims.jti).toBeDefined();
    const oldJti = claims.jti as string;
    fake.rows.set(oldJti, {
      jti: oldJti,
      userId: 'user-1',
      tokenHash: fake.hash(token),
      expiresAt: new Date(claims.exp * 1000),
      revokedAt: null,
      replacedByJti: null,
    });

    fake.setReadBarrier(2);
    const [resA, resB] = await Promise.all([
      nativeRefreshHandler(makeCtx({ refreshToken: token })),
      nativeRefreshHandler(makeCtx({ refreshToken: token })),
    ]);

    expect([resA.status, resB.status].sort()).toEqual([200, 401]);
    const winnerRes = resA.status === 200 ? resA : resB;
    const loserRes = resA.status === 200 ? resB : resA;
    const winnerBody = (await winnerRes.json()) as { accessToken: string; refreshToken: string };
    const loserBody = (await loserRes.json()) as { code: string };
    expect(loserBody.code).toBe('UNAUTHORIZED');

    // Pre-fix, the loser's pre-CAS insert left a third row here, live and orphaned (no revocation path).
    const allRows = [...fake.rows.values()];
    expect(allRows).toHaveLength(2);
    const liveRows = allRows.filter((row) => row.revokedAt === null);
    expect(liveRows).toHaveLength(1);

    const original = fake.rows.get(oldJti) as StoreRow;
    expect(original.revokedAt).not.toBeNull();
    const successor = liveRows[0] as StoreRow;
    expect(original.replacedByJti).toBe(successor.jti);
    expect(successor.tokenHash).toBe(fake.hash(winnerBody.refreshToken));
    expect(successor.userId).toBe('user-1');
  });

  it('losing the race does not trip the family-wide revoke (reuse detection stays for genuine reuse)', async () => {
    const { token, claims } = signLoopToken({
      sub: 'user-1',
      email: 'a@b.com',
      typ: 'refresh',
      ttlSeconds: 300,
    });
    const oldJti = claims.jti as string;
    fake.rows.set(oldJti, {
      jti: oldJti,
      userId: 'user-1',
      tokenHash: fake.hash(token),
      expiresAt: new Date(claims.exp * 1000),
      revokedAt: null,
      replacedByJti: null,
    });

    fake.setReadBarrier(2);
    await Promise.all([
      nativeRefreshHandler(makeCtx({ refreshToken: token })),
      nativeRefreshHandler(makeCtx({ refreshToken: token })),
    ]);
    // The winner's successor must still be live — a race-loser 401
    // must not have escalated into revokeAllRefreshTokensForUser.
    expect([...fake.rows.values()].filter((row) => row.revokedAt === null)).toHaveLength(1);

    // But a LATER replay of the rotated-out token (post-race, no
    // barrier) is genuine reuse: A2-1608 revokes the whole family.
    const replay = await nativeRefreshHandler(makeCtx({ refreshToken: token }));
    expect(replay.status).toBe(401);
    expect([...fake.rows.values()].filter((row) => row.revokedAt === null)).toHaveLength(0);
  });
});
