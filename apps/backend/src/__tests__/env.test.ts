import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';

// env.ts validates process.env at module-load time, so we must make the parse
// succeed on import even though our individual tests exercise parseEnv with
// synthetic inputs. vi.hoisted runs before the import below.
vi.hoisted(() => {
  if (!process.env.GIFT_CARD_API_BASE_URL) {
    process.env.GIFT_CARD_API_BASE_URL = 'https://placeholder-for-import.local';
  }
});

import { Keypair } from '@stellar/stellar-sdk';
import { parseEnv, CANONICAL_MAINNET_USDC_ISSUER } from '../env.js';

// A valid HTTPS Discord webhook URL (SEC-10 schema shape). Reused as
// the production monitoring webhook that CFG-01 now requires.
const MONITORING_WEBHOOK = 'https://discord.com/api/webhooks/123456789012345678/AbCdEf-gh_Ij';

// Minimum viable env — everything else is optional or has a default.
// `DATABASE_URL` is required (ADR 012) so every parse run needs it;
// the value is a valid shape so the .url() + protocol check passes
// without opening a real connection. `DISCORD_WEBHOOK_MONITORING` is
// carried here so the production-success fixtures below (which spread
// `...base`) satisfy the CFG-01 required-in-prod boot guard; it's
// optional in dev/test, so its presence is inert for the dev parses.
// NS-10 (CF-25 / X-PRIV-03): production boots require
// LOOP_REDEEM_ENCRYPTION_KEY (or the explicit opt-out). A 32-byte key
// (base64 of "0123456789abcdef0123456789abcdef") that also clears the
// 32-byte length validation. Carried in `base` — same pattern as
// DISCORD_WEBHOOK_MONITORING above — so every production-success
// fixture that spreads `...base` satisfies the guard; it's optional in
// dev/test, so its presence is inert for the dev parses.
const REDEEM_KEY = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

const base = {
  GIFT_CARD_API_BASE_URL: 'https://upstream.example.com',
  DATABASE_URL: 'postgres://user:pass@localhost:5433/loop',
  DISCORD_WEBHOOK_MONITORING: MONITORING_WEBHOOK,
  LOOP_REDEEM_ENCRYPTION_KEY: REDEEM_KEY,
};

// Hardening B3: production boots require LOOP_ADMIN_STEP_UP_SIGNING_KEY
// (or the explicit opt-out), so production-success fixtures carry it.
const STEP_UP_KEY = 'admin-step-up-test-key-32-chars-min!!';
const JWT_KEY = 'jwt-test-signing-key-32-chars-min!!';
// AUDIT-2 finding A: production boots require LOOP_STELLAR_USDC_ISSUER
// (or the explicit opt-out), so production-success fixtures carry it
// too — same pattern as STEP_UP_KEY above.
const USDC_ISSUER = CANONICAL_MAINNET_USDC_ISSUER;

describe('parseEnv', () => {
  it('parses a minimal valid env with defaults', () => {
    const env = parseEnv(base);
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(8080);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.REFRESH_INTERVAL_HOURS).toBe(6);
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

  // R3-1 production readiness (2026-07-10): the operator-float
  // reconciler's per-asset drift thresholds and reconciliation cadence
  // are `parseEnv`-validated, not hardcoded — a malformed override
  // fails boot instead of silently coercing to something unintended.
  describe('R3-1: operator-float reconciliation config', () => {
    it('defaults to a fee-tolerant XLM threshold and an exact USDC threshold', () => {
      const env = parseEnv(base);
      expect(env.LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS).toBe(10_000_000n);
      expect(env.LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS).toBe(1n);
      expect(env.LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS).toBe(24);
    });

    it('coerces valid overrides from string', () => {
      const env = parseEnv({
        ...base,
        LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS: '50000000',
        LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS: '0',
        LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS: '6',
      });
      expect(env.LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS).toBe(50_000_000n);
      expect(env.LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS).toBe(0n);
      expect(env.LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS).toBe(6);
    });

    it('fails boot on a non-numeric threshold instead of silently defaulting', () => {
      expect(() =>
        parseEnv({ ...base, LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS: 'a-lot' }),
      ).toThrow(/LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS/);
      expect(() =>
        parseEnv({ ...base, LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS: 'not-a-number' }),
      ).toThrow(/LOOP_OPERATOR_FLOAT_USDC_THRESHOLD_STROOPS/);
    });

    it('fails boot on a negative threshold', () => {
      expect(() => parseEnv({ ...base, LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS: '-1' })).toThrow(
        /LOOP_OPERATOR_FLOAT_XLM_THRESHOLD_STROOPS/,
      );
    });

    it('fails boot on a zero or negative reconciliation interval', () => {
      expect(() =>
        parseEnv({ ...base, LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS: '0' }),
      ).toThrow(/LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS/);
      expect(() =>
        parseEnv({ ...base, LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS: '-1' }),
      ).toThrow(/LOOP_OPERATOR_FLOAT_RECONCILIATION_INTERVAL_HOURS/);
    });
  });

  it('rejects non-http(s) URLs for GIFT_CARD_API_BASE_URL', () => {
    expect(() => parseEnv({ GIFT_CARD_API_BASE_URL: 'file:///etc/passwd' })).toThrow(
      /GIFT_CARD_API_BASE_URL/,
    );
    expect(() => parseEnv({ GIFT_CARD_API_BASE_URL: 'ftp://upstream.example.com' })).toThrow(
      /GIFT_CARD_API_BASE_URL/,
    );
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

  it('coerces INCLUDE_DISABLED_MERCHANTS boolean-ish strings', () => {
    expect(
      parseEnv({ ...base, INCLUDE_DISABLED_MERCHANTS: 'true' }).INCLUDE_DISABLED_MERCHANTS,
    ).toBe(true);
    expect(parseEnv({ ...base, INCLUDE_DISABLED_MERCHANTS: '' }).INCLUDE_DISABLED_MERCHANTS).toBe(
      false,
    );
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

  it('warns (does not throw) on INCLUDE_DISABLED_MERCHANTS=true in production', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseEnv({
      ...base,
      NODE_ENV: 'production',
      INCLUDE_DISABLED_MERCHANTS: 'true',
      IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('INCLUDE_DISABLED_MERCHANTS'));
    warn.mockRestore();
  });

  // Audit A-025 — image proxy allowlist is mandatory in production.
  it('refuses to start in production when IMAGE_PROXY_ALLOWED_HOSTS is unset', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'production' })).toThrow(
      /IMAGE_PROXY_ALLOWED_HOSTS/,
    );
  });

  it('refuses to start in production when IMAGE_PROXY_ALLOWED_HOSTS is empty', () => {
    expect(() =>
      parseEnv({ ...base, NODE_ENV: 'production', IMAGE_PROXY_ALLOWED_HOSTS: '   ' }),
    ).toThrow(/IMAGE_PROXY_ALLOWED_HOSTS/);
  });

  it('accepts production config once IMAGE_PROXY_ALLOWED_HOSTS is set', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com,images.example.com',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      LOOP_AUTH_NATIVE_ENABLED: 'true',
      LOOP_JWT_SIGNING_KEY: JWT_KEY,
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.IMAGE_PROXY_ALLOWED_HOSTS).toBe('cdn.example.com,images.example.com');
  });

  it('allows DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1 as an explicit emergency override', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT: '1',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
    });
    expect(env.NODE_ENV).toBe('production');
  });

  it('does not enforce the allowlist in development or test', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    expect(() => parseEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
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

    it('applies the same check to the admin step-up signing keys', () => {
      expect(() => parseEnv({ ...base, LOOP_ADMIN_STEP_UP_SIGNING_KEY: 'd'.repeat(32) })).toThrow(
        /LOOP_ADMIN_STEP_UP_SIGNING_KEY.*low-entropy/,
      );
      expect(() => parseEnv({ ...base, LOOP_ADMIN_STEP_UP_SIGNING_KEY: REAL_KEY })).not.toThrow();
    });

    it('still enforces the minimum-length bar independently of entropy', () => {
      expect(() => parseEnv({ ...base, LOOP_JWT_SIGNING_KEY: 'short' })).toThrow(
        /LOOP_JWT_SIGNING_KEY must be at least 32 characters/,
      );
    });
  });

  // Launch-runbook tripwire: a typo'd USDC issuer on mainnet makes
  // the payment watcher silently ignore every legitimate deposit.
  describe('LOOP_STELLAR_USDC_ISSUER mainnet tripwire', () => {
    const NON_CANONICAL_ISSUER = `G${'B'.repeat(55)}`;
    const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015';

    it('warns (does not throw) when a mainnet config uses a non-canonical USDC issuer', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({ ...base, LOOP_STELLAR_USDC_ISSUER: NON_CANONICAL_ISSUER });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('LOOP_STELLAR_USDC_ISSUER'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(CANONICAL_MAINNET_USDC_ISSUER));
      warn.mockRestore();
    });

    it('stays quiet for the canonical Circle issuer on mainnet', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({ ...base, LOOP_STELLAR_USDC_ISSUER: CANONICAL_MAINNET_USDC_ISSUER });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });

    it('stays quiet off mainnet (testnet passphrase) and when the issuer is unset', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({
        ...base,
        LOOP_STELLAR_USDC_ISSUER: NON_CANONICAL_ISSUER,
        LOOP_STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
      });
      parseEnv({ ...base });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // A2-1605: DISABLE_RATE_LIMITING is a test-harness flag; production
  // with it set opens every rate-limited route to volumetric abuse.
  describe('A2-1605: DISABLE_RATE_LIMITING production guard', () => {
    it('refuses to start in production when DISABLE_RATE_LIMITING=true', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          DISABLE_RATE_LIMITING: 'true',
          DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
        }),
      ).toThrow(/DISABLE_RATE_LIMITING/);
    });

    it('refuses in production on the boolean coercions too (1 / yes / on)', () => {
      for (const v of ['1', 'yes', 'on']) {
        expect(() =>
          parseEnv({
            ...base,
            NODE_ENV: 'production',
            IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
            DISABLE_RATE_LIMITING: v,
            DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
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
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
          LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
        }),
      ).not.toThrow();
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          DISABLE_RATE_LIMITING: 'false',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
          LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
        }),
      ).not.toThrow();
    });
  });

  // AUDIT-2-E: LOOP_TEST_ENDPOINTS_SECRET only has meaning alongside
  // NODE_ENV==='test' (it gates the test-only /__test__/* mount) and
  // has no business being present in a production env at all.
  describe('AUDIT-2-E: LOOP_TEST_ENDPOINTS_SECRET production guard', () => {
    it('refuses to start in production when LOOP_TEST_ENDPOINTS_SECRET is set', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
          LOOP_TEST_ENDPOINTS_SECRET: 'a-secret-that-is-long-enough-16',
        }),
      ).toThrow(/LOOP_TEST_ENDPOINTS_SECRET/);
    });

    it('accepts production when LOOP_TEST_ENDPOINTS_SECRET is unset', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
          LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
        }),
      ).not.toThrow();
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
        LOOP_JWT_SIGNING_KEY: 'jwt-test-signing-key-32-chars-min!!',
        LOOP_JWT_RSA_PRIVATE_KEY: pem,
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('remove LOOP_JWT_SIGNING_KEY'));
      warn.mockRestore();
    });

    it('stays quiet when only one signing family is configured', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({ ...base, LOOP_JWT_SIGNING_KEY: 'jwt-test-signing-key-32-chars-min!!' });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // Hardening B3 (2026-07 plan): the two auth misconfigurations that
  // previously only surfaced at request time now fail at boot.
  describe('B3: native-auth signing-key boot guard', () => {
    it('refuses LOOP_AUTH_NATIVE_ENABLED=true with no signing capability (any env)', () => {
      for (const nodeEnv of ['development', 'test', 'production'] as const) {
        expect(() =>
          parseEnv({
            ...base,
            NODE_ENV: nodeEnv,
            LOOP_AUTH_NATIVE_ENABLED: 'true',
            IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
            LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          }),
        ).toThrow(/LOOP_AUTH_NATIVE_ENABLED=true requires a JWT signing key/);
      }
    });

    it('accepts native auth with the HS256 key', () => {
      expect(() =>
        parseEnv({
          ...base,
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: 'jwt-test-signing-key-32-chars-min!!',
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
            IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
            LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
            ...(value === undefined ? {} : { LOOP_AUTH_NATIVE_ENABLED: value }),
          }),
        ).toThrow(/LOOP_AUTH_NATIVE_ENABLED must be true in production/);
      }
    });

    it('accepts production with native auth enabled and a signing key', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
          LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
        }),
      ).not.toThrow();
    });

    it('allows DISABLE_NATIVE_AUTH_ENFORCEMENT=1 as the explicit rollback opt-out', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          DISABLE_NATIVE_AUTH_ENFORCEMENT: '1',
          LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
        }),
      ).not.toThrow();
    });

    it('rejects any rollback opt-out value other than "1" at parse time', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          DISABLE_NATIVE_AUTH_ENFORCEMENT: 'true',
        }),
      ).toThrow(/DISABLE_NATIVE_AUTH_ENFORCEMENT/);
    });

    it('does not enforce native auth outside production', () => {
      expect(() => parseEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
      expect(() => parseEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
    });
  });

  describe('B3: production step-up-key boot guard (ADR 028)', () => {
    it('refuses production without LOOP_ADMIN_STEP_UP_SIGNING_KEY', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
        }),
      ).toThrow(/LOOP_ADMIN_STEP_UP_SIGNING_KEY must be set in production/);
    });

    it('allows DISABLE_ADMIN_STEP_UP_ENFORCEMENT=1 as the explicit opt-out', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          DISABLE_ADMIN_STEP_UP_ENFORCEMENT: '1',
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
          LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
        }),
      ).not.toThrow();
    });

    it('rejects any opt-out value other than "1" at parse time', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          DISABLE_ADMIN_STEP_UP_ENFORCEMENT: 'true',
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
        }),
      ).toThrow(/DISABLE_ADMIN_STEP_UP_ENFORCEMENT/);
    });

    it('does not enforce the step-up key outside production', () => {
      expect(() => parseEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
      expect(() => parseEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
    });
  });

  // AUDIT-2 finding A: production must not silently disable the USDC
  // deposit rail. The watcher's issuer-match guard (horizon.ts) now
  // fails closed on an unset issuer — matches no USDC deposit at all
  // — but a production deploy that never noticed the rail went dark
  // is still a launch-readiness gap, so parseEnv fails loud too.
  // Same shape as the admin step-up guard directly above.
  describe('production USDC-issuer boot guard (AUDIT-2 finding A)', () => {
    it('refuses production without LOOP_STELLAR_USDC_ISSUER', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
        }),
      ).toThrow(/LOOP_STELLAR_USDC_ISSUER must be set in production/);
    });

    it('accepts production once LOOP_STELLAR_USDC_ISSUER is set', () => {
      const env = parseEnv({
        ...base,
        NODE_ENV: 'production',
        IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
        LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
        LOOP_AUTH_NATIVE_ENABLED: 'true',
        LOOP_JWT_SIGNING_KEY: JWT_KEY,
        LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
      });
      expect(env.LOOP_STELLAR_USDC_ISSUER).toBe(USDC_ISSUER);
    });

    it('allows DISABLE_USDC_ISSUER_ENFORCEMENT=1 as the explicit opt-out', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
          DISABLE_USDC_ISSUER_ENFORCEMENT: '1',
        }),
      ).not.toThrow();
    });

    it('rejects any opt-out value other than "1" at parse time', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
          LOOP_AUTH_NATIVE_ENABLED: 'true',
          LOOP_JWT_SIGNING_KEY: JWT_KEY,
          DISABLE_USDC_ISSUER_ENFORCEMENT: 'true',
        }),
      ).toThrow(/DISABLE_USDC_ISSUER_ENFORCEMENT/);
    });

    it('does not enforce the USDC issuer outside production', () => {
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
  // estimator (middleware/fleet-size.ts) that now takes priority over
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

  describe('ADR 030 Phase B: LOOP_WALLET_PROVIDER cross-field requirement', () => {
    it('defaults to the empty string (wallet layer OFF)', () => {
      expect(parseEnv(base).LOOP_WALLET_PROVIDER).toBe('');
    });

    it('rejects unknown provider values', () => {
      expect(() => parseEnv({ ...base, LOOP_WALLET_PROVIDER: 'dfns' })).toThrow(
        /LOOP_WALLET_PROVIDER/,
      );
    });

    it('requires PRIVY_APP_ID + PRIVY_APP_SECRET when provider=privy', () => {
      expect(() => parseEnv({ ...base, LOOP_WALLET_PROVIDER: 'privy' })).toThrow(
        /PRIVY_APP_ID and PRIVY_APP_SECRET/,
      );
      expect(() =>
        parseEnv({ ...base, LOOP_WALLET_PROVIDER: 'privy', PRIVY_APP_ID: 'app123' }),
      ).toThrow(/PRIVY_APP_SECRET/);
      expect(() =>
        parseEnv({ ...base, LOOP_WALLET_PROVIDER: 'privy', PRIVY_APP_SECRET: 'sec456' }),
      ).toThrow(/PRIVY_APP_ID/);
    });

    it('accepts provider=privy with both credentials set', () => {
      const env = parseEnv({
        ...base,
        LOOP_WALLET_PROVIDER: 'privy',
        PRIVY_APP_ID: 'app123',
        PRIVY_APP_SECRET: 'sec456',
      });
      expect(env.LOOP_WALLET_PROVIDER).toBe('privy');
      expect(env.PRIVY_APP_ID).toBe('app123');
      expect(env.PRIVY_APP_SECRET).toBe('sec456');
    });

    it('ignores stray PRIVY_* credentials when the provider is unset', () => {
      expect(() => parseEnv({ ...base, PRIVY_APP_SECRET: 'sec456' })).not.toThrow();
    });
  });

  describe('ADR 031 V3: LOOP_VAULTS_ENABLED cross-field requirements', () => {
    const RPC = 'https://soroban-testnet.stellar.org';
    // A production config that passes every OTHER production boot guard,
    // so a test can isolate the vaults↔workers check.
    const prodBase = {
      ...base,
      NODE_ENV: 'production',
      IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      LOOP_AUTH_NATIVE_ENABLED: 'true',
      LOOP_JWT_SIGNING_KEY: JWT_KEY,
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
    };

    it('LOOP_VAULTS_ENABLED=true requires LOOP_SOROBAN_RPC_URL (any env)', () => {
      expect(() => parseEnv({ ...base, LOOP_VAULTS_ENABLED: 'true' })).toThrow(
        /LOOP_SOROBAN_RPC_URL/,
      );
    });

    it('P2-4: LOOP_VAULTS_ENABLED=true requires LOOP_WORKERS_ENABLED=true in production', () => {
      expect(() =>
        parseEnv({ ...prodBase, LOOP_VAULTS_ENABLED: 'true', LOOP_SOROBAN_RPC_URL: RPC }),
      ).toThrow(/LOOP_WORKERS_ENABLED/);
    });

    it('P2-4: production vaults+workers both on is accepted', () => {
      const env = parseEnv({
        ...prodBase,
        LOOP_VAULTS_ENABLED: 'true',
        LOOP_SOROBAN_RPC_URL: RPC,
        LOOP_WORKERS_ENABLED: 'true',
      });
      expect(env.LOOP_VAULTS_ENABLED).toBe(true);
      expect(env.LOOP_WORKERS_ENABLED).toBe(true);
    });

    it('P2-4: outside production, vaults on with workers off is allowed (tests/dev drive the sweep directly)', () => {
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'test',
          LOOP_VAULTS_ENABLED: 'true',
          LOOP_SOROBAN_RPC_URL: RPC,
          LOOP_WORKERS_ENABLED: 'false',
        }),
      ).not.toThrow();
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
          DISCORD_WEBHOOK_ADMIN_AUDIT: 'https://canary.discord.com/api/webhooks/2/def',
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
        parseEnv({ ...base, DISCORD_WEBHOOK_ADMIN_AUDIT: 'https://discord.com/login' }),
      ).toThrow(/DISCORD_WEBHOOK_ADMIN_AUDIT/);
    });

    it('rejects a look-alike host (discord.com.evil.test)', () => {
      expect(() =>
        parseEnv({
          ...base,
          DISCORD_WEBHOOK_ORDERS: 'https://discord.com.evil.test/api/webhooks/1/2',
        }),
      ).toThrow(/DISCORD_WEBHOOK_ORDERS/);
    });
  });

  // CFG-01 (FT-06 follow-up): DISCORD_WEBHOOK_MONITORING is required in
  // production — an unset webhook silently drops every monitoring alert.
  describe('CFG-01: production DISCORD_WEBHOOK_MONITORING boot guard', () => {
    const prodMinusMonitoring = {
      ...base,
      DISCORD_WEBHOOK_MONITORING: undefined,
      NODE_ENV: 'production' as const,
      IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      DISABLE_NATIVE_AUTH_ENFORCEMENT: '1' as const,
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
    };

    it('refuses production when DISCORD_WEBHOOK_MONITORING is unset', () => {
      expect(() => parseEnv(prodMinusMonitoring)).toThrow(/DISCORD_WEBHOOK_MONITORING must be set/);
    });

    it('also fires when only LOOP_ENV marks production (NODE_ENV=development)', () => {
      expect(() =>
        parseEnv({ ...base, DISCORD_WEBHOOK_MONITORING: undefined, LOOP_ENV: 'production' }),
      ).toThrow(/DISCORD_WEBHOOK_MONITORING must be set/);
    });

    it('accepts production once the monitoring webhook is set', () => {
      expect(() =>
        parseEnv({ ...prodMinusMonitoring, DISCORD_WEBHOOK_MONITORING: MONITORING_WEBHOOK }),
      ).not.toThrow();
    });

    it('allows DISABLE_MONITORING_WEBHOOK_ENFORCEMENT=1 as the explicit opt-out', () => {
      expect(() =>
        parseEnv({ ...prodMinusMonitoring, DISABLE_MONITORING_WEBHOOK_ENFORCEMENT: '1' }),
      ).not.toThrow();
    });

    it('rejects any opt-out value other than "1" at parse time', () => {
      expect(() =>
        parseEnv({ ...prodMinusMonitoring, DISABLE_MONITORING_WEBHOOK_ENFORCEMENT: 'true' }),
      ).toThrow(/DISABLE_MONITORING_WEBHOOK_ENFORCEMENT/);
    });

    it('does not require the monitoring webhook outside production', () => {
      expect(() =>
        parseEnv({ ...base, DISCORD_WEBHOOK_MONITORING: undefined, NODE_ENV: 'development' }),
      ).not.toThrow();
      expect(() =>
        parseEnv({ ...base, DISCORD_WEBHOOK_MONITORING: undefined, NODE_ENV: 'test' }),
      ).not.toThrow();
    });
  });

  // NS-10 (CF-25 / X-PRIV-03 follow-up): production must ENCRYPT the
  // gift-card redeem code + PIN at rest. Before this guard the key was
  // opt-in and its absence only WARNed at boot, so a prod deploy that
  // forgot LOOP_REDEEM_ENCRYPTION_KEY silently stored every spendable
  // bearer secret in PLAINTEXT. parseEnv now fails closed in production
  // when the key is unset — same shape as the USDC-issuer / step-up
  // guards above, with a `"1"`-only opt-out. Dev/test keep warn-and-allow.
  describe('NS-10: production redeem-encryption-key boot guard', () => {
    // A production config that clears every OTHER prod boot guard, so a
    // test can isolate the redeem-key check (parseEnv throws on the FIRST
    // failing guard, and this one runs late). `base` carries the redeem
    // key, so we explicitly UNSET it here to exercise the guard.
    const prodMinusRedeem = {
      ...base,
      NODE_ENV: 'production' as const,
      IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      LOOP_AUTH_NATIVE_ENABLED: 'true' as const,
      LOOP_JWT_SIGNING_KEY: JWT_KEY,
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
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
  });

  // CFG-02: an admin daily money cap of 0 DISABLES the cap. A fat-finger
  // 0 in production silently removes the treasury safeguard, so warn.
  describe('CFG-02: admin daily money cap = 0 in production', () => {
    const prodOk = {
      ...base,
      NODE_ENV: 'production' as const,
      IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      DISABLE_NATIVE_AUTH_ENFORCEMENT: '1' as const,
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
    };

    it('warns (does not throw) when the adjustment cap is 0 in production', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({ ...prodOk, ADMIN_DAILY_ADJUSTMENT_CAP_MINOR: '0' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ADMIN_DAILY_ADJUSTMENT_CAP_MINOR=0 in production DISABLES'),
      );
      warn.mockRestore();
    });

    it('warns when the withdrawal/emission cap is 0 in production', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({ ...prodOk, ADMIN_DAILY_WITHDRAWAL_CAP_MINOR: '0' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ADMIN_DAILY_WITHDRAWAL_CAP_MINOR=0 in production DISABLES'),
      );
      warn.mockRestore();
    });

    it('stays quiet in production with the default (non-zero) caps', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv(prodOk);
      expect(warn).not.toHaveBeenCalledWith(
        expect.stringContaining('DISABLES the per-admin daily'),
      );
      warn.mockRestore();
    });

    it('does not warn on a 0 cap outside production (documented dev/test hatch)', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const env = parseEnv({ ...base, ADMIN_DAILY_ADJUSTMENT_CAP_MINOR: '0' });
      expect(env.ADMIN_DAILY_ADJUSTMENT_CAP_MINOR).toBe(0n);
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    });
  });

  // CFG-05: an unrecognised LOOP_STELLAR_NETWORK_PASSPHRASE (typo) warns
  // — it silently points the payout signer / watcher at the wrong chain.
  describe('CFG-05: unrecognised Stellar network passphrase', () => {
    it('warns on a passphrase that is neither pubnet, testnet, nor futurenet', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parseEnv({ ...base, LOOP_STELLAR_NETWORK_PASSPHRASE: 'Public Global Stellar Netwrok' });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('is not a recognised Stellar network passphrase'),
      );
      warn.mockRestore();
    });

    it('stays quiet for the recognised pubnet / testnet / futurenet passphrases', () => {
      for (const passphrase of [
        'Public Global Stellar Network ; September 2015',
        'Test SDF Network ; September 2015',
        'Test SDF Future Network ; October 2022',
      ]) {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        parseEnv({ ...base, LOOP_STELLAR_NETWORK_PASSPHRASE: passphrase });
        expect(warn).not.toHaveBeenCalledWith(
          expect.stringContaining('is not a recognised Stellar network passphrase'),
        );
        warn.mockRestore();
      }
    });
  });

  // CFG-06: a mis-typed LOOP_KILL_* value must fail CLOSED (engaged), not
  // reject at boot (which crash-loops the machine and leaves Fly serving
  // the old, un-killed machine = fail OPEN). See killSwitchBoolean.
  describe('CFG-06: kill-switch schema fails CLOSED on an unrecognised value', () => {
    it('accepts an unrecognised value at boot and maps it to engaged (true)', () => {
      // envBoolean REJECTED these — a boot crash on the kill-carrying
      // machine leaves Fly serving the old, un-killed machine.
      expect(parseEnv({ ...base, LOOP_KILL_AUTH: 'disbaled' }).LOOP_KILL_AUTH).toBe(true);
      expect(parseEnv({ ...base, LOOP_KILL_ORDERS: 'kill' }).LOOP_KILL_ORDERS).toBe(true);
      expect(parseEnv({ ...base, LOOP_KILL_EMISSIONS: 'banana' }).LOOP_KILL_EMISSIONS).toBe(true);
      expect(parseEnv({ ...base, LOOP_KILL_ORDERS_LEGACY: 'nope' }).LOOP_KILL_ORDERS_LEGACY).toBe(
        true,
      );
    });

    it('still parses recognised booleans normally (truthy → engaged, falsy/unset → open)', () => {
      expect(parseEnv({ ...base, LOOP_KILL_AUTH: 'true' }).LOOP_KILL_AUTH).toBe(true);
      expect(parseEnv({ ...base, LOOP_KILL_AUTH: 'on' }).LOOP_KILL_AUTH).toBe(true);
      expect(parseEnv({ ...base, LOOP_KILL_AUTH: 'false' }).LOOP_KILL_AUTH).toBe(false);
      expect(parseEnv({ ...base, LOOP_KILL_AUTH: 'off' }).LOOP_KILL_AUTH).toBe(false);
      expect(parseEnv(base).LOOP_KILL_AUTH).toBe(false);
      expect(parseEnv(base).LOOP_KILL_ORDERS_LEGACY).toBeUndefined();
    });
  });

  // FT-09: EMAIL_PROVIDER=resend without RESEND_API_KEY is a silent login
  // outage (every OTP swallowed into a fake 200). Fail at boot in prod.
  describe('FT-09: production RESEND_API_KEY boot guard', () => {
    const prodResend = {
      ...base,
      NODE_ENV: 'production' as const,
      IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
      LOOP_ADMIN_STEP_UP_SIGNING_KEY: STEP_UP_KEY,
      DISABLE_NATIVE_AUTH_ENFORCEMENT: '1' as const,
      LOOP_STELLAR_USDC_ISSUER: USDC_ISSUER,
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
      // Native auth is disabled here (opt-out), so no email provider is
      // needed at all — the guard must not fire on an unset provider.
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

describe('parseEnv — ADR 031 issuer-secret pinning', () => {
  // Real ed25519 material: the check derives the public key from the
  // secret, so the fixtures must be a genuine keypair.
  const issuerKp = Keypair.random();
  const otherKp = Keypair.random();

  it('accepts a secret whose derived account matches the configured issuer address', () => {
    const env = parseEnv({
      ...base,
      LOOP_STELLAR_GBPLOOP_ISSUER: issuerKp.publicKey(),
      LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: issuerKp.secret(),
    });
    expect(env.LOOP_STELLAR_GBPLOOP_ISSUER_SECRET).toBe(issuerKp.secret());
  });

  it('boot-fails when the derived account mismatches the issuer address', () => {
    expect(() =>
      parseEnv({
        ...base,
        LOOP_STELLAR_GBPLOOP_ISSUER: otherKp.publicKey(),
        LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: issuerKp.secret(),
      }),
    ).toThrow(/does not match LOOP_STELLAR_GBPLOOP_ISSUER/);
  });

  it('boot-fails on an orphan secret (no issuer address to validate against)', () => {
    expect(() =>
      parseEnv({
        ...base,
        LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: issuerKp.secret(),
      }),
    ).toThrow(/LOOP_STELLAR_GBPLOOP_ISSUER is not/);
  });

  it('rejects malformed issuer secrets at the schema layer', () => {
    expect(() =>
      parseEnv({
        ...base,
        LOOP_STELLAR_GBPLOOP_ISSUER: issuerKp.publicKey(),
        LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: 'not-a-secret',
      }),
    ).toThrow(/LOOP_STELLAR_GBPLOOP_ISSUER_SECRET/);
  });

  it('LOOP_INTEREST_ONCHAIN_ENABLED parses as a strict boolean and defaults false', () => {
    expect(parseEnv(base).LOOP_INTEREST_ONCHAIN_ENABLED).toBe(false);
    expect(
      parseEnv({ ...base, LOOP_INTEREST_ONCHAIN_ENABLED: 'true' }).LOOP_INTEREST_ONCHAIN_ENABLED,
    ).toBe(true);
    expect(() => parseEnv({ ...base, LOOP_INTEREST_ONCHAIN_ENABLED: 'sure' })).toThrow(
      /LOOP_INTEREST_ONCHAIN_ENABLED/,
    );
  });
});

describe('parseEnv — ADR 044 / S4-1 payout channel accounts', () => {
  // Real ed25519 material: the checks derive public keys from the
  // secrets, so the fixtures must be genuine keypairs.
  const operatorKp = Keypair.random();
  const issuerKp = Keypair.random();
  const chan1 = Keypair.random();
  const chan2 = Keypair.random();

  it('accepts an unset LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS (default — no channels)', () => {
    const env = parseEnv(base);
    expect(env.LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS).toBeUndefined();
  });

  it('accepts a single well-formed channel secret', () => {
    const env = parseEnv({ ...base, LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: chan1.secret() });
    expect(env.LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS).toBe(chan1.secret());
  });

  it('accepts multiple comma-separated channel secrets distinct from operator/issuer', () => {
    const env = parseEnv({
      ...base,
      LOOP_STELLAR_OPERATOR_SECRET: operatorKp.secret(),
      LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},${chan2.secret()}`,
    });
    expect(env.LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS).toBe(`${chan1.secret()},${chan2.secret()}`);
  });

  it('rejects a malformed entry at the schema layer', () => {
    expect(() =>
      parseEnv({ ...base, LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: 'not-a-secret' }),
    ).toThrow(/LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS/);
    expect(() =>
      parseEnv({
        ...base,
        LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},not-a-secret`,
      }),
    ).toThrow(/LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS/);
  });

  it('boot-fails on two channel entries deriving the same account', () => {
    expect(() =>
      parseEnv({
        ...base,
        LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},${chan1.secret()}`,
      }),
    ).toThrow(/derive the same account/);
  });

  it('boot-fails when a channel collides with the configured operator account', () => {
    expect(() =>
      parseEnv({
        ...base,
        LOOP_STELLAR_OPERATOR_SECRET: operatorKp.secret(),
        LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},${operatorKp.secret()}`,
      }),
    ).toThrow(/LOOP_STELLAR_OPERATOR_SECRET/);
  });

  it('boot-fails when a channel collides with a configured issuer account', () => {
    expect(() =>
      parseEnv({
        ...base,
        LOOP_STELLAR_GBPLOOP_ISSUER: issuerKp.publicKey(),
        LOOP_STELLAR_GBPLOOP_ISSUER_SECRET: issuerKp.secret(),
        LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},${issuerKp.secret()}`,
      }),
    ).toThrow(/LOOP_STELLAR_GBPLOOP_ISSUER_SECRET/);
  });

  it('does not require an operator or any issuer to be configured at all', () => {
    // Channels are validated on their own merits; the only cross-field
    // checks are collision checks against whatever IS configured.
    const env = parseEnv({
      ...base,
      LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS: `${chan1.secret()},${chan2.secret()}`,
    });
    expect(env.LOOP_STELLAR_OPERATOR_SECRET).toBeUndefined();
    expect(env.LOOP_STELLAR_PAYOUT_CHANNEL_SECRETS).toBe(`${chan1.secret()},${chan2.secret()}`);
  });
});
