import { describe, it, expect, vi } from 'vitest';
import { ApiException } from '@loop/shared';
import { isExpectedClientError, forwardQueryErrorToSentry } from '../query-error-reporting';

/**
 * A2-1322 — the filter decides what reaches Sentry. Its job is to
 * preserve signal: 4xx outcomes on admin / auth-gated surfaces are
 * expected (a non-admin hitting an admin route sees 404/401), so the
 * filter silences them. Anything else — 5xx, a non-ApiException throw,
 * our internal TIMEOUT envelope (status=0) — is forwarded.
 */
describe('isExpectedClientError', () => {
  it('treats 4xx ApiException as expected (silences Sentry)', () => {
    expect(isExpectedClientError(new ApiException(401, { code: 'x', message: 'x' }))).toBe(true);
    expect(isExpectedClientError(new ApiException(403, { code: 'x', message: 'x' }))).toBe(true);
    expect(isExpectedClientError(new ApiException(404, { code: 'x', message: 'x' }))).toBe(true);
    expect(isExpectedClientError(new ApiException(422, { code: 'x', message: 'x' }))).toBe(true);
    expect(isExpectedClientError(new ApiException(429, { code: 'x', message: 'x' }))).toBe(true);
  });

  it('treats 5xx ApiException as unexpected (forwards to Sentry)', () => {
    expect(isExpectedClientError(new ApiException(500, { code: 'x', message: 'x' }))).toBe(false);
    expect(isExpectedClientError(new ApiException(502, { code: 'x', message: 'x' }))).toBe(false);
    expect(isExpectedClientError(new ApiException(503, { code: 'x', message: 'x' }))).toBe(false);
  });

  it('forwards the internal TIMEOUT envelope (status=0) — it indicates a runtime anomaly', () => {
    expect(isExpectedClientError(new ApiException(0, { code: 'TIMEOUT', message: 'x' }))).toBe(
      false,
    );
  });

  it('forwards generic Error throws (JS runtime, network lost, non-typed errors)', () => {
    expect(isExpectedClientError(new Error('boom'))).toBe(false);
    expect(isExpectedClientError(new TypeError('undefined is not a function'))).toBe(false);
    expect(isExpectedClientError('string error')).toBe(false);
    expect(isExpectedClientError(null)).toBe(false);
  });
});

describe('forwardQueryErrorToSentry', () => {
  it('calls captureException for a 5xx ApiException with source tag + key extra', () => {
    const sentry = { captureException: vi.fn() };
    const err = new ApiException(500, { code: 'INTERNAL', message: 'boom' });
    forwardQueryErrorToSentry(err, { source: 'tanstack-query', key: ['admin-treasury'] }, sentry);
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(sentry.captureException).toHaveBeenCalledWith(err, {
      tags: { source: 'tanstack-query' },
      extra: { key: ['admin-treasury'] },
    });
  });

  it('does NOT call captureException for a 401 ApiException (expected user-space)', () => {
    const sentry = { captureException: vi.fn() };
    forwardQueryErrorToSentry(
      new ApiException(401, { code: 'UNAUTHORIZED', message: 'x' }),
      { source: 'tanstack-query', key: ['admin-users'] },
      sentry,
    );
    expect(sentry.captureException).not.toHaveBeenCalled();
  });

  it('forwards a non-ApiException throw (runtime TypeError)', () => {
    const sentry = { captureException: vi.fn() };
    const err = new TypeError('cannot read x of undefined');
    forwardQueryErrorToSentry(
      err,
      { source: 'tanstack-mutation', key: ['admin-credit-adjust'] },
      sentry,
    );
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('tags the Sentry event with mutation source for MutationCache events', () => {
    const sentry = { captureException: vi.fn() };
    forwardQueryErrorToSentry(
      new Error('boom'),
      { source: 'tanstack-mutation', key: ['admin-mutation'] },
      sentry,
    );
    expect(sentry.captureException.mock.calls[0]?.[1]).toMatchObject({
      tags: { source: 'tanstack-mutation' },
    });
  });

  it('handles an undefined mutation key (mutations often have no key)', () => {
    const sentry = { captureException: vi.fn() };
    forwardQueryErrorToSentry(
      new Error('boom'),
      { source: 'tanstack-mutation', key: undefined },
      sentry,
    );
    expect(sentry.captureException.mock.calls[0]?.[1]).toMatchObject({
      extra: { key: null },
    });
  });
});
