import { z } from 'zod';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';
import { coreEnvFields } from './env/sections/core.js';
import { authEnvFields } from './env/sections/auth.js';
import { infraEnvFields } from './env/sections/infra.js';

/**
 * Environment schema. Exported so tests can exercise it directly if they
 * ever need to (today they go through `parseEnv` instead); production
 * code should consume the validated `env` object at the bottom of this
 * file, not the raw schema.
 */
export const EnvSchema = z.object({
  ...coreEnvFields,
  ...authEnvFields,
  ...infraEnvFields,
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * Parses a raw env source against `EnvSchema`. Returns the validated env or
 * throws with a descriptive message that includes each failing field's reason
 * (not just the path), so ops can tell the difference between "missing" and
 * "present but invalid URL". Exported so tests can exercise the schema
 * without relying on mutating `process.env`.
 */
export function parseEnv(source: NodeJS.ProcessEnv): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment variables — ${details}`);
  }

  // Hardening B7: HS256 retirement tripwire. After an RS256 cutover the
  // HS256 key must stay set only for the 30-day refresh window so
  // outstanding HS256 tokens keep verifying — then it MUST be removed:
  // every extra day it stays set is a standing forgery-if-leaked
  // surface running alongside the RSA key for no benefit.
  if (
    parsed.data.LOOP_JWT_RSA_PRIVATE_KEY !== undefined &&
    parsed.data.LOOP_JWT_SIGNING_KEY !== undefined
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '[env] Both LOOP_JWT_RSA_PRIVATE_KEY and LOOP_JWT_SIGNING_KEY are set. If the RS256 cutover ' +
        'is more than 30 days old (the refresh-token TTL), remove LOOP_JWT_SIGNING_KEY — outstanding ' +
        'HS256 tokens have all expired and the key is now a pure forgery-if-leaked surface.',
    );
  }

  // Audit A-018: operators can override client IDs per environment, but
  // the web bundle hardcodes `DEFAULT_CLIENT_IDS` (via @loop/shared) at
  // build time. Warn when the effective server value diverges from that
  // default so the operator knows to rebuild the web app with matching
  // values, or the client-id allowlist in `requireAuth()` will reject
  // authenticated requests after login.
  const divergentClientIds: Array<[string, string, string]> = [];
  if (parsed.data.CTX_CLIENT_ID_WEB !== DEFAULT_CLIENT_IDS.web) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_WEB',
      parsed.data.CTX_CLIENT_ID_WEB,
      DEFAULT_CLIENT_IDS.web,
    ]);
  }
  if (parsed.data.CTX_CLIENT_ID_IOS !== DEFAULT_CLIENT_IDS.ios) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_IOS',
      parsed.data.CTX_CLIENT_ID_IOS,
      DEFAULT_CLIENT_IDS.ios,
    ]);
  }
  if (parsed.data.CTX_CLIENT_ID_ANDROID !== DEFAULT_CLIENT_IDS.android) {
    divergentClientIds.push([
      'CTX_CLIENT_ID_ANDROID',
      parsed.data.CTX_CLIENT_ID_ANDROID,
      DEFAULT_CLIENT_IDS.android,
    ]);
  }
  for (const [name, actual, expected] of divergentClientIds) {
    // eslint-disable-next-line no-console
    console.warn(
      `[env] ${name}=${actual} differs from @loop/shared DEFAULT_CLIENT_IDS (${expected}). ` +
        `The web bundle sends X-Client-Id from the shared constant, so authenticated requests will ` +
        `fail the X-Client-Id allowlist (audit A-036) until apps/web is rebuilt with a matching value.`,
    );
  }

  // A2-1605: DISABLE_RATE_LIMITING bypasses every per-IP rate limiter.
  // That's a test-harness flag — refuse to boot in production with it.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.DISABLE_RATE_LIMITING) {
    throw new Error(
      'Invalid environment variables — DISABLE_RATE_LIMITING must not be set in production (audit A2-1605). ' +
        'The flag is a test-harness escape hatch; production runs without it. ' +
        'Unset the variable and redeploy.',
    );
  }

  // AUDIT-2-E: LOOP_TEST_ENDPOINTS_SECRET only has meaning alongside
  // `NODE_ENV==='test'` (it gates the test-only `/__test__/*` mount).
  // The secret has no business being present in a production env at
  // all; refusing to boot catches a copy-pasted env file.
  if (parsed.data.NODE_ENV === 'production' && parsed.data.LOOP_TEST_ENDPOINTS_SECRET) {
    throw new Error(
      'Invalid environment variables — LOOP_TEST_ENDPOINTS_SECRET must not be set in production (AUDIT-2-E). ' +
        'It only unlocks the test-only /__test__/* endpoints; unset it and redeploy.',
    );
  }

  // The mongo driver can't run without a connection string; fail at
  // boot rather than on the first collection access.
  if (parsed.data.DB_DRIVER === 'mongo' && parsed.data.MONGODB_URI === undefined) {
    throw new Error(
      'Invalid environment variables — DB_DRIVER=mongo requires MONGODB_URI. ' +
        'Set it, or use DB_DRIVER=memory (the default) for the JSON-backed in-memory store.',
    );
  }

  // Hardening B3: native auth enabled with NO signing capability.
  // verify-otp / refresh would 500 on every call — an outage discovered
  // by the first user, not the deploy. Both key families count.
  if (
    parsed.data.LOOP_AUTH_NATIVE_ENABLED &&
    parsed.data.LOOP_JWT_SIGNING_KEY === undefined &&
    parsed.data.LOOP_JWT_RSA_PRIVATE_KEY === undefined
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_AUTH_NATIVE_ENABLED=true requires a JWT signing key ' +
        '(LOOP_JWT_SIGNING_KEY or LOOP_JWT_RSA_PRIVATE_KEY, ADR 013 / ADR 030). Without one, every ' +
        'verify-otp/refresh call 500s. Set a key or disable native auth.',
    );
  }

  // R3-7: production must not silently fall back to the legacy
  // CTX-proxy auth path. Fail fast unless the operator deliberately
  // ships the rollback/staging override.
  if (
    parsed.data.NODE_ENV === 'production' &&
    !parsed.data.LOOP_AUTH_NATIVE_ENABLED &&
    parsed.data.DISABLE_NATIVE_AUTH_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_AUTH_NATIVE_ENABLED must be true in production ' +
        '(R3-7 / ADR 013). Leaving it false reverts auth to the legacy CTX-proxy path. ' +
        'Set LOOP_AUTH_NATIVE_ENABLED=true with a JWT signing key, or set ' +
        'DISABLE_NATIVE_AUTH_ENFORCEMENT=1 only for an explicit rollback/staging deploy.',
    );
  }

  // FT-09: EMAIL_PROVIDER=resend selected without RESEND_API_KEY. The
  // OTP send path throws, but the request-otp handler swallows that
  // into a generic 200 (enumeration defence) — a total, invisible
  // login outage. Fail at boot in production instead.
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.EMAIL_PROVIDER === 'resend' &&
    (parsed.data.RESEND_API_KEY === undefined || parsed.data.RESEND_API_KEY === '')
  ) {
    throw new Error(
      'Invalid environment variables — EMAIL_PROVIDER=resend requires RESEND_API_KEY in ' +
        'production (FT-09). Without it every request-otp throws in the email provider and is ' +
        'swallowed into a fake 200 (a silent, total login outage). Set RESEND_API_KEY, or unset ' +
        'EMAIL_PROVIDER to fall back to the dev console stub.',
    );
  }

  // A2-203: the fallback cashback split must respect the
  // `userCashback + margin + wholesale = 100` invariant. Reject a
  // misconfigured env at boot rather than silently over-granting
  // cashback at order-creation time.
  const userCashback = Number.parseFloat(parsed.data.DEFAULT_USER_CASHBACK_PCT_OF_CTX);
  const loopMargin = Number.parseFloat(parsed.data.DEFAULT_LOOP_MARGIN_PCT_OF_CTX);
  if (userCashback + loopMargin > 100) {
    throw new Error(
      `Invalid environment variables — DEFAULT_USER_CASHBACK_PCT_OF_CTX (${userCashback}%) ` +
        `+ DEFAULT_LOOP_MARGIN_PCT_OF_CTX (${loopMargin}%) exceeds 100% of face value. ` +
        `Wholesale (what Loop pays CTX) would go negative.`,
    );
  }

  // NS-10 (CF-25 / X-PRIV-03 follow-up): production must ENCRYPT the
  // gift-card redeem code + PIN at rest — they're spendable bearer
  // secrets. Fail CLOSED at boot in production when the key is unset,
  // with a `"1"`-only emergency opt-out. Dev/test keep the
  // warn-and-allow posture (index.ts) so local work isn't blocked.
  if (
    parsed.data.NODE_ENV === 'production' &&
    (parsed.data.LOOP_REDEEM_ENCRYPTION_KEY === undefined ||
      parsed.data.LOOP_REDEEM_ENCRYPTION_KEY === '') &&
    parsed.data.DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT !== '1'
  ) {
    throw new Error(
      'Invalid environment variables — LOOP_REDEEM_ENCRYPTION_KEY must be set in production ' +
        '(NS-10; CF-25 / X-PRIV-03). Without it, gift-card redeem codes/PINs (spendable bearer ' +
        'secrets) are stored PLAINTEXT at rest and any logical DB read yields spendable cards. ' +
        'Generate a 32-byte key (`openssl rand -base64 32`), or set ' +
        'DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT=1 to deliberately ship production with redeem ' +
        'secrets stored in plaintext (rollback/staging only, never with live redemption data).',
    );
  }

  // CF-25 / X-PRIV-03: validate the redeem envelope key decodes to
  // exactly 32 bytes when present. A wrong-length key would silently
  // write ciphertext nobody can later decrypt (the read path throws on
  // every order), so fail at boot instead. Optional → no constraint.
  if (
    parsed.data.LOOP_REDEEM_ENCRYPTION_KEY !== undefined &&
    parsed.data.LOOP_REDEEM_ENCRYPTION_KEY !== ''
  ) {
    const raw = parsed.data.LOOP_REDEEM_ENCRYPTION_KEY;
    const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
      ? Buffer.from(raw, 'hex')
      : Buffer.from(raw, 'base64');
    if (bytes.length !== 32) {
      throw new Error(
        `Invalid environment variables — LOOP_REDEEM_ENCRYPTION_KEY must decode to 32 bytes ` +
          `(got ${bytes.length}); supply 32 random bytes as base64 or hex ` +
          `(e.g. \`openssl rand -base64 32\`).`,
      );
    }
  }

  return parsed.data;
}

/** Validated, typed environment configuration. */
export const env = parseEnv(process.env);
