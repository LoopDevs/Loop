/**
 * Loop-native auth handlers (ADR 013). Activated by the
 * `LOOP_AUTH_NATIVE_ENABLED` env flag; dispatchers in `handler.ts`
 * route requests here when the flag is on.
 *
 * Ships the full Loop-native trio: request-otp, verify-otp, refresh.
 * Users never see CTX; all user identity is Loop-internal.
 */
import type { Context } from 'hono';
import { logger } from '../logger.js';
import {
  findLiveOtp,
  incrementOtpAttempts,
  tryConsumeOtp,
  countRecentOtpsForEmail,
  OTP_TTL_MS,
} from './otps.js';
import {
  isEmailOtpLocked,
  registerFailedOtpAttempt,
  clearOtpAttempts,
  OTP_EMAIL_LOCKOUT_MS,
} from './otp-attempt-counter.js';
import { enqueueWalletProvisioning } from '../wallet/provisioning.js';
import { normalizeEmail, NonAsciiEmailError } from './normalize-email.js';
import { verifyLoopToken, isLoopAuthConfigured } from './tokens.js';
import { findOrCreateUserByEmail } from '../db/users.js';
import {
  findLiveRefreshToken,
  findRefreshTokenRecord,
  tryRevokeIfLive,
  revokeAllRefreshTokensForUser,
} from './refresh-tokens.js';

// A2-803 (auth slice): request-body schemas live in the shared
// `request-schemas.ts` module so both this Loop-native path and the
// CTX-proxy path (`handler.ts`) verify against the same source.
// Platform is forwarded only so the response envelope matches the
// CTX proxy's; the native path doesn't consume it today.
import { VerifyOtpBody, RefreshBody } from './request-schemas.js';

// `nativeRequestOtpHandler` (POST /api/auth/request-otp — native
// path) lives in `./native-request-otp.ts`. Re-exported here so
// the dispatcher in `auth/handler.ts` keeps importing from the
// historical `./native.js` path.
export { nativeRequestOtpHandler } from './native-request-otp.js';

const log = logger.child({ handler: 'auth-native' });

// `issueTokenPair` (and its `TokenPair` interface) lives in
// `./issue-token-pair.ts` — shared with the social-login handlers
// in `./social.ts`, which used to ship a near-identical local copy.
// Re-exported here so existing import sites against `'./native.js'`
// keep resolving.
export { issueTokenPair, type TokenPair } from './issue-token-pair.js';
import { issueTokenPair, mintTokenPair, persistMintedRefreshToken } from './issue-token-pair.js';

/**
 * POST /api/auth/verify-otp — native path.
 *
 * Consumes the OTP row (single-use), creates-or-finds the Loop user
 * by email, mints a Loop access/refresh pair, persists the refresh
 * row. Returns `{ accessToken, refreshToken }` — identical shape to
 * the CTX-proxy path so the client is agnostic.
 *
 * Wrong-code guesses bump the per-row `attempts` counter; after
 * `OTP_MAX_ATTEMPTS` the row is excluded from `findLiveOtp` and
 * further tries 401. Expired / missing rows also 401.
 *
 * B5: the authoritative brute-force ceiling is the per-EMAIL failed-
 * attempt counter (`otp-attempt-counter.ts`), checked before the code
 * comparison and incremented on every wrong guess. Once an email
 * crosses the threshold it's locked (429) regardless of how many fresh
 * codes an attacker rotates in — closing the row-rotation bypass at
 * the identity level. A successful verify clears the counter.
 */
export async function nativeVerifyOtpHandler(c: Context): Promise<Response> {
  if (!isLoopAuthConfigured()) {
    // Feature-flag-on without signing key set — refuse loudly rather
    // than silently mint unsigned tokens.
    log.error('LOOP_AUTH_NATIVE_ENABLED without LOOP_JWT_SIGNING_KEY');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Auth not configured' }, 500);
  }
  const parsed = VerifyOtpBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email and otp are required' }, 400);
  }
  let email: string;
  try {
    email = normalizeEmail(parsed.data.email);
  } catch (err) {
    if (err instanceof NonAsciiEmailError) {
      // A2-2002: same generic shape as request-otp. Verify shouldn't
      // confirm "your email looks valid but" either.
      return c.json({ code: 'VALIDATION_ERROR', message: 'email and otp are required' }, 400);
    }
    throw err;
  }

  try {
    // B5: identity-level lockout — refuse before touching any code so a
    // locked email can't keep guessing by rotating fresh OTP rows.
    if (await isEmailOtpLocked({ email })) {
      c.header('Retry-After', String(Math.ceil(OTP_EMAIL_LOCKOUT_MS / 1000)));
      return c.json(
        { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' },
        429,
      );
    }
    const hit = await findLiveOtp({ email, code: parsed.data.otp });
    if (hit === null) {
      // Bump the per-row attempts counter on any guess so brute force
      // against a specific row gets squeezed. No-ops if no live row.
      await incrementOtpAttempts({ email });
      // SEC-15: only arm the per-EMAIL lockout when the email actually has
      // a live OTP that a wrong guess could be brute-forcing. A "wrong"
      // guess against an email with NO outstanding code is not brute force
      // — there is nothing to find — so counting it toward the lockout lets
      // an UNAUTHENTICATED attacker trip B5 on any account (incl. admins)
      // just by POSTing wrong codes for an idle email, silently and for
      // free; and because admin step-up (`admin/step-up-handler.ts`) reads
      // the SAME per-email lockout, that also denies the victim's step-up.
      // Gating on live-OTP existence removes that free, silent unauth DoS
      // WITHOUT weakening brute-force protection: a wrong guess against a
      // genuinely-pending code still counts in full (the ceiling is
      // unchanged for real login/attack traffic), and an attacker who wants
      // to arm the lock must now keep a live OTP present — which only
      // `request-otp` can create (per-email 3/min + per-IP capped, and it
      // emails the victim, so the attack is no longer silent or free).
      //
      // `countRecentOtpsForEmail(windowMs = OTP_TTL_MS)` is a one-directional
      // proxy: an OTP row's `expires_at = created_at + OTP_TTL_MS`, so
      // `count === 0` means every row for this email is already expired
      // (definitely no live code) — the only case we skip. `count > 0` may
      // include consumed / attempt-maxed rows, so we still arm (fail toward
      // counting), never skipping when a real live code exists.
      const recentOtps = await countRecentOtpsForEmail({ email, windowMs: OTP_TTL_MS });
      if (recentOtps > 0) {
        // B5: the authoritative per-email ceiling. If this guess tips the
        // email over the threshold, surface the lockout immediately.
        const { locked } = await registerFailedOtpAttempt({ email });
        if (locked) {
          c.header('Retry-After', String(Math.ceil(OTP_EMAIL_LOCKOUT_MS / 1000)));
          return c.json(
            { code: 'TOO_MANY_ATTEMPTS', message: 'Too many attempts. Try again later.' },
            429,
          );
        }
      }
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    // BK-otpatomic: single-use is enforced by an ATOMIC compare-and-set,
    // not a read-then-mark. `findLiveOtp` above only READ the row as
    // unconsumed; two concurrent verifies with the same valid code both
    // pass that read. `tryConsumeOtp` flips `consumed_at` NULL → now() in
    // ONE `UPDATE ... WHERE consumed_at IS NULL RETURNING`, so exactly one
    // caller gets the row back (`won === true`) and proceeds to mint; the
    // loser gets 0 rows and must NOT issue a second pair. Mirrors the
    // refresh path's `tryRevokeIfLive` CAS (A4-098).
    const won = await tryConsumeOtp(hit.id);
    if (!won) {
      // A concurrent verify already consumed this OTP — it is now spent.
      // Surface the same generic 401 a wrong / expired / already-consumed
      // code returns, without minting tokens or clearing the counter (the
      // winner already did the latter).
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid or expired verification code' }, 401);
    }
    // B5: legitimate verify clears the email's failed-attempt counter.
    await clearOtpAttempts(email);
    const user = await findOrCreateUserByEmail(email);
    const pair = await issueTokenPair({ id: user.id, email: user.email });
    // ADR 030 Phase C1 — fire-and-forget embedded-wallet
    // provisioning. Synchronous + never throws; signup must not
    // block on Stellar or the wallet provider. Failures are picked
    // up by the provisioning sweeper with backoff.
    enqueueWalletProvisioning(user.id);
    // A2-557: strip the internal `refreshJti` field; wire contract
    // stays `{ accessToken, refreshToken }`.
    return c.json({ accessToken: pair.accessToken, refreshToken: pair.refreshToken });
  } catch (err) {
    log.error({ err, email }, 'Native verify-otp failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Verification failed' }, 500);
  }
}

/**
 * POST /api/auth/refresh — native path.
 *
 * Rotates the refresh token: verifies the JWT signature + typ, checks
 * the `refresh_tokens` row is live and hash-matches, revokes the old
 * row, writes a new pair. A reused refresh (already revoked) is a
 * strong signal of token theft — we revoke all of that user's
 * sessions defensively and reject the request.
 */
export async function nativeRefreshHandler(c: Context): Promise<Response> {
  if (!isLoopAuthConfigured()) {
    log.error('LOOP_AUTH_NATIVE_ENABLED without LOOP_JWT_SIGNING_KEY');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Auth not configured' }, 500);
  }
  const parsed = RefreshBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'refreshToken is required' }, 400);
  }

  try {
    const verified = verifyLoopToken(parsed.data.refreshToken, 'refresh');
    if (!verified.ok) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }
    const { claims } = verified;
    if (claims.jti === undefined) {
      return c.json({ code: 'UNAUTHORIZED', message: 'Refresh token missing jti' }, 401);
    }
    const row = await findLiveRefreshToken({
      jti: claims.jti,
      token: parsed.data.refreshToken,
    });
    if (row === null) {
      // A2-1608: distinguish two rejection modes:
      //   - record exists but revokedAt != null → reuse of a rotated
      //     refresh. Only an attacker presenting a previously-valid
      //     token (already rotated out) can reach this branch; the
      //     legitimate client has the successor token. Revoke the
      //     entire family so the attacker's stolen lineage dies.
      //   - record missing → forged / cleaned-up row. 401 alone.
      const record = await findRefreshTokenRecord(claims.jti);
      if (record !== null && record.revokedAt !== null) {
        log.error(
          { jti: claims.jti, sub: claims.sub, userId: record.userId },
          'Refresh-token reuse detected — revoking all refresh tokens for user',
        );
        await revokeAllRefreshTokensForUser(record.userId);
      } else {
        log.warn({ jti: claims.jti, sub: claims.sub }, 'Refresh token not live');
      }
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }

    // A4-098: concurrency-safe rotation. Two parallel refresh
    // requests with the same old token both make it past
    // findLiveRefreshToken (the row is live until SOMEONE revokes
    // it). To prevent both from issuing successors, we gate the
    // mint on a compare-and-set revoke that only succeeds for the
    // first caller. The loser short-circuits to 401 instead of
    // creating a parallel live successor lineage.
    //
    // Ordering matters: SIGN the successor pair first (so the CAS
    // can stamp `replaced_by_jti` atomically with the revoke), but
    // PERSIST the successor row only after winning the CAS. The
    // earlier shape called `issueTokenPair` — which inserts the
    // `refresh_tokens` row — before `tryRevokeIfLive`, so the
    // losing side of a concurrent rotation had already written a
    // live successor row that nothing would ever revoke (it isn't
    // the `replaced_by_jti` of any row, and the loser's 401 left
    // it behind as a live orphaned credential).
    const minted = mintTokenPair({ id: claims.sub, email: claims.email });
    const won = await tryRevokeIfLive({ jti: claims.jti, replacedByJti: minted.refreshJti });
    if (!won) {
      // Concurrent rotation lost the race. The other caller already
      // revoked the row + minted its own successor; we must not
      // emit a second live pair under the same prior jti. Nothing
      // was persisted for this loser — the signed pair above is
      // dropped on the floor. Surface a 401 — the legitimate
      // client should retry refresh; an attacker holding the same
      // prior token gets the same 401 and on the next attempt
      // trips the reuse-detection path above.
      log.warn(
        { jti: claims.jti, sub: claims.sub },
        'Refresh token rotation lost concurrent race — rejecting',
      );
      return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
    }
    // CAS won — now persist the successor row. If this write fails
    // the old token is already revoked and the successor was never
    // stored, so the client re-authenticates: fail-closed beats an
    // orphaned live credential.
    await persistMintedRefreshToken(minted);
    // Strip the internal fields before returning to the client —
    // the wire contract stays `{ accessToken, refreshToken }`.
    return c.json({ accessToken: minted.accessToken, refreshToken: minted.refreshToken });
  } catch (err) {
    log.error({ err }, 'Native refresh failed unexpectedly');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Refresh failed' }, 500);
  }
}
