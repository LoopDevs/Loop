/**
 * `POST /api/admin/users/:userId/clear-otp-lockout` (readiness-backlog
 * A5-3) — the support-incident-response lever for "user is locked out
 * of login and can't get in".
 *
 * TIER + STEP-UP DECISION (see the PR description for the full
 * reasoning): admin-tier, NOT step-up-gated. Modeled directly on the
 * B4 `revoke-sessions` precedent (`../auth/revoke-sessions-handler.ts`)
 * rather than the ADR 037 support-tier delivery-unsticking actions
 * (wallet reprovision / watcher-skip reopen / redemption re-fetch):
 * those re-drive work the customer already paid for and touch no
 * security control, whereas this action WEAKENS a brute-force defense
 * (B5) for one account — closer in kind to revoke-sessions (an
 * account-security lever) than to a delivery unstick. Kept at
 * admin-tier so a compromised or socially-engineered support session
 * can't unilaterally reopen the guess budget on an arbitrary account.
 * Not step-up-gated because, like revoke-sessions, it moves no value
 * and is self-limiting: clearing the counter doesn't grant access by
 * itself, it only lets the user try their code again, and any further
 * wrong guesses re-arm the same B5 lockout from a clean window. Unlike
 * revoke-sessions this DOES carry a required `reason` + Discord audit
 * (ADR 017-lite — the same envelope the support delivery-unsticking
 * actions use even though they move no money either) because clearing
 * a brute-force defense is a more security-relevant event than
 * signing a user out, and a reason gives an incident reviewer context
 * revoke-sessions doesn't need.
 *
 * Reuses `clearOtpAttempts` (`../auth/otp-attempt-counter.ts`) — the
 * SAME primitive a successful `verify-otp` uses to reset a user's
 * counter. No bespoke unlock path, so there's exactly one way a
 * lockout row gets cleared. Idempotent: deleting an already-clear (or
 * never-existing) counter row is a no-op success (`wasLocked: false`),
 * so a double-click or a retried request can't error.
 *
 * PER-TARGET VELOCITY CAP (A5-3 review P1): the per-IP route limit
 * (20/min) does NOT bound the "clear → guess → clear" B5-defeat loop —
 * that loop only needs ONE clear per ~60s to keep re-arming the lockout
 * just ahead of the per-IP verify-otp cap (10/min), and a compromised
 * bearer can spread its clears across several IPs all aimed at ONE
 * victim. So we ALSO cap clears PER TARGET userId in a rolling 24h
 * window (`CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY`, default 5 — a
 * locked-out legit user needs 1, occasionally 2). This is the control
 * that actually bounds the loop: it collapses the admin-assisted guess
 * ceiling from the pre-B5 ~14,400/day back to ~960 + (5 × 10) ≈
 * 1,010/day per account, restoring essentially all of B5's value even
 * under a compromised admin bearer. The count reuses the existing
 * `admin_idempotency_keys` audit rows (the path encodes the target
 * userId; a row exists only for an APPLIED clear; replays don't inflate
 * it) — no new table. Fail-CLOSED: if the count query errors we reject
 * (503) rather than allow an unbounded clear.
 *
 * SEC-clearotp: the count→check→clear sequence is made ATOMIC against a
 * concurrent distinct-idempotency-key burst by a per-target
 * transaction-scoped advisory lock (`clearLockoutTargetLockKey`) held on
 * an OUTER txn that wraps the whole guard. `withIdempotencyGuard` alone
 * serialises only same-(adminUserId, key) callers, so without this lock a
 * burst of distinct-key clears at ONE target all read the same pre-commit
 * count and every one slips past the cap. `pg_try_advisory_xact_lock`
 * (fail-closed 409 for the loser) is used, not the blocking form, so a
 * burst can't pin a pool connection each while waiting.
 *
 * KNOWN GAP — CONV-AUTH-01 (recovery vs anti-abuse, deferred): the 5/day
 * per-target cap is simultaneously the ANTI-ABUSE budget (a compromised
 * bearer's clear→guess erosion of B5) AND the RECOVERY budget (letting a
 * genuinely-locked victim back in). While an attacker can re-lock cheaply,
 * those collide: after 5 clears the victim is unrecoverable in-product for
 * the rest of the 24h. Decoupling them safely needs a signal a compromised
 * plain bearer lacks (a step-up-gated recovery override with a higher,
 * separately-audited ceiling — reversing this file's deliberate NOT-step-
 * up tier decision — or a distinct-actor/four-eyes budget), i.e. a
 * security-design decision + a route/middleware change beyond this
 * handler's scope. SEC-15 (gating the per-email lockout on live-OTP
 * existence) already raises the re-lock cost (an attacker must keep a
 * victim-visible, throttled OTP live), partially mitigating this until the
 * decoupling lands.
 */
import { createHash } from 'node:crypto';
import type { Context } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AdminClearOtpLockoutResult } from '@loop/shared';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import { otpAttemptCounters } from '../db/schema.js';
import { getUserById, type User } from '../db/users.js';
import { clearOtpAttempts } from '../auth/otp-attempt-counter.js';
import { notifyAdminAudit } from '../discord.js';
import { logger } from '../logger.js';
import { buildAuditEnvelope, type AdminAuditEnvelope } from './audit-envelope.js';
import {
  IDEMPOTENCY_KEY_MIN,
  IDEMPOTENCY_KEY_MAX,
  countAppliedActionsForPath,
  validateIdempotencyKey,
  withIdempotencyGuard,
} from './idempotency.js';

const log = logger.child({ handler: 'admin-clear-otp-lockout' });

/**
 * Max clears APPLIED to a single target userId inside
 * `CLEAR_LOCKOUT_WINDOW_MS` before further clears are rejected. Default
 * 5 — generous for the "fat-fingered the code" case (a legit user needs
 * 1, occasionally 2), tight enough that the clear→guess loop can't
 * meaningfully erode B5's ceiling. A code constant (not an env var) to
 * keep the surface small; promote to env if operators ever need to tune
 * it live.
 */
export const CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY = 5;

/**
 * Rolling window for the per-target cap. Kept at 24h to match
 * `IDEMPOTENCY_TTL_HOURS` — the `admin_idempotency_keys` rows the count
 * reads are swept at that TTL, so a longer window would silently miss
 * reaped rows. Equal is safe: the effective window can only be
 * shorter-or-equal, never looser.
 */
export const CLEAR_LOCKOUT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Thrown from inside the idempotency guard when the per-target cap is hit → 429 (no snapshot stored). */
class ClearLockoutRateExceededError extends Error {
  constructor(readonly priorClears: number) {
    super(`clear-otp-lockout per-target cap reached (${priorClears})`);
    this.name = 'ClearLockoutRateExceededError';
  }
}

/**
 * SEC-clearotp: thrown when the per-target advisory lock is already held
 * by a concurrent clear for the SAME target → 409, fail-closed (this
 * request performs no clear). See the lock rationale where the guard is
 * invoked.
 */
class ClearLockoutConcurrentError extends Error {
  constructor() {
    super('clear-otp-lockout concurrent request for the same target');
    this.name = 'ClearLockoutConcurrentError';
  }
}

/**
 * SEC-clearotp: transaction-scoped advisory-lock key that serialises all
 * clears aimed at ONE target userId, so the per-target velocity cap's
 * count→check→clear→snapshot sequence is atomic across concurrent
 * requests with DISTINCT idempotency keys (which the guard's own
 * (adminUserId, key) lock does NOT serialise). Same 8-byte-of-SHA-256 →
 * signed-bigint derivation as `idempotencyLockKey` /
 * `adjustmentCapLockKey`; keyed on the target so distinct targets never
 * contend.
 */
export function clearLockoutTargetLockKey(userId: string): bigint {
  const digest = createHash('sha256').update(`clear-otp-lockout:${userId}`).digest();
  const raw =
    (BigInt(digest[0]!) << 56n) |
    (BigInt(digest[1]!) << 48n) |
    (BigInt(digest[2]!) << 40n) |
    (BigInt(digest[3]!) << 32n) |
    (BigInt(digest[4]!) << 24n) |
    (BigInt(digest[5]!) << 16n) |
    (BigInt(digest[6]!) << 8n) |
    BigInt(digest[7]!);
  return BigInt.asIntN(64, raw);
}

/** Thrown when the per-target COUNT query itself fails → 503, fail-closed (no clear performed). */
class ClearLockoutRateCheckUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super('clear-otp-lockout rate-check query failed');
    this.name = 'ClearLockoutRateCheckUnavailableError';
  }
}

export async function adminClearOtpLockoutHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || !UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }
  const idempotencyKey = c.req.header('idempotency-key');
  if (!validateIdempotencyKey(idempotencyKey)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: `Idempotency-Key header required (${IDEMPOTENCY_KEY_MIN}-${IDEMPOTENCY_KEY_MAX} chars)`,
      },
      400,
    );
  }
  const actor = c.get('user') as User | undefined;
  if (actor === undefined) {
    return c.json({ code: 'UNAUTHORIZED', message: 'Admin context missing' }, 401);
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON' }, 400);
  }
  const reason =
    body !== null && typeof body === 'object' ? (body as Record<string, unknown>)['reason'] : null;
  if (typeof reason !== 'string' || reason.length < 2 || reason.length > 500) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'reason must be 2-500 chars' }, 400);
  }

  // Pre-classify outside the guard so a bad userId never burns an
  // idempotency snapshot.
  let target;
  try {
    target = await getUserById(userId);
  } catch (err) {
    log.error({ err, userId }, 'Clear-otp-lockout target lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to resolve target user' }, 500);
  }
  if (target === null) {
    return c.json({ code: 'USER_NOT_FOUND', message: 'User not found' }, 404);
  }
  const targetEmail = target.email;
  const clearPath = `/api/admin/users/${userId}/clear-otp-lockout`;

  let guardResult: Awaited<ReturnType<typeof withIdempotencyGuard>>;
  try {
    guardResult = await db.transaction(async (outerTx) => {
      // SEC-clearotp: the per-target velocity cap below (count → check →
      // clear) is NOT atomic on its own. `withIdempotencyGuard` serialises
      // only on (adminUserId, idempotency-key), so a BURST of concurrent
      // requests with DISTINCT keys aimed at the SAME target all read the
      // same prior-clear count (none has committed its idempotency row yet)
      // and every one passes the cap — the 5/day ceiling is bypassed by the
      // width of the burst. Serialise per-TARGET with a transaction-scoped
      // advisory lock that spans the WHOLE guard (count → clear → snapshot
      // insert), matching the credit-adjustment daily-cap pattern
      // (`credits/adjustments.ts`) and the watchdog single-flight
      // (`payments/stuck-payout-watchdog.ts`). The lock lives on THIS outer
      // txn — which strictly contains the guard's own txn — so the next
      // caller for the same target counts only AFTER this caller's
      // idempotency row has committed (a lock released inside the guard
      // would free too early and leave the race open).
      //
      // `pg_try_advisory_xact_lock` (NOT the blocking form): a concurrent
      // burst must not pin a pool connection each while waiting on the
      // lock — a loser returns 409 immediately (fail-closed: no clear, no
      // bypass, no burned snapshot) and the client retries. Legitimate use
      // (one support agent, one request) never contends.
      const lockResult = await outerTx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${clearLockoutTargetLockKey(userId)}) AS locked`,
      );
      const lockRows = Array.isArray(lockResult)
        ? (lockResult as Array<{ locked: boolean }>)
        : ((lockResult as { rows?: Array<{ locked: boolean }> }).rows ?? []);
      if (lockRows[0]?.locked !== true) {
        throw new ClearLockoutConcurrentError();
      }
      return await withIdempotencyGuard(
        {
          adminUserId: actor.id,
          key: idempotencyKey,
          method: 'POST',
          path: clearPath,
        },
        async () => {
          // PER-TARGET velocity cap (review P1) — checked BEFORE the clear
          // so a capped request never mutates the counter. Runs inside the
          // guard's doWrite (so a REPLAY of an already-applied clear skips
          // it entirely) but on the global `db` connection, so it counts
          // only PRIOR committed clears for this target — not this
          // request's own not-yet-stored row. FAIL-CLOSED: a count-query
          // error rejects (503) rather than allowing an uncounted clear.
          // SEC-clearotp: this count→check→clear is made atomic against a
          // concurrent distinct-key burst by the per-target advisory lock
          // held on the enclosing `outerTx`.
          let priorClears: number;
          try {
            priorClears = await countAppliedActionsForPath({
              path: clearPath,
              windowMs: CLEAR_LOCKOUT_WINDOW_MS,
            });
          } catch (err) {
            throw new ClearLockoutRateCheckUnavailableError(err);
          }
          if (priorClears >= CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY) {
            throw new ClearLockoutRateExceededError(priorClears);
          }

          const [lockRow] = await db
            .select({ lockedUntil: otpAttemptCounters.lockedUntil })
            .from(otpAttemptCounters)
            .where(eq(otpAttemptCounters.email, targetEmail))
            .limit(1);
          const wasLocked =
            lockRow?.lockedUntil !== null &&
            lockRow?.lockedUntil !== undefined &&
            lockRow.lockedUntil.getTime() > Date.now();

          // B5: the SAME clear primitive a successful verify-otp uses —
          // no bespoke unlock path.
          await clearOtpAttempts(targetEmail);

          const result: AdminClearOtpLockoutResult = { userId, wasLocked, cleared: true };
          const envelope: AdminAuditEnvelope<AdminClearOtpLockoutResult> = buildAuditEnvelope({
            result,
            actor,
            idempotencyKey,
            appliedAt: new Date(),
            replayed: false,
          });
          return { status: 200, body: envelope as unknown as Record<string, unknown> };
        },
      );
    });
  } catch (err) {
    // The cap rejection + fail-closed count error are thrown from inside
    // the guard's doWrite, and the concurrent-lock rejection from the
    // outer txn — none stores a snapshot (all roll back), so a later retry
    // re-evaluates against a fresh count.
    if (err instanceof ClearLockoutConcurrentError) {
      // SEC-clearotp: another clear for this SAME target holds the
      // per-target advisory lock. Fail closed (no clear performed) so a
      // distinct-idempotency-key burst can't slip extra clears past the
      // per-target cap; a legitimate caller simply retries.
      log.warn(
        { userId, adminUserId: actor.id },
        'A5-3: concurrent clear-otp-lockout for the same target — rejecting the racing request',
      );
      return c.json(
        {
          code: 'OTP_LOCKOUT_CLEAR_CONCURRENT',
          message:
            'Another clear for this account is in progress; no change was made. Please retry.',
        },
        409,
      );
    }
    if (err instanceof ClearLockoutRateExceededError) {
      log.warn(
        { userId, adminUserId: actor.id, priorClears: err.priorClears },
        'A5-3: clear-otp-lockout per-target cap reached — rejecting',
      );
      return c.json(
        {
          code: 'OTP_LOCKOUT_CLEAR_RATE_EXCEEDED',
          message: `This account's OTP lockout has already been cleared ${CLEAR_LOCKOUT_MAX_PER_TARGET_PER_DAY} times in the last 24h — refusing further clears. Escalate if a legitimate user is still locked out.`,
        },
        429,
      );
    }
    if (err instanceof ClearLockoutRateCheckUnavailableError) {
      // FAIL CLOSED: could not verify the per-target rate, so we did NOT
      // clear. A support agent can retry; an attacker gets no free pass.
      log.error(
        { err: err.cause, userId, adminUserId: actor.id },
        'A5-3: clear-otp-lockout rate-check query failed — failing closed',
      );
      return c.json(
        {
          code: 'OTP_LOCKOUT_CLEAR_RATE_CHECK_UNAVAILABLE',
          message: 'Could not verify the clear-rate limit; no change was made. Please retry.',
        },
        503,
      );
    }
    log.error({ err, userId, actorUserId: actor.id }, 'Clear OTP lockout failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to clear OTP lockout' }, 500);
  }

  if (guardResult.status === 200) {
    log.warn(
      { userId, adminUserId: actor.id, replayed: guardResult.replayed },
      'A5-3: admin cleared OTP lockout for user (incident response)',
    );
    notifyAdminAudit({
      actorUserId: actor.id,
      endpoint: `POST /api/admin/users/${userId}/clear-otp-lockout`,
      targetUserId: userId,
      reason,
      idempotencyKey,
      replayed: guardResult.replayed,
    });
  }

  return c.json(guardResult.body, guardResult.status as 200 | 500);
}
