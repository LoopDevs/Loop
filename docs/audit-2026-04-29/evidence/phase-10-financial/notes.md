# Phase 10 — Financial Correctness

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditor: Codex
- Phase status: in-progress

## Findings logged

- `A3-006` High — payout compensation is not at-most-once and can race with payout retry, creating a double-benefit / treasury-loss path.
- `A3-007` High — admin withdrawal idempotency is weaker than documented and can double-debit via concurrent same-key retries or duplicate semantic withdrawals.
- `A3-008` Medium — the daily admin-adjustment cap is raceable across different target users because the cap check is not serialised per admin.

## Notes

- This is a static seed pass only. Runtime probes and invariant tests still need to follow.
- The migration journal looked superficially aligned on this pass; the early risk is in money-write concurrency and idempotency rather than obvious numbering drift.
