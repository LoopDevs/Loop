import { describe, it, expect } from 'vitest';
import { scrubSentryEvent } from '../sentry-scrubber.js';

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
});
