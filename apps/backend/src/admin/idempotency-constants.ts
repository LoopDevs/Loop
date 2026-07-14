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
 *
 * NS-03 decoupling: this constant now governs ONLY the REPLAY-hit
 * window — the bounded period in which a re-submitted (adminUserId,
 * key) pair returns the cached response instead of re-executing the
 * write. It is applied at read time in two places:
 *   - `lookupIdempotencyKey()` (idempotency-store.ts) — a row older
 *     than this window is treated as a MISS.
 *   - the re-read inside `withIdempotencyGuard()` (idempotency.ts) —
 *     same window, so the guarded and manual replay paths cannot
 *     drift.
 *
 * It is NO LONGER the retention/sweep cutoff. `admin_idempotency_keys`
 * doubles as the durable admin money-move AUDIT trail (read by
 * `audit-tail.ts` and `user-audit-timeline.ts`), which must persist
 * far longer than the 24h replay window for regulatory/forensic
 * reasons. Retention is now governed independently by
 * `LOOP_ADMIN_AUDIT_RETENTION_DAYS` (consumed by
 * `sweepStaleIdempotencyKeys()`). Keeping the replay window at 24h
 * while retaining rows for years is safe: a re-submit past 24h is a
 * replay MISS and re-executes (the same behaviour as before, when the
 * row would already have been swept) — see `sweepStaleIdempotencyKeys`
 * for the ON-CONFLICT interaction on the retained row.
 */
export const IDEMPOTENCY_TTL_HOURS = 24;
