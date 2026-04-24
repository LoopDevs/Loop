/**
 * Social-login ID-token replay guard (A2-566).
 *
 * A verified id_token from Google / Apple is replayable within its
 * provider TTL (Google: 1h, Apple: 10min) — the prior verify-only
 * path accepted signature / issuer / audience / exp but nothing else.
 * An attacker who intercepts a valid id_token could mint Loop sessions
 * as the token's subject for the rest of that window.
 *
 * Fix: one-shot consumption. Each successfully verified token is
 * recorded in `social_id_token_uses` by sha256 digest before we mint
 * the Loop session pair. Duplicate submissions hit the primary-key
 * conflict and `consumeIdToken` returns false.
 *
 * Why hash not jti: Apple historically doesn't emit `jti`, and storing
 * the token verbatim would leak claim content. sha256(token) is stable,
 * provider-agnostic, and carries no recoverable user data.
 *
 * The table's `expires_at` column carries the id_token's own `exp`
 * claim so a daily sweep worker can drop rows that are already
 * expiry-rejected upstream. Cap at 48h past exp to absorb clock skew.
 */
import { createHash } from 'node:crypto';
import { db } from '../db/client.js';
import { socialIdTokenUses } from '../db/schema.js';
import { logger } from '../logger.js';
import type { SocialProvider } from '../db/schema.js';

const log = logger.child({ component: 'id-token-replay' });

/**
 * Records `token` as consumed for `provider`. Returns:
 * - `true` when the row was inserted fresh — caller may proceed.
 * - `false` when the row already existed — caller MUST reject as a
 *   replay.
 *
 * The `expiresAt` argument is the id_token's own `exp` claim, in
 * seconds since epoch. Used only for the sweep — the uniqueness check
 * is on `tokenHash` alone.
 */
export async function consumeIdToken(args: {
  token: string;
  provider: SocialProvider;
  expSeconds: number;
}): Promise<boolean> {
  const tokenHash = createHash('sha256').update(args.token).digest('hex');
  const expiresAt = new Date(args.expSeconds * 1000);
  try {
    const inserted = await db
      .insert(socialIdTokenUses)
      .values({ tokenHash, provider: args.provider, expiresAt })
      .onConflictDoNothing({ target: socialIdTokenUses.tokenHash })
      .returning({ tokenHash: socialIdTokenUses.tokenHash });
    if (inserted.length === 0) {
      log.warn({ provider: args.provider }, 'Social id_token replay rejected');
      return false;
    }
    return true;
  } catch (err) {
    // A DB error is operational, not a replay — fail closed so an
    // attacker can't ride a transient Postgres blip into a replay
    // window. The auth handler surfaces this as a 503.
    log.error({ err, provider: args.provider }, 'id-token replay-guard DB error');
    throw err;
  }
}
