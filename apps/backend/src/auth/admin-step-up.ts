/**
 * Admin step-up auth (ADR 028, A4-063).
 *
 * Mints + verifies the short-lived (5-minute) `X-Admin-Step-Up`
 * JWT that gates destructive admin endpoints — credit-adjust,
 * emissions, payout retry. Sits beside `auth/tokens.ts` (which
 * mints the bearer access + refresh tokens) but uses a SEPARATE
 * signing key so a `LOOP_JWT_SIGNING_KEY` compromise doesn't widen
 * to step-up.
 *
 * ISSUANCE is stateless — no DB row per issued token; the 5-minute
 * TTL is enforced by the `exp` claim. Verification accepts either
 * `LOOP_ADMIN_STEP_UP_SIGNING_KEY` or
 * `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` so a rotation overlaps
 * for the TTL without a flag-day.
 *
 * SEC-02-stepup (auth privilege): the stateless `exp` is not the only
 * bound. `consumeAdminStepUpToken` is the DB-backed, security-
 * authoritative check a destructive write uses: it binds the token to
 * a SINGLE action-class (no wildcard bypass) and records the token's
 * `jti` in `admin_step_up_consumptions` atomically so the token is
 * SINGLE-USE — a token minted for "queue emission" can neither be
 * replayed for a refund nor reused after it's consumed. `signAdmin…`
 * therefore stamps a unique `jti` on every minted token, and the
 * middleware (`admin-step-up-middleware.ts`) consumes rather than
 * merely verifies.
 *
 * Claim shape diverges from access/refresh tokens by intent:
 * `purpose: 'admin-step-up'` + `aud: 'admin-write'` make a stolen
 * step-up token unusable as a bearer token (the bearer-verifier
 * checks `aud === 'loop-clients'` which doesn't match) and a
 * stolen access token unusable as a step-up (the step-up verifier
 * checks `purpose === 'admin-step-up'`).
 *
 * CF-08 (cold audit 2026-06-15): the token also carries a `scope`
 * claim binding it to an action class. A token minted for a
 * *specific* action (e.g. `'refund'`) cannot be replayed against a
 * *different* destructive write.
 *
 * SEC-02-stepup tightened CF-08: the `'admin-write'` wildcard scope is
 * `signAdminStepUpToken`'s issuance DEFAULT (so a mint that omits a
 * scope still produces a well-formed token), but `consumeAdminStepUp
 * Token` — the authoritative gate — REJECTS a wildcard against a
 * concrete action (`scope_mismatch`). The old "one wildcard token,
 * any write" escape hatch WAS the all-class privilege this finding
 * removes; every live mint now requests a concrete class.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { lt } from 'drizzle-orm';
import { env } from '../env.js';
import { db } from '../db/client.js';
import { adminStepUpConsumptions } from '../db/schema.js';

/**
 * 5 minutes — short enough that a stolen token can't be used for a
 * meaningful destructive spree, long enough that an admin doesn't
 * re-auth between every line of a 20-row CSV import.
 */
export const ADMIN_STEP_UP_TTL_SECONDS = 5 * 60;

const STEP_UP_PURPOSE = 'admin-step-up';
const STEP_UP_AUDIENCE = 'admin-write';
const STEP_UP_ISSUER = 'loop-api';

/**
 * CF-08: action-class scopes a step-up token can be bound to. The
 * wildcard `'admin-write'` (the default at mint time) satisfies every
 * gate — that's the backward-safe behaviour the web client relies on
 * today (it mints one generic token and replays it across writes). A
 * narrower scope (`'credit-adjustment'` / `'refund'` / `'withdrawal'`
 * / `'emission'` / `'payout-retry'` / `'payout-compensation'` /
 * `'home-currency'` / `'operator-float'` / `'staff-role-grant'` /
 * `'staff-role-revoke'` / `'order-redrive'` / `'order-refund'` /
 * `'vault-redrive'`)
 * is opt-in and binds the token to that single class — the gate
 * middleware rejects it on any other class with `STEP_UP_PURPOSE_MISMATCH`.
 */
export const STEP_UP_SCOPE_WILDCARD = 'admin-write';
export const STEP_UP_SCOPES = [
  STEP_UP_SCOPE_WILDCARD,
  'credit-adjustment',
  'refund',
  'withdrawal',
  'emission',
  'payout-retry',
  'payout-compensation',
  'home-currency',
  'operator-float',
  'staff-role-grant',
  'staff-role-revoke',
  // Hardening B1 review finding (2026-07 plan): the cashback-config
  // upsert sets FUTURE emission rates (orders stamp the split at
  // creation from this table), so it is squarely the stolen-bearer
  // threat ADR 028 exists for — gate it like the other money writes.
  'cashback-config',
  // Hardening A6: the late-deposit refund submits an outbound Stellar
  // payment from the operator account to the deposit's sender — a
  // captured bearer alone must not be able to drain the operator to
  // attacker-chosen deposits.
  'deposit-refund',
  // A5-1: re-driving a stuck order re-runs `procureOne`, which can
  // submit a real outbound Stellar payment to CTX (`payCtxOrder`) — a
  // captured bearer alone must not be able to trigger that.
  'order-redrive',
  // A5-4: the order-bound admin refund can submit a real outbound
  // Stellar refund-to-sender (xlm/usdc) or credit a mirror balance —
  // and, for a FULFILLED order, is the compensating control for the
  // operator-accepted code-unused-attestation double-spend risk. A
  // captured bearer alone must not be able to trigger either.
  'order-refund',
  // ADR 031 V7: re-driving a failed/stuck vault emission or redemption
  // row re-enters a state machine that can submit real outbound
  // Soroban deposit/transfer/withdraw calls (vault-emissions.ts /
  // vault-redemptions.ts) — the same class of risk as order-redrive
  // and payout-retry. A captured bearer alone must not be able to
  // trigger either.
  'vault-redrive',
] as const;
export type AdminStepUpScope = (typeof STEP_UP_SCOPES)[number];

export function isAdminStepUpScope(s: unknown): s is AdminStepUpScope {
  return typeof s === 'string' && (STEP_UP_SCOPES as readonly string[]).includes(s);
}

export interface AdminStepUpClaims {
  /** Admin user id — must match the bearer access token's `sub` at the gate. */
  sub: string;
  /** Admin email at the time the step-up was issued. */
  email: string;
  /** Fixed string `'admin-step-up'`; rejects stolen access/refresh tokens. */
  purpose: typeof STEP_UP_PURPOSE;
  /** Fixed string `'admin-write'`; rejects tokens minted for other surfaces. */
  aud: typeof STEP_UP_AUDIENCE;
  iss: typeof STEP_UP_ISSUER;
  /**
   * CF-08 action-class binding. `'admin-write'` is the wildcard that
   * satisfies every gate (backward-safe default); a narrower value
   * binds the token to a single destructive-write class.
   */
  scope: AdminStepUpScope;
  /**
   * SEC-02-stepup: per-token unique id (a v4 UUID) — the single-use
   * key `consumeAdminStepUpToken` records atomically so a token can't
   * be replayed after it's consumed. Optional on the wire for
   * backward-safety: a legacy token minted before this claim existed
   * verifies with `jti` absent, and the consume path fails such a
   * token closed (`not_consumable`) rather than treating it as
   * unlimited-use.
   */
  jti?: string;
  iat: number;
  exp: number;
}

export interface SignAdminStepUpOptions {
  sub: string;
  email: string;
  /**
   * CF-08: action class this token is minted for. Defaults to the
   * wildcard `'admin-write'` so a scope-less mint still produces a
   * well-formed token — but SEC-02-stepup's `consumeAdminStepUpToken`
   * rejects a wildcard against a concrete gate, so every live mint
   * passes a narrower scope. Pass one to bind the token to a class.
   */
  scope?: AdminStepUpScope;
  /**
   * SEC-02-stepup: override the single-use `jti`. Defaults to a fresh
   * v4 UUID; a test may pin it to assert single-use consumption.
   */
  jti?: string;
  /** Override `now` for tests; seconds since epoch. */
  now?: number;
  /** Override TTL for tests; defaults to ADMIN_STEP_UP_TTL_SECONDS. */
  ttlSeconds?: number;
}

export type AdminStepUpVerifyReason =
  | 'malformed'
  | 'bad_signature'
  | 'expired'
  | 'wrong_purpose'
  | 'wrong_audience'
  | 'wrong_issuer'
  | 'not_configured';

export type AdminStepUpVerifyResult =
  | { ok: true; claims: AdminStepUpClaims }
  | { ok: false; reason: AdminStepUpVerifyReason };

/**
 * SEC-02-stepup: reasons `consumeAdminStepUpToken` can reject. Extends
 * the stateless verify reasons with the authorisation properties this
 * finding adds:
 *   - `scope_mismatch`   — the token was minted for a DIFFERENT
 *     action-class than the gate guards (no wildcard bypass).
 *   - `already_consumed` — the token has been used once already
 *     (single-use).
 *   - `not_consumable`   — the token carries no `jti`, so single-use
 *     can't be tracked; fail closed.
 */
export type AdminStepUpConsumeReason =
  | AdminStepUpVerifyReason
  | 'scope_mismatch'
  | 'already_consumed'
  | 'not_consumable';

export type AdminStepUpConsumeResult =
  | { ok: true; claims: AdminStepUpClaims }
  | { ok: false; reason: AdminStepUpConsumeReason };

function b64urlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

function hmac(key: string, signingInput: string): Buffer {
  return createHmac('sha256', key).update(signingInput).digest();
}

function currentSigningKey(): string {
  const k = env.LOOP_ADMIN_STEP_UP_SIGNING_KEY;
  if (k === undefined) {
    throw new Error(
      'LOOP_ADMIN_STEP_UP_SIGNING_KEY is not configured — admin step-up auth is disabled',
    );
  }
  return k;
}

/**
 * Returns true iff a step-up signing key is configured. The middleware
 * uses this to decide between "401 STEP_UP_REQUIRED" (key configured;
 * admin must present a valid step-up token) and "503 STEP_UP_UNAVAILABLE"
 * (key not configured; surface fails closed). Both block the action.
 */
export function isAdminStepUpConfigured(): boolean {
  return env.LOOP_ADMIN_STEP_UP_SIGNING_KEY !== undefined;
}

/**
 * Signs an admin step-up JWT. Throws if the signing key is not
 * configured — callers should gate on `isAdminStepUpConfigured()` and
 * 503 the request rather than triggering this throw.
 */
export function signAdminStepUpToken(opts: SignAdminStepUpOptions): {
  token: string;
  claims: AdminStepUpClaims;
} {
  const key = currentSigningKey();
  const nowSec = opts.now ?? Math.floor(Date.now() / 1000);
  const claims: AdminStepUpClaims = {
    sub: opts.sub,
    email: opts.email,
    purpose: STEP_UP_PURPOSE,
    aud: STEP_UP_AUDIENCE,
    iss: STEP_UP_ISSUER,
    scope: opts.scope ?? STEP_UP_SCOPE_WILDCARD,
    // SEC-02-stepup: every freshly-minted token carries a unique `jti`
    // so it can be consumed single-use at the gate.
    jti: opts.jti ?? randomUUID(),
    iat: nowSec,
    exp: nowSec + (opts.ttlSeconds ?? ADMIN_STEP_UP_TTL_SECONDS),
  };
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = b64urlEncode(hmac(key, signingInput));
  return { token: `${signingInput}.${sig}`, claims };
}

/**
 * Verifies an admin step-up JWT. Returns `not_configured` when the
 * signing-key env var is unset so the gate can fail closed (503)
 * rather than silently skipping.
 */
export function verifyAdminStepUpToken(token: string): AdminStepUpVerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, providedSig] = parts;
  if (
    header === undefined ||
    payload === undefined ||
    providedSig === undefined ||
    header.length === 0 ||
    payload.length === 0 ||
    providedSig.length === 0
  ) {
    return { ok: false, reason: 'malformed' };
  }
  const signingInput = `${header}.${payload}`;
  const providedSigBuf = b64urlDecode(providedSig);
  const keys = [
    env.LOOP_ADMIN_STEP_UP_SIGNING_KEY,
    env.LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS,
  ].filter((k): k is string => typeof k === 'string' && k.length > 0);
  if (keys.length === 0) return { ok: false, reason: 'not_configured' };
  const matched = keys.some((k) => {
    const expected = hmac(k, signingInput);
    return expected.length === providedSigBuf.length && timingSafeEqual(expected, providedSigBuf);
  });
  if (!matched) return { ok: false, reason: 'bad_signature' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(b64urlDecode(payload).toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { ok: false, reason: 'malformed' };
  }
  const obj = parsed as Record<string, unknown>;
  if (
    typeof obj['sub'] !== 'string' ||
    typeof obj['email'] !== 'string' ||
    typeof obj['purpose'] !== 'string' ||
    typeof obj['aud'] !== 'string' ||
    typeof obj['iss'] !== 'string' ||
    typeof obj['iat'] !== 'number' ||
    typeof obj['exp'] !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (obj['purpose'] !== STEP_UP_PURPOSE) {
    return { ok: false, reason: 'wrong_purpose' };
  }
  if (obj['aud'] !== STEP_UP_AUDIENCE) {
    return { ok: false, reason: 'wrong_audience' };
  }
  if (obj['iss'] !== STEP_UP_ISSUER) {
    return { ok: false, reason: 'wrong_issuer' };
  }
  if (obj['exp'] < Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  // CF-08: `scope` is optional on the wire for backward-safety —
  // tokens minted before this claim existed (or with the field
  // absent) are treated as the wildcard so a rotation window doesn't
  // hard-fail in-flight tokens. A *present* scope must be a known
  // value; an unknown string is a malformed token, not a silent
  // wildcard.
  let scope: AdminStepUpScope;
  if (obj['scope'] === undefined) {
    scope = STEP_UP_SCOPE_WILDCARD;
  } else if (isAdminStepUpScope(obj['scope'])) {
    scope = obj['scope'];
  } else {
    return { ok: false, reason: 'malformed' };
  }
  // SEC-02-stepup: `jti` is optional on the wire (a legacy token minted
  // before the claim existed has none). A *present* jti must be a
  // non-empty string; a non-string / empty string is a malformed token.
  // An absent jti leaves the claim undefined — the consume path fails
  // such a token closed rather than treating it as unlimited-use.
  let jti: string | undefined;
  if (obj['jti'] === undefined) {
    jti = undefined;
  } else if (typeof obj['jti'] === 'string' && obj['jti'].length > 0) {
    jti = obj['jti'];
  } else {
    return { ok: false, reason: 'malformed' };
  }
  return {
    ok: true,
    claims: {
      sub: obj['sub'],
      email: obj['email'],
      purpose: STEP_UP_PURPOSE,
      aud: STEP_UP_AUDIENCE,
      iss: STEP_UP_ISSUER,
      scope,
      ...(jti !== undefined ? { jti } : {}),
      iat: obj['iat'],
      exp: obj['exp'],
    },
  };
}

/**
 * SEC-02-stepup: the SECURITY-authoritative step-up check for a
 * destructive admin write. Where `verifyAdminStepUpToken` is the
 * stateless signature/claims check, this is the DB-backed gate that
 * closes the audited "one OTP → 5-minute, unlimited-use, all-class
 * token" hole by additionally enforcing:
 *
 *   1. ACTION-CLASS BINDING. The token authorises exactly the class it
 *      was minted for: `claims.scope` must equal the concrete `action`
 *      the caller guards. A wildcard-scoped token does NOT satisfy a
 *      concrete action here — the wildcard-satisfies-everything escape
 *      hatch IS the all-class privilege this finding removes. So a
 *      token minted to "queue an emission" cannot be replayed for a
 *      refund. A scope mismatch is rejected BEFORE the consume insert,
 *      so a wrong-class presentation burns nothing.
 *
 *   2. SINGLE-USE. The token's `jti` is recorded atomically on first
 *      consumption (`INSERT ... ON CONFLICT (jti) DO NOTHING`) — the
 *      first presentation wins and returns a row; every replay of the
 *      same token conflicts, returns no row, and is rejected. This is
 *      the same atomic-consume idiom as `refresh_tokens`'
 *      `tryRevokeIfLive`.
 *
 * Callers pass the concrete `action` the route guards — the same class
 * they already declare to `requireAdminStepUp(action)`.
 */
export async function consumeAdminStepUpToken(opts: {
  token: string;
  action: AdminStepUpScope;
}): Promise<AdminStepUpConsumeResult> {
  const verified = verifyAdminStepUpToken(opts.token);
  if (!verified.ok) {
    return { ok: false, reason: verified.reason };
  }
  const { claims } = verified;

  // (1) Action-class binding. Exact match, no wildcard bypass. Checked
  // before the insert so a wrong-class presentation consumes nothing.
  if (claims.scope !== opts.action) {
    return { ok: false, reason: 'scope_mismatch' };
  }

  // A jti is required to bound uses. A legacy token minted before the
  // claim existed can't be tracked — fail closed rather than silently
  // grant unlimited use.
  if (claims.jti === undefined) {
    return { ok: false, reason: 'not_consumable' };
  }

  // (2) Atomic single-use consume. The FIRST insert of this jti wins
  // and returns the row; a concurrent or later replay conflicts on the
  // primary key, returns nothing, and is rejected.
  const inserted = await db
    .insert(adminStepUpConsumptions)
    .values({
      jti: claims.jti,
      sub: claims.sub,
      scope: claims.scope,
      expiresAt: new Date(claims.exp * 1000),
    })
    .onConflictDoNothing({ target: adminStepUpConsumptions.jti })
    .returning({ jti: adminStepUpConsumptions.jti });

  if (inserted.length === 0) {
    return { ok: false, reason: 'already_consumed' };
  }
  return { ok: true, claims };
}

/**
 * SEC-02-stepup: retention sweep for the single-use ledger. Deletes
 * `admin_step_up_consumptions` rows whose `expires_at` is older than
 * `now - retentionMs`. Once a token's `exp` has passed it can no longer
 * verify (so its consumption marker can never block a live replay), and
 * the row carries `sub` — an unbounded table is a slowly-growing PII
 * store with no lawful retention basis. Mirrors `purgeExpiredOtps` /
 * `purgeDeadRefreshTokens`; keyed on the `admin_step_up_consumptions_
 * expires` index. Returns the number of rows deleted.
 */
export async function purgeExpiredAdminStepUpConsumptions(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  const deleted = await db
    .delete(adminStepUpConsumptions)
    .where(lt(adminStepUpConsumptions.expiresAt, cutoff))
    .returning({ jti: adminStepUpConsumptions.jti });
  return deleted.length;
}
