/** Returns a user-friendly error message, checking if the device is offline. */
export function friendlyError(err: unknown, fallback: string): string {
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return 'You appear to be offline. Please check your connection and try again.';
  }
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    if (status === 503) return 'Service temporarily unavailable. Please try again shortly.';
    if (status === 429) return 'Too many attempts. Please wait a moment.';
  }
  return fallback;
}
