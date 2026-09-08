/**
 * Admin step-up auth (ADR 028, A4-063).
 *
 * Mints + verifies the short-lived (5-minute) `X-Admin-Step-Up` JWT
 * that gates destructive admin endpoints. Sits beside `auth/tokens.ts`
 * (which mints the bearer access + refresh tokens) but uses a SEPARATE
 * signing key — `admin.stepUp.signingKey`, not `auth.native.jwt` — so
 * a compromise of the bearer key doesn't widen to step-up.
 *
 * ISSUANCE is stateless — no row per issued token; the 5-minute TTL is
 * the `exp` claim. Verification accepts `signingKey` or
 * `previousSigningKey` so a rotation overlaps for the TTL without a
 * flag-day.
 *
 * SEC-02-stepup (auth privilege): the stateless `exp` is not the only
 * bound. `consumeAdminStepUpToken` is the DB-backed, security-
 * authoritative check a destructive write uses: it binds the token to
 * a SINGLE action class (no wildcard bypass) and records the token's
 * `jti` so the token is SINGLE-USE — a token minted to grant a staff
 * role can neither be replayed against a config edit nor reused after
 * it's spent. `signAdminStepUpToken` therefore stamps a unique `jti`
 * on every token, and the middleware consumes rather than verifies.
 *
 * Claim shape diverges from access/refresh tokens by intent:
 * `purpose: 'admin-step-up'` + `aud: 'admin-write'` make a stolen
 * step-up token unusable as a bearer (the bearer verifier wants
 * `aud === 'loop-clients'`) and a stolen access token unusable as a
 * step-up.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config/index.js';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';

/**
 * 5 minutes — short enough that a stolen token can't fund a
 * destructive spree, long enough that an admin doesn't re-auth
 * between two lines of the same ops task.
 */
export const ADMIN_STEP_UP_TTL_SECONDS = 5 * 60;

const STEP_UP_PURPOSE = 'admin-step-up';
const STEP_UP_AUDIENCE = 'admin-write';
const STEP_UP_ISSUER = 'loop-api';

/**
 * CF-08 action classes a step-up token can be bound to, one per
 * destructive mount. The wildcard is the issuance default so a
 * scope-less mint still produces a well-formed token — but
 * `consumeAdminStepUpToken` REJECTS a wildcard against a concrete
 * gate: "one token, any write" was the all-class privilege
 * SEC-02-stepup removed, so every live mint names its class.
 */
export const STEP_UP_SCOPE_WILDCARD = 'admin-write';
export const STEP_UP_SCOPES = [
  STEP_UP_SCOPE_WILDCARD,
  // ADR 037 role management — a captured bearer must not be able to
  // mint itself a colleague, or quietly unmake one. Separate scopes
  // per direction so a grant token can't be replayed to revoke.
  'staff-role-grant',
  'staff-role-revoke',
  // Hardening B1: the cashback-config upsert sets the split FUTURE
  // orders stamp at creation, so it is squarely the stolen-bearer
  // threat ADR 028 exists for — gate it like the other money writes.
  'cashback-config',
  // ADR 015: an admin flipping a user's home currency re-denominates
  // what they are quoted and charged.
  'home-currency',
  // A5-1: re-driving a stuck order re-runs procurement against CTX,
  // which can create a real gift card — a captured bearer alone must
  // not be able to trigger that.
  'order-redrive',
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
  /** Fixed `'admin-step-up'`; rejects stolen access/refresh tokens. */
  purpose: typeof STEP_UP_PURPOSE;
  /** Fixed `'admin-write'`; rejects tokens minted for other surfaces. */
  aud: typeof STEP_UP_AUDIENCE;
  iss: typeof STEP_UP_ISSUER;
  /** CF-08 action-class binding. */
  scope: AdminStepUpScope;
  /**
   * SEC-02-stepup per-token unique id — the single-use key
   * `consumeAdminStepUpToken` records so a spent token can't be
   * replayed. Optional on the wire only so a token minted before the
   * claim existed still parses; the consume path fails such a token
   * closed rather than treating it as unlimited-use.
   */
  jti?: string;
  iat: number;
  exp: number;
}

export interface SignAdminStepUpOptions {
  sub: string;
  email: string;
  /** Action class to bind to. Defaults to the wildcard; see above. */
  scope?: AdminStepUpScope;
  /** Override the single-use `jti`; a test may pin it. */
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
 * SEC-02-stepup: what `consumeAdminStepUpToken` can reject beyond the
 * stateless reasons.
 *   - `scope_mismatch`   — minted for a DIFFERENT class than the gate
 *     guards (no wildcard bypass).
 *   - `already_consumed` — spent once already.
 *   - `not_consumable`   — carries no `jti`, so single-use can't be
 *     tracked; fail closed.
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
  const k = config.admin.stepUp.signingKey;
  if (k === undefined) {
    throw new Error('admin.stepUp.signingKey is not configured — admin step-up auth is disabled');
  }
  return k;
}

/**
 * True iff a step-up signing key is configured. The middleware uses
 * this to choose between "401 STEP_UP_REQUIRED" (configured; present a
 * token) and "503 STEP_UP_UNAVAILABLE" (not configured; the surface
 * fails closed). Both block the action.
 */
export function isAdminStepUpConfigured(): boolean {
  return config.admin.stepUp.signingKey !== undefined;
}

/**
 * Signs an admin step-up JWT. Throws when no signing key is
 * configured — callers gate on `isAdminStepUpConfigured()` and 503
 * rather than triggering this.
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
 * Verifies an admin step-up JWT. Returns `not_configured` when no key
 * is set so the gate can fail closed (503) rather than skip silently.
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
  const keys = [config.admin.stepUp.signingKey, config.admin.stepUp.previousSigningKey].filter(
    (k): k is string => typeof k === 'string' && k.length > 0,
  );
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
  if (obj['purpose'] !== STEP_UP_PURPOSE) return { ok: false, reason: 'wrong_purpose' };
  if (obj['aud'] !== STEP_UP_AUDIENCE) return { ok: false, reason: 'wrong_audience' };
  if (obj['iss'] !== STEP_UP_ISSUER) return { ok: false, reason: 'wrong_issuer' };
  if (obj['exp'] < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  // An ABSENT scope reads as the wildcard so an in-flight token from
  // before the claim existed still parses; a PRESENT but unknown scope
  // is a malformed token, never a silent wildcard.
  let scope: AdminStepUpScope;
  if (obj['scope'] === undefined) {
    scope = STEP_UP_SCOPE_WILDCARD;
  } else if (isAdminStepUpScope(obj['scope'])) {
    scope = obj['scope'];
  } else {
    return { ok: false, reason: 'malformed' };
  }
  // Same shape for `jti`: absent is tolerated here and rejected at the
  // consume; present-but-not-a-string is malformed.
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
 *   1. ACTION-CLASS BINDING. `claims.scope` must EQUAL the concrete
 *      `action` the caller guards. A wildcard-scoped token does not
 *      satisfy a concrete action — the wildcard-satisfies-everything
 *      escape hatch WAS the privilege this removes. Checked BEFORE the
 *      consume insert, so a wrong-class presentation burns nothing.
 *
 *   2. SINGLE-USE. The `jti` is recorded on first consumption; the
 *      collection's unique spec makes the insert the atomic act, so a
 *      replay collides and is refused. Same atomic-consume idiom as
 *      `refresh_tokens`' `tryRevokeIfLive`.
 */
export async function consumeAdminStepUpToken(opts: {
  token: string;
  action: AdminStepUpScope;
}): Promise<AdminStepUpConsumeResult> {
  const verified = verifyAdminStepUpToken(opts.token);
  if (!verified.ok) return { ok: false, reason: verified.reason };
  const { claims } = verified;

  // (1) Action-class binding. Exact match, no wildcard bypass.
  if (claims.scope !== opts.action) return { ok: false, reason: 'scope_mismatch' };

  // A jti is required to bound uses. A token minted before the claim
  // existed can't be tracked — fail closed rather than grant unlimited
  // use.
  if (claims.jti === undefined) return { ok: false, reason: 'not_consumable' };

  // (2) Atomic single-use consume. The FIRST insert of this jti wins;
  // a concurrent or later replay violates the unique spec.
  try {
    await db.collection('admin_step_up_consumptions').insertOne({
      jti: claims.jti,
      sub: claims.sub,
      scope: claims.scope,
      expiresAt: new Date(claims.exp * 1000),
      consumedAt: new Date(),
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'already_consumed' };
    throw err;
  }
  return { ok: true, claims };
}

/**
 * SEC-02-stepup retention sweep. Deletes consumption rows whose
 * `expiresAt` is older than `retentionMs`. Once a token's `exp` has
 * passed it can no longer verify, so its marker can never block a live
 * replay — and the row carries `sub`, making an unbounded table a
 * slowly-growing PII store with no retention basis. Mirrors
 * `purgeExpiredOtps` / `purgeDeadRefreshTokens`; returns rows deleted.
 */
export async function purgeExpiredAdminStepUpConsumptions(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  return await db.collection('admin_step_up_consumptions').deleteMany({
    expiresAt: { $lt: cutoff },
  });
}
