# Supplementary: test-vacuity sample — credits/**tests** (from a peer Claude session)

Source: unsolicited report delivered mid-audit by another Claude Code session
auditing the same repo. Not independently commissioned by this audit's
orchestration — treat findings below as PLAUSIBLE pending the normal
adversarial-verification pass (Phase 5), same as any other raw input.

## Files read (16 files, all read in full per the reporting agent)

apps/backend/src/credits/{accrue-interest,adjustments,ledger-invariant,
liabilities,payout-builder,withdrawals,refunds,payout-compensation}.ts

- their **tests** siblings.

## Headline

2 of 8 test files have at least one genuinely vacuous/weak test; 2 more have
one borderline-but-defensible weak test; 4 files (ledger-invariant,
payout-builder, withdrawals, payout-compensation) had no vacuous tests.

## Findings (3 worth carrying into synthesis)

### EXT-01 — `liabilities.test.ts:58-65` weak currency-filter test

`'filters by the requested currency (only one SELECT per call)'` only asserts
`whereClauses.length === 1`, never that the filter value is actually `'EUR'`.
Feeds the ADR-015 on-chain/off-chain stablecoin drift check — a silently
broken currency filter (summing all currencies) would pass this test and
could mask real backing-asset drift.
Fix: capture the literal currency arg passed to the mock `.where()` and
assert equality, not just call count.

### EXT-02 — `adjustments.test.ts:292-307` weak per-currency cap isolation test

`'different currency writes are unaffected'` claims to test per-currency
admin-adjustment-cap isolation (a treasury anti-drain control) but the
mock's FIFO response queue ignores the actual currency clause queried — a
regression that summed two currencies' caps together would still pass.
Fix: make the mock branch on queried currency; assert a near-cap USD bucket
doesn't block a fresh EUR adjustment.

### EXT-03 — `accrue-interest.test.ts:262-266` single-row transaction-isolation test

`'uses a transaction for each per-user write'` seeds only one user row, so it
cannot distinguish "one tx per user" (the documented FOR-UPDATE/idempotency
guarantee) from "one shared tx for the whole nightly accrual batch."
Fix: seed 2+ users, assert `dbMock['transaction']` called once per user.

## Minor / borderline (not carried forward as standalone findings)

- `adjustments.test.ts` / `refunds.test.ts` both have a
  `'skips the cap check when cap is 0 (disabled)'` test that only asserts
  `.resolves.toBeDefined()` rather than real balance values — borderline,
  still has some regression-catching power via the `capMinor > 0n` guard.
- `ledger-invariant.test.ts` has solid pure-function coverage but
  `computeLedgerDriftSql` (the SQL-backed half) has zero test coverage —
  a coverage gap, not a vacuous test; cross-reference against this audit's
  own financial-invariant findings before filing separately.
