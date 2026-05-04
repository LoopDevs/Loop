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
});
