import { describe, it, expect, vi, afterEach } from 'vitest';
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
});
