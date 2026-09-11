// Admin step-up auth — ADR 028, A4-063, SEC-02-stepup
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import { getActiveSigner, getVerifiers, isAnySignerConfigured } from './signer.js';

export const ADMIN_STEP_UP_TTL_SECONDS = 5 * 60;

const STEP_UP_PURPOSE = 'admin-step-up';
const STEP_UP_AUDIENCE = 'admin-write';
const STEP_UP_ISSUER = 'loop-api';

export const STEP_UP_SCOPE_WILDCARD = 'admin-write';
export const STEP_UP_SCOPES = [
  STEP_UP_SCOPE_WILDCARD,
  // ADR 037: separate scopes per direction so a grant token can't be replayed to revoke.
  'staff-role-grant',
  'staff-role-revoke',
  // Hardening B1: cashback-config upsert sets split for FUTURE orders — gate like other money writes.
  'cashback-config',
  // ADR 015: flipping home currency re-denominates quotes and charges.
  'home-currency',
  // A5-1: re-driving a stuck order re-runs procurement against CTX, which can create a real gift card.
  'order-redrive',
] as const;
export type AdminStepUpScope = (typeof STEP_UP_SCOPES)[number];

export function isAdminStepUpScope(s: unknown): s is AdminStepUpScope {
  return typeof s === 'string' && (STEP_UP_SCOPES as readonly string[]).includes(s);
}

export interface AdminStepUpClaims {
  sub: string;
  email: string;
  purpose: typeof STEP_UP_PURPOSE;
  aud: typeof STEP_UP_AUDIENCE;
  iss: typeof STEP_UP_ISSUER;
  scope: AdminStepUpScope;
  /** SEC-02-stepup: single-use key; absent tokens fail closed at consume. */
  jti?: string;
  iat: number;
  exp: number;
}

export interface SignAdminStepUpOptions {
  sub: string;
  email: string;
  scope?: AdminStepUpScope;
  jti?: string;
  now?: number;
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

export function isAdminStepUpConfigured(): boolean {
  return isAnySignerConfigured();
}

export function signAdminStepUpToken(opts: SignAdminStepUpOptions): {
  token: string;
  claims: AdminStepUpClaims;
} {
  const signer = getActiveSigner();
  if (signer === null) {
    throw new Error(
      'No Loop JWT signing key configured (auth.native.jwt.current) — admin step-up auth is disabled',
    );
  }
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
  const header = b64urlEncode(JSON.stringify({ alg: signer.alg, typ: 'JWT' }));
  const payload = b64urlEncode(JSON.stringify(claims));
  const signingInput = `${header}.${payload}`;
  const sig = b64urlEncode(signer.sign(signingInput));
  return { token: `${signingInput}.${sig}`, claims };
}

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
  const verifiers = getVerifiers();
  if (verifiers.length === 0) return { ok: false, reason: 'not_configured' };
  const matched = verifiers.some((s) => s.verify(signingInput, providedSigBuf));
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
  // Absent scope reads as wildcard for backward compat; present-but-unknown is malformed.
  let scope: AdminStepUpScope;
  if (obj['scope'] === undefined) {
    scope = STEP_UP_SCOPE_WILDCARD;
  } else if (isAdminStepUpScope(obj['scope'])) {
    scope = obj['scope'];
  } else {
    return { ok: false, reason: 'malformed' };
  }
  // Absent jti tolerated here, rejected at consume; present-but-not-string is malformed.
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

export async function consumeAdminStepUpToken(opts: {
  token: string;
  action: AdminStepUpScope;
}): Promise<AdminStepUpConsumeResult> {
  const verified = verifyAdminStepUpToken(opts.token);
  if (!verified.ok) return { ok: false, reason: verified.reason };
  const { claims } = verified;

  // SEC-02-stepup: exact match required; wildcard does not satisfy concrete action.
  if (claims.scope !== opts.action) return { ok: false, reason: 'scope_mismatch' };

  // SEC-02-stepup: jti required for single-use tracking; absent means fail closed.
  if (claims.jti === undefined) return { ok: false, reason: 'not_consumable' };

  // SEC-02-stepup: atomic single-use consume via unique insert.
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

export async function purgeExpiredAdminStepUpConsumptions(args: {
  retentionMs: number;
  now?: Date;
}): Promise<number> {
  const cutoff = new Date((args.now ?? new Date()).getTime() - args.retentionMs);
  return await db.collection('admin_step_up_consumptions').deleteMany({
    expiresAt: { $lt: cutoff },
  });
}
