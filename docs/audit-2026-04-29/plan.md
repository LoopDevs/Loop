# Audit Plan

## Objectives

Produce a fresh, adversarial answer to:

1. Is the current codebase correct?
2. Is it secure against realistic abuse and operator mistakes?
3. Is it operable and honestly documented?
4. Are financial and identity invariants actually enforced?

This audit is independent of prior sign-off. Earlier findings and remediations can be reconciled only after new evidence is written.

## Audit principles

- Cold means no trust in earlier audit conclusions.
- Comprehensive means every tracked file in scope gets a disposition.
- Granular means findings cite concrete files, lines, and evidence artifacts.
- Stable target means no fixes while evidence gathering is in flight.
- Adversarial means probing abuse cases, not only reading happy paths.

## Scope

In scope:

- `apps/backend/**`
- `apps/web/**`
- `apps/mobile/**`
- `packages/shared/**`
- `.github/**`
- `docs/**`
- `scripts/**`
- root configs and repo policy files

Out of scope:

- CTX internals
- Stellar consensus behavior
- Fly.io internals beyond our configuration

## Required deliverables

- `tracker.md` maintained as the execution source of truth
- one evidence folder per phase with notes + artifacts
- file-disposition inventory
- findings register with severity, impact, remediation, and evidence refs
- operator handoff list for settings the user must flip
- post-audit remediation queue

## Phase model

| Phase | Title                                 | Purpose                                                                                  |
| ----- | ------------------------------------- | ---------------------------------------------------------------------------------------- |
| 0     | Inventory & Freeze                    | lock baseline SHA, enumerate files, map files to phases, record exclusions               |
| 1     | Governance & Repo Hygiene             | repo policy, branch protection, generated residue, ownership, stale artifacts            |
| 2     | Architecture & ADR Truth              | compare implementation to AGENTS/docs/ADRs, note drift and undocumented changes          |
| 3     | Build, Release & Reproducibility      | scripts, builds, Dockerfiles, deploy parity, local reproducibility                       |
| 4     | Dependencies & Supply Chain           | dependency necessity, audit posture, provenance, pinned tooling, transitive risk         |
| 5     | Backend Request Surface               | middleware, auth gates, route registration, request/response correctness                 |
| 6     | Admin Surface                         | admin reads/writes, CSV exports, actor/idempotency/audit guarantees, step-up enforcement |
| 7     | Public API Surface                    | ADR-020 never-500 guarantees, cache-control, no-PII, rate limits, fallback behavior      |
| 8     | Orders, Procurement & Money Movement  | order creation, procurement, redemption, payout creation, lifecycle correctness          |
| 9     | Data Layer & Migrations               | Drizzle schema parity, hand-written SQL, `_journal.json`, boot migrations, constraints   |
| 10    | Financial Correctness                 | ledger invariants, balances, currency handling, reconciliation, concurrency correctness  |
| 11    | Workers & Schedulers                  | merchant/location refresh, watchers, payout/procurement workers, retry/idempotency       |
| 12    | Web Runtime                           | routes, services, query/state invariants, UX/error paths, SSR/mobile build split         |
| 13    | Mobile & Native Bridges               | Capacitor shell, native wrappers, generated overlays, device-storage and lifecycle risk  |
| 14    | Shared Contracts & Serialization      | `packages/shared`, OpenAPI, proto, error codes, enum exhaustiveness                      |
| 15    | Security, Privacy & Abuse             | auth/session abuse, SSRF, XSS, secrets, logging leakage, trust boundaries                |
| 16    | Testing & Regression Confidence       | unit/integration/e2e coverage quality, false confidence, missing high-risk assertions    |
| 17    | Observability & Operational Readiness | SLOs, alerting, on-call, runbooks, log policy, incident recovery posture                 |
| 18    | CI/CD & Release Controls              | workflow safety, protected branches, secret use, scanning, deployment gates              |
| 19    | Synthesis, Reconciliation & Sign-off  | cross-phase dedupe, coverage-gap pass, final counts, audit closure                       |

## Checklist corrections versus legacy material

The legacy `docs/audit-checklist.md` is seed material only. The fresh checklist must explicitly cover:

- dual-path auth, not proxy-only auth
- admin as a first-class surface
- LOOP-native credits, payouts, and procurement
- workers/watchers/schedulers
- database migration correctness and schema/journal parity
- public API guarantees under ADR 020
- contracts/docs/OpenAPI/AGENTS truthfulness
- operational controls, privacy, and runbook readiness

## Worker model

Lead auditor responsibilities:

- own tracker integrity and phase gates
- prevent duplicate work and double-filed findings
- reconcile cross-phase issues
- enforce evidence quality and exclusion discipline

Parallel worker lanes for execution:

1. Governance, architecture, CI/CD, and supply chain
2. Backend request surface, auth, and public API
3. Admin surface plus operator-only flows
4. Orders, credits, payouts, workers, database, and financial invariants
5. Web runtime and shared contracts
6. Mobile shell, native wrappers, and generated overlays
7. Docs, runbooks, observability, privacy, and operational readiness

## Sequencing

1. Complete Phase 0 first. No parallel audit work before inventory and freeze.
2. Run Phases 1 to 4 in parallel.
3. Run Phases 5 to 14 in parallel by lane, with the lead auditor managing overlap.
4. Start Phase 10 only after enough evidence exists from Phases 8, 9, and 14 to test financial invariants meaningfully.
5. Run Phase 15 after major request/data surfaces are understood.
6. Run Phases 16 to 18 after enough implementation context exists to judge coverage and release readiness.
7. Close with Phase 19 synthesis and a deliberate negative-space pass.

## Completeness gates

The audit is not complete until all are true:

- every in-scope tracked file has a disposition
- every phase has evidence notes and artifact references
- every ADR has a reconciliation line
- every public and authenticated route has been mapped to a phase owner
- every admin write path has explicit authz/idempotency/audit review
- every money-moving path has invariant checks and concurrency review
- every generated or excluded area has an explicit reason
- the final pass covers code vs docs, code vs tests, tests vs CI, and web vs mobile assumptions

## Negative-space pass

One late phase pass is reserved for things that should exist but might not:

- missing tests for high-risk paths
- missing runbooks for alert-worthy failure modes
- missing OpenAPI registrations
- missing shared contracts
- missing env docs
- missing security headers or policy files
- missing audit trails for sensitive reads/writes

## Execution notes

- Evidence should stay append-only during an active phase.
- Large outputs belong in phase artifact files, not inline in notes.
- If the repo changes mid-audit, record the delta and either re-freeze or restart the affected phase.
