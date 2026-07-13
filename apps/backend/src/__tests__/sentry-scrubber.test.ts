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
    // A4-074: emails are now scrubbed via the free-text regex pass
    // even at non-sensitive key names (was previously left intact).
    // The scrubber walks string values applying EMAIL_RE / BEARER_RE
    // / STELLAR_SECRET_RE / LONG_HEX_RE.
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
      // A4-074: free-text regex pass — emails redacted regardless
      // of the field name they live under.
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

  // CF2-09 (2026-06-30 cold audit): the implementation already walked
  // breadcrumbs (unlike the web twin, which didn't) but this file had
  // zero test coverage pinning that behavior.
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

  // OBS-04 (cold audit): the scrubber's hand-maintained key list had
  // drifted from logger.ts REDACT_PATHS — the source of truth it claims
  // to mirror. Secrets the logger redacts leaked to Sentry: the Privy
  // wallet-provider app secret (`appSecret` / `PRIVY_APP_SECRET`) and
  // the OTP `code`. Values below are chosen so they are NOT caught by
  // the free-text regex pass (no email / Bearer / Stellar-secret /
  // 32+hex shape) — so a bare `[REDACTED]` here can only come from the
  // key-based redaction that drifted, not from the A4-074 string pass.
  it('OBS-04: redacts appSecret / PRIVY_APP_SECRET / OTP code that leaked past the drifted scrubber', () => {
    const out = scrubSentryEvent({
      request: {
        data: {
          // OTP verification body: logger redacts `code`, scrubber did not.
          code: '123456',
          phone: '+15551234567',
        },
      },
      extra: {
        // Privy adapter config object dumped into `extra`.
        appSecret: 'privy-app-secret-value',
        // Fully-qualified env-key shape from an env dump.
        PRIVY_APP_SECRET: 'privy-env-secret-value',
        // Nested, to prove depth is covered too.
        privy: { appSecret: 'nested-privy-secret' },
        // A non-secret field must still survive.
        merchantId: 'amazon',
      },
    });
    const data = out.request?.data as Record<string, unknown>;
    expect(data.code).toBe('[REDACTED]');
    // Not a secret key — the phone value has no free-text PII shape, so
    // it passes through (documents that we didn't over-redact).
    expect(data.phone).toBe('+15551234567');
    const extra = out.extra as Record<string, unknown>;
    expect(extra.appSecret).toBe('[REDACTED]');
    expect(extra.PRIVY_APP_SECRET).toBe('[REDACTED]');
    expect((extra.privy as Record<string, unknown>).appSecret).toBe('[REDACTED]');
    expect(extra.merchantId).toBe('amazon');
  });

  // OBS-04 drift-guard: prove parity with the logger by exercising a
  // field named after *every* leaf key in REDACT_PATHS. Any key the
  // scrubber fails to redact is a leak. The value has no free-text PII
  // shape, so the only way it becomes `[REDACTED]` is key-based
  // redaction — this fails RED for all 13 drifted keys pre-fix.
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
});
