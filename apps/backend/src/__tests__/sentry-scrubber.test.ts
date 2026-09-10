import { describe, it, expect } from 'vitest';
import { scrubSentryEvent } from '../sentry-scrubber.js';
import { REDACT_PATHS } from '../logger.js';

describe('scrubSentryEvent (A2-1308)', () => {
  it('redacts Authorization / cookie from request.headers', () => {
    const out = scrubSentryEvent({
      request: {
        headers: {
          authorization: 'Bearer AAA.BBB.CCC',
          cookie: 'sid=abc',
          'user-agent': 'probe/1.0',
        },
      },
    });
    const headers = out.request?.headers as Record<string, string>;
    expect(headers.authorization).toBe('[REDACTED]');
    expect(headers.cookie).toBe('[REDACTED]');
    expect(headers['user-agent']).toBe('probe/1.0');
  });

  it('redacts accessToken / refreshToken / otp anywhere in request.data', () => {
    const out = scrubSentryEvent({
      request: {
        data: {
          accessToken: 'AAA.BBB',
          user: { refreshToken: 'rtok', email: 'u@example.com' },
          otp: '123456',
        },
      },
    });
    const data = out.request?.data as Record<string, unknown>;
    expect(data.accessToken).toBe('[REDACTED]');
    expect(data.otp).toBe('[REDACTED]');
    const user = data.user as Record<string, unknown>;
    expect(user.refreshToken).toBe('[REDACTED]');
    // A4-074: emails scrubbed via free-text regex pass even at non-sensitive key names
    expect(user.email).toBe('[REDACTED_EMAIL]');
  });

  it('redacts env-named secrets under extra / contexts', () => {
    const out = scrubSentryEvent({
      extra: {
        LOOP_JWT_SIGNING_KEY: 'real-secret',
        GIFT_CARD_API_SECRET: 'gc-secret',
        DATABASE_URL: 'postgres://u:p@h/d',
        PORT: 8080,
      },
      contexts: {
        env: {
          DISCORD_WEBHOOK_ORDERS: 'https://discord.com/api/webhooks/x/y',
          DISCORD_WEBHOOK_MONITORING: 'https://discord.com/api/webhooks/a/b',
          SENTRY_DSN: 'https://x@o.ingest.sentry.io/1',
          NODE_ENV: 'production',
        },
      },
    });
    const extra = out.extra as Record<string, unknown>;
    expect(extra.LOOP_JWT_SIGNING_KEY).toBe('[REDACTED]');
    expect(extra.GIFT_CARD_API_SECRET).toBe('[REDACTED]');
    expect(extra.DATABASE_URL).toBe('[REDACTED]');
    expect(extra.PORT).toBe(8080);
    const env = (out.contexts as Record<string, unknown>).env as Record<string, unknown>;
    expect(env.DISCORD_WEBHOOK_ORDERS).toBe('[REDACTED]');
    expect(env.DISCORD_WEBHOOK_MONITORING).toBe('[REDACTED]');
    expect(env.SENTRY_DSN).toBe('[REDACTED]');
    expect(env.NODE_ENV).toBe('production');
  });

  it('leaves non-PII non-sensitive fields intact (A4-074: emails / bearers / Stellar secrets / long hex still scrubbed)', () => {
    const out = scrubSentryEvent({
      extra: { merchantId: 'amazon', amountMinor: '1000', email: 'u@example.com' },
    });
    expect(out.extra).toEqual({
      merchantId: 'amazon',
      amountMinor: '1000',
      // A4-074: free-text regex pass — emails redacted regardless of field name
      email: '[REDACTED_EMAIL]',
    });
  });

  it('survives arbitrary depth and arrays', () => {
    const out = scrubSentryEvent({
      extra: {
        chain: [
          { accessToken: 'a1' },
          { nested: { refreshToken: 'r1', email: 'e@x' } },
          'plain-string',
        ],
      },
    });
    const chain = (out.extra as Record<string, unknown>).chain as Array<
      Record<string, unknown> | string
    >;
    expect((chain[0] as Record<string, unknown>).accessToken).toBe('[REDACTED]');
    expect(
      ((chain[1] as Record<string, unknown>).nested as Record<string, unknown>).refreshToken,
    ).toBe('[REDACTED]');
    expect(chain[2]).toBe('plain-string');
  });

  it('passes the event through unchanged on an unexpected shape', () => {
    const weird = { weird: { foo: 'bar' } } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(weird);
    expect(out).toEqual(weird);
  });

  // CF2-09: pins breadcrumb scrubbing behavior (implementation already walked breadcrumbs)
  it('scrubs free-text PII in breadcrumb.message and sensitive keys in breadcrumb.data', () => {
    const out = scrubSentryEvent({
      breadcrumbs: [
        { message: 'user u@example.com did something', data: { accessToken: 'tok-1' } },
        { message: 'no pii here' },
      ],
    });
    expect(out.breadcrumbs?.[0]?.message).toBe('user [REDACTED_EMAIL] did something');
    expect((out.breadcrumbs?.[0]?.data as Record<string, string>).accessToken).toBe('[REDACTED]');
    expect(out.breadcrumbs?.[1]?.message).toBe('no pii here');
  });

  // OBS-04: values chosen to avoid free-text regex shapes, isolating key-based redaction
  it('OBS-04: redacts appSecret / PRIVY_APP_SECRET / OTP code that leaked past the drifted scrubber', () => {
    const out = scrubSentryEvent({
      request: {
        data: {
          code: '123456',
          phone: '+15551234567',
        },
      },
      extra: {
        appSecret: 'privy-app-secret-value',
        PRIVY_APP_SECRET: 'privy-env-secret-value',
        privy: { appSecret: 'nested-privy-secret' },
        merchantId: 'amazon',
      },
    });
    const data = out.request?.data as Record<string, unknown>;
    expect(data.code).toBe('[REDACTED]');
    expect(data.phone).toBe('+15551234567');
    const extra = out.extra as Record<string, unknown>;
    expect(extra.appSecret).toBe('[REDACTED]');
    expect(extra.PRIVY_APP_SECRET).toBe('[REDACTED]');
    expect((extra.privy as Record<string, unknown>).appSecret).toBe('[REDACTED]');
    expect(extra.merchantId).toBe('amazon');
  });

  // OBS-04 drift-guard: exercises every leaf key in REDACT_PATHS to prove parity with logger
  it('OBS-04: redacts every secret key the logger does (no drift from REDACT_PATHS)', () => {
    const leafKeys = [...new Set(REDACT_PATHS.map((p) => p.slice(p.lastIndexOf('.') + 1)))];
    const SAFE_VALUE = 'redact-me-please'; // no email/Bearer/Stellar/hex shape
    const extra: Record<string, string> = {};
    for (const k of leafKeys) extra[k] = SAFE_VALUE;

    const out = scrubSentryEvent({ extra });
    const scrubbed = out.extra as Record<string, string>;
    const leaked = leafKeys.filter((k) => scrubbed[k] !== '[REDACTED]');
    expect(leaked).toEqual([]);
  });

  // OBS-04 gap 1: values carry no free-text PII shape, isolating type-agnostic key redaction
  it('OBS-04: redacts a NON-STRING value at a secret key (number / boolean / object / array)', () => {
    const out = scrubSentryEvent({
      extra: {
        apiKey: 1234567890,
        secret: true,
        apiSecret: { raw: 42, note: 'sekret' },
        privateKey: [0xdead, 'part-two'],
        PORT: 8080,
      },
    });
    const extra = out.extra as Record<string, unknown>;
    expect(extra.apiKey).toBe('[REDACTED]');
    expect(extra.secret).toBe('[REDACTED]');
    expect(extra.apiSecret).toBe('[REDACTED]');
    expect(extra.privateKey).toBe('[REDACTED]');
    expect(extra.PORT).toBe(8080);
  });

  // OBS-04 carve-out: null/undefined at secret keys preserved to keep event shape honest
  it('OBS-04: preserves null / undefined at a secret key (no fabricated marker)', () => {
    const out = scrubSentryEvent({ extra: { apiKey: null, apiSecret: undefined } });
    const extra = out.extra as Record<string, unknown>;
    expect(extra.apiKey).toBeNull();
    expect('apiSecret' in extra).toBe(true);
    expect(extra.apiSecret).toBeUndefined();
  });

  // OBS-04 gap 2: pins event.user key-walk and free-text PII redaction
  it('OBS-04: key-walks event.user (secret keys + free-text PII redacted, benign fields intact)', () => {
    const out = scrubSentryEvent({
      user: {
        id: 'u-123',
        apiKey: 'user-scoped-secret',
        email: 'u@example.com',
        ip_address: '1.2.3.4',
        username: 'alice',
      },
    });
    const user = out.user as Record<string, unknown>;
    expect(user.apiKey).toBe('[REDACTED]');
    expect(user.email).toBe('[REDACTED_EMAIL]');
    expect(user.id).toBe('u-123');
    expect(user.ip_address).toBe('1.2.3.4');
    expect(user.username).toBe('alice');
  });

  // OBS-04 pin: regression guard for exception.values[].value free-text PII scrub
  it('OBS-04: exception.values[].value keeps its free-text PII scrub (regression pin)', () => {
    const out = scrubSentryEvent({
      exception: {
        values: [
          {
            type: 'AuthError',
            value: 'login failed for u@example.com with Bearer abcdefghijklmnop0123',
          },
        ],
      },
    });
    expect(out.exception?.values?.[0]?.value).toBe(
      'login failed for [REDACTED_EMAIL] with [REDACTED_BEARER]',
    );
  });
});
