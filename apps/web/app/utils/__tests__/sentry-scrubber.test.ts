import { describe, it, expect } from 'vitest';
import { scrubSentryEvent } from '../sentry-scrubber';

describe('scrubSentryEvent (web)', () => {
  it('redacts authorization header verbatim', () => {
    const out = scrubSentryEvent({
      request: { headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.x.y' } },
    });
    expect(out.request?.headers?.['Authorization']).toBe('[REDACTED]');
  });

  it('redacts cookies', () => {
    const out = scrubSentryEvent({
      request: { cookies: { Cookie: 'session=secret', other: 'visible' } },
    });
    expect(out.request?.cookies?.['Cookie']).toBe('[REDACTED]');
    expect(out.request?.cookies?.['other']).toBe('visible');
  });

  it('redacts the long sensitive-key list (case-insensitive)', () => {
    const sensitive = [
      'accessToken',
      'REFRESHTOKEN',
      'otp',
      'password',
      'apiKey',
      'secretKey',
      'mnemonic',
      'seedPhrase',
      'sentry_dsn',
      'database_url',
    ];
    for (const key of sensitive) {
      const out = scrubSentryEvent({ extra: { [key]: 'sensitive-value' } });
      expect(out.extra?.[key]).toBe('[REDACTED]');
    }
  });

  it('redacts only string values; objects/arrays/nulls are walked but kept structurally', () => {
    const out = scrubSentryEvent({
      extra: {
        accessToken: 'abc',
        nested: { accessToken: 'inner', innocuous: 'leaveme' },
        list: [{ accessToken: 'list-token' }],
        nullish: null,
      },
    });
    expect(out.extra?.accessToken).toBe('[REDACTED]');
    expect((out.extra?.nested as Record<string, string>).accessToken).toBe('[REDACTED]');
    expect((out.extra?.nested as Record<string, string>).innocuous).toBe('leaveme');
    expect((out.extra?.list as Array<Record<string, string>>)[0]!.accessToken).toBe('[REDACTED]');
    expect(out.extra?.nullish).toBeNull();
  });

  it('does not redact innocuous keys that happen to contain sensitive substrings', () => {
    const out = scrubSentryEvent({
      extra: {
        // These do not match the regex (anchored ^...$).
        accessTokenCount: 'NUMBER',
        my_password_hint: 'visible-hint',
      },
    });
    expect(out.extra?.accessTokenCount).toBe('NUMBER');
    expect(out.extra?.my_password_hint).toBe('visible-hint');
  });

  it('walks request.data + request.headers + request.cookies + extra + contexts + tags independently', () => {
    const out = scrubSentryEvent({
      request: {
        headers: { Authorization: 'h-secret' },
        data: { otp: 'd-secret' },
        cookies: { Cookie: 'c-secret' },
      },
      extra: { password: 'e-secret' },
      contexts: { auth: { refreshToken: 'ctx-secret' } },
      tags: { secret: 't-secret' },
    });
    expect(out.request?.headers?.['Authorization']).toBe('[REDACTED]');
    expect((out.request?.data as Record<string, string>).otp).toBe('[REDACTED]');
    expect(out.request?.cookies?.['Cookie']).toBe('[REDACTED]');
    expect(out.extra?.password).toBe('[REDACTED]');
    expect((out.contexts?.auth as Record<string, string>).refreshToken).toBe('[REDACTED]');
    expect(out.tags?.secret).toBe('[REDACTED]');
  });

  it('leaves the event unchanged when none of the redact-eligible sections are present', () => {
    const out = scrubSentryEvent({});
    expect(out).toEqual({});
  });

  it('returns the event verbatim if the scrubber itself throws (defence-in-depth)', () => {
    // Force a throw by making event.extra a getter that throws.
    const event = {
      get extra(): never {
        throw new Error('boom');
      },
    } as unknown as Parameters<typeof scrubSentryEvent>[0];
    const out = scrubSentryEvent(event);
    // Same reference is returned on the catch path.
    expect(out).toBe(event);
  });

  // CF2-09 (2026-06-30 cold audit): this file had drifted from the
  // backend twin — no breadcrumb handling at all, and no free-text
  // (email/bearer/hex) pass on message/exception/breadcrumbs. Sentry's
  // default integrations capture console.* calls as breadcrumbs
  // automatically, so any PII logged anywhere in the app (e.g. the
  // native DSR export screen's now-fixed console.log(payload),
  // W30-02) reached Sentry completely unscrubbed before this fix.
  describe('CF2-09: breadcrumbs + free-text PII scrubbing', () => {
    it('redacts email addresses in breadcrumb messages', () => {
      const out = scrubSentryEvent({
        breadcrumbs: [{ message: 'user alice@example.com clicked export', category: 'console' }],
      });
      expect(out.breadcrumbs?.[0]?.message).toBe('user [REDACTED_EMAIL] clicked export');
      expect(out.breadcrumbs?.[0]?.category).toBe('console');
    });

    it('redacts sensitive keys inside breadcrumb.data', () => {
      const out = scrubSentryEvent({
        breadcrumbs: [{ message: 'fetch', data: { accessToken: 'abc123', url: '/api/orders' } }],
      });
      expect((out.breadcrumbs?.[0]?.data as Record<string, string>).accessToken).toBe('[REDACTED]');
      expect((out.breadcrumbs?.[0]?.data as Record<string, string>).url).toBe('/api/orders');
    });

    it('scrubs multiple breadcrumbs independently', () => {
      const out = scrubSentryEvent({
        breadcrumbs: [{ message: 'first bob@example.com' }, { message: 'second no-pii-here' }],
      });
      expect(out.breadcrumbs?.[0]?.message).toBe('first [REDACTED_EMAIL]');
      expect(out.breadcrumbs?.[1]?.message).toBe('second no-pii-here');
    });

    it('redacts email/bearer/stellar-secret/long-hex patterns in event.message', () => {
      const out = scrubSentryEvent({ message: 'failed for alice@example.com' });
      expect(out.message).toBe('failed for [REDACTED_EMAIL]');
    });

    it('redacts free-text PII in exception.values[].value', () => {
      const out = scrubSentryEvent({
        exception: { values: [{ type: 'Error', value: 'token Bearer abc123def456ghi789jkl' }] },
      });
      expect(out.exception?.values?.[0]?.value).toBe('token [REDACTED_BEARER]');
    });

    it('redacts the idempotency-key sensitive-key variants (A4-039 parity with backend)', () => {
      const camel = scrubSentryEvent({ extra: { idempotencyKey: 'key-value' } });
      expect(camel.extra?.['idempotencyKey']).toBe('[REDACTED]');
      const header = scrubSentryEvent({
        request: { headers: { 'Idempotency-Key': 'header-value' } },
      });
      expect(header.request?.headers?.['Idempotency-Key']).toBe('[REDACTED]');
    });

    it('leaves an event with no breadcrumbs/message/exception unaffected', () => {
      const out = scrubSentryEvent({
        extra: { safe: 'value' },
      } as { extra: Record<string, unknown>; breadcrumbs?: never; message?: never });
      expect(out.breadcrumbs).toBeUndefined();
      expect(out.message).toBeUndefined();
      expect(out.extra?.['safe']).toBe('value');
    });
  });
});
