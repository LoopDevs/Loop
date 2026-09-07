/**
 * BK-otpatomic regression (store-backed): concurrent `verify-otp` with
 * the SAME valid code must stay single-use — of two truly concurrent
 * `nativeVerifyOtpHandler` calls EXACTLY ONE succeeds (200 + a token
 * pair) and the other is rejected (401), against the real store.
 *
 * Runs under `vitest.integration.config.ts` against the ephemeral
 * in-memory document store. The security-critical steps all hit the
 * live store: the OTP seed (`createOtp`), the atomic single-use
 * consume (`tryConsumeOtp` — the `{id, consumedAt: null}` CAS
 * updateOne), the user upsert, and the `refresh_tokens` insert.
 *
 * A 2-party read barrier wraps the REAL `findLiveOtp` so BOTH requests
 * observe the row as unconsumed BEFORE either consumes it — the widest
 * possible race window, exactly the interleaving the read-then-mark bug
 * needs. This makes the property deterministic in both directions:
 *   - Pre-fix (`markOtpConsumed` — an UNCONDITIONAL update): both pass
 *     the read, both mark, both mint → two 200s + two live refresh rows.
 *     The `[200, 401]` assertion + `refresh count === 1` go RED.
 *   - Post-fix (atomic CAS): both pass the read, the conditional update
 *     lets exactly one win → one 200, one 401, one refresh row. GREEN.
 *
 * The barrier only fences the READ; the consume/mint run unfenced
 * against the real store, so the atomic guarantee itself is what's
 * under test, not a mock of it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Context } from 'hono';
import type * as OtpsModule from '../../auth/otps.js';
import { db, __resetDbForTests } from '../../db/client.js';

// A rendezvous the wrapped `findLiveOtp` parks on: the first N-1 readers
// block, and the Nth releases them all, so every reader has observed the
// pre-consume row before any consume runs. hoisted so it exists before
// the `vi.mock` factory below is applied.
const barrier = vi.hoisted(() => {
  let expected = 0;
  let parked: Array<() => void> = [];
  return {
    /** Arm the barrier for the next `n` `findLiveOtp` calls. */
    arm(n: number): void {
      expected = n;
      parked = [];
    },
    async wait(): Promise<void> {
      if (expected <= 1) return;
      await new Promise<void>((resolve) => {
        parked.push(resolve);
        if (parked.length === expected) {
          const release = parked;
          parked = [];
          expected = 0;
          for (const r of release) r();
        }
      });
    },
  };
});

// Wrap ONLY `findLiveOtp` with the barrier; everything else — crucially
// the atomic `tryConsumeOtp`, plus `createOtp` / attempt counters — falls
// through to the REAL implementation and hits the live DB.
vi.mock('../../auth/otps.js', async () => {
  const actual = await vi.importActual<typeof OtpsModule>('../../auth/otps.js');
  return {
    ...actual,
    findLiveOtp: async (args: Parameters<typeof actual.findLiveOtp>[0]) => {
      const hit = await actual.findLiveOtp(args); // real DB read
      await barrier.wait(); // park until every concurrent reader has read
      return hit;
    },
  };
});

// Imported AFTER the vi.mock above so native.ts resolves the
// barrier-wrapped otps module. `createOtp` is the real (spread) impl.
import { nativeVerifyOtpHandler } from '../../auth/native.js';
import { createOtp } from '../../auth/otps.js';

/** Minimal Hono `Context` stand-in — just the surface the handler uses. */
function makeCtx(body: unknown): Context {
  const headers: Record<string, string> = {};
  return {
    req: { json: async () => body },
    header: (k: string, v: string) => {
      headers[k] = v;
    },
    json: (b: unknown, status?: number) =>
      new Response(JSON.stringify(b), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json', ...headers },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  __resetDbForTests();
});

describe('BK-otpatomic: concurrent verify-otp single-use (real DB)', () => {
  it('two concurrent verifies with the same valid code → exactly one 200, one 401', async () => {
    const email = 'race@example.com';
    const code = '135790';
    await createOtp({ email, code });

    // Both handlers must read the live OTP before either consumes it.
    barrier.arm(2);
    const [resA, resB] = await Promise.all([
      nativeVerifyOtpHandler(makeCtx({ email, otp: code })),
      nativeVerifyOtpHandler(makeCtx({ email, otp: code })),
    ]);

    // Single-use: exactly one success, the other specifically a 401 —
    // NOT two 200s (the read-then-mark bug) and NOT a 500.
    expect([resA.status, resB.status].sort((a, b) => a - b)).toEqual([200, 401]);

    const winnerRes = resA.status === 200 ? resA : resB;
    const loserRes = resA.status === 200 ? resB : resA;
    const winnerBody = (await winnerRes.json()) as { accessToken: string; refreshToken: string };
    const loserBody = (await loserRes.json()) as { code: string };
    // Winner gets a real JWT pair; loser gets the generic unauthorized code.
    expect(winnerBody.accessToken.split('.')).toHaveLength(3);
    expect(winnerBody.refreshToken.split('.')).toHaveLength(3);
    expect(loserBody.code).toBe('UNAUTHORIZED');

    // Store invariant #1: the OTP row is consumed exactly once.
    const otpRows = await db.collection('otps').findMany({ email });
    expect(otpRows).toHaveLength(1);
    expect(otpRows[0]?.consumedAt).not.toBeNull();

    // Store invariant #2: exactly ONE session was issued — the loser
    // minted nothing. Pre-fix, both callers minted, leaving two live
    // refresh rows for the one user.
    const userRows = await db.collection('users').findMany({ email });
    expect(userRows).toHaveLength(1);
    const userId = userRows[0]!.id;
    const refreshRows = await db.collection('refresh_tokens').findMany({ userId });
    expect(refreshRows).toHaveLength(1);
  });
});
