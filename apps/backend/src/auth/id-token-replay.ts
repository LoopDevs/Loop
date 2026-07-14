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
 * claim. `purgeExpiredIdTokenUses` (AGT-06) is the retention sweep the
 * line above always promised — scheduled by the shared auth-row purge
 * worker (`auth-row-purge.ts`) alongside the `otps` / `refresh_tokens`
 * sweeps — dropping rows whose exp is older than the auth-row retention
 * grace (30d by default). That grace dwarfs any clock-skew window, so
 * the sweep can never drop a row whose token is still verify-acceptable
 * (see the function's safety note).
 */
import { createHash } from 'node:crypto';
import { lt } from 'drizzle-orm';
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

/**
 * AGT-06: retention sweep for `social_id_token_uses`. Deletes rows
 * whose `expires_at` (the id_token's own `exp` claim) is older than
 * `now - retentionMs`, and returns the number deleted. Mirrors the
 * sibling `purgeExpiredOtps` shape so the shared auth-row purge worker
 * can drive it with the same retention grace.
 *
 * Safety — this NEVER deletes a row still needed for replay protection.
 * A row is only load-bearing while `verifyIdToken` could still accept
 * the token. That verify path (`id-token-verify-with-key.ts`, hand-rolled
 * over node:crypto) rejects a token once `exp + leeway < now`, where
 * `leeway` defaults to 60s — so a token is verify-acceptable for at most
 * ~60s past its `exp`, after which its row can never gate a replay again.
 * The `retentionMs` grace keeps rows far longer still (the shared auth-row
 * retention, `LOOP_AUTH_ROW_RETENTION_DAYS`, default 30d, floor 1d) — at
 * least ~1 day vs a 60s acceptance window, orders of magnitude of margin —
 * so a row whose token is still verify-acceptable is never in range of the
 * `now - retentionMs` delete cutoff. Deleting a still-valid row would
 * re-open the replay window; the grace makes that impossible.
 *
 * DELETE-only, idempotent, and cross-instance safe: a pure
 * `DELETE ... WHERE expires_at < cutoff` with no SELECT-then-mutate gap.
 * Two machines running it at once just contend on row locks for the
 * same dead rows, and a re-run with nothing eligible deletes zero. Uses
 * the `social_id_token_uses_expires_at_idx` index for the range scan.
 */
export async function purgeExpiredIdTokenUses(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  const deleted = await db
    .delete(socialIdTokenUses)
    .where(lt(socialIdTokenUses.expiresAt, cutoff))
    .returning({ tokenHash: socialIdTokenUses.tokenHash });
  return deleted.length;
}
