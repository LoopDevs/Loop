import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  parseConfig,
  loadConfig,
  configFilePath,
  DEFAULT_CONFIG_FILENAME,
} from '../config/index.js';

/**
 * These tests exercise the config *schema and loader* directly with
 * synthetic YAML-shaped documents, so they never touch the real
 * `config.yaml`. The setup file (`vitest-env-setup.ts`) already points
 * `CONFIG_PATH` at the committed placeholder fixture, which is what
 * makes importing `../config/index.js` (and its boot-time
 * `loadConfig()`) safe from a test.
 */

// A valid HTTPS Discord webhook URL (SEC-10 schema shape).
const MONITORING_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEf-gh_Ij';

// NS-10 (CF-25 / X-PRIV-03): production boots require
// `orders.redeem.encryptionKey` (or the explicit opt-out). A 32-byte key
// (base64 of "0123456789abcdef0123456789abcdef") that also clears the
// 32-byte length validation. Carried in `base` so every
// production-success fixture that spreads `...base` satisfies the
// guard; it's optional in dev/test, so its presence is inert there.
const REDEEM_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const JWT_KEY = 'jwt-test-signing-key-32-chars-min!!';

/**
 * The minimum viable document: `ctx.baseUrl` and the operator
 * credentials are the only keys with no default anywhere in the schema
 * (ADR 052 — CTX is the payment processor, so a deployment without
 * credentials would come up with orders that never leave `unpaid`).
 */
const base = {
  ctx: {
    baseUrl: 'https://upstream.example.com',
    credentials: { key: 'test-operator-key', secret: 'test-operator-secret' },
  },
  orders: { redeem: { encryptionKey: REDEEM_KEY } },
};

/**
 * A production document that clears every production boot guard:
 * native auth on with a signing key (R3-7), a real email provider
 * (A4-093), and the redeem key from `base` (NS-10). Individual guard
 * tests start from this and break exactly one thing.
 */
const prodBase = {
  ...base,
  auth: { native: { enabled: true, jwt: { hs256: { current: JWT_KEY } } } },
  email: { provider: 'resend', apiKey: 're_test_key_value' },
};

/**
 * `parseConfig` lets `NODE_ENV` override the document's `env:` key (see
 * the module comment in `../config/index.js`), and vitest always sets
 * `NODE_ENV=test`. So a test that wants a production parse has to move
 * the *process* variable, not the document key.
 */
function withNodeEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env['NODE_ENV'];
  if (value === undefined) delete process.env['NODE_ENV'];
  else process.env['NODE_ENV'] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = previous;
  }
}

/** Parse `document` as if the process were running in production. */
function parseProd(document: unknown): ReturnType<typeof parseConfig> {
  return withNodeEnv('production', () => parseConfig(document, 'test config'));
}

/** Parse `document` in the ambient (test) environment. */
function parse(document: unknown): ReturnType<typeof parseConfig> {
  return parseConfig(document, 'test config');
}

describe('parseConfig', () => {
  it('parses a minimal valid document and fills in every default', () => {
    const config = parse(base);
    expect(config.server.port).toBe(8080);
    expect(config.server.logLevel).toBe('info');
    expect(config.server.trustProxy).toBe(false);
    expect(config.catalog.locationRefreshIntervalHours).toBe(24);
    expect(config.ctx.clientIds.web).toBe('loopweb');
    expect(config.ctx.paymentCurrencies).toEqual(['XLM']);
    expect(config.database.driver).toBe('memory');
    expect(config.email.provider).toBe('console');
    expect(config.rateLimit.enabled).toBe(true);
    expect(config.auth.native.enabled).toBe(false);
    expect(config.launch.phase1Only).toBe(false);
  });

  it('defaults env to development when NODE_ENV is unset', () => {
    expect(withNodeEnv(undefined, () => parseConfig(base, 'test config')).env).toBe('development');
  });

  it('honours the documented env: key when NODE_ENV is unset', () => {
    expect(
      withNodeEnv(undefined, () => parseConfig({ ...prodBase, env: 'production' }, 'test config'))
        .env,
    ).toBe('production');
  });

  // The one documented env-overlay: node tooling sets NODE_ENV on its
  // own, so a test run loading a development config must not take
  // development branches under a `test` process.
  it('lets NODE_ENV override the document env: key', () => {
    // `env: production` in the file, `test` in the process — the
    // process wins, so the production guards never even run here.
    expect(parse({ ...base, env: 'production' }).env).toBe('test');
    expect(parseProd({ ...prodBase, env: 'development' }).env).toBe('production');
  });

  it('reports missing required keys by path with a clear message', () => {
    // `ctx:` is the only section with no defaults, so an empty document
    // fails on the section itself...
    expect(() => parse({})).toThrow(/ctx: /);
    // ...and a half-filled one names the exact leaf that is missing.
    expect(() => parse({ ctx: { credentials: base.ctx.credentials } })).toThrow(/ctx\.baseUrl: /);
  });

  it('includes the validation reason alongside the path, not just the path', () => {
    try {
      parse({ ctx: { ...base.ctx, baseUrl: 'not-a-url' } });
      expect.fail('should have thrown');
    } catch (err) {
      // We emit 'path: reason' rather than a bare path.
      expect((err as Error).message).toMatch(/ctx\.baseUrl: /);
    }
  });

  it('names the source in the error so an operator knows which file failed', () => {
    expect(() => parseConfig({}, '/etc/loop/config.yaml')).toThrow(
      /Invalid configuration in \/etc\/loop\/config\.yaml/,
    );
  });

  // YAML writes `key:` with no value as null. An operator commenting a
  // setting out that way means "unset", not "the value null" — the
  // loader strips nulls before validation so optional keys stay
  // optional and defaulted keys still get their default.
  it('treats a null value (a bare `key:` in YAML) as absent', () => {
    const config = parse({
      ...base,
      observability: { sentry: { dsn: null } },
      server: { logLevel: null },
    });
    expect(config.observability.sentry.dsn).toBeUndefined();
    expect(config.server.logLevel).toBe('info');
  });

  describe('server', () => {
    it('accepts a port override and rejects one outside the TCP range', () => {
      expect(parse({ ...base, server: { port: 9090 } }).server.port).toBe(9090);
      expect(() => parse({ ...base, server: { port: 0 } })).toThrow(/server\.port/);
      expect(() => parse({ ...base, server: { port: 65536 } })).toThrow(/server\.port/);
      expect(() => parse({ ...base, server: { port: -1 } })).toThrow(/server\.port/);
    });

    // The env format had to coerce every value out of a string, which
    // is where `TRUST_PROXY=false` silently meaning `true` came from.
    // YAML has real scalars, so a quoted string is now an operator
    // mistake worth rejecting rather than guessing at.
    it('rejects a stringly-typed port or boolean instead of coercing it', () => {
      expect(() => parse({ ...base, server: { port: '9090' } })).toThrow(/server\.port/);
      expect(() => parse({ ...base, server: { trustProxy: 'yes' } })).toThrow(/server\.trustProxy/);
    });

    it('accepts every pino level, including silent and fatal', () => {
      expect(parse({ ...base, server: { logLevel: 'silent' } }).server.logLevel).toBe('silent');
      expect(parse({ ...base, server: { logLevel: 'fatal' } }).server.logLevel).toBe('fatal');
      expect(() => parse({ ...base, server: { logLevel: 'verbose' } })).toThrow(/server\.logLevel/);
    });
  });

  describe('ctx', () => {
    it('accepts http and https base URLs', () => {
      expect(
        parse({ ...base, ctx: { ...base.ctx, baseUrl: 'http://local.test' } }).ctx.baseUrl,
      ).toBe('http://local.test');
      expect(
        parse({ ...base, ctx: { ...base.ctx, baseUrl: 'https://spend.ctx.com' } }).ctx.baseUrl,
      ).toBe('https://spend.ctx.com');
    });

    it('rejects a non-http(s) base URL', () => {
      for (const baseUrl of ['file:///etc/passwd', 'ftp://upstream.example.com']) {
        expect(() => parse({ ...base, ctx: { ...base.ctx, baseUrl } })).toThrow(/ctx\.baseUrl/);
      }
    });

    // ADR 052: CTX is the payment processor, so the operator API creds
    // are boot-required.
    it('rejects a document without the operator API credentials', () => {
      expect(() => parse({ ctx: { baseUrl: base.ctx.baseUrl } })).toThrow(/ctx\.credentials/);
      expect(() => parse({ ctx: { ...base.ctx, credentials: { key: '', secret: 'x' } } })).toThrow(
        /ctx\.credentials\.key/,
      );
    });

    // Audit A-018: the web bundle hardcodes DEFAULT_CLIENT_IDS at build
    // time, so a server-side override that isn't mirrored into a web
    // rebuild breaks the X-Client-Id allowlist (A-036) after login.
    it('warns when a client id diverges from the shared default', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parse({ ...base, ctx: { ...base.ctx, clientIds: { web: 'customweb' } } });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ctx.clientIds.web=customweb'));
      warn.mockRestore();
    });

    it('stays quiet when the client ids match the shared defaults', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parse(base);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // The document store (post-Drizzle): `database.driver` picks the
  // driver and, as a discriminated union, drags in exactly the keys
  // that driver needs — the old "DB_DRIVER=mongo requires MONGODB_URI"
  // boot guard is now a parse error with the path already in it.
  describe('database', () => {
    it('defaults to the memory driver with the _data/db.json path', () => {
      const config = parse(base);
      expect(config.database).toEqual({ driver: 'memory', jsonPath: '_data/db.json' });
    });

    it('rejects an unknown driver', () => {
      expect(() => parse({ ...base, database: { driver: 'postgres' } })).toThrow(
        /database\.driver/,
      );
    });

    it("accepts a jsonPath override, including '' (ephemeral, no persistence)", () => {
      expect(
        parse({ ...base, database: { driver: 'memory', jsonPath: '/var/data/loop.json' } })
          .database,
      ).toEqual({ driver: 'memory', jsonPath: '/var/data/loop.json' });
      expect(parse({ ...base, database: { driver: 'memory', jsonPath: '' } }).database).toEqual({
        driver: 'memory',
        jsonPath: '',
      });
    });

    it('accepts mongodb:// and mongodb+srv:// connection strings', () => {
      for (const uri of [
        'mongodb://localhost:27017',
        'mongodb+srv://cluster.example.mongodb.net',
      ]) {
        expect(parse({ ...base, database: { driver: 'mongo', uri } }).database).toMatchObject({
          driver: 'mongo',
          uri,
          name: 'loop',
        });
      }
    });

    it('rejects a URI that is not a mongodb URL', () => {
      // A well-formed URL on the wrong scheme is the classic paste
      // error (postgres:// from the old stack) — must fail loudly.
      for (const uri of [
        'not-a-url',
        'postgres://user:pass@localhost:5432/loop',
        'https://localhost:27017',
      ]) {
        expect(() => parse({ ...base, database: { driver: 'mongo', uri } })).toThrow(
          /database\.uri/,
        );
      }
    });

    it('fails at boot when the mongo driver is picked with no uri', () => {
      expect(() => parse({ ...base, database: { driver: 'mongo' } })).toThrow(/database\.uri/);
    });

    it('accepts a database name override', () => {
      expect(
        parse({
          ...base,
          database: { driver: 'mongo', uri: 'mongodb://localhost:27017', name: 'loop_test' },
        }).database,
      ).toMatchObject({ name: 'loop_test' });
    });
  });

  // CF2-17 (2026-06-30 cold audit): length alone doesn't rule out a
  // guessable signing key — a 32-char string of one repeated character
  // passes `.min(32)` but has zero real entropy.
  describe('signing-key entropy validation', () => {
    const hs256 = (jwt: Record<string, unknown>): unknown => ({
      ...base,
      auth: { native: { enabled: true, jwt: { hs256: jwt } } },
    });

    it('accepts a realistic random-looking key', () => {
      expect(() => parse(hs256({ current: JWT_KEY }))).not.toThrow();
    });

    it('rejects a 32-char single-repeated-character key despite meeting the length bar', () => {
      expect(() => parse(hs256({ current: 'a'.repeat(32) }))).toThrow(
        /auth\.native\.jwt\.hs256\.current.*low-entropy/,
      );
    });

    it('rejects a short repeating-cycle key (e.g. "ab" repeated)', () => {
      expect(() => parse(hs256({ current: 'ab'.repeat(17) }))).toThrow(/low-entropy/);
    });

    it('applies the same check to the previous-key slot', () => {
      expect(() => parse(hs256({ current: JWT_KEY, previous: 'c'.repeat(32) }))).toThrow(
        /auth\.native\.jwt\.hs256\.previous.*low-entropy/,
      );
    });

    it('still enforces the minimum-length bar independently of entropy', () => {
      expect(() => parse(hs256({ current: 'short' }))).toThrow(
        /auth\.native\.jwt\.hs256\.current must be at least 32 characters/,
      );
    });
  });

  // ADR 030 Phase A: the RS256 signing keys are PEM-validated at parse
  // time — a malformed or non-RSA PEM must fail the boot rather than
  // surface as a 500 on the first token mint or JWKS fetch.
  describe('RS256 signing keys (ADR 030 Phase A)', () => {
    // Generated at runtime — never commit a PEM fixture, even test-only.
    const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    const ecPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();

    const rs256 = (jwt: Record<string, unknown>): unknown => ({
      ...base,
      auth: { native: { jwt: { rs256: jwt } } },
    });

    it('is optional — absent leaves RS256 unconfigured', () => {
      const config = parse(base);
      expect(config.auth.native.jwt.rs256.current).toBeUndefined();
      expect(config.auth.native.jwt.rs256.previous).toBeUndefined();
    });

    it('accepts a valid PKCS8 RSA PEM on both slots', () => {
      const config = parse(rs256({ current: rsaPem, previous: rsaPem }));
      expect(config.auth.native.jwt.rs256.current).toBe(rsaPem);
      expect(config.auth.native.jwt.rs256.previous).toBe(rsaPem);
    });

    it('normalises escaped \\n sequences to real newlines (secret-store flattening)', () => {
      const flattened = rsaPem.replace(/\n/g, '\\n');
      expect(parse(rs256({ current: flattened })).auth.native.jwt.rs256.current).toBe(rsaPem);
    });

    it('rejects a malformed PEM with the openssl hint', () => {
      expect(() => parse(rs256({ current: 'not-a-pem' }))).toThrow(
        /auth\.native\.jwt\.rs256\.current.*openssl genpkey/,
      );
    });

    it('rejects a truncated PEM', () => {
      expect(() => parse(rs256({ current: rsaPem.slice(0, 80) }))).toThrow(
        /auth\.native\.jwt\.rs256\.current/,
      );
    });

    it('rejects a non-RSA (EC) private key', () => {
      expect(() => parse(rs256({ current: ecPem }))).toThrow(/must be an RSA private key/);
    });

    it('validates the previous slot with the same rules', () => {
      expect(() => parse(rs256({ current: rsaPem, previous: 'garbage' }))).toThrow(
        /auth\.native\.jwt\.rs256\.previous/,
      );
    });
  });

  // Hardening B3: native auth without any signing key used to surface
  // as a 500 on the first verify-otp/refresh. The schema expresses it
  // as a parse error on `auth.native.jwt` instead.
  describe('native-auth signing-key requirement', () => {
    it('refuses auth.native.enabled with no signing capability, in any env', () => {
      for (const nodeEnv of ['development', 'test', 'production'] as const) {
        expect(() =>
          withNodeEnv(nodeEnv, () =>
            parseConfig({ ...base, auth: { native: { enabled: true } } }, 'test config'),
          ),
        ).toThrow(/auth\.native\.enabled requires a signing key/);
      }
    });

    it('accepts native auth with only the HS256 key', () => {
      expect(() =>
        parse({
          ...base,
          auth: { native: { enabled: true, jwt: { hs256: { current: JWT_KEY } } } },
        }),
      ).not.toThrow();
    });

    it('accepts native auth with only the RS256 key', () => {
      const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      expect(() =>
        parse({ ...base, auth: { native: { enabled: true, jwt: { rs256: { current: pem } } } } }),
      ).not.toThrow();
    });

    it('leaves native-auth-disabled documents unconstrained', () => {
      expect(() => parse(base)).not.toThrow();
    });
  });

  // Hardening B7: HS256 retirement tripwire. After an RS256 cutover the
  // HS256 key must go once the refresh window elapses.
  describe('B7: HS256 retirement tripwire', () => {
    it('warns on every boot while both the RSA and HS256 keys are set', () => {
      const pem = generateKeyPairSync('rsa', { modulusLength: 2048 })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parse({
        ...base,
        auth: {
          native: { enabled: true, jwt: { hs256: { current: JWT_KEY }, rs256: { current: pem } } },
        },
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('remove the hs256 key'));
      warn.mockRestore();
    });

    it('stays quiet when only one signing family is configured', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parse({ ...base, auth: { native: { enabled: true, jwt: { hs256: { current: JWT_KEY } } } } });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  describe('email', () => {
    it('defaults to the console provider with the Loop sender identity', () => {
      const config = parse(base);
      expect(config.email.provider).toBe('console');
      expect(config.email.from).toEqual({ address: 'noreply@loopfinance.io', name: 'Loop' });
    });

    // FT-09: the resend provider without a key is a silent login outage
    // (every OTP swallowed into a fake 200). The discriminated union
    // makes it un-representable rather than a boot guard.
    it('requires an apiKey for the resend provider', () => {
      expect(() => parse({ ...base, email: { provider: 'resend' } })).toThrow(/email\.apiKey/);
      expect(() => parse({ ...base, email: { provider: 'resend', apiKey: '' } })).toThrow(
        /email\.apiKey/,
      );
      expect(
        parse({ ...base, email: { provider: 'resend', apiKey: 're_test_key_value' } }).email,
      ).toMatchObject({ provider: 'resend', apiKey: 're_test_key_value' });
    });

    it('rejects an unknown provider', () => {
      expect(() => parse({ ...base, email: { provider: 'mailgun' } })).toThrow(/email\.provider/);
    });
  });

  // A2-203: the fallback cashback split must respect the
  // `userCashback + margin + wholesale = 100` invariant.
  describe('A2-203: orders.cashbackDefaults', () => {
    it('defaults to a 0/0 split', () => {
      const config = parse(base);
      expect(config.orders.cashbackDefaults.userCashbackPct).toBe(0);
      expect(config.orders.cashbackDefaults.loopMarginPct).toBe(0);
    });

    it('accepts a valid non-zero split (8% cashback + 2% margin)', () => {
      const config = parse({
        ...base,
        orders: { ...base.orders, cashbackDefaults: { userCashbackPct: 8, loopMarginPct: 2 } },
      });
      expect(config.orders.cashbackDefaults.userCashbackPct).toBe(8);
      expect(config.orders.cashbackDefaults.loopMarginPct).toBe(2);
    });

    it('rejects non-numeric and over-precise percentages', () => {
      expect(() =>
        parse({
          ...base,
          orders: { ...base.orders, cashbackDefaults: { userCashbackPct: 'eight' } },
        }),
      ).toThrow(/orders\.cashbackDefaults\.userCashbackPct/);
      expect(() =>
        parse({
          ...base,
          orders: { ...base.orders, cashbackDefaults: { loopMarginPct: 2.555 } },
        }),
      ).toThrow(/orders\.cashbackDefaults\.loopMarginPct/);
    });

    it('refuses a sum > 100 (wholesale would go negative)', () => {
      expect(() =>
        parse({
          ...base,
          orders: { ...base.orders, cashbackDefaults: { userCashbackPct: 80, loopMarginPct: 30 } },
        }),
      ).toThrow(/exceeds 100% of face value/);
    });
  });

  // CF-25 / X-PRIV-03: a wrong-length key would silently write
  // ciphertext nobody can later decrypt, so the decoded length is
  // validated whenever the key is present, in any env.
  describe('orders.redeem.encryptionKey', () => {
    it('rejects a key that does not decode to exactly 32 bytes', () => {
      expect(() =>
        parse({
          ...base,
          orders: { redeem: { encryptionKey: Buffer.from('short').toString('base64') } },
        }),
      ).toThrow(/must decode to exactly 32 bytes/);
    });

    it('accepts a 64-char hex key alongside the base64 form', () => {
      const hexKey = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
      expect(
        parse({ ...base, orders: { redeem: { encryptionKey: hexKey } } }).orders.redeem
          .encryptionKey,
      ).toBe(hexKey);
    });

    it('is optional outside production', () => {
      expect(() => parse({ ...base, orders: {} })).not.toThrow();
    });
  });

  // SEC-10: the Discord webhooks must be real HTTPS Discord webhook
  // URLs, not merely well-formed URLs. A non-Discord / non-HTTPS host
  // would exfiltrate every alert/audit embed off-platform.
  describe('SEC-10: Discord webhook URL host/scheme constraint', () => {
    const VALID = 'https://discord.com/api/webhooks/123456789012345678/tok-EN_value';
    const discord = (d: Record<string, unknown>): unknown => ({
      ...base,
      observability: { discord: d },
    });

    it('accepts a canonical HTTPS Discord webhook URL', () => {
      expect(parse(discord({ ordersWebhook: VALID })).observability.discord.ordersWebhook).toBe(
        VALID,
      );
    });

    it('accepts the versioned webhook path and ptb/canary hosts', () => {
      expect(() =>
        parse(
          discord({
            ordersWebhook: 'https://discord.com/api/v10/webhooks/1/abc',
            monitoringWebhook: 'https://canary.discord.com/api/webhooks/2/def',
          }),
        ),
      ).not.toThrow();
    });

    it('rejects a well-formed URL on a non-Discord host', () => {
      expect(() =>
        parse(discord({ ordersWebhook: 'https://evil.example.com/api/webhooks/1/2' })),
      ).toThrow(/observability\.discord\.ordersWebhook/);
    });

    it('rejects an http (non-TLS) Discord URL', () => {
      expect(() =>
        parse(discord({ monitoringWebhook: 'http://discord.com/api/webhooks/1/2' })),
      ).toThrow(/observability\.discord\.monitoringWebhook/);
    });

    it('rejects a Discord host with a non-webhook path', () => {
      expect(() => parse(discord({ monitoringWebhook: 'https://discord.com/login' }))).toThrow(
        /observability\.discord\.monitoringWebhook/,
      );
    });

    it('rejects a look-alike host (discord.com.evil.test)', () => {
      expect(() =>
        parse(discord({ ordersWebhook: 'https://discord.com.evil.test/api/webhooks/1/2' })),
      ).toThrow(/observability\.discord\.ordersWebhook/);
    });

    it('accepts the monitoring webhook fixture used across the suite', () => {
      expect(
        parse(discord({ monitoringWebhook: MONITORING_WEBHOOK })).observability.discord
          .monitoringWebhook,
      ).toBe(MONITORING_WEBHOOK);
    });
  });

  describe('rateLimit.machineCountEstimate', () => {
    it('defaults to 1 (no division)', () => {
      expect(parse(base).rateLimit.machineCountEstimate).toBe(1);
    });

    it('accepts a positive integer', () => {
      expect(
        parse({ ...base, rateLimit: { machineCountEstimate: 5 } }).rateLimit.machineCountEstimate,
      ).toBe(5);
    });

    it('rejects zero, negative and fractional values', () => {
      for (const machineCountEstimate of [0, -1, 1.5]) {
        expect(() => parse({ ...base, rateLimit: { machineCountEstimate } })).toThrow(
          /rateLimit\.machineCountEstimate/,
        );
      }
    });
  });

  describe('testing.endpointsSecret', () => {
    it('is unset by default', () => {
      expect(parse(base).testing.endpointsSecret).toBeUndefined();
    });

    it('accepts a secret of at least 16 chars outside production', () => {
      expect(
        parse({ ...base, testing: { endpointsSecret: 'a-secret-that-is-long-enough-16' } }).testing
          .endpointsSecret,
      ).toBe('a-secret-that-is-long-enough-16');
    });

    it('rejects a secret shorter than 16 chars in any env', () => {
      expect(() => parse({ ...base, testing: { endpointsSecret: 'too-short' } })).toThrow(
        /testing\.endpointsSecret/,
      );
    });
  });
});

/**
 * The production postures that are unsafe enough to refuse the boot
 * over. Each has an explicit `unsafe:` opt-out where a deliberate
 * rollback needs one.
 */
describe('production cross-field guards', () => {
  it('accepts a production document that clears every guard', () => {
    expect(() => parseProd(prodBase)).not.toThrow();
  });

  // A2-1605: disabling rate limiting bypasses every per-IP limiter.
  it('A2-1605: refuses production with rateLimit.enabled false', () => {
    expect(() => parseProd({ ...prodBase, rateLimit: { enabled: false } })).toThrow(
      /rateLimit\.enabled must not be false in production/,
    );
  });

  it('A2-1605: allows rateLimit.enabled false in development and test', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(() =>
        withNodeEnv(nodeEnv, () =>
          parseConfig({ ...base, rateLimit: { enabled: false } }, 'test config'),
        ),
      ).not.toThrow();
    }
  });

  // AUDIT-2-E: the secret only unlocks the test-only /__test__/* mount;
  // its presence in a production file means a copy-pasted config.
  it('AUDIT-2-E: refuses production when testing.endpointsSecret is set', () => {
    expect(() =>
      parseProd({ ...prodBase, testing: { endpointsSecret: 'a-secret-that-is-long-enough-16' } }),
    ).toThrow(/testing\.endpointsSecret must not be set in production/);
  });

  // R3-7: production must not silently fall back to the legacy
  // CTX-proxy auth path.
  it('R3-7: refuses production when auth.native.enabled is false or absent', () => {
    expect(() => parseProd(base)).toThrow(/auth\.native\.enabled must be true in production/);
    expect(() => parseProd({ ...base, auth: { native: { enabled: false } } })).toThrow(
      /auth\.native\.enabled must be true in production/,
    );
  });

  it('R3-7: allows unsafe.allowLegacyProxyAuth as the explicit rollback opt-out', () => {
    expect(() => parseProd({ ...base, unsafe: { allowLegacyProxyAuth: true } })).not.toThrow();
  });

  it('R3-7: does not enforce native auth outside production', () => {
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(() => withNodeEnv(nodeEnv, () => parseConfig(base, 'test config'))).not.toThrow();
    }
  });

  // A4-093 / FT-09: the console provider only logs OTPs to stdout, so
  // every login would silently fail while returning 200.
  it('A4-093: refuses production native auth with the console email provider', () => {
    expect(() => parseProd({ ...prodBase, email: { provider: 'console' } })).toThrow(
      /email\.provider must be a real provider/,
    );
  });

  it('A4-093: does not constrain the email provider when native auth is off', () => {
    expect(() =>
      parseProd({
        ...base,
        unsafe: { allowLegacyProxyAuth: true },
        email: { provider: 'console' },
      }),
    ).not.toThrow();
  });

  // NS-10 (CF-25 / X-PRIV-03): redeem codes/PINs are spendable bearer
  // secrets — production must encrypt them at rest.
  it('NS-10: refuses production when orders.redeem.encryptionKey is unset', () => {
    const prodMinusRedeem = { ...prodBase, orders: {} };
    expect(() => parseProd(prodMinusRedeem)).toThrow(
      /orders\.redeem\.encryptionKey must be set in production/,
    );
  });

  it('NS-10: allows unsafe.allowPlaintextRedeemSecrets as the explicit opt-out', () => {
    const prodMinusRedeem = { ...prodBase, orders: {} };
    expect(() =>
      parseProd({ ...prodMinusRedeem, unsafe: { allowPlaintextRedeemSecrets: true } }),
    ).not.toThrow();
  });

  it('NS-10: does not enforce the redeem key outside production', () => {
    const baseMinusRedeem = { ...base, orders: {} };
    for (const nodeEnv of ['development', 'test'] as const) {
      expect(() =>
        withNodeEnv(nodeEnv, () => parseConfig(baseMinusRedeem, 'test config')),
      ).not.toThrow();
    }
  });
});

describe('configFilePath', () => {
  it('resolves CONFIG_PATH against the working directory', () => {
    const previous = process.env['CONFIG_PATH'];
    try {
      process.env['CONFIG_PATH'] = 'somewhere/custom.yaml';
      expect(configFilePath()).toBe(resolve('somewhere/custom.yaml'));
      delete process.env['CONFIG_PATH'];
      expect(configFilePath()).toBe(resolve(DEFAULT_CONFIG_FILENAME));
    } finally {
      if (previous === undefined) delete process.env['CONFIG_PATH'];
      else process.env['CONFIG_PATH'] = previous;
    }
  });
});

describe('loadConfig', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-config-'));

  /** Write `contents` to a uniquely-named file in the temp dir. */
  function fixture(name: string, contents: string): string {
    const path = join(dir, name);
    writeFileSync(path, contents);
    return path;
  }

  it('reads, parses and validates a YAML file', () => {
    const path = fixture(
      'valid.yaml',
      [
        'ctx:',
        '  baseUrl: https://upstream.example.com',
        '  credentials:',
        '    key: k',
        '    secret: s',
        'server:',
        '  port: 9091',
        '',
      ].join('\n'),
    );
    const config = loadConfig(path);
    expect(config.ctx.baseUrl).toBe('https://upstream.example.com');
    expect(config.server.port).toBe(9091);
  });

  it('points the operator at config.example.yaml when the file is missing', () => {
    expect(() => loadConfig(join(dir, 'does-not-exist.yaml'))).toThrow(
      /Could not read the config file at .*does-not-exist\.yaml.*config\.example\.yaml/s,
    );
  });

  it('reports a YAML syntax error as such, not as a pile of missing keys', () => {
    const path = fixture('broken.yaml', 'ctx:\n  baseUrl: [unclosed\n');
    expect(() => loadConfig(path)).toThrow(/Could not parse .*broken\.yaml as YAML/);
  });

  it('reports an empty file as empty rather than reporting every key missing', () => {
    const path = fixture('empty.yaml', '# nothing but a comment\n');
    expect(() => loadConfig(path)).toThrow(/is empty or is not a YAML mapping/);
  });

  it('reports a non-mapping document as such', () => {
    const path = fixture('scalar.yaml', 'just-a-string\n');
    expect(() => loadConfig(path)).toThrow(/is empty or is not a YAML mapping/);
  });

  it('surfaces schema failures with the file path as the source', () => {
    const path = fixture('invalid.yaml', 'ctx:\n  baseUrl: not-a-url\n');
    expect(() => loadConfig(path)).toThrow(/Invalid configuration in .*invalid\.yaml/);
  });
});
