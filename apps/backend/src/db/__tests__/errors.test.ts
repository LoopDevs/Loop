import { describe, it, expect } from 'vitest';
import { isUniqueViolation, isUniqueViolationOnAny } from '../errors.js';

/**
 * AUDIT-2 finding D (2026-07-09): the bug this file guards against is
 * that a message-substring check against the TOP-LEVEL `err.message`
 * never matches a real Drizzle-wrapped driver error, because Drizzle's
 * `DrizzleQueryError.message` is a FIXED string ("Failed query: ...")
 * — the real Postgres error (code, constraint_name) lives on
 * `err.cause`. Every positive-case test here therefore constructs the
 * REAL wrapped shape (outer message fixed, `code`/`constraint_name` on
 * `.cause`), not a flat `Error` with the substring inlined at the top
 * level — that flat shape is exactly what gave the old tests false
 * confidence.
 */

/** Builds a `PostgresError`-like object: an `Error` with `code` + `constraint_name`. */
function postgresError(opts: { code: string; constraintName?: string; message?: string }): Error {
  return Object.assign(
    new Error(opts.message ?? `duplicate key value violates unique constraint`),
    {
      code: opts.code,
      constraint_name: opts.constraintName,
    },
  );
}

/**
 * Builds the real `DrizzleQueryError`-like wrapper: top-level message
 * is the fixed "Failed query: ..." string (never the constraint text),
 * `.cause` holds the underlying `PostgresError`.
 */
function drizzleQueryError(cause: unknown): Error {
  return Object.assign(
    new Error('Failed query: insert into "credit_transactions" ...\nparams: ...'),
    { cause },
  );
}

describe('isUniqueViolation', () => {
  it('recognizes a real Drizzle-wrapped unique violation via .cause, matching a specific constraint', () => {
    const err = drizzleQueryError(
      postgresError({
        code: '23505',
        constraintName: 'interest_mint_snapshots_user_asset_period_unique',
      }),
    );
    expect(isUniqueViolation(err, 'interest_mint_snapshots_user_asset_period_unique')).toBe(true);
  });

  it('recognizes a unique violation with no constraint pinned (matches any 23505)', () => {
    const err = drizzleQueryError(
      postgresError({ code: '23505', constraintName: 'some_other_unique' }),
    );
    expect(isUniqueViolation(err)).toBe(true);
  });

  it('does NOT match when the code is 23505 but the constraint name differs — a different unique violation is not silently swallowed', () => {
    const err = drizzleQueryError(
      postgresError({ code: '23505', constraintName: 'some_unrelated_unique_index' }),
    );
    expect(isUniqueViolation(err, 'interest_mint_snapshots_user_asset_period_unique')).toBe(false);
  });

  it('does NOT match a non-unique-violation error code (e.g. FK violation 23503) even walking a real cause chain', () => {
    const err = drizzleQueryError(
      postgresError({ code: '23503', constraintName: 'credit_transactions_user_id_users_id_fk' }),
    );
    expect(isUniqueViolation(err, 'credit_transactions_user_id_users_id_fk')).toBe(false);
  });

  it('does NOT match a plain unexpected error with no cause and no code — still a genuine error', () => {
    const err = new Error('connection terminated unexpectedly');
    expect(isUniqueViolation(err)).toBe(false);
    expect(isUniqueViolation(err, 'any_constraint')).toBe(false);
  });

  it('does NOT match a plain Error whose MESSAGE happens to contain the constraint name (the exact old anti-pattern)', () => {
    // This is the shape the OLD, broken code accepted (message
    // substring at the top level) and the shape the real driver never
    // produces. The helper must not fall back to message-sniffing.
    const err = new Error(
      'duplicate key value violates unique constraint "interest_mint_snapshots_user_asset_period_unique"',
    );
    expect(isUniqueViolation(err, 'interest_mint_snapshots_user_asset_period_unique')).toBe(false);
  });

  it('walks a multiply-nested cause chain within the depth bound', () => {
    // err -> cause (plain Error) -> cause (PostgresError, depth 2)
    const inner = postgresError({ code: '23505', constraintName: 'deep_unique' });
    const middle = Object.assign(new Error('wrapper'), { cause: inner });
    const outer = drizzleQueryError(middle);
    expect(isUniqueViolation(outer, 'deep_unique')).toBe(true);
  });

  it('gives up beyond the bounded walk depth (does not infinite-loop on a long/cyclic chain)', () => {
    // Build a chain deeper than the helper's bound with the match at
    // the very bottom — it must NOT be found (proves the walk is
    // bounded, not unbounded).
    let cur: Error = postgresError({ code: '23505', constraintName: 'too_deep' });
    for (let i = 0; i < 10; i++) {
      cur = Object.assign(new Error(`wrapper-${i}`), { cause: cur });
    }
    expect(isUniqueViolation(cur, 'too_deep')).toBe(false);
  });

  it('handles non-Error, non-Error-instance thrown values without throwing', () => {
    expect(isUniqueViolation('a plain string error')).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation({ code: '23505', constraint_name: 'x' })).toBe(false);
  });
});

describe('isUniqueViolationOnAny', () => {
  it('matches when the violation hits any of several named constraints (interest-mint writes two uniquely-indexed rows per txn)', () => {
    const snapshotViolation = drizzleQueryError(
      postgresError({
        code: '23505',
        constraintName: 'interest_mint_snapshots_user_asset_period_unique',
      }),
    );
    const ledgerViolation = drizzleQueryError(
      postgresError({
        code: '23505',
        constraintName: 'credit_transactions_interest_period_unique',
      }),
    );
    const names = [
      'interest_mint_snapshots_user_asset_period_unique',
      'credit_transactions_interest_period_unique',
    ] as const;
    expect(isUniqueViolationOnAny(snapshotViolation, names)).toBe(true);
    expect(isUniqueViolationOnAny(ledgerViolation, names)).toBe(true);
  });

  it('does not match a unique violation on a constraint outside the allowed set', () => {
    const err = drizzleQueryError(
      postgresError({ code: '23505', constraintName: 'unrelated_unique' }),
    );
    expect(
      isUniqueViolationOnAny(err, [
        'interest_mint_snapshots_user_asset_period_unique',
        'credit_transactions_interest_period_unique',
      ]),
    ).toBe(false);
  });
});
