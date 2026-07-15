import { describe, expect, it } from 'vitest';

import { ApiErrorCode, ApiException, DEFAULT_CLIENT_IDS } from './api.js';

describe('ApiException', () => {
  it('carries status, code, message, details, and requestId', () => {
    const e = new ApiException(429, {
      code: ApiErrorCode.RATE_LIMITED,
      message: 'slow down',
      details: { retryAfter: 30 },
      requestId: 'req-1',
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('ApiException');
    expect(e.status).toBe(429);
    expect(e.code).toBe('RATE_LIMITED');
    expect(e.message).toBe('slow down');
    expect(e.details).toEqual({ retryAfter: 30 });
    expect(e.requestId).toBe('req-1');
  });

  it('leaves optional fields undefined when absent', () => {
    const e = new ApiException(500, { code: 'INTERNAL_ERROR', message: 'boom' });
    expect(e.details).toBeUndefined();
    expect(e.requestId).toBeUndefined();
    expect(e.retryAfter).toBeUndefined();
  });

  it('ONB-4: carries retryAfter (Retry-After seconds) when present', () => {
    const e = new ApiException(429, {
      code: ApiErrorCode.RATE_LIMITED,
      message: 'slow down',
      retryAfter: 30,
    });
    expect(e.retryAfter).toBe(30);
  });
});

describe('ApiErrorCode', () => {
  it('every key equals its value (switch-ladder safety)', () => {
    // The web error switch-ladders compare against these constants; a
    // key/value mismatch would make a `case ApiErrorCode.X` silently
    // unreachable while the backend emits the literal string.
    for (const [key, value] of Object.entries(ApiErrorCode)) {
      expect(value).toBe(key);
    }
  });

  it('values are unique', () => {
    const values = Object.values(ApiErrorCode);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('DEFAULT_CLIENT_IDS', () => {
  it('covers exactly the three platforms with distinct ids', () => {
    expect(Object.keys(DEFAULT_CLIENT_IDS).sort()).toEqual(['android', 'ios', 'web']);
    const ids = Object.values(DEFAULT_CLIENT_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
