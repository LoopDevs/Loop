import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

// env.ts validates process.env at module-load time, so we must make the parse
// succeed on import even though our individual tests exercise parseEnv with
// synthetic inputs. vi.hoisted runs before the import below.
vi.hoisted(() => {
  if (!process.env.GIFT_CARD_API_BASE_URL) {
    process.env.GIFT_CARD_API_BASE_URL = 'https://placeholder-for-import.local';
  }
  process.env.GIFT_CARD_API_KEY ??= 'placeholder-api-key';
  process.env.GIFT_CARD_API_SECRET ??= 'placeholder-api-secret';
});

import { parseEnv } from '../env.js';

// A valid HTTPS Discord webhook URL (SEC-10 schema shape).
const MONITORING_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEf-gh_Ij';

// Minimum viable env — everything else is optional or has a default.
// NS-10 (CF-25 / X-PRIV-03): production boots require
// LOOP_REDEEM_ENCRYPTION_KEY (or the explicit opt-out). A 32-byte key
// (base64 of "0123456789abcdef0123456789abcdef") that also clears the
// 32-byte length validation. Carried in `base` so every
// production-success fixture that spreads `...base` satisfies the
// guard; it's optional in dev/test, so its presence is inert for the
// dev parses.
const REDEEM_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const base = {
  GIFT_CARD_API_BASE_URL: 'https://upstream.example.com',
  GIFT_CARD_API_KEY: 'test-operator-key',
  GIFT_CARD_API_SECRET: 'test-operator-secret',
  LOOP_REDEEM_ENCRYPTION_KEY: REDEEM_KEY,
};

const JWT_KEY = 'jwt-test-signing-key-32-chars-min!!';

// R3-7: production boots require native auth enabled + a signing key
// (or the explicit rollback opt-out), so production-success fixtures
// carry the pair.
const prodBase = {
  ...base,
  NODE_ENV: 'production' as const,
  LOOP_AUTH_NATIVE_ENABLED: 'true' as const,
  LOOP_JWT_SIGNING_KEY: JWT_KEY,
};

describe('parseEnv', () => {
  it('parses a minimal valid env with defaults', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.LOCATION_REFRESH_INTERVAL_HOURS).toBe(24);
    expect(env.CTX_CLIENT_ID_WEB).toBe('loopweb');
  });

  it('coerces PORT from string and rejects non-numeric', () => {
    expect(parseEnv({ ...base, PORT: '9090' }).PORT).toBe(9090);
    expect(() => parseEnv({ ...base, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('rejects PORT outside valid TCP range', () => {
    expect(() => parseEnv({ ...base, PORT: '0' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...base, PORT: '65536' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...base, PORT: '-1' })).toThrow(/PORT/);
  });

  it('rejects non-http(s) URLs for GIFT_CARD_API_BASE_URL', () => {
    expect(() => parseEnv({ GIFT_CARD_API_BASE_URL: 'file:///etc/passwd' })).toThrow(
      /GIFT_CARD_API_BASE_URL/,
    );
    expect(() => parseEnv({ GIFT_CARD_API_BASE_URL: 'ftp://upstream.example.com' })).toThrow(
      /GIFT_CARD_API_BASE_URL/,
    );
  });

  // ADR 052: ctx is the payment processor, so the operator API creds
  // are boot-required — a deployment without them would come up with
  // orders that never leave `unpaid`.
  it('rejects an env without the operator API credentials', () => {
    const withoutKey: Record<string, string> = { ...base };
    delete withoutKey['GIFT_CARD_API_KEY'];
    expect(() => parseEnv(withoutKey)).toThrow(/GIFT_CARD_API_KEY/);
    const withoutSecret: Record<string, string> = { ...base };
    delete withoutSecret['GIFT_CARD_API_SECRET'];
    expect(() => parseEnv(withoutSecret)).toThrow(/GIFT_CARD_API_SECRET/);
    expect(() => parseEnv({ ...base, GIFT_CARD_API_KEY: '' })).toThrow(/GIFT_CARD_API_KEY/);
  });

  it('accepts http and https for GIFT_CARD_API_BASE_URL', () => {
    expect(
      parseEnv({ ...base, GIFT_CARD_API_BASE_URL: 'http://local.test' }).GIFT_CARD_API_BASE_URL,
    ).toBe('http://local.test');
    expect(
      parseEnv({ ...base, GIFT_CARD_API_BASE_URL: 'https://spend.ctx.com' }).GIFT_CARD_API_BASE_URL,
    ).toBe('https://spend.ctx.com');
  });

  // A2-203: the default cashback split must respect userCashback +
  // margin + wholesale = 100 invariant. A misconfigured env should
  // fail at boot rather than silently over-granting cashback.
  it('A2-203: defaults to 0/0 for DEFAULT_USER_CASHBACK_PCT_OF_CTX + DEFAULT_LOOP_MARGIN_PCT_OF_CTX', () => {
    const env = parseEnv(base);
    expect(env.DEFAULT_USER_CASHBACK_PCT_OF_CTX).toBe('0.00');
    expect(env.DEFAULT_LOOP_MARGIN_PCT_OF_CTX).toBe('0.00');
  });

  it('A2-203: accepts a valid non-zero split (8% cashback + 2% margin)', () => {
    const env = parseEnv({
      ...base,
      DEFAULT_USER_CASHBACK_PCT_OF_CTX: '8.00',
      DEFAULT_LOOP_MARGIN_PCT_OF_CTX: '2.00',
    });
    expect(env.DEFAULT_USER_CASHBACK_PCT_OF_CTX).toBe('8.00');
    expect(env.DEFAULT_LOOP_MARGIN_PCT_OF_CTX).toBe('2.00');
  });

  it('A2-203: rejects non-percent strings', () => {
    expect(() => parseEnv({ ...base, DEFAULT_USER_CASHBACK_PCT_OF_CTX: 'eight' })).toThrow(
      /DEFAULT_USER_CASHBACK_PCT_OF_CTX/,
    );
    expect(() => parseEnv({ ...base, DEFAULT_LOOP_MARGIN_PCT_OF_CTX: '2.555' })).toThrow(
      /DEFAULT_LOOP_MARGIN_PCT_OF_CTX/,
    );
  });

  it('A2-203: refuses a sum > 100 (wholesale would go negative)', () => {
    expect(() =>
      parseEnv({
        ...base,
        DEFAULT_USER_CASHBACK_PCT_OF_CTX: '80.00',
        DEFAULT_LOOP_MARGIN_PCT_OF_CTX: '30.00',
      }),
    ).toThrow(/exceeds 100%/);
  });

  it('includes the actual validation reason in the error, not just the path', () => {
    try {
      parseEnv({ GIFT_CARD_API_BASE_URL: 'not-a-url' });
      expect.fail('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('GIFT_CARD_API_BASE_URL');
      // We now emit 'path: reason' instead of just 'path'
      expect(message).toMatch(/GIFT_CARD_API_BASE_URL:/);
    }
  });

  it('reports missing required vars with a clear message', () => {
    try {
      parseEnv({});
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('GIFT_CARD_API_BASE_URL');
    }
  });

  // Regression: `z.coerce.boolean()` treats any non-empty string as true,
  // so `TRUST_PROXY=false` would silently enable X-Forwarded-For trust —
  // the opposite of what the operator wrote. The custom envBoolean parser
  // must honour the common "off" spellings.
  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['TRUE', true],
    ['Yes', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['False', false],
    ['', false],
  ])('envBoolean TRUST_PROXY=%j → %s', (input, expected) => {
    expect(parseEnv({ ...base, TRUST_PROXY: input }).TRUST_PROXY).toBe(expected);
  });

  it('rejects unparseable TRUST_PROXY values instead of guessing', () => {
    expect(() => parseEnv({ ...base, TRUST_PROXY: 'maybe' })).toThrow(/TRUST_PROXY/);
  });

  it('accepts pino levels silent and fatal', () => {
    expect(parseEnv({ ...base, LOG_LEVEL: 'silent' }).LOG_LEVEL).toBe('silent');
    expect(parseEnv({ ...base, LOG_LEVEL: 'fatal' }).LOG_LEVEL).toBe('fatal');
  });

  it('rejects unknown LOG_LEVEL', () => {
    expect(() => parseEnv({ ...base, LOG_LEVEL: 'verbose' })).toThrow(/LOG_LEVEL/);
  });

  it('rejects Discord webhook URLs that are not URLs', () => {
    expect(() => parseEnv({ ...base, DISCORD_WEBHOOK_ORDERS: 'not-a-url' })).toThrow(
      /DISCORD_WEBHOOK_ORDERS/,
    );
  });

  // The document store (post-Drizzle): DB_DRIVER picks the driver, the
  // memory driver persists to DB_JSON_PATH, the mongo driver needs a
  // real mongodb:// connection string.
  describe('document-store configuration (DB_DRIVER / DB_JSON_PATH / MONGODB_*)', () => {
    it('defaults to the memory driver with the data/db.json path and the loop database name', () => {
      const env = parseEnv(base);
      expect(env.DB_DRIVER).toBe('memory');
      expect(env.DB_JSON_PATH).toBe('data/db.json');
      expect(env.MONGODB_DB).toBe('loop');
      expect(env.MONGODB_URI).toBeUndefined();
    });

    it('rejects an unknown DB_DRIVER value', () => {
      expect(() => parseEnv({ ...base, DB_DRIVER: 'postgres' })).toThrow(/DB_DRIVER/);
    });

    it("accepts DB_JSON_PATH overrides, including '' (ephemeral, no persistence)", () => {
      expect(parseEnv({ ...base, DB_JSON_PATH: '/var/data/loop.json' }).DB_JSON_PATH).toBe(
        '/var/data/loop.json',
      );
      expect(parseEnv({ ...base, DB_JSON_PATH: '' }).DB_JSON_PATH).toBe('');
    });

    it('accepts mongodb:// and mongodb+srv:// connection strings', () => {
      expect(parseEnv({ ...base, MONGODB_URI: 'mongodb://localhost:27017' }).MONGODB_URI).toBe(
        'mongodb://localhost:27017',
      );
      expect(
        parseEnv({ ...base, MONGODB_URI: 'mongodb+srv://cluster.example.mongodb.net' }).MONGODB_URI,
      ).toBe('mongodb+srv://cluster.example.mongodb.net');
    });

    it('rejects a MONGODB_URI that is not a mongodb URL', () => {
      expect(() => parseEnv({ ...base, MONGODB_URI: 'not-a-url' })).toThrow(/MONGODB_URI/);
      // A well-formed URL on the wrong scheme is the classic paste
      // error (postgres:// from the old stack) — must fail loudly.
      expect(() =>
        parseEnv({ ...base, MONGODB_URI: 'postgres://user:pass@localhost:5432/loop' }),
      ).toThrow(/MONGODB_URI/);
      expect(() => parseEnv({ ...base, MONGODB_URI: 'https://localhost:27017' })).toThrow(
        /MONGODB_URI/,
      );
    });

    it('DB_DRIVER=mongo without MONGODB_URI fails at boot (never on first collection access)', () => {
      expect(() => parseEnv({ ...base, DB_DRIVER: 'mongo' })).toThrow(
        /DB_DRIVER=mongo requires MONGODB_URI/,
      );
    });

    it('accepts DB_DRIVER=mongo once MONGODB_URI is set', () => {
      const env = parseEnv({
        ...base,
        DB_DRIVER: 'mongo',
        MONGODB_URI: 'mongodb://localhost:27017',
        MONGODB_DB: 'loop_test',
      });
      expect(env.DB_DRIVER).toBe('mongo');
      expect(env.MONGODB_DB).toBe('loop_test');
    });
  });

  // CF2-17 (2026-06-30 cold audit): length alone doesn't rule out a
  // guessable signing key — a 32-char string of one repeated character
  // passes `.min(32)` but has zero real entropy.
  describe('signing-key entropy validation', () => {
    const REAL_KEY = 'jwt-test-signing-key-32-chars-min!!';

    it('accepts a realistic random-looking key', () => {
      expect(() => parseEnv({ ...base, LOOP_JWT_SIGNING_KEY: REAL_KEY })).not.toThrow();
    });

    it('rejects a 32-char single-repeated-character key despite meeting the length bar', () => {
      expect(() => parseEnv({ ...base, LOOP_JWT_SIGNING_KEY: 'a'.repeat(32) })).toThrow(
        /LOOP_JWT_SIGNING_KEY.*low-entropy/,
      );
    });

    it('rejects a short repeating-cycle key (e.g. "ab" repeated)', () => {
      expect(() => parseEnv({ ...base, LOOP_JWT_SIGNING_KEY: 'ab'.repeat(17) })).toThrow(
        /low-entropy/,
      );
    });

    it('applies the same check to LOOP_JWT_SIGNING_KEY_PREVIOUS', () => {
      expect(() =>
        parseEnv({
          ...base,
          LOOP_JWT_SIGNING_KEY: REAL_KEY,
          LOOP_JWT_SIGNING_KEY_PREVIOUS: 'c'.repeat(32),
        }),
      ).toThrow(/LOOP_JWT_SIGNING_KEY_PREVIOUS.*low-entropy/);
    });

    it('still enforces the minimum-length bar independently of entropy', () => {
      expect(() => parseEnv({ ...base, LOOP_JWT_SIGNING_KEY: 'short' })).toThrow(
        /LOOP_JWT_SIGNING_KEY must be at least 32 characters/,
      );
    });
  });

  // A2-1605: DISABLE_RATE_LIMITING is a test-harness flag; production
  // with it set opens every rate-limited route to volumetric abuse.
  describe('A2-1605: DISABLE_RATE_LIMITING production guard', () => {
    it('refuses to start in production when DISABLE_RATE_LIMITING=true', () => {
      expect(() =>
        parseEnv({
          ...prodBase,
          DISABLE_RATE_LIMITING: 'true',
        }),
      ).toThrow(/DISABLE_RATE_LIMITING/);
    });

    it('refuses in production on the boolean coercions too (1 / yes / on)', () => {
      for (const v of ['1', 'yes', 'on']) {
        expect(() =>
          parseEnv({
            ...prodBase,
            DISABLE_RATE_LIMITING: v,
          }),
        ).toThrow(/DISABLE_RATE_LIMITING/);
      }
    });

    it('accepts DISABLE_RATE_LIMITING=true in development + test', () => {
      for (const nodeEnv of ['development', 'test'] as const) {
        const env = parseEnv({ ...base, NODE_ENV: nodeEnv, DISABLE_RATE_LIMITING: 'true' });
        expect(env.DISABLE_RATE_LIMITING).toBe(true);
      }
    });

    it('accepts production when DISABLE_RATE_LIMITING is unset / false', () => {
      expect(() => parseEnv(prodBase)).not.toThrow();
      expect(() => parseEnv({ ...prodBase, DISABLE_RATE_LIMITING: 'false' })).not.toThrow();
    });
  });

  // AUDIT-2-E: LOOP_TEST_ENDPOINTS_SECRET only has meaning alongside
  // NODE_ENV==='test' (it gates the test-only /__test__/* mount) and
  // has no business being present in a production env at all.
  describe('AUDIT-2-E: LOOP_TEST_ENDPOINTS_SECRET production guard', () => {
    it('refuses to start in production when LOOP_TEST_ENDPOINTS_SECRET is set', () => {
      expect(() =>
        parseEnv({
          ...prodBase,
          LOOP_TEST_ENDPOINTS_SECRET: 'a-secret-that-is-long-enough-16',
        }),
      ).toThrow(/LOOP_TEST_ENDPOINTS_SECRET/);
    });

    it('accepts production when LOOP_TEST_ENDPOINTS_SECRET is unset', () => {
      expect(() => parseEnv(prodBase)).not.toThrow();
    });

    it('accepts LOOP_TEST_ENDPOINTS_SECRET in development + test', () => {
      for (const nodeEnv of ['development', 'test'] as const) {
        const env = parseEnv({
          ...base,
          NODE_ENV: nodeEnv,
          LOOP_TEST_ENDPOINTS_SECRET: 'a-secret-that-is-long-enough-16',
        });
        expect(env.LOOP_TEST_ENDPOINTS_SECRET).toBe('a-secret-that-is-long-enough-16');
      }
    });

    it('rejects a secret shorter than 16 chars in any NODE_ENV', () => {
      expect(() =>
        parseEnv({ ...base, NODE_ENV: 'test', LOOP_TEST_ENDPOINTS_SECRET: 'too-short' }),
      ).toThrow();
    });
  });

  // Hardening B7 (2026-07 plan): HS256 retirement tripwire.
  describe('B7: HS256 retirement tripwire', () => {
    it('warns on every boot while both the RSA and HS256 keys are set', () => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({
        ...base,
        LOOP_JWT_SIGNING_KEY: JWT_KEY,
        LOOP_JWT_RSA_PRIVATE_KEY: pem,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('remove LOOP_JWT_SIGNING_KEY'));
      warn.mockRestore();
    });

    it('stays quiet when only one signing family is configured', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({ ...base, LOOP_JWT_SIGNING_KEY: JWT_KEY });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // Hardening B3 (2026-07 plan): the auth misconfiguration that
  // previously only surfaced at request time now fails at boot.
  describe('B3: native-auth signing-key boot guard', () => {
    it('refuses LOOP_AUTH_NATIVE_ENABLED=true with no signing capability (any env)', () => {
      for (const nodeEnv of ['development', 'test', 'production'] as const) {
        expect(() =>
          parseEnv({
            ...base,
            NODE_ENV: nodeEnv,
            LOOP_AUTH_NATIVE_ENABLED: 'true',
          }),
        ).toThrow(/LOOP_AUTH_NATIVE_ENABLED=true requires a JWT signing key/);
      }
    });

    it('accepts native auth with the HS256 key', () => {
      expect(() =>
        parseEnv({
          ...base,
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
        }),
      ).not.toThrow();
    });

    it('accepts native auth with only the RS256 key', () => {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      expect(() =>
        parseEnv({
          ...base,
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_RSA_PRIVATE_KEY: pem,
        }),
      ).not.toThrow();
    });

    it('leaves native-auth-disabled configs unconstrained', () => {
      expect(() => parseEnv({ ...base })).not.toThrow();
    });
  });

  describe('R3-7: production native-auth boot guard', () => {
    it('refuses production when LOOP_AUTH_NATIVE_ENABLED is unset or false', () => {
      for (const value of [undefined, 'false'] as const) {
        expect(() =>
          parseEnv({
            ...base,
            NODE_ENV: 'production',
            ...(value === undefined ? {} : { LOOP_AUTH_NATIVE_ENABLED: value }),
          }),
        ).toThrow(/LOOP_AUTH_NATIVE_ENABLED must be true in production/);
      }
    });

    it('accepts production with native auth enabled and a signing key', () => {
      expect(() => parseEnv(prodBase)).not.toThrow();
    });

    it('allows DISABLE_NATIVE_AUTH_ENFORCEMENT=1 as the explicit rollback opt-out', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
        }),
      ).not.toThrow();
    });

    it('rejects any rollback opt-out value other than "1" at parse time', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          DISABLE_NATIVE_AUTH_ENFORCEMENT: 'true',
        }),
      ).toThrow(/DISABLE_NATIVE_AUTH_ENFORCEMENT/);
    });

    it('does not enforce native auth outside production', () => {
      expect(() => parseEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
      expect(() => parseEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
    });
  });

  // CF2-10 (2026-06-30 cold audit) / PLAT-30-04 precedent: new env vars
  // need direct parseEnv-level coverage, not just indirect exercise via
  // a sibling module.
  describe('RATE_LIMIT_MACHINE_COUNT_ESTIMATE', () => {
    it('defaults to 1 (no division — same posture as TRUST_PROXY)', () => {
      const env = parseEnv({ ...base });
      expect(env.RATE_LIMIT_MACHINE_COUNT_ESTIMATE).toBe(1);
    });

    it('coerces a numeric string', () => {
      const env = parseEnv({ ...base, RATE_LIMIT_MACHINE_COUNT_ESTIMATE: '5' });
      expect(env.RATE_LIMIT_MACHINE_COUNT_ESTIMATE).toBe(5);
    });

    it('rejects zero and negative values', () => {
      expect(() => parseEnv({ ...base, RATE_LIMIT_MACHINE_COUNT_ESTIMATE: '0' })).toThrow();
      expect(() => parseEnv({ ...base, RATE_LIMIT_MACHINE_COUNT_ESTIMATE: '-1' })).toThrow();
    });
  });

  // S4-4 (2026-07-09): FLY_APP_NAME feeds the dynamic fleet-size
  // estimator (middleware/fleet-size.ts) that takes priority over
  // the static RATE_LIMIT_MACHINE_COUNT_ESTIMATE above. Platform-
  // injected (never admin-set), so it's optional with no default.
  describe('FLY_APP_NAME', () => {
    it('is undefined by default (local dev / CI / non-Fly hosts)', () => {
      const env = parseEnv({ ...base });
      expect(env.FLY_APP_NAME).toBeUndefined();
    });

    it('passes through whatever the Fly runtime injects', () => {
      const env = parseEnv({ ...base, FLY_APP_NAME: 'loopfinance-api' });
      expect(env.FLY_APP_NAME).toBe('loopfinance-api');
    });
  });

  // SEC-10: DISCORD_WEBHOOK_* must be real HTTPS Discord webhook URLs,
  // not merely well-formed URLs. A non-Discord / non-HTTPS host would
  // exfiltrate every alert/audit embed off-platform.
  describe('SEC-10: Discord webhook URL host/scheme constraint', () => {
    const VALID = 'https://discord.com/api/webhooks/123456789012345678/tok-EN_value';

    it('accepts a canonical HTTPS Discord webhook URL', () => {
      const env = parseEnv({ ...base, DISCORD_WEBHOOK_ORDERS: VALID });
      expect(env.DISCORD_WEBHOOK_ORDERS).toBe(VALID);
    });

    it('accepts the versioned webhook path and ptb/canary hosts', () => {
      expect(() =>
        parseEnv({
          ...base,
          DISCORD_WEBHOOK_ORDERS: 'https://discord.com/api/v10/webhooks/1/abc',
          DISCORD_WEBHOOK_MONITORING: 'https://canary.discord.com/api/webhooks/2/def',
        }),
      ).not.toThrow();
    });

    it('rejects a well-formed URL on a non-Discord host', () => {
      expect(() =>
        parseEnv({ ...base, DISCORD_WEBHOOK_ORDERS: 'https://evil.example.com/api/webhooks/1/2' }),
      ).toThrow(/DISCORD_WEBHOOK_ORDERS/);
    });

    it('rejects an http (non-TLS) Discord URL', () => {
      expect(() =>
        parseEnv({ ...base, DISCORD_WEBHOOK_MONITORING: 'http://discord.com/api/webhooks/1/2' }),
      ).toThrow(/DISCORD_WEBHOOK_MONITORING/);
    });

    it('rejects a Discord host with a non-webhook path', () => {
      expect(() =>
        parseEnv({ ...base, DISCORD_WEBHOOK_MONITORING: 'https://discord.com/login' }),
      ).toThrow(/DISCORD_WEBHOOK_MONITORING/);
    });

    it('rejects a look-alike host (discord.com.evil.test)', () => {
      expect(() =>
        parseEnv({
          ...base,
          DISCORD_WEBHOOK_ORDERS: 'https://discord.com.evil.test/api/webhooks/1/2',
        }),
      ).toThrow(/DISCORD_WEBHOOK_ORDERS/);
    });

    it('accepts the monitoring webhook fixture used across these tests', () => {
      const env = parseEnv({ ...base, DISCORD_WEBHOOK_MONITORING: MONITORING_WEBHOOK });
      expect(env.DISCORD_WEBHOOK_MONITORING).toBe(MONITORING_WEBHOOK);
    });
  });

  // NS-10 (CF-25 / X-PRIV-03 follow-up): production must ENCRYPT the
  // gift-card redeem code + PIN at rest. Before this guard the key was
  // opt-in and its absence only WARNed at boot, so a prod deploy that
  // forgot LOOP_REDEEM_ENCRYPTION_KEY silently stored every spendable
  // bearer secret in PLAINTEXT. parseEnv fails closed in production
  // when the key is unset, with a `"1"`-only opt-out. Dev/test keep
  // warn-and-allow.
  describe('NS-10: production redeem-encryption-key boot guard', () => {
    // A production config that clears every OTHER prod boot guard, so a
    // test can isolate the redeem-key check. `base` carries the redeem
    // key, so we explicitly UNSET it here to exercise the guard.
    const prodMinusRedeem = {
      ...prodBase,
      LOOP_REDEEM_ENCRYPTION_KEY: undefined,
    };

    it('refuses to start in production when LOOP_REDEEM_ENCRYPTION_KEY is unset', () => {
      expect(() => parseEnv(prodMinusRedeem)).toThrow(
        /LOOP_REDEEM_ENCRYPTION_KEY must be set in production/,
      );
    });

    it('refuses to start in production when LOOP_REDEEM_ENCRYPTION_KEY is empty', () => {
      expect(() => parseEnv({ ...prodMinusRedeem, LOOP_REDEEM_ENCRYPTION_KEY: '' })).toThrow(
        /LOOP_REDEEM_ENCRYPTION_KEY must be set in production/,
      );
    });

    it('accepts production once LOOP_REDEEM_ENCRYPTION_KEY is set', () => {
      const env = parseEnv({ ...prodMinusRedeem, LOOP_REDEEM_ENCRYPTION_KEY: REDEEM_KEY });
      expect(env.LOOP_REDEEM_ENCRYPTION_KEY).toBe(REDEEM_KEY);
    });

    it('allows DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT=1 as the explicit opt-out', () => {
      expect(() =>
        parseEnv({ ...prodMinusRedeem, DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT: '1' }),
      ).not.toThrow();
    });

    it('rejects any opt-out value other than "1" at parse time', () => {
      expect(() =>
        parseEnv({ ...prodMinusRedeem, DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT: 'true' }),
      ).toThrow(/DISABLE_REDEEM_ENCRYPTION_ENFORCEMENT/);
    });

    it('does not enforce the redeem key outside production (dev/test boot with the key unset)', () => {
      expect(() =>
        parseEnv({ ...base, LOOP_REDEEM_ENCRYPTION_KEY: undefined, NODE_ENV: 'development' }),
      ).not.toThrow();
      expect(() =>
        parseEnv({ ...base, LOOP_REDEEM_ENCRYPTION_KEY: undefined, NODE_ENV: 'test' }),
      ).not.toThrow();
    });

    // CF-25 / X-PRIV-03: a wrong-length key would silently write
    // ciphertext nobody can later decrypt, so parseEnv validates the
    // decoded length whenever the key is present (any NODE_ENV).
    it('rejects a key that does not decode to exactly 32 bytes', () => {
      expect(() =>
        parseEnv({ ...base, LOOP_REDEEM_ENCRYPTION_KEY: Buffer.from('short').toString('base64') }),
      ).toThrow(/must decode to 32 bytes/);
    });

    it('accepts a 64-char hex key alongside the base64 form', () => {
      const hexKey = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
      expect(() => parseEnv({ ...base, LOOP_REDEEM_ENCRYPTION_KEY: hexKey })).not.toThrow();
    });
  });

  // FT-09: EMAIL_PROVIDER=resend without RESEND_API_KEY is a silent login
  // outage (every OTP swallowed into a fake 200). Fail at boot in prod.
  describe('FT-09: production RESEND_API_KEY boot guard', () => {
    const prodResend = {
      ...prodBase,
      EMAIL_PROVIDER: 'resend' as const,
    };

    it('refuses production when EMAIL_PROVIDER=resend but RESEND_API_KEY is unset', () => {
      expect(() => parseEnv(prodResend)).toThrow(/EMAIL_PROVIDER=resend requires RESEND_API_KEY/);
    });

    it('refuses production when RESEND_API_KEY is empty', () => {
      expect(() => parseEnv({ ...prodResend, RESEND_API_KEY: '' })).toThrow(
        /EMAIL_PROVIDER=resend requires RESEND_API_KEY/,
      );
    });

    it('accepts production once RESEND_API_KEY is set', () => {
      expect(() => parseEnv({ ...prodResend, RESEND_API_KEY: 're_test_key_value' })).not.toThrow();
    });

    it('does not require RESEND_API_KEY when EMAIL_PROVIDER is not resend', () => {
      expect(() => parseEnv({ ...prodResend, EMAIL_PROVIDER: undefined })).not.toThrow();
    });

    it('does not enforce the RESEND key outside production', () => {
      expect(() =>
        parseEnv({ ...base, NODE_ENV: 'development', EMAIL_PROVIDER: 'resend' }),
      ).not.toThrow();
    });
  });
});

// ADR 030 Phase A: the RS256 signing keys are PEM-validated at boot —
// a malformed or non-RSA PEM must fail parseEnv (boot) rather than
// surface as a 500 on the first token mint or JWKS fetch.
describe('LOOP_JWT_RSA_PRIVATE_KEY (ADR 030 Phase A)', () => {
  // Generated at runtime — never commit a PEM fixture, even test-only.
  const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();
  const ecPem = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    .privateKey.export({ type: 'pkcs8', format: 'pem' })
    .toString();

  it('is optional — absent leaves RS256 unconfigured', () => {
    const env = parseEnv(base);
    expect(env.LOOP_JWT_RSA_PRIVATE_KEY).toBeUndefined();
    expect(env.LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS).toBeUndefined();
  });

  it('accepts a valid PKCS8 RSA PEM on both slots', () => {
    const env = parseEnv({
      ...base,
      LOOP_JWT_RSA_PRIVATE_KEY: rsaPem,
      LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: rsaPem,
    });
    expect(env.LOOP_JWT_RSA_PRIVATE_KEY).toBe(rsaPem);
    expect(env.LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS).toBe(rsaPem);
  });

  it('normalises escaped \\n sequences to real newlines (secret-store flattening)', () => {
    const flattened = rsaPem.replace(/\n/g, '\\n');
    const env = parseEnv({ ...base, LOOP_JWT_RSA_PRIVATE_KEY: flattened });
    expect(env.LOOP_JWT_RSA_PRIVATE_KEY).toBe(rsaPem);
  });

  it('rejects a malformed PEM at boot with the openssl hint', () => {
    expect(() => parseEnv({ ...base, LOOP_JWT_RSA_PRIVATE_KEY: 'not-a-pem' })).toThrow(
      /LOOP_JWT_RSA_PRIVATE_KEY.*openssl genpkey/,
    );
  });

  it('rejects a truncated PEM at boot', () => {
    expect(() => parseEnv({ ...base, LOOP_JWT_RSA_PRIVATE_KEY: rsaPem.slice(0, 80) })).toThrow(
      /LOOP_JWT_RSA_PRIVATE_KEY/,
    );
  });

  it('rejects a non-RSA (EC) private key at boot', () => {
    expect(() => parseEnv({ ...base, LOOP_JWT_RSA_PRIVATE_KEY: ecPem })).toThrow(
      /must be an RSA private key/,
    );
  });

  it('validates the _PREVIOUS slot with the same rules', () => {
    expect(() =>
      parseEnv({
        ...base,
        LOOP_JWT_RSA_PRIVATE_KEY: rsaPem,
        LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS: 'garbage',
      }),
    ).toThrow(/LOOP_JWT_RSA_PRIVATE_KEY_PREVIOUS/);
  });
});
