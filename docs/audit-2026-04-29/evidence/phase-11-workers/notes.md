# Phase 11 — Workers & Schedulers

- Capture date: 2026-04-29
- Commit audited: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditors: Codex, worker `Descartes`
- Phase status: complete

## Findings logged

- `A3-031` High — payout retry is not at-most-once when the Horizon idempotency pre-check is degraded.

## Clean bill so far

- Merchant and cluster refresh paths use in-flight guards plus atomic snapshot replacement.

## Cross-phase note

- Worker observability weaknesses are tracked separately under `A3-024`.
