import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiException } from '@loop/shared';
import { friendlyError } from '../error-messages';

describe('friendlyError', () => {
  afterEach(() => {
    vi.stubGlobal('navigator', { onLine: true });
  });

  it('returns offline message when navigator.onLine is false', () => {
    vi.stubGlobal('navigator', { onLine: false });
    const msg = friendlyError(new Error('fail'), 'Fallback');
    expect(msg).toContain('offline');
  });

  it('returns fallback when online and error has no status', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError(new Error('fail'), 'My fallback');
    expect(msg).toBe('My fallback');
  });

  it('returns 503 message for service unavailable', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError({ status: 503 }, 'Fallback');
    expect(msg).toContain('temporarily unavailable');
  });

  it('returns 429 message for rate limiting', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError({ status: 429 }, 'Fallback');
    expect(msg).toContain('Too many attempts');
  });

  it('returns fallback for unknown status codes', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError({ status: 500 }, 'Server error fallback');
    expect(msg).toBe('Server error fallback');
  });

  it('returns a provider-trouble message for 502 UPSTREAM_ERROR', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError({ status: 502 }, 'Fallback');
    expect(msg).toContain('provider');
  });

  it('returns a provider-timeout message for 504 GATEWAY_TIMEOUT', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError({ status: 504 }, 'Fallback');
    expect(msg.toLowerCase()).toContain('timed out');
  });

  it('returns fallback for null error', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError(null, 'Null fallback');
    expect(msg).toBe('Null fallback');
  });

  it('returns fallback for string error', () => {
    vi.stubGlobal('navigator', { onLine: true });
    const msg = friendlyError('some string', 'String fallback');
    expect(msg).toBe('String fallback');
  });

  // A2-1153: bespoke copy for backend error codes rather than status.
  describe('code-keyed messages (A2-1153)', () => {
    const apiErr = (status: number, code: string, message: string): ApiException =>
      new ApiException(status, { code, message });

    it('INSUFFICIENT_CREDIT has its own copy, not the 400 fallback', () => {
      const msg = friendlyError(apiErr(400, 'INSUFFICIENT_CREDIT', 'not enough'), 'Fallback');
      expect(msg).toContain('cashback balance');
    });

    it('HOME_CURRENCY_LOCKED explains the one-way lock', () => {
      const msg = friendlyError(apiErr(409, 'HOME_CURRENCY_LOCKED', 'locked'), 'Fallback');
      expect(msg).toContain('home currency is locked');
    });

    it('RATE_LIMITED maps from the 429 code (not just status)', () => {
      const msg = friendlyError(apiErr(429, 'RATE_LIMITED', 'too many'), 'Fallback');
      expect(msg).toContain('Too many attempts');
    });

    it('UPSTREAM_ERROR code beats generic 502 status match', () => {
      const msg = friendlyError(apiErr(502, 'UPSTREAM_ERROR', 'upstream'), 'Fallback');
      expect(msg).toContain('provider is having trouble');
    });

    it('VALIDATION_ERROR falls through to the backend message (null entry)', () => {
      const msg = friendlyError(
        apiErr(400, 'VALIDATION_ERROR', 'amount must be positive'),
        'Fallback',
      );
      expect(msg).toBe('amount must be positive');
    });

    it('unknown code falls through to status map', () => {
      const msg = friendlyError(apiErr(503, 'SOME_NEW_CODE', 'message'), 'Fallback');
      expect(msg).toContain('temporarily unavailable');
    });

    it('unknown code + unknown status returns caller fallback', () => {
      const msg = friendlyError(apiErr(500, 'SOME_NEW_CODE', 'message'), 'Server error fallback');
      expect(msg).toBe('Server error fallback');
    });
  });
});
