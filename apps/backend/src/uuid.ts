/**
 * Shared UUID-v4 shape check (A2-512).
 *
 * Admin drill-down handlers take untrusted id params from the URL
 * (userId, payoutId, adjustmentId, refundId, orderId). Before the
 * value ever reaches Drizzle's parameterised query builder we want a
 * shape guard that keeps "looks roughly like a uuid" input from
 * hitting the DB as a 2MB pasted log string. Every admin-drill file
 * previously declared its own identical regex under either `UUID_RE`
 * or (in one case) `PENDING_PAYOUT_UUID_RE`; consolidating here keeps
 * the shape check drift-free as new handlers are added.
 *
 * Accepts the RFC 4122 hex-dash-hex shape case-insensitively. We
 * deliberately don't enforce the version / variant nibbles: admin
 * handlers use the id solely as a routing key against a known column
 * value. A surface-area regex that excludes valid-but-unusual uuids
 * would be a liability for no security benefit.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
