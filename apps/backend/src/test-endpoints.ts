// test-only HTTP surface — AUDIT-2-E, A2-1705
import type { Context, Hono, Next } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { config } from './config/index.js';
import { __resetRateLimitsForTests } from './middleware/rate-limit.js';
import { __resetUpstreamProbeCacheOnlyForTests } from './health.js';
import { findOrCreateUserByEmail } from './db/users.js';
import { issueTokenPair } from './auth/issue-token-pair.js';

const SECRET_HEADER = 'x-test-endpoints-secret';

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on mismatched-length buffers; lengths are not secret
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function mountTestEndpoints(app: Hono): void {
  if (config.env !== 'test') {
    return;
  }

  const secret = config.testing.endpointsSecret;
  if (!secret) {
    return;
  }

  const requireSecret = async (c: Context, next: Next): Promise<void | Response> => {
    const supplied = c.req.header(SECRET_HEADER);
    if (!supplied || !safeEqual(supplied, secret)) {
      return c.notFound();
    }
    await next();
    return undefined;
  };

  app.post('/__test__/reset', requireSecret, (c) => {
    __resetRateLimitsForTests();
    __resetUpstreamProbeCacheOnlyForTests();
    return c.json({ message: 'reset' });
  });

  // A2-1705 phase A.3: test-only loop-native session minter.
  // Bypasses OTP flow to mint real tokens for e2e harness.
  const MintBody = z.object({
    email: z.string().email().min(1).max(254),
  });
  app.post('/__test__/mint-loop-token', requireSecret, async (c) => {
    const raw = (await c.req.json().catch(() => null)) as unknown;
    const parsed = MintBody.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: 'invalid body', detail: parsed.error.format() }, 400);
    }
    const user = await findOrCreateUserByEmail(parsed.data.email);
    // NS-09: mint with current token_version for revocability
    const pair = await issueTokenPair({
      id: user.id,
      email: user.email,
      tokenVersion: user.tokenVersion,
    });
    return c.json({
      userId: user.id,
      email: user.email,
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
    });
  });
}
