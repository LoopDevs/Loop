// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { scrubErrorForSentry, scrubStringForSentry } from '../sentry-error-scrubber';

describe('scrubStringForSentry', () => {
  it('redacts email addresses', () => {
    expect(scrubStringForSentry('login failed for alice@example.com')).toBe(
      'login failed for [REDACTED_EMAIL]',
    );
  });

  it('redacts bearer tokens', () => {
    const s = 'Header: Authorization: Bearer abcDEF1234567890-_=tail+more';
    expect(scrubStringForSentry(s)).toContain('[REDACTED_BEARER]');
    expect(scrubStringForSentry(s)).not.toContain('abcDEF1234567890');
  });

  it('redacts stellar secret-key-shaped strings', () => {
    const stellarSecret = 'S' + 'A'.repeat(55);
    const s = `backup copy: ${stellarSecret}`;
    expect(scrubStringForSentry(s)).toBe('backup copy: [REDACTED_STELLAR_SECRET]');
  });

  it('redacts long hex strings (session ids, access tokens)', () => {
    const hex = 'a'.repeat(48);
    expect(scrubStringForSentry(`token=${hex}`)).toBe('token=[REDACTED_HEX]');
  });

  it('leaves short order-id-shaped hex alone (under the 32-char threshold)', () => {
    const s = '/api/orders/abc1234def5678';
    expect(scrubStringForSentry(s)).toBe(s);
  });
});

describe('scrubErrorForSentry', () => {
  it('replaces a thrown Response with a safe Error wrapper (no body)', () => {
    const res = new Response('sensitive body with email@x.com', {
      status: 502,
      statusText: 'Bad Gateway',
    });
    const out = scrubErrorForSentry(res);
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toContain('Response');
    expect((out as Error).message).not.toContain('email@x.com');
  });

  it('replaces a thrown Request the same way', () => {
    const req = new Request('https://example.com/auth', {
      method: 'POST',
      body: 'secret=bearer-xxx',
    });
    const out = scrubErrorForSentry(req);
    expect(out).toBeInstanceOf(Error);
    expect((out as Error).message).toContain('Request');
  });

  it('strips `response` attribute when it is a Response', () => {
    const err = new Error('loader failed') as Error & { response?: unknown };
    err.response = new Response('body with token=abc', { status: 500 });
    const out = scrubErrorForSentry(err) as Error & { response?: unknown };
    expect(out.response).toBeUndefined();
  });

  it('strips `cause` attribute when it is a Request', () => {
    const err = new Error('loader failed') as Error & { cause?: unknown };
    err.cause = new Request('https://x/y');
    const out = scrubErrorForSentry(err) as Error & { cause?: unknown };
    expect(out.cause).toBeUndefined();
  });

  it('preserves a non-Response `cause` (so error chaining still works)', () => {
    const inner = new Error('inner failure');
    const err = new Error('outer failure', { cause: inner });
    const out = scrubErrorForSentry(err) as Error & { cause?: unknown };
    expect(out.cause).toBe(inner);
  });

  it('redacts email / bearer shapes in error.message', () => {
    const err = new Error('401 for alice@example.com with Bearer eyJhbGciOiJIUzI1NiI1234567890');
    const out = scrubErrorForSentry(err) as Error;
    expect(out.message).toContain('[REDACTED_EMAIL]');
    expect(out.message).toContain('[REDACTED_BEARER]');
    expect(out.message).not.toContain('alice@example.com');
  });

  it('preserves the original name + stack (non-mutating clone)', () => {
    const err = new Error('x');
    err.name = 'LoaderError';
    const originalStack = err.stack;
    const out = scrubErrorForSentry(err) as Error;
    expect(out.name).toBe('LoaderError');
    expect(out.stack).toBe(originalStack);
    // The original is untouched so UI state can still consume it.
    expect(err.message).toBe('x');
  });

  it('redacts string inputs via scrubStringForSentry', () => {
    const out = scrubErrorForSentry('boom email@x.com') as string;
    expect(out).toBe('boom [REDACTED_EMAIL]');
  });

  it('passes through unknown shapes (numbers, objects without scrub hooks)', () => {
    expect(scrubErrorForSentry(42)).toBe(42);
    const obj = { foo: 'bar' };
    expect(scrubErrorForSentry(obj)).toBe(obj);
  });
});
