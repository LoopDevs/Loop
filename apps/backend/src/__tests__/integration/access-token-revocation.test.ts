/**
 * NS-09 — real-postgres integration test for ACCESS-TOKEN REVOCATION.
 *
 * The gap: access tokens are 15-min, signature-only, and carry no
 * per-token DB row, so before NS-09 `verifyLoopToken` checked only the
 * signature + expiry — NOT liveness. A logout, a "sign out everywhere",
 * or a compromise event could not invalidate an already-issued,
 * still-signed access token: it stayed valid for its full TTL. (Refresh
 * tokens were already DB-revocable; the gap was the ACCESS token, and
 * the admin bearers, which ARE Loop access tokens.)
 *
 * The fix: a per-user `users.token_version` (migration 0070) that is
 *   - stamped as the `tv` claim on every minted access token,
 *   - compared against the row's CURRENT value on every authenticated
 *     request in `requireAuth`, and
 *   - bumped (atomic +1) on logout / sign-out-all / refresh-reuse.
 *
 * These tests drive the REAL enforcement point (`requireAuth`) against a
 * live `users` row and pin the security property directly:
 *   (a) a valid access token whose `tv` matches verifies OK;
 *   (b) after a bump (revoke-all AND logout), the SAME previously-valid
 *       token is REJECTED 401 — the load-bearing assertion, red against
 *       the un-enforced code (where the token stays valid);
 *   (c) a token minted AFTER the bump (carrying the new `tv`) verifies OK;
 *   (d) a legacy access token with NO `tv` claim fails closed (401).
 *
 * Runs under `vitest.integration.config.ts` (LOOP_E2E_DB=1 + a real
 * postgres). `requireAuth` is exercised through a minimal Hono-context
 * stub — the same pattern as `logout-preserves-rotation-lineage.test.ts`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';
import { ensureMigrated, truncateAllTables } from './db-test-setup.js';
import { db } from '../../db/client.js';
import { users, refreshTokens } from '../../db/schema.js';
import { requireAuth } from '../../auth/require-auth.js';
import { logoutHandler } from '../../auth/logout-handler.js';
import { signLoopToken } from '../../auth/tokens.js';
import { getUserTokenVersion } from '../../db/users.js';
import { revokeAllRefreshTokensForUser, hashRefreshToken } from '../../auth/refresh-tokens.js';

const ACCESS_TTL = 15 * 60; // 15 min, matches production
const REFRESH_TTL = 30 * 24 * 60 * 60; // 30 days

let realFetch: typeof globalThis.fetch;

beforeAll(async () => {
  await ensureMigrated();
});

beforeEach(async () => {
  await truncateAllTables();
  // logoutHandler best-effort revokes upstream (CTX /logout). Stub fetch
  // so the test never touches the network — the handler swallows upstream
  // errors anyway; a stubbed 200 keeps the circuit breaker closed.
  realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 200 })) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

interface FakeCtx {
  store: Map<string, unknown>;
  ctx: Context;
}

function makeCtx(headers: Record<string, string | undefined>): FakeCtx {
  const store = new Map<string, unknown>();
  return {
    store,
    ctx: {
      req: { header: (name: string) => headers[name] ?? headers[name.toLowerCase()] },
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      json: (b: unknown, status?: number) =>
        new Response(JSON.stringify(b), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

/** Minimal Hono-context stub carrying a JSON body — for `logoutHandler`. */
function makeBodyCtx(body: unknown): Context {
  return {
    req: { json: async () => body },
    json: (b: unknown, status?: number) =>
      new Response(JSON.stringify(b), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

/** Drives `requireAuth` with a bearer token; reports outcome + whether it passed through. */
async function runAuth(
  token: string,
): Promise<{ status: number | null; passed: boolean; kind: string | undefined }> {
  const fake = makeCtx({ Authorization: `Bearer ${token}` });
  let nextCalled = false;
  const res = await requireAuth(fake.ctx, async () => {
    nextCalled = true;
  });
  const auth = fake.store.get('auth') as { kind: string } | undefined;
  return {
    status: res instanceof Response ? res.status : null,
    passed: nextCalled,
    kind: auth?.kind,
  };
}

async function seedUser(): Promise<{ userId: string; email: string }> {
  const email = `ns09-${Date.now()}-${Math.random().toString(36).slice(2)}@test.local`;
  const [u] = await db.insert(users).values({ email }).returning({ id: users.id });
  return { userId: u!.id, email };
}

/** Mints a real, signature-valid access token carrying an explicit `tv`. */
function mintAccess(userId: string, email: string, tv: number | undefined): string {
  return signLoopToken({
    sub: userId,
    email,
    typ: 'access',
    ttlSeconds: ACCESS_TTL,
    ...(tv !== undefined ? { tv } : {}),
  }).token;
}

describe('NS-09: access tokens are revocable via users.token_version', () => {
  it('(a) a valid access token whose tv matches the row verifies OK', async () => {
    const { userId, email } = await seedUser(); // token_version defaults to 0
    const token = mintAccess(userId, email, 0);

    const out = await runAuth(token);
    expect(out.passed).toBe(true);
    expect(out.status).toBeNull();
    expect(out.kind).toBe('loop');
  });

  it('(b+c) revoke-all bumps token_version: the SAME token is rejected, a fresh one is accepted', async () => {
    const { userId, email } = await seedUser();
    const token = mintAccess(userId, email, 0);

    // Baseline: the token authorizes.
    expect((await runAuth(token)).passed).toBe(true);

    // "Sign out everywhere" / incident-response revoke bumps token_version.
    await revokeAllRefreshTokensForUser(userId);
    expect(await getUserTokenVersion(userId)).toBe(1);

    // (b) THE load-bearing property: the SAME previously-valid access
    // token — still signature-valid, still unexpired — is now REJECTED.
    const afterBump = await runAuth(token);
    expect(afterBump.passed).toBe(false);
    expect(afterBump.status).toBe(401);

    // (c) A token minted AFTER the bump carries tv=1 and verifies OK.
    const fresh = mintAccess(userId, email, 1);
    const freshOut = await runAuth(fresh);
    expect(freshOut.passed).toBe(true);
    expect(freshOut.status).toBeNull();
  });

  it('(b) logout bumps token_version so the still-live access token is rejected', async () => {
    const { userId, email } = await seedUser();
    const accessToken = mintAccess(userId, email, 0);

    // A live refresh token the client presents on logout.
    const jti = 'ns09-logout-jti';
    const refreshToken = signLoopToken({
      sub: userId,
      email,
      typ: 'refresh',
      ttlSeconds: REFRESH_TTL,
      jti,
    }).token;
    await db.insert(refreshTokens).values({
      jti,
      userId,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(Date.now() + REFRESH_TTL * 1000),
    });

    // Access token works before logout.
    expect((await runAuth(accessToken)).passed).toBe(true);

    // Log out (presenting the refresh token). This must bump token_version
    // — the whole point of NS-09: a logout invalidates the access token,
    // not just the refresh token.
    const res = await logoutHandler(makeBodyCtx({ refreshToken, platform: 'web' }));
    expect(res.status).toBe(200);
    expect(await getUserTokenVersion(userId)).toBe(1);

    // The access token minted before the logout is now rejected.
    const afterLogout = await runAuth(accessToken);
    expect(afterLogout.passed).toBe(false);
    expect(afterLogout.status).toBe(401);

    // The presented refresh token's own row was revoked too (COR-11 path
    // still intact) — the logout is a full session kill, not just a tv bump.
    const row = await db.query.refreshTokens.findFirst({ where: eq(refreshTokens.jti, jti) });
    expect(row?.revokedAt).not.toBeNull();
  });

  it('(d) a legacy access token with NO tv claim fails closed (401)', async () => {
    const { userId, email } = await seedUser(); // token_version = 0
    // Pre-NS-09 shape: valid signature, unexpired, but no `tv` claim.
    const legacy = mintAccess(userId, email, undefined);

    const out = await runAuth(legacy);
    expect(out.passed).toBe(false);
    expect(out.status).toBe(401);
  });
});
