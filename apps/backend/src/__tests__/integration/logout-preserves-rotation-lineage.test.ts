/**
 * COR-11 — real-postgres integration test for `logoutHandler`
 * (`auth/logout-handler.ts`).
 *
 * Refresh tokens rotate in a chain: each rotated row's
 * `replaced_by_jti` links to the token that superseded it, so a
 * stolen-token reuse can be traced through the chain (A → B → C → …).
 *
 * The bug (COR-11): logout revokes the presented token by jti through
 * `revokeRefreshToken`, which unconditionally coerced `replaced_by_jti`
 * to NULL. A logout presented with an already-rotated (mid-chain) token
 * — a stale device, or an attacker covering their tracks; `verifyLoopToken`
 * checks the SIGNATURE, not DB liveness — therefore clobbered that row's
 * rotation link and dead-ended the audit chain at the logout, so a
 * compromise could no longer be traced past it.
 *
 * These tests drive the REAL `logoutHandler` against a live `refresh_tokens`
 * chain (upstream fetch stubbed — logout swallows upstream errors and the
 * DB revoke happens before it) and pin:
 *   1. a mid-chain logout leaves `replaced_by_jti` intact (lineage
 *      traceable end-to-end) while still invalidating the token — proven
 *      RED against the overwrite, and
 *   2. a well-behaved tail logout still invalidates the live token and
 *      leaves the whole chain intact.
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * `loop_test` postgres).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { db } from '../../db/client.js';
import { refreshTokens, users } from '../../db/schema.js';
import { logoutHandler } from '../../auth/logout-handler.js';
import { signLoopToken } from '../../auth/tokens.js';
import { hashRefreshToken, type RefreshTokenRow } from '../../auth/refresh-tokens.js';

const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days, matches production
const T1 = new Date('2026-07-10T00:00:00Z');
const T2 = new Date('2026-07-11T00:00:00Z');

let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAllTables();
  // Logout best-effort revokes upstream (CTX /logout) after the local
  // revoke. Stub `fetch` so the test never touches the network — the
  // handler swallows upstream errors anyway, but a stubbed 200 keeps
  // the circuit breaker closed and the run deterministic.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

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

async function getRow(jti: string): Promise<RefreshTokenRow | undefined> {
  return db.query.refreshTokens.findFirst({ where: eq(refreshTokens.jti, jti) });
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
  const [u] = await db
    .insert(users)
    .values({ email: `cor11-${Date.now()}@test.local` })
    .returning({ id: users.id });
  const userId = u!.id;

  const jtis = { A: 'cor11-jti-A', B: 'cor11-jti-B', C: 'cor11-jti-C' };
  const mint = (jti: string): string =>
    signLoopToken({ sub: userId, email: 'cor11@test.local', typ: 'refresh', ttlSeconds: REFRESH_TTL, jti })
      .token;
  const tokens = { A: mint(jtis.A), B: mint(jtis.B), C: mint(jtis.C) };
  const expiresAt = new Date(Date.now() + REFRESH_TTL * 1000);

  await db.insert(refreshTokens).values([
    // A: rotated out, links to its successor B.
    {
      jti: jtis.A,
      userId,
      tokenHash: hashRefreshToken(tokens.A),
      expiresAt,
      revokedAt: T1,
      replacedByJti: jtis.B,
      lastUsedAt: T1,
    },
    // B: rotated out, links to its successor C.
    {
      jti: jtis.B,
      userId,
      tokenHash: hashRefreshToken(tokens.B),
      expiresAt,
      revokedAt: T2,
      replacedByJti: jtis.C,
      lastUsedAt: T2,
    },
    // C: the live tail (never rotated → no successor yet).
    {
      jti: jtis.C,
      userId,
      tokenHash: hashRefreshToken(tokens.C),
      expiresAt,
      revokedAt: null,
      replacedByJti: null,
      lastUsedAt: null,
    },
  ]);

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
