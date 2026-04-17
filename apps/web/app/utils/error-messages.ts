import { ApiException } from '@loop/shared';

/**
 * Status-to-user-message map. Shared between the ApiException branch and the
 * plain-shape branch so "add a new mapping" is a single edit, not two.
 *
 * 502 + 504 matter because the backend surfaces transient upstream failures
 * as 502 UPSTREAM_ERROR (see auth/handler and orders/handler). Without a
 * dedicated message, the user saw whatever generic fallback the call site
 * passed — usually "Failed to send verification code" or similar — which
 * gave no signal that this was worth retrying.
 */
const STATUS_MESSAGES: Record<number, string> = {
  429: 'Too many attempts. Please wait a moment.',
  502: 'Our provider is having trouble. Please try again.',
  503: 'Service temporarily unavailable. Please try again shortly.',
  504: 'Our provider timed out. Please try again.',
};

/** Returns a user-friendly error message, checking if the device is offline. */
export function friendlyError(err: unknown, fallback: string): string {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'You appear to be offline. Please check your connection and try again.';
  }
  if (err instanceof ApiException) {
    // Client-side classifications set in services/api-client.ts when fetch
    // aborts or rejects. Both get status: 0.
    if (err.code === 'TIMEOUT') return 'The request took too long. Please try again.';
    if (err.code === 'NETWORK_ERROR') return 'Network error. Please check your connection.';
    const mapped = STATUS_MESSAGES[err.status];
    if (mapped !== undefined) return mapped;
  } else if (err && typeof err === 'object' && 'status' in err) {
    // Fallback for plain shape-matching (e.g. a thrown object from elsewhere).
    const status = (err as { status: number }).status;
    const mapped = STATUS_MESSAGES[status];
    if (mapped !== undefined) return mapped;
  }
  return fallback;
}
