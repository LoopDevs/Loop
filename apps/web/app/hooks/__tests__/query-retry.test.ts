import { describe, it, expect } from 'vitest';
import { ApiException } from '@loop/shared';
import { shouldRetry } from '../query-retry';

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
