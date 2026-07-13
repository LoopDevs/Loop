import { ApiException } from '@loop/shared';

/**
 * Is this a transient failure worth retrying, as opposed to a client
 * error that won't heal? 4xx responses are permanent for the same
 * request — 400 stays 400, 404 stays 404 (endpoint not deployed), 401
 * means re-auth, 429 means back off — so they are NOT transient.
 * Everything else (5xx, timeouts, network errors → status 0, and
 * non-ApiException failures) is a blip that may succeed on retry.
 *
 * Single source of truth for the "retry vs. give up" distinction: the
 * retry predicate below decides whether to auto-retry, and error-state
 * UI uses it to decide whether to offer a manual "retry" affordance
 * (which would be a lie for a 4xx that can never succeed).
 */
export function isTransientError(error: unknown): boolean {
  if (error instanceof ApiException) {
    return error.status < 400 || error.status >= 500;
  }
  return true;
}

/**
 * Retry predicate for TanStack Query: don't retry 4xx responses (client
 * errors won't become 2xx by trying again — 400 stays 400, 404 stays 404,
 * 429 means back off). Retry up to 2 times for 5xx, timeouts, and network
 * errors, which may succeed on retry.
 *
 * Used by every useQuery hook in the app for uniform retry behaviour.
 */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (!isTransientError(error)) return false;
  return failureCount < 2;
}
