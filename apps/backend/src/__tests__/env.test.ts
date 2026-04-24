import { describe, it, expect, vi } from 'vitest';

// env.ts validates process.env at module-load time, so we must make the parse
// succeed on import even though our individual tests exercise parseEnv with
// synthetic inputs. vi.hoisted runs before the import below.
vi.hoisted(() => {
  if (!process.env.GIFT_CARD_API_BASE_URL) {
    process.env.GIFT_CARD_API_BASE_URL = 'https://placeholder-for-import.local';
  }
});

import { parseEnv } from '../env.js';

// Minimum viable env — everything else is optional or has a default.
// `DATABASE_URL` is required (ADR 012) so every parse run needs it;
// the value is a valid shape so the .url() + protocol check passes
// without opening a real connection.
const base = {
  GIFT_CARD_API_BASE_URL: 'https://upstream.example.com',
  DATABASE_URL: 'postgres://user:pass@localhost:5433/loop',
};

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
    });
    expect(env.NODE_ENV).toBe('production');
    expect(env.IMAGE_PROXY_ALLOWED_HOSTS).toBe('cdn.example.com,images.example.com');
  });

  it('allows DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1 as an explicit emergency override', () => {
    const env = parseEnv({
      ...base,
      NODE_ENV: 'production',
      DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT: '1',
    });
    expect(env.NODE_ENV).toBe('production');
  });

  it('does not enforce the allowlist in development or test', () => {
    expect(() => parseEnv({ ...base, NODE_ENV: 'development' })).not.toThrow();
    expect(() => parseEnv({ ...base, NODE_ENV: 'test' })).not.toThrow();
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
        }),
      ).not.toThrow();
      expect(() =>
        parseEnv({
          ...base,
          NODE_ENV: 'production',
          IMAGE_PROXY_ALLOWED_HOSTS: 'cdn.example.com',
          DISABLE_RATE_LIMITING: 'false',
        }),
      ).not.toThrow();
    });
  });
});
