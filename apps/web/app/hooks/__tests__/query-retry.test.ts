import { describe, it, expect } from 'vitest';
import { ApiException } from '@loop/shared';
import { shouldRetry, isTransientError } from '../query-retry';

describe('isTransientError (retry vs. give up classifier)', () => {
  it('treats 5xx, timeouts and network errors as transient', () => {
    expect(isTransientError(new ApiException(500, { code: 'INTERNAL_ERROR', message: 'x' }))).toBe(
      true,
    );
    expect(
      isTransientError(new ApiException(503, { code: 'SERVICE_UNAVAILABLE', message: 'x' })),
    ).toBe(true);
    expect(isTransientError(new ApiException(0, { code: 'NETWORK_ERROR', message: 'x' }))).toBe(
      true,
    );
    expect(isTransientError(new Error('failed to fetch'))).toBe(true);
  });

  it('treats 4xx (not-deployed 404, auth 401, rate-limit 429) as permanent', () => {
    expect(isTransientError(new ApiException(404, { code: 'NOT_FOUND', message: 'x' }))).toBe(
      false,
    );
    expect(isTransientError(new ApiException(401, { code: 'UNAUTHENTICATED', message: 'x' }))).toBe(
      false,
    );
    expect(isTransientError(new ApiException(429, { code: 'RATE_LIMITED', message: 'x' }))).toBe(
      false,
    );
  });
});

describe('query retry policy (used by every useQuery hook)', () => {
  it('does not retry on 400 validation errors', () => {
    const err = new ApiException(400, { code: 'VALIDATION_ERROR', message: 'bad' });
    expect(shouldRetry(0, err)).toBe(false);
    expect(shouldRetry(1, err)).toBe(false);
  });

  it('does not retry on 404 not-found', () => {
    const err = new ApiException(404, { code: 'NOT_FOUND', message: 'nope' });
    expect(shouldRetry(0, err)).toBe(false);
  });

  it('does not retry on 429 rate-limited (user must back off)', () => {
    const err = new ApiException(429, { code: 'RATE_LIMITED', message: 'slow down' });
    expect(shouldRetry(0, err)).toBe(false);
  });

  it('retries 5xx up to 2 times', () => {
    const err = new ApiException(500, { code: 'INTERNAL_ERROR', message: 'boom' });
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(1, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(false);
  });

  it('retries TIMEOUT / NETWORK_ERROR (status 0)', () => {
    const timeout = new ApiException(0, { code: 'TIMEOUT', message: 'timeout' });
    const network = new ApiException(0, { code: 'NETWORK_ERROR', message: 'offline' });
    expect(shouldRetry(0, timeout)).toBe(true);
    expect(shouldRetry(0, network)).toBe(true);
  });

  it('retries generic Error (non-ApiException) up to 2 times', () => {
    const err = new Error('weird');
    expect(shouldRetry(0, err)).toBe(true);
    expect(shouldRetry(2, err)).toBe(false);
  });
});
