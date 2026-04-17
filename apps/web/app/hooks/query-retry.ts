import { ApiException } from '@loop/shared';

/**
 * Retry predicate for TanStack Query: don't retry 4xx responses (client
 * errors won't become 2xx by trying again — 400 stays 400, 404 stays 404,
 * 429 means back off). Retry up to 2 times for 5xx, timeouts, and network
 * errors, which may succeed on retry.
 *
 * Used by every useQuery hook in the app for uniform retry behaviour.
 */
export function shouldRetry(failureCount: number, error: Error): boolean {
  if (error instanceof ApiException) {
    if (error.status >= 400 && error.status < 500) return false;
  }
  return failureCount < 2;
}
