/**
 * Shared Postgres unique-violation (SQLSTATE `23505`) detection.
 *
 * postgres-js surfaces a raw `PostgresError` with `code === '23505'`
 * and `constraint_name` populated for a unique-index violation.
 * Drizzle wraps that raw error in a `DrizzleQueryError` whose own
 * top-level `.message` is a FIXED string — `"Failed query: <sql>\n
 * params: <params>"` — never the underlying constraint-violation
 * text. The real Postgres error lives on `err.cause`, not on the
 * top-level `err`.
 *
 * A message-substring check against the top-level `err.message`
 * (e.g. `err.message.includes('some_unique_constraint')`) therefore
 * NEVER matches a real Drizzle-wrapped driver error — it only
 * matches a test mock that throws a flat `Error` with the substring
 * inlined at the top level, which is not the shape the real driver
 * produces. `credits/interest-mint.ts` and `credits/accrue-interest.ts`
 * both shipped exactly that bug (AUDIT-2 finding D, 2026-07-09): a
 * benign crash-recovery re-run of an already-minted period got
 * misclassified as a genuine error, which (because the cursor only
 * advances when the sweep sees zero errors) stalled the interest-mint
 * cursor and error-spammed until the UTC day rolled over. Not a
 * double-mint — the DB unique constraint still forces the transaction
 * to roll back before the catch block runs — but a broken self-heal /
 * observability guarantee.
 *
 * `credits/refunds.ts` (`isDuplicateRefund`) and `credits/emissions.ts`
 * (`isDuplicateEmission`) already solved this correctly by walking
 * `err.cause`; this helper factors that logic out to one place so the
 * bug class can't recur a third time.
 */

interface CauseCarrier {
  cause?: unknown;
}

interface PostgresErrorLike {
  code?: string;
  constraint_name?: string;
}

/** Bounds the cause-chain walk so a cyclic or absurdly-deep chain can't spin. */
const MAX_CAUSE_DEPTH = 4;

/**
 * Walks `err` and its `.cause` chain (bounded depth) for a structured
 * Postgres unique-violation (`code === '23505'`). When `constraintName`
 * is given, only a violation of that specific constraint counts — so a
 * DIFFERENT unique violation on the same table isn't silently
 * swallowed as "the one race this caller already expects".
 */
export function isUniqueViolation(err: unknown, constraintName?: string): boolean {
  let cur: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && cur instanceof Error; depth++) {
    const e = cur as Error & PostgresErrorLike;
    if (
      e.code === '23505' &&
      (constraintName === undefined || e.constraint_name === constraintName)
    ) {
      return true;
    }
    cur = (e as CauseCarrier).cause;
  }
  return false;
}

/**
 * Convenience wrapper matching against any of several constraint
 * names — for a caller (like the interest-mint per-user transaction)
 * that writes more than one uniquely-indexed row in the same
 * transaction and treats a violation of ANY of those fences as the
 * same benign "already processed" outcome.
 */
export function isUniqueViolationOnAny(err: unknown, constraintNames: readonly string[]): boolean {
  return constraintNames.some((name) => isUniqueViolation(err, name));
}
