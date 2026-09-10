// COR-11 — real-postgres integration test for `logoutHandler`
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { db, __resetDbForTests } from '../../db/client.js';
import type { RefreshTokenDoc } from '../../db/types.js';
import { logoutHandler } from '../../auth/logout-handler.js';
import { signLoopToken } from '../../auth/tokens.js';
import { hashRefreshToken } from '../../auth/refresh-tokens.js';

const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days, matches production
const T1 = new Date('2026-07-10T00:00:00Z');
const T2 = new Date('2026-07-11T00:00:00Z');

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  __resetDbForTests();
  // Stub fetch to keep circuit breaker closed and run deterministic
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

function makeCtx(body: unknown): Context {
  return {
    // No Authorization header — upstream CTX revoke is out of scope
    req: { json: async () => body, header: () => undefined },
    json: (b: unknown, status?: number) =>
      new Response(JSON.stringify(b), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

async function getRow(jti: string): Promise<RefreshTokenDoc | null> {
  return db.collection('refresh_tokens').findOne({ jti });
}

/**
 * Seeds a rotation chain A → B → C for a fresh user and returns a real,
 * signature-valid refresh JWT for each jti. A and B are the rotated-out
 * (revoked, linked) rows; C is the live tail.
 */
async function seedChain(): Promise<{
  userId: string;
  tokens: { A: string; B: string; C: string };
}> {
  const userId = randomUUID();
  const seededAt = new Date();
  await db.collection('users').insertOne({
    id: userId,
    ctxUserId: null,
    email: `cor11-${Date.now()}@test.local`,
    tokenVersion: 0,
    homeCurrency: 'USD',
    isAdmin: false,
    createdAt: seededAt,
    updatedAt: seededAt,
  });

  const jtis = { A: 'cor11-jti-A', B: 'cor11-jti-B', C: 'cor11-jti-C' };
  const mint = (jti: string): string =>
    signLoopToken({
      sub: userId,
      email: 'cor11@test.local',
      typ: 'refresh',
      ttlSeconds: REFRESH_TTL,
      jti,
    }).token;
  const tokens = { A: mint(jtis.A), B: mint(jtis.B), C: mint(jtis.C) };
  const expiresAt = new Date(Date.now() + REFRESH_TTL * 1000);

  const refreshTokensCollection = db.collection('refresh_tokens');
  // A: rotated out, links to its successor B.
  await refreshTokensCollection.insertOne({
    jti: jtis.A,
    userId,
    tokenHash: hashRefreshToken(tokens.A),
    expiresAt,
    revokedAt: T1,
    replacedByJti: jtis.B,
    lastUsedAt: T1,
    createdAt: seededAt,
  });
  // B: rotated out, links to its successor C.
  await refreshTokensCollection.insertOne({
    jti: jtis.B,
    userId,
    tokenHash: hashRefreshToken(tokens.B),
    expiresAt,
    revokedAt: T2,
    replacedByJti: jtis.C,
    lastUsedAt: T2,
    createdAt: seededAt,
  });
  // C: the live tail (never rotated → no successor yet).
  await refreshTokensCollection.insertOne({
    jti: jtis.C,
    userId,
    tokenHash: hashRefreshToken(tokens.C),
    expiresAt,
    revokedAt: null,
    replacedByJti: null,
    lastUsedAt: null,
    createdAt: seededAt,
  });

  return { userId, tokens };
}

describe('COR-11: logout preserves the refresh-token rotation-chain audit lineage', () => {
  it('mid-chain logout keeps replaced_by_jti intact (chain traceable) AND invalidates the token', async () => {
    const { tokens } = await seedChain();

    // Log out presenting token A — an already-rotated, still-signed
    // token (stale device / theft cover-up). Pre-fix this clobbers
    // A.replaced_by_jti to NULL, severing A → B → C.
    const res = await logoutHandler(makeCtx({ refreshToken: tokens.A, platform: 'web' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ message: 'Logged out' });

    const a = await getRow('cor11-jti-A');
    const b = await getRow('cor11-jti-B');
    const c = await getRow('cor11-jti-C');

    // The rotation lineage survives the logout end-to-end: A → B → C.
    // This is the assertion the overwrite breaks (A.replaced_by_jti
    // would be NULL pre-fix).
    expect(a?.replacedByJti).toBe('cor11-jti-B');
    expect(b?.replacedByJti).toBe('cor11-jti-C');

    // The logout's actual effect is preserved: the token is invalidated
    // (revoked_at set). A was already revoked by rotation and stays so.
    expect(a?.revokedAt).not.toBeNull();

    // B and C were not the logout target — untouched.
    expect(b?.revokedAt?.getTime()).toBe(T2.getTime());
    expect(c?.revokedAt).toBeNull();
  });

  it('tail logout invalidates the live token and leaves the chain intact', async () => {
    const { tokens } = await seedChain();

    // Well-behaved logout: the client presents its current (tail) token C.
    const res = await logoutHandler(makeCtx({ refreshToken: tokens.C, platform: 'web' }));
    expect(res.status).toBe(200);

    const a = await getRow('cor11-jti-A');
    const b = await getRow('cor11-jti-B');
    const c = await getRow('cor11-jti-C');

    // The live token is now invalidated.
    expect(c?.revokedAt).not.toBeNull();
    // The tail had no successor; it still has none (not spuriously linked).
    expect(c?.replacedByJti).toBeNull();

    // The rotation chain behind it is untouched and fully traceable.
    expect(a?.replacedByJti).toBe('cor11-jti-B');
    expect(b?.replacedByJti).toBe('cor11-jti-C');
  });
});
