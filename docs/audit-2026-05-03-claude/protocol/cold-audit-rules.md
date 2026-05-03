# Cold Audit Rules

## Independence

- Prior findings, old trackers, old remediation plans, and previous sign-offs are not input evidence.
- Old audit files may be read only for scaffold shape, inventory, or documentation-truth review.
- A finding that resembles an old finding must be independently rediscovered from current files or runtime evidence.
- If a reviewer recognizes a prior issue, they must record the current evidence path before filing it.
- Claude must not use another agent's notes, findings, evidence, or execution tracker as evidence.
- Claude may use only this directory, current code/config/runtime evidence, and historical docs treated as claims to verify.

## Verification Hierarchy

Use this trust order:

1. Current code and config at the baseline commit.
2. Runtime command output captured during this audit.
3. Tests executed or inspected during this audit.
4. Current docs only after code verification.
5. Prior docs and audit material only as historical claims to audit.

## Scope Discipline

- Every tracked file gets a disposition.
- Every generated or binary file gets a source-of-truth, checksum, metadata, or explicit exclusion disposition.
- Every cross-file interaction gets one primary owner and all relevant secondary phase references.
- Do not close a phase because tests pass. Tests are evidence, not proof of completeness.

## Change Discipline

- Freeze the baseline before execution.
- If code changes during execution, record the delta and re-open affected phases.
- Do not remediate findings during evidence collection unless the lead auditor explicitly pauses the audit and records the baseline change.
- Do not rewrite evidence to make results look cleaner.
