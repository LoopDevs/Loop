import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  parseConfig,
  loadConfig,
  configFilePath,
  DEFAULT_CONFIG_FILENAME,
} from '../config/index.js';

// A valid HTTPS Discord webhook URL (SEC-10 schema shape).
const MONITORING_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEf-gh_Ij';

// NS-10 (CF-25 / X-PRIV-03): production boots require the redeem key;
// carried in base so production fixtures satisfy the guard
const REDEEM_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const JWT_KEY = 'jwt-test-signing-key-32-chars-min!!';

// minimal doc: ctx.baseUrl + credentials are the only keys with no default (ADR 052)
const base = {
  ctx: {
    baseUrl: 'https://upstream.example.com',
    credentials: { key: 'test-operator-key', secret: 'test-operator-secret' },
  },
  orders: { redeem: { encryptionKey: REDEEM_KEY } },
};

// production doc clearing every boot guard (R3-7, A4-093, NS-10); guard tests break exactly one thing
const prodBase = {
  ...base,
  auth: { native: { enabled: true, jwt: { current: JWT_KEY } } },
  email: { provider: 'resend', credentials: { key: 're_test_key_value' } },
};

// NODE_ENV overrides the document's env: key and vitest always sets NODE_ENV=test,
// so production parses must move the process variable
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

function parseProd(document: unknown): ReturnType<typeof parseConfig> {
  return withNodeEnv('production', () => parseConfig(document, 'test config'));
}

function parse(document: unknown): ReturnType<typeof parseConfig> {
  return parseConfig(document, 'test config');
}

describe('parseConfig', () => {
  it('parses a minimal valid document and fills in every default', () => {
    const config = parse(base);
    expect(config.server.port).toBe(8080);
    expect(config.server.logLevel).toBe('info');
    expect(config.server.trustProxy).toBe(false);
    expect(config.server.corsOrigins).toEqual([]);
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

  // node tooling sets NODE_ENV itself, so a test run must not take development branches under a `test` process
  it('lets NODE_ENV override the document env: key', () => {
    expect(parse({ ...base, env: 'production' }).env).toBe('test');
    expect(parseProd({ ...prodBase, env: 'development' }).env).toBe('production');
  });

  it('reports missing required keys by path with a clear message', () => {
    expect(() => parse({})).toThrow(/ctx: /);
    expect(() => parse({ ctx: { credentials: base.ctx.credentials } })).toThrow(/ctx\.baseUrl: /);
  });

  it('includes the validation reason alongside the path, not just the path', () => {
    try {
      parse({ ctx: { ...base.ctx, baseUrl: 'not-a-url' } });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toMatch(/ctx\.baseUrl: /);
    }
  });

  it('names the source in the error so an operator knows which file failed', () => {
    expect(() => parseConfig({}, '/etc/loop/config.yaml')).toThrow(
      /Invalid configuration in \/etc\/loop\/config\.yaml/,
    );
  });

  // a bare `key:` in YAML is null, meaning "unset" — the loader strips nulls so optional/defaulted keys stay intact
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

    // the env format's string coercion is where TRUST_PROXY=false meant true; YAML scalars make that a rejectable mistake
    it('rejects a stringly-typed port or boolean instead of coercing it', () => {
      expect(() => parse({ ...base, server: { port: '9090' } })).toThrow(/server\.port/);
      expect(() => parse({ ...base, server: { trustProxy: 'yes' } })).toThrow(/server\.trustProxy/);
    });

    it('accepts origin-shaped corsOrigins entries and rejects paths or bare hosts', () => {
      expect(
        parse({ ...base, server: { corsOrigins: ['https://web.staging.example.com'] } }).server
          .corsOrigins,
      ).toEqual(['https://web.staging.example.com']);
      expect(() =>
        parse({ ...base, server: { corsOrigins: ['https://a.example.com/path'] } }),
      ).toThrow(/server\.corsOrigins/);
      expect(() => parse({ ...base, server: { corsOrigins: ['a.example.com'] } })).toThrow(
        /server\.corsOrigins/,
      );
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

    it('rejects a document without the operator API credentials', () => {
      expect(() => parse({ ctx: { baseUrl: base.ctx.baseUrl } })).toThrow(/ctx\.credentials/);
      expect(() => parse({ ctx: { ...base.ctx, credentials: { key: '', secret: 'x' } } })).toThrow(
        /ctx\.credentials\.key/,
      );
    });

    // A-018: the web bundle hardcodes DEFAULT_CLIENT_IDS at build time,
    // so an unmirrored server override breaks the X-Client-Id allowlist (A-036) after login
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

  // database.driver is a discriminated union — the old DB_DRIVER/MONGODB_URI boot guard is now a parse error with the path
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
      // wrong-scheme URL is the classic paste error (postgres:// from the old stack)
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

  // CF2-17: length alone doesn't rule out a guessable key — a repeated character passes .min(32) with zero entropy
  describe('signing-key entropy validation', () => {
    const jwtDoc = (jwt: Record<string, unknown>): unknown => ({
      ...base,
      auth: { native: { enabled: true, jwt } },
    });

    it('accepts a realistic random-looking key', () => {
      expect(() => parse(jwtDoc({ current: JWT_KEY }))).not.toThrow();
    });

    it('rejects a 32-char single-repeated-character key despite meeting the length bar', () => {
      expect(() => parse(jwtDoc({ current: 'a'.repeat(32) }))).toThrow(
        /auth\.native\.jwt\.current.*low-entropy/,
      );
    });

    it('rejects a short repeating-cycle key (e.g. "ab" repeated)', () => {
      expect(() => parse(jwtDoc({ current: 'ab'.repeat(17) }))).toThrow(/low-entropy/);
    });

    it('applies the same check to the previous-key slot', () => {
      expect(() => parse(jwtDoc({ current: JWT_KEY, previous: 'c'.repeat(32) }))).toThrow(
        /auth\.native\.jwt\.previous.*low-entropy/,
      );
    });

    it('still enforces the minimum-length bar independently of entropy', () => {
      expect(() => parse(jwtDoc({ current: 'short' }))).toThrow(
        /auth\.native\.jwt\.current must be at least 32 characters/,
      );
    });
  });

  // Hardening B3: native auth without a signing key used to 500 on first verify-otp/refresh; now a parse error
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

    it('accepts native auth with a signing key', () => {
      expect(() =>
        parse({
          ...base,
          auth: { native: { enabled: true, jwt: { current: JWT_KEY } } },
        }),
      ).not.toThrow();
    });

    it('leaves native-auth-disabled documents unconstrained', () => {
      expect(() => parse(base)).not.toThrow();
    });
  });

  describe('email', () => {
    it('defaults to the console provider with the Loop sender identity', () => {
      const config = parse(base);
      expect(config.email.provider).toBe('console');
      expect(config.email.from).toEqual({ address: 'noreply@loopfinance.io', name: 'Loop' });
    });

    // FT-09: resend without a key is a silent login outage (OTPs swallowed into fake 200s) — the union makes it un-representable
    it('requires credentials.key for the resend provider', () => {
      expect(() => parse({ ...base, email: { provider: 'resend' } })).toThrow(/email\.credentials/);
      expect(() => parse({ ...base, email: { provider: 'resend', credentials: {} } })).toThrow(
        /email\.credentials\.key/,
      );
      expect(() =>
        parse({ ...base, email: { provider: 'resend', credentials: { key: '' } } }),
      ).toThrow(/email\.credentials\.key/);
      expect(
        parse({
          ...base,
          email: { provider: 'resend', credentials: { key: 're_test_key_value' } },
        }).email,
      ).toMatchObject({ provider: 'resend', credentials: { key: 're_test_key_value' } });
    });

    it('requires a region for the aws_ses provider', () => {
      expect(() => parse({ ...base, email: { provider: 'aws_ses' } })).toThrow(/email\.region/);
      expect(() => parse({ ...base, email: { provider: 'aws_ses', region: '' } })).toThrow(
        /email\.region/,
      );
    });

    it('accepts aws_ses without credentials (SDK default chain applies)', () => {
      const email = parse({ ...base, email: { provider: 'aws_ses', region: 'eu-west-1' } }).email;
      expect(email).toMatchObject({ provider: 'aws_ses', region: 'eu-west-1' });
      expect('credentials' in email && email.credentials !== undefined).toBe(false);
    });

    it('accepts aws_ses with a full static credential pair', () => {
      expect(
        parse({
          ...base,
          email: {
            provider: 'aws_ses',
            region: 'eu-west-1',
            credentials: { key: 'AKIA_TEST_KEY_ID', secret: 'test-secret' },
          },
        }).email,
      ).toMatchObject({
        provider: 'aws_ses',
        credentials: { key: 'AKIA_TEST_KEY_ID', secret: 'test-secret' },
      });
    });

    it('rejects a partial aws_ses credential pair', () => {
      expect(() =>
        parse({
          ...base,
          email: {
            provider: 'aws_ses',
            region: 'eu-west-1',
            credentials: { key: 'AKIA_TEST_KEY_ID' },
          },
        }),
      ).toThrow(/email\.credentials\.secret/);
    });

    it('rejects an unknown provider', () => {
      expect(() => parse({ ...base, email: { provider: 'mailgun' } })).toThrow(/email\.provider/);
    });
  });

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

  // CF-25 / X-PRIV-03: a wrong-length key would write ciphertext nobody can decrypt,
  // so the decoded length is validated whenever present
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

  // SEC-10: a non-Discord / non-HTTPS host would exfiltrate every alert/audit embed off-platform
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

describe('admin', () => {
  it('defaults to no allowlist and financial-grade audit retention', () => {
    const cfg = parse(base);
    expect(cfg.admin.emails).toEqual([]);
    expect(cfg.admin.ctxUserIds).toEqual([]);
    expect(cfg.admin.auditRetentionDays).toBe(2557);
  });

  it('accepts allowlists as lists', () => {
    const cfg = parse({
      ...base,
      admin: { emails: ['a@loop.test', 'b@loop.test'], ctxUserIds: ['ctx-1'] },
    });
    expect(cfg.admin.emails).toEqual(['a@loop.test', 'b@loop.test']);
    expect(cfg.admin.ctxUserIds).toEqual(['ctx-1']);
  });

  it('rejects a non-address in the email allowlist', () => {
    // a typo here silently grants nobody — a security-relevant no-op an operator wouldn't notice
    expect(() => parse({ ...base, admin: { emails: ['not-an-email'] } })).toThrow(
      /admin\.emails\.0/,
    );
  });

  it('rejects a non-positive audit retention', () => {
    expect(() => parse({ ...base, admin: { auditRetentionDays: 0 } })).toThrow(
      /admin\.auditRetentionDays/,
    );
  });
});

// production postures unsafe enough to refuse boot; each has an explicit unsafe: opt-out for deliberate rollback
describe('production cross-field guards', () => {
  it('accepts a production document that clears every guard', () => {
    expect(() => parseProd(prodBase)).not.toThrow();
  });

  it('A2-1605: forces rateLimit.enabled true in production, warning if set false', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const cfg = parseProd({ ...prodBase, rateLimit: { enabled: false } });
      expect(cfg.rateLimit.enabled).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('rateLimit.enabled=false'));
    } finally {
      warn.mockRestore();
    }
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

  // the secret only unlocks the test-only /__test__/* mount; in a production file it means copy-pasted config
  it('AUDIT-2-E: refuses production when testing.endpointsSecret is set', () => {
    expect(() =>
      parseProd({ ...prodBase, testing: { endpointsSecret: 'a-secret-that-is-long-enough-16' } }),
    ).toThrow(/testing\.endpointsSecret must not be set in production/);
  });

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

  // the console provider only logs OTPs to stdout, so every login would silently fail while returning 200
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

  // redeem codes/PINs are spendable bearer secrets — production must encrypt them at rest
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
