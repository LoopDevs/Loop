import { ApiException } from '@loop/shared';

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
    if (err.status === 503) return 'Service temporarily unavailable. Please try again shortly.';
    if (err.status === 429) return 'Too many attempts. Please wait a moment.';
  } else if (err && typeof err === 'object' && 'status' in err) {
    // Fallback for plain shape-matching (e.g. a thrown object from elsewhere).
    const status = (err as { status: number }).status;
    if (status === 503) return 'Service temporarily unavailable. Please try again shortly.';
    if (status === 429) return 'Too many attempts. Please wait a moment.';
  }
  return fallback;
}
