# Second and Third Pass Protocol

## Second Pass

Run after each phase's first-pass evidence is complete.

Required checks:

- Re-read phase notes against assigned primary files.
- Confirm all primary files have disposition.
- Confirm secondary phase interactions are listed.
- Compare code vs docs for the phase.
- Compare code vs tests for the phase.
- Compare generated outputs vs source where relevant.
- Search for direct boundary violations, such as direct fetches, direct plugin imports, unvalidated upstream data, missing authz, missing OpenAPI, or undocumented env vars.
- Verify every finding has enough evidence and no finding relies on prior audit text.

Second-pass outcome must be one of:

- `pass`
- `pass-with-findings`
- `reopen-phase`
- `blocked`

## Third Pass

Run only after all phases complete second pass.

Required checks:

- Re-run tracked file count and compare to `file-disposition.tsv`.
- Confirm zero `unreviewed` rows.
- Confirm zero missing evidence-note files.
- Confirm every route, workflow, script, env var, DB table, migration, shared export, native wrapper, public asset, and doc family has an owner.
- Re-run negative-space searches for missing authz, validation, idempotency, audit trails, rate limits, tests, docs, runbooks, alerts, error codes, OpenAPI registrations, and cleanup paths.
- Reconcile all findings for duplicates and severity consistency.
- Check that old audit findings were not imported without independent evidence.
- Produce final sign-off notes with residual risks and accepted exclusions.

Third-pass outcome must be one of:

- `audit-complete`
- `audit-complete-with-accepted-risk`
- `reopen-specific-phases`
- `blocked`

## Fourth Pass: Planned vs Current Features

Run after third pass and before final sign-off.

Required checks:

- Populate the planned-feature matrix from roadmap, ADRs, known limitations, docs, TODOs, and current code.
- Verify every current user/admin/operator feature is represented.
- Verify every planned feature has current-code disposition.
- Confirm partial future-facing code is either unreachable, intentionally gated, documented, tested, and observable, or filed as a finding.
- Confirm deferred controls still meet their deferral assumptions.

Fourth-pass outcome must be one of:

- `feature-matrix-complete`
- `feature-matrix-complete-with-findings`
- `reopen-docs-or-implementation-phases`
- `blocked`

## Fifth Pass: Plan Self-Review

Run after Phase 24 exists and again before final sign-off.

Required checks:

- Confirm the plan, checklist, tracker, protocol, journeys, findings, evidence, and inventory all reference planned-feature reconciliation.
- Confirm phase counts and file-disposition rows include all new audit files.
- Confirm `inventory/scaffold-disposition.tsv` exists and every scaffold file has a self-review disposition.
- Confirm review dimensions are explicit: logic correctness, code quality, documentation accuracy, documentation coverage, test coverage, test accuracy, security/privacy, operations, and planned-feature fit.
- Confirm the final report can answer both current correctness and planned-vs-current completeness.

Fifth-pass outcome must be one of:

- `plan-reviewed`
- `plan-reviewed-with-gaps`
- `blocked`

## Negative-Space Search Prompts

- "Where should an auth check exist but does not?"
- "Where should an idempotency key exist but does not?"
- "Where can a worker do the same thing twice?"
- "Where can a public route leak stale, personal, or internal data?"
- "Where can a client forge state the server trusts?"
- "Where can money move without a ledger transaction?"
- "Where can a DB constraint be weaker than TypeScript?"
- "Where can mobile storage fail open?"
- "Where can CI skip a required check?"
- "Where can docs send an operator to the wrong command?"
