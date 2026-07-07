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
 * The step-up token is stateless — no DB row per issued token; the
 * 5-minute TTL is enforced by the `exp` claim. Verification accepts
 * either `LOOP_ADMIN_STEP_UP_SIGNING_KEY` or
 * `LOOP_ADMIN_STEP_UP_SIGNING_KEY_PREVIOUS` so a rotation overlaps
 * for the TTL without a flag-day.
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
 * *specific* action (e.g. `'refund'`) cannot be silently replayed
 * against a *different* destructive write — the gate middleware
 * rejects a scope mismatch. The default `'admin-write'` scope is a
 * wildcard that satisfies every gate, so a caller that doesn't ask
 * for a narrower scope keeps the prior "one token, any write"
 * behaviour (backward-safe). Narrowing is opt-in at mint time.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

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
 * `'staff-role-revoke'`)
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
  iat: number;
  exp: number;
}

export interface SignAdminStepUpOptions {
  sub: string;
  email: string;
  /**
   * CF-08: action class this token is minted for. Defaults to the
   * wildcard `'admin-write'` so existing callers keep "any write"
   * semantics. Pass a narrower scope to bind the token to one class.
   */
  scope?: AdminStepUpScope;
  /** Override `now` for tests; seconds since epoch. */
  now?: number;
  /** Override TTL for tests; defaults to ADMIN_STEP_UP_TTL_SECONDS. */
  ttlSeconds?: number;
}

export type AdminStepUpVerifyResult =
  | { ok: true; claims: AdminStepUpClaims }
  | {
      ok: false;
      reason:
        | 'malformed'
        | 'bad_signature'
        | 'expired'
        | 'wrong_purpose'
        | 'wrong_audience'
        | 'wrong_issuer'
        | 'not_configured';
    };

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
  return {
    ok: true,
    claims: {
      sub: obj['sub'],
      email: obj['email'],
      purpose: STEP_UP_PURPOSE,
      aud: STEP_UP_AUDIENCE,
      iss: STEP_UP_ISSUER,
      scope,
      iat: obj['iat'],
      exp: obj['exp'],
    },
  };
}
