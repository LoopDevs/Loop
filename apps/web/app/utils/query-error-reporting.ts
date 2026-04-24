/**
 * TanStack Query → Sentry bridge (A2-1322).
 *
 * Before this helper, `QueryClient` had no `queryCache` / `mutationCache`
 * hooks, so every failed query/mutation crossed into `useQuery({ onError })`
 * and `useMutation({ onError })` at the call site, was handled locally (if
 * at all), and never reached Sentry. Result: admin-surface errors —
 * broken admin shapes, backend 500s, unexpected JS throws inside a
 * query function — passed silently. Users saw a toast or blank card and
 * ops saw nothing.
 *
 * The filter is narrow on purpose. A 401 on the admin surface when a
 * non-admin navigates there is an expected client-space outcome, not a
 * bug; flooding Sentry with those would bury real signal. Similarly
 * 403/404/422/429 all have deterministic handling in the UI. The
 * forward is gated on:
 *   - non-`ApiException` throws (JS runtime errors, aborts beyond the
 *     typed TIMEOUT path, unexpected network shapes)
 *   - `ApiException` with status >= 500 (backend bug / circuit-open)
 *   - `ApiException` with status === 0 (our internal TIMEOUT / aborted
 *     envelope; these are always "unexpected" as far as a retry policy
 *     is concerned so forward them too)
 *
 * The handler uses the `Sentry.captureException` shape rather than a
 * direct `Sentry.init` dependency — when Sentry is not initialised the
 * SDK's `captureException` is a no-op, and tests that don't mock
 * Sentry still run cleanly.
 */
import type * as SentryType from '@sentry/react';
import { ApiException } from '@loop/shared';

/** Sentry.captureException contract surface actually used here. */
export type SentryLike = Pick<typeof SentryType, 'captureException'>;

/**
 * Returns true when the error is an expected client-space outcome
 * whose presence in Sentry would be noise (401/403/404/422/429 —
 * handled locally by the calling surface). Anything else forwards.
 */
export function isExpectedClientError(err: unknown): boolean {
  if (!(err instanceof ApiException)) return false;
  const s = err.status;
  // status === 0 is the internal TIMEOUT / aborted envelope; forward
  // it because it indicates a runtime anomaly rather than a
  // user-space decision.
  if (s === 0) return false;
  // 5xx is always a backend bug / infra issue — forward.
  if (s >= 500) return false;
  // 4xx is user-space and handled locally.
  return s >= 400 && s < 500;
}

export interface ForwardArgs {
  /** Identifies the query key or mutation key for Sentry extras. */
  source: 'tanstack-query' | 'tanstack-mutation';
  key: readonly unknown[] | undefined;
}

/**
 * Forwards the error to Sentry if it looks unexpected. Quietly drops
 * expected 4xx cases. Accepts a `sentry` module reference so tests
 * can pass an in-memory double.
 */
export function forwardQueryErrorToSentry(
  err: unknown,
  args: ForwardArgs,
  sentry: SentryLike,
): void {
  if (isExpectedClientError(err)) return;
  sentry.captureException(err, {
    tags: { source: args.source },
    extra: { key: args.key ?? null },
  });
}
