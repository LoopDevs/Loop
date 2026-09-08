/**
 * Application configuration — loaded from the YAML file at
 * `CONFIG_PATH` (default `config.yaml`, resolved against the working
 * directory), validated once at boot, and consumed everywhere as the
 * typed `config` object exported at the bottom of this file.
 *
 * ── Why a file and not environment variables ───────────────────────
 *
 * This replaces the flat `process.env` schema that lived in `env.ts`.
 * That format spread ~60 `SCREAMING_SNAKE` names across one namespace
 * with no way to say that some of them only mean anything in
 * combination — so the combinations lived in a dozen hand-written boot
 * guards below the schema ("mongo requires a URI", "native auth
 * requires a signing key", "resend requires an API key"). Nesting puts
 * those relationships back into the schema (`./schema.ts` +
 * `./sections/`), where a parent switch literally contains the
 * settings it governs:
 *
 *   auth:
 *     native:
 *       enabled: true
 *       jwt:
 *         hs256:
 *           current:  ...
 *           previous: ...
 *
 * The section modules under `./sections/` mirror the YAML file's shape
 * one-for-one, so the file and the schema can be read side by side.
 * Several former guards are gone entirely — see the section modules for
 * which, and why.
 *
 * ── What is still an environment variable ──────────────────────────
 *
 * Two things, both platform-level rather than operator-authored:
 *
 * - `CONFIG_PATH` — which file to load. Defaults to `config.yaml`
 *   resolved against the working directory. This is also the seam for
 *   the planned encrypted-config step, which will add a
 *   `CONFIG_DECRYPTION_KEY` alongside it and decrypt before parsing;
 *   nothing else in the codebase should need to change for that.
 * - `NODE_ENV` — overrides the file's `env:` key when set. Node
 *   tooling (vitest, tsup, countless libraries) sets and reads
 *   `NODE_ENV` on its own, so the process environment has to win here
 *   or a test run loading a development config would take production
 *   branches. It is the one documented exception, not a general
 *   env-overlay: no other key can be overridden this way.
 *
 * `FLY_APP_NAME` is read directly from `process.env` at its single use
 * site (`middleware/fleet-size.ts`) because Fly injects it into the
 * machine — no operator ever writes it, so it does not belong in a
 * file operators author.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';
import { stripNulls } from './schema-helpers.js';
import { ConfigSchema, type Config } from './schema.js';

export { ConfigSchema, type Config } from './schema.js';

/** Default config file, resolved against the working directory. */
export const DEFAULT_CONFIG_FILENAME = 'config.yaml';

/**
 * Cross-field checks that a per-field schema can't express, run after
 * parsing. Two kinds live here:
 *
 * - **Warnings** for a config that works but is probably not what the
 *   operator meant, or that has a companion change they still owe.
 * - **Throws** for a production posture that is unsafe enough to be
 *   worth refusing the boot over. Each has an explicit opt-out under
 *   `unsafe:` where a deliberate rollback needs one.
 *
 * The guards that used to check "setting A requires setting B" are
 * *not* here any more — the schema sections express those as
 * discriminated unions, so they fail at parse time with the offending
 * path already in the message.
 */
export function applyCrossFieldGuards(config: Config, source: string): void {
  const isProduction = config.env === 'production';

  // Hardening B7: HS256 retirement tripwire. After an RS256 cutover the
  // HS256 key must stay set only for the 30-day refresh window so
  // outstanding HS256 tokens keep verifying — then it MUST be removed:
  // every extra day it stays set is a standing forgery-if-leaked
  // surface running alongside the RSA key for no benefit.
  if (
    config.auth.native.jwt.rs256.current !== undefined &&
    config.auth.native.jwt.hs256.current !== undefined
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      '[config] Both auth.native.jwt.rs256.current and auth.native.jwt.hs256.current are set. If the ' +
        'RS256 cutover is more than 30 days old (the refresh-token TTL), remove the hs256 key — ' +
        'outstanding HS256 tokens have all expired and the key is now a pure forgery-if-leaked surface.',
    );
  }

  // Audit A-018: operators can override client IDs per environment, but
  // the web bundle hardcodes `DEFAULT_CLIENT_IDS` (via @loop/shared) at
  // build time. Warn when the effective server value diverges from that
  // default so the operator knows to rebuild the web app with matching
  // values, or the client-id allowlist in `requireAuth()` will reject
  // authenticated requests after login.
  for (const platform of ['web', 'ios', 'android'] as const) {
    const actual = config.ctx.clientIds[platform];
    const expected = DEFAULT_CLIENT_IDS[platform];
    if (actual !== expected) {
      // eslint-disable-next-line no-console
      console.warn(
        `[config] ctx.clientIds.${platform}=${actual} differs from @loop/shared DEFAULT_CLIENT_IDS ` +
          `(${expected}). The web bundle sends X-Client-Id from the shared constant, so authenticated ` +
          `requests will fail the X-Client-Id allowlist (audit A-036) until apps/web is rebuilt with a ` +
          `matching value.`,
      );
    }
  }

  const fail = (message: string): never => {
    throw new Error(`Invalid configuration in ${source} — ${message}`);
  };

  // A2-1605: disabling rate limiting bypasses every per-IP limiter.
  // That's a test-harness flag — refuse to boot in production with it.
  if (isProduction && !config.rateLimit.enabled) {
    fail(
      'rateLimit.enabled must not be false in production (audit A2-1605). It is a test-harness ' +
        'escape hatch that disables every per-IP limit on every route; production runs with limits on.',
    );
  }

  // AUDIT-2-E: `testing.endpointsSecret` only has meaning alongside
  // `env: test` (it gates the test-only `/__test__/*` mount). The secret
  // has no business being present in a production config at all;
  // refusing to boot catches a copy-pasted file.
  if (isProduction && config.testing.endpointsSecret !== undefined) {
    fail(
      'testing.endpointsSecret must not be set in production (AUDIT-2-E). It only unlocks the ' +
        'test-only /__test__/* endpoints; remove it and redeploy.',
    );
  }

  // R3-7: production must not silently fall back to the legacy
  // CTX-proxy auth path. Fail fast unless the operator deliberately
  // ships the rollback/staging override.
  if (isProduction && !config.auth.native.enabled && !config.unsafe.allowLegacyProxyAuth) {
    fail(
      'auth.native.enabled must be true in production (R3-7 / ADR 013). Leaving it false reverts ' +
        'auth to the legacy CTX-proxy path. Enable native auth with a JWT signing key, or set ' +
        'unsafe.allowLegacyProxyAuth: true only for an explicit rollback/staging deploy.',
    );
  }

  // A4-093: the OTP send path needs a real email provider. The `console`
  // provider logs OTPs to stdout — with native auth on in production,
  // every OTP request would land in the request-otp catch arm and return
  // a generic 200 (enumeration defence) without ever sending a code: a
  // total, invisible login outage. Refuse to boot so the gap is loud.
  if (isProduction && config.auth.native.enabled && config.email.provider === 'console') {
    fail(
      'email.provider must be a real provider when auth.native.enabled is true in production ' +
        '(A4-093 / FT-09). The `console` provider only logs OTPs to stdout, so every login request ' +
        'would silently fail while returning 200. Set email.provider: resend with an apiKey.',
    );
  }

  // NS-10 (CF-25 / X-PRIV-03): production must ENCRYPT the gift-card
  // redeem code + PIN at rest — they're spendable bearer secrets. Fail
  // CLOSED at boot in production when the key is unset. Dev/test keep
  // the warn-and-allow posture (index.ts) so local work isn't blocked.
  if (
    isProduction &&
    config.orders.redeem.encryptionKey === undefined &&
    !config.unsafe.allowPlaintextRedeemSecrets
  ) {
    fail(
      'orders.redeem.encryptionKey must be set in production (NS-10; CF-25 / X-PRIV-03). Without it, ' +
        'gift-card redeem codes/PINs (spendable bearer secrets) are stored PLAINTEXT at rest and any ' +
        'logical DB read yields spendable cards. Generate a 32-byte key (`openssl rand -base64 32`), ' +
        'or set unsafe.allowPlaintextRedeemSecrets: true to deliberately ship production with redeem ' +
        'secrets in plaintext (rollback/staging only, never with live redemption data).',
    );
  }

  // A2-203: the fallback cashback split must respect the
  // `userCashback + margin + wholesale = 100` invariant. Reject a
  // misconfigured file at boot rather than silently over-granting
  // cashback at order-creation time.
  const { userCashbackPct, loopMarginPct } = config.orders.cashbackDefaults;
  if (userCashbackPct + loopMarginPct > 100) {
    fail(
      `orders.cashbackDefaults.userCashbackPct (${userCashbackPct}%) + loopMarginPct ` +
        `(${loopMarginPct}%) exceeds 100% of face value. Wholesale (what Loop pays CTX) would go ` +
        `negative.`,
    );
  }
}

/**
 * Validates an already-parsed config document. Throws with a message
 * that names each failing path *and* its reason, so an operator can
 * tell "missing" from "present but not a valid URL". Exported so tests
 * can exercise the schema without touching the filesystem.
 *
 * `source` only ever appears in error messages — it's the file path in
 * production and something descriptive in tests.
 */
export function parseConfig(document: unknown, source = 'config'): Config {
  const parsed = ConfigSchema.safeParse(stripNulls(document));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration in ${source} — ${details}`);
  }

  // NODE_ENV wins over the file's `env:` — see the module comment.
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv === 'development' || nodeEnv === 'production' || nodeEnv === 'test') {
    parsed.data.env = nodeEnv;
  }

  applyCrossFieldGuards(parsed.data, source);
  return parsed.data;
}

/** Where `loadConfig()` reads from, honouring `CONFIG_PATH`. */
export function configFilePath(): string {
  return resolve(process.env['CONFIG_PATH'] ?? DEFAULT_CONFIG_FILENAME);
}

/**
 * Reads, parses and validates the config file. Any failure here is a
 * boot failure by design: a backend running on a half-understood
 * config is worse than one that refuses to start.
 */
export function loadConfig(path = configFilePath()): Config {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read the config file at ${path} — ${reason}. Copy config.example.yaml to ` +
        `config.yaml and fill it in, or point CONFIG_PATH at the file you meant.`,
    );
  }

  let document: unknown;
  try {
    document = parseYaml(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not parse ${path} as YAML — ${reason}`);
  }

  // An empty file parses to null, which is a valid YAML document but
  // never a valid config — say so rather than reporting every required
  // key as missing.
  if (document === null || typeof document !== 'object') {
    throw new Error(`${path} is empty or is not a YAML mapping. Start from config.example.yaml.`);
  }

  return parseConfig(document, path);
}

/** Validated, typed application configuration. */
export const config = loadConfig();
