// application config — A2-1605, AUDIT-2-E, R3-7, A4-093, NS-10, A2-203
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { DEFAULT_CLIENT_IDS } from '@loop/shared';
import { stripNulls } from './schema-helpers.js';
import { ConfigSchema, type Config } from './schema.js';

export { ConfigSchema, type Config } from './schema.js';

export const DEFAULT_CONFIG_FILENAME = 'config.yaml';

export function applyCrossFieldGuards(config: Config, source: string): void {
  const isProduction = config.env === 'production';

  // Hardening B7: HS256 key must be removed 30 days after RS256 cutover to eliminate forgery surface.
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

  // Audit A-018: warn if server client IDs diverge from build-time web bundle defaults to prevent auth rejection.
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

  // A2-1605: refuse boot in production if rate limiting is disabled.
  if (isProduction && !config.rateLimit.enabled) {
    fail(
      'rateLimit.enabled must not be false in production (audit A2-1605). It is a test-harness ' +
        'escape hatch that disables every per-IP limit on every route; production runs with limits on.',
    );
  }

  // AUDIT-2-E: refuse boot in production if test-only endpoints secret is present.
  if (isProduction && config.testing.endpointsSecret !== undefined) {
    fail(
      'testing.endpointsSecret must not be set in production (AUDIT-2-E). It only unlocks the ' +
        'test-only /__test__/* endpoints; remove it and redeploy.',
    );
  }

  // R3-7: refuse boot in production if native auth is disabled without explicit unsafe override.
  if (isProduction && !config.auth.native.enabled && !config.unsafe.allowLegacyProxyAuth) {
    fail(
      'auth.native.enabled must be true in production (R3-7 / ADR 013). Leaving it false reverts ' +
        'auth to the legacy CTX-proxy path. Enable native auth with a JWT signing key, or set ' +
        'unsafe.allowLegacyProxyAuth: true only for an explicit rollback/staging deploy.',
    );
  }

  // A4-093: refuse boot in production if native auth is enabled with console email provider.
  if (isProduction && config.auth.native.enabled && config.email.provider === 'console') {
    fail(
      'email.provider must be a real provider when auth.native.enabled is true in production ' +
        '(A4-093 / FT-09). The `console` provider only logs OTPs to stdout, so every login request ' +
        'would silently fail while returning 200. Set email.provider: resend or aws_ses with credentials.',
    );
  }

  // NS-10: refuse boot in production if redeem secrets encryption key is missing.
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

  // A2-203: enforce cashback split invariant to prevent negative wholesale values.
  const { userCashbackPct, loopMarginPct } = config.orders.cashbackDefaults;
  if (userCashbackPct + loopMarginPct > 100) {
    fail(
      `orders.cashbackDefaults.userCashbackPct (${userCashbackPct}%) + loopMarginPct ` +
        `(${loopMarginPct}%) exceeds 100% of face value. Wholesale (what Loop pays CTX) would go ` +
        `negative.`,
    );
  }
}

export function parseConfig(document: unknown, source = 'config'): Config {
  const parsed = ConfigSchema.safeParse(stripNulls(document));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration in ${source} — ${details}`);
  }

  // NODE_ENV overrides file env to prevent test runs from taking production branches.
  const nodeEnv = process.env['NODE_ENV'];
  if (nodeEnv === 'development' || nodeEnv === 'production' || nodeEnv === 'test') {
    parsed.data.env = nodeEnv;
  }

  applyCrossFieldGuards(parsed.data, source);
  return parsed.data;
}

export function configFilePath(): string {
  return resolve(process.env['CONFIG_PATH'] ?? DEFAULT_CONFIG_FILENAME);
}

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

  // Empty file parses to null; reject explicitly to avoid misleading "missing key" errors.
  if (document === null || typeof document !== 'object') {
    throw new Error(`${path} is empty or is not a YAML mapping. Start from config.example.yaml.`);
  }

  return parseConfig(document, path);
}

export const config = loadConfig();
