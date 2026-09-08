/**
 * Admin idempotency constants (ADR 017).
 *
 * Lives in its own module so both the guard (`./idempotency.ts`) and
 * the single-row store layer (`./idempotency-store.ts`) can share the
 * replay window without a circular import. Re-exported from
 * `./idempotency.ts` so existing import sites keep resolving.
 */

export const IDEMPOTENCY_KEY_MIN = 16;
export const IDEMPOTENCY_KEY_MAX = 128;

/**
 * A2-500: ADR-017 §6 promised a 24h TTL on admin-idempotency
 * snapshots, but nothing enforced it — rows accumulated forever.
 *
 * NS-03 decoupling: this constant governs ONLY the REPLAY-hit window —
 * the period in which a re-submitted (adminUserId, key) pair returns
 * the cached response instead of re-executing the write. It is applied
 * at read time in two places, `lookupIdempotencyKey()` and the re-read
 * inside `withIdempotencyGuard()`, so the guarded and manual replay
 * paths cannot drift.
 *
 * It is NOT the retention cutoff. `admin_idempotency_keys` doubles as
 * the durable admin-action AUDIT trail (`audit-tail.ts` reads it),
 * which must persist far longer than the replay window. Retention is
 * governed independently by `admin.auditRetentionDays`. Keeping the
 * replay window at 24h while retaining rows for years is safe: a
 * re-submit past 24h is a replay MISS and re-executes — the same
 * behaviour as before, when the row would already have been swept.
 */
export const IDEMPOTENCY_TTL_HOURS = 24;
