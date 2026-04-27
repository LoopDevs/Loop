/**
 * Admin idempotency constants (ADR 017).
 *
 * Lives in its own module so both the higher-level guard pattern
 * (`./idempotency.ts`) and the single-row store layer
 * (`./idempotency-store.ts`) can share the 24h TTL without a
 * circular import. Re-exported from `./idempotency.ts` so existing
 * import sites keep resolving.
 */

export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 128;

/**
 * A2-500: ADR-017 #6 promised a 24h TTL on admin-idempotency
 * snapshots, but nothing enforced it — rows accumulated forever.
 * The TTL is applied in two places:
 *   - `sweepStaleIdempotencyKeys()` runs hourly from the app-level
 *     cleanup interval and DELETEs rows whose `created_at` is older
 *     than the TTL.
 *   - `lookupIdempotencyKey()` filters expired rows at read time so
 *     a replay within the first sweep window after a restart still
 *     sees the correct behaviour.
 */
export const IDEMPOTENCY_TTL_HOURS = 24;
