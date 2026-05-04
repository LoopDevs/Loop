# Full Cold Audit Plan

## Objective

Produce a fresh, adversarial, code-verified assessment of the entire Loop system:

1. Correctness: the implementation does what the product, API, and financial model require.
2. Security: realistic attackers, malicious users, compromised clients, hostile networks, and operator mistakes cannot violate trust boundaries.
3. Financial integrity: every money-moving path preserves ledger, asset, payout, settlement, and reconciliation invariants under retry, crash, and concurrency.
4. Operability: failures are observable, actionable, recoverable, and honestly documented.
5. Release integrity: CI, build, mobile sync, deployment, dependency, and review controls prevent unsafe changes from shipping.
6. Documentation truth: docs, ADRs, AGENTS files, OpenAPI, runbooks, and tests match code rather than intent.
7. Code quality: implementation is maintainable, typed, cohesive, bounded, readable, and consistent with local patterns.
8. Test truth: tests cover the right risks and accurately exercise production behavior rather than only proving mocks or implementation details.

## Cold-Audit Rules

- Do not import old findings into this audit.
- Do not trust docs, ADRs, AGENTS files, tests, comments, or prior evidence without code verification.
- Use `docs/audit-2026-04-29` only as a baseline for scaffold shape and for opportunities to make this plan more granular.
- Treat old audit directories as ordinary docs that must themselves be audited for stale claims.
- Every finding must be rediscovered from current code, runtime output, config, or independently captured command evidence.
- Every in-scope tracked file must receive an explicit disposition.
- Every cross-file interaction must be mapped to at least one phase owner.

## Scope

In scope:

- `apps/backend/**`: Hono app, middleware, routes, auth, admin, public API, orders, credits, payments, workers, DB, OpenAPI, fixtures, tests, Docker and Fly config.
- `apps/web/**`: React Router app, SSR/static split, routes, services, hooks, stores, native wrappers, components, utils, CSS, tests, build config, Docker and Fly config.
- `apps/mobile/**`: Capacitor config, generated native projects if tracked, native overlays, native assets, mobile package, scripts, README.
- `packages/shared/**`: shared types, utilities, proto output, package exports, tests if present.
- `.github/**`: workflows, CODEOWNERS, issue and PR templates, Dependabot, labeler, automation.
- `scripts/**`: verification, docs lint, budget checks, e2e helpers, policy checks, DB scripts.
- `tests/**`: Playwright mocked, real, flywheel, fixtures, global setup.
- `docs/**`: architecture, ADRs, development, deployment, testing, standards, runbooks, SLO, alerting, log policy, old audits, archive, roadmap.
- Root files: package manifests, lockfile, TS/ESLint/Playwright/Commitlint configs, Docker compose, policy files, gitleaks, npmrc, gitignore, README, license, changelog, security, conduct, contribution, AGENTS.

Out of scope:

- CTX internals beyond Loop's contract handling, error handling, validation, and operational assumptions.
- Stellar consensus internals beyond Loop's use of Horizon, asset, transaction, memo, trustline, and balance APIs.
- Fly.io, GitHub, npm, Apple, Google, and Android platform internals beyond Loop-owned configuration and integration assumptions.

## Required Deliverables

- Full plan document: this file.
- Full tracking document: [tracker.md](./tracker.md).
- Protocol documents: [protocol/](./protocol/).
- Journey documents: [journeys/](./journeys/).
- Findings register: [findings/register.md](./findings/register.md).
- Severity model and finding template: [findings/severity-model.md](./findings/severity-model.md), [findings/template.md](./findings/template.md).
- Evidence convention and phase evidence notes: [evidence/](./evidence/).
- Inventory, exclusions, file counts, file disposition register, and phase map: [inventory/](./inventory/).

## Review Dimensions

Every implementation phase must explicitly review these dimensions:

- Logic correctness: inputs, outputs, state machines, invariants, edge cases, concurrency, retries, crash windows, and failure modes.
- Code quality: type safety, local patterns, cohesion, naming, duplication, dead code, complexity, import boundaries, generated-code discipline, and maintainability.
- Security and privacy: trust boundaries, validation, authn/authz, secrets, PII, redaction, abuse limits, injection, SSRF, XSS, CSRF, and supply-chain exposure.
- Documentation accuracy: whether existing docs, comments, ADRs, OpenAPI, AGENTS, runbooks, and examples are true for current code.
- Documentation coverage: whether important current behavior, operational procedures, env vars, limits, and planned/deferred features are documented at all.
- Test coverage: whether unit, integration, property, e2e, mocked, real, flywheel, CI, and manual verification cover high-risk behavior.
- Test accuracy: whether tests assert meaningful behavior with realistic boundaries, avoid false confidence from overmocking, exercise negative cases, and match production wiring.
- Planned-feature fit: whether current code matches the planned feature set, exposes partial planned behavior, or implements undocumented capabilities.

## Phase Model

| Phase | Title                                    | Purpose                                                                                                                                                                  |
| ----: | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|    00 | Inventory and Freeze                     | Establish exact baseline, file lists, excluded generated output, dirty-state policy, and ownership map.                                                                  |
|    01 | Governance and Repo Hygiene              | Review branch rules, CODEOWNERS, policy files, templates, ownership, stale files, ignored artifacts, and repository hygiene.                                             |
|    02 | Architecture and ADR Truth               | Reconcile implementation against root docs, package guides, ADRs, architecture boundaries, and known limitations.                                                        |
|    03 | Build, Release, and Reproducibility      | Validate local commands, builds, Dockerfiles, Fly config, mobile export, proto generation, bundle checks, and reproducibility.                                           |
|    04 | Dependencies and Supply Chain            | Audit direct and transitive dependencies, lockfile integrity, licenses, scanners, pinned CLIs, package duplication, and provenance.                                      |
|    05 | Backend Request Lifecycle                | Audit app boot, middleware order, route registration, validation, error envelopes, rate limits, CORS, headers, circuit breakers, and upstream proxying.                  |
|    06 | Auth, Identity, and Sessions             | Audit native auth, legacy CTX auth, social login, OTP, JWTs, refresh, logout, session restore, token storage, replay, and client IDs.                                    |
|    07 | Admin Surface and Operator Controls      | Audit every admin read/write, authz, step-up expectations, idempotency, actor binding, audit logs, CSV, drill-downs, Discord side effects, and sensitive data.           |
|    08 | Public API and Public Surfaces           | Audit unauthenticated endpoints, cache-control, never-500 behavior, PII leakage, marketing routes, sitemap, robots, manifest, and public stats.                          |
|    09 | Orders, Procurement, and Redemption      | Audit order creation, idempotency, state machine, CTX procurement, redemption fields, polling, replay, crash recovery, and user authorization.                           |
|    10 | Payments, Payouts, and Stellar Rails     | Audit Horizon watchers, payment matching, payout submission, memo idempotency, asset choice, trustlines, balance reads, floors, retry, and failure classification.       |
|    11 | Data Layer and Migrations                | Audit Drizzle schema, handwritten SQL, journal order, constraints, triggers, indexes, migration boot, rollback assumptions, and fresh-deploy parity.                     |
|    12 | Financial Invariants and Reconciliation  | Prove ledger, credits, liabilities, cashback, refunds, withdrawals, interest, treasury, and reporting invariants under concurrency and failures.                         |
|    13 | Workers, Schedulers, and Background Jobs | Audit startup orchestration, merchant/location sync, procurement worker, payout worker, payment watcher, asset drift watcher, stuck watchdogs, and cadence safety.       |
|    14 | Web Runtime and UX State                 | Audit routes, services, hooks, stores, query keys, loaders, SSR/static split, error boundaries, purchase flow, wallet flow, admin UI, forms, and accessibility.          |
|    15 | Mobile Shell and Native Bridges          | Audit Capacitor config, generated native files, overlays, plugin wrappers, storage, biometrics, app lock, share, clipboard, network, permissions, backup, and lifecycle. |
|    16 | Shared Contracts and Serialization       | Audit shared types, enums, barrel exports, OpenAPI, proto, Zod schemas, error codes, response shapes, and web/backend compatibility.                                     |
|    17 | Security, Privacy, and Abuse Resistance  | Threat-model auth, admin, public, payment, SSRF, XSS, CSRF, brute force, fraud, logging, secrets, webhook, PII, device, and supply-chain abuse.                          |
|    18 | Testing and Regression Confidence        | Audit unit, integration, property, e2e, mocked, real, flywheel, coverage, test isolation, fixtures, CI test wiring, and false-confidence gaps.                           |
|    19 | Observability and Operations             | Audit logs, metrics, Sentry, Discord, health endpoints, runtime health, SLOs, alerting, on-call, runbooks, incident recovery, and operational handoffs.                  |
|    20 | CI/CD and Release Controls               | Audit workflows, permissions, triggers, caches, branch gates, scans, SBOM, CodeQL, PR review automation, deploy gates, secrets, mobile release assumptions.              |
|    21 | Documentation Truth and Supportability   | Audit every doc, archived doc, roadmap, standards, API compatibility notes, runbooks, env docs, and examples against code.                                               |
|    22 | Bottom-Up File Pass                      | Confirm every tracked file was read or dispositioned, generated exclusions are justified, and orphaned/dead files are identified.                                        |
|    23 | Journey and Cross-File Pass              | Trace every end-to-end journey and every cross-file interaction through code, tests, docs, config, and operations.                                                       |
|    24 | Planned Features and Current Feature Set | Reconcile roadmap, ADR future phases, deferred controls, TODOs, known limitations, and product claims against the implemented feature set.                               |
|    25 | Synthesis and Sign-Off                   | Dedupe findings, perform negative-space review, verify all pass closures, produce final risk summary and remediation queue.                                              |

## Execution Lanes

Lane A: governance, architecture, build, dependencies, CI/CD, release controls.

Lane B: backend lifecycle, middleware, route inventory, auth, public API, OpenAPI.

Lane C: admin, operator controls, sensitive reads/writes, CSV, audit trails.

Lane D: orders, payments, payouts, credits, database, migrations, workers, financial invariants.

Lane E: web runtime, native wrappers, mobile shell, shared contracts, serialization.

Lane F: tests, docs, observability, operations, runbooks, security and privacy.

The lead auditor owns phase gates, cross-lane dedupe, file-disposition integrity, and final synthesis.

## Mandatory Passes

First pass:

- Build the inventory.
- Assign every tracked file to a primary phase.
- Map all routes, workflows, scripts, env vars, DB tables, migrations, shared exports, native wrappers, and journeys.
- Capture evidence before writing findings.

Second pass:

- Re-read phase outputs against file-disposition gaps.
- Reconcile code vs docs, code vs tests, handlers vs OpenAPI, shared types vs producers/consumers, web vs mobile, migrations vs schema, and CI vs documented commands.
- Check cross-file interactions for missing owners and duplicate assumptions.

Third pass:

- Perform negative-space review.
- Search for missing controls, missing tests, missing docs, missing runbooks, missing alerts, missing rate limits, missing authz, missing idempotency, missing validation, and missing operational gates.
- Re-run inventory counts and prove every file has a final disposition.
- Confirm no prior findings were imported without independent evidence.

Fourth pass:

- Build the current feature set from code, routes, services, tests, migrations, UI flows, workers, and deploy config.
- Build the planned feature set from `docs/roadmap.md`, ADRs, known limitations, TODOs, comments, runbooks, old audit planning files, AGENTS, README files, and user-facing copy.
- Classify each feature as implemented, partially implemented, planned, deferred, stale, contradictory, undocumented, or implemented-without-docs.
- Identify risks where docs imply future work but code already exposes partial behavior, or where code ships hidden functionality with no product/ops plan.

Fifth pass:

- Re-run the plan itself against the repository inventory after all new phase files exist.
- Check that planned-feature reconciliation changes the file-disposition map, journey maps, evidence notes, tracker, and final sign-off requirements.
- Check that the scaffold itself has a complete disposition in `inventory/scaffold-disposition.tsv`.
- Check that each phase notes template requires review of logic correctness, code quality, documentation accuracy, documentation coverage, test coverage, and test accuracy where applicable.
- Confirm the final audit report can answer both "is the current system correct?" and "how far is the current system from the planned system?"

## Completeness Gates

The audit is not complete until:

- Every tracked file in [inventory/file-disposition.tsv](./inventory/file-disposition.tsv) has a primary phase and final disposition.
- Every phase has evidence notes and, where applicable, artifact files.
- Every backend route maps to middleware, authn/authz, rate limit, OpenAPI, tests, docs, and error envelope evidence.
- Every web route maps to services, query/state behavior, error boundary, SSR/static behavior, tests, and navigation journey evidence.
- Every admin write path maps to actor, authz, idempotency, reason/audit, DB transaction, tests, OpenAPI, and docs.
- Every money-moving path maps to ledger effects, transaction boundaries, retries, reconciliation, observability, and tests.
- Every migration maps to schema, journal, constraints, tests, and deployment behavior.
- Every native plugin import is accounted for by wrapper, package parity, permission, native lifecycle, and test evidence.
- Every shared export maps to backend producer and web consumer or is documented as unused/dead.
- Every CI job maps to documented required gates and release controls.
- Every old audit and archived doc has a truthfulness disposition as documentation, not evidence.
- Every planned, deferred, future-phase, known-limitation, and roadmap feature has a current-code disposition.
- The final report includes a planned-vs-current feature matrix with risk classification.

## Evidence Standard

Evidence must be specific, reproducible, and local to this baseline:

- command output with command, date/time, commit SHA, and redaction note
- code excerpts referenced by file path and line number in findings
- runtime outputs from tests, builds, scripts, and checks
- inventories generated from `git ls-files`, `rg --files`, `find`, package manifests, workflows, OpenAPI registration, route tables, and DB migrations
- manual reasoning notes tied to exact files and interactions

## Finding Standard

Every finding must include:

- stable ID: `A4-###`
- title, severity, status, owner, phase, surface
- concrete affected files and lines
- evidence references
- impact and exploitability
- reproduction or reasoning path
- remediation recommendation
- tests or verification expected after remediation
- whether the finding is independently rediscovered, not copied from a prior audit

## Negative-Space Questions

Use these in Phase 25:

- What path can move money without an idempotency key, audit trail, transaction, or reconciliation view?
- What path trusts a client, upstream, env var, header, document, cache, or test fixture without validation?
- What public path can fail closed in a way that violates public API guarantees?
- What admin path exposes sensitive data without a business need, audit trail, or role boundary?
- What state machine can reach an impossible state after retry, reload, crash, duplicate worker, or partial upstream outage?
- What code is shipped but not tested, documented but not implemented, tested but not shipped, or configured but not enforced?
- What generated or binary artifact can silently drift from its source of truth?
- What failure would wake an operator, and where is the alert, runbook, and recovery command?

Use these in Phase 24:

- What does the roadmap promise that code does not support?
- What code exists for a future feature but is reachable today?
- What feature is implemented but absent from roadmap, docs, tests, or runbooks?
- What deferred security control has a trigger condition that has already been reached?
- What planned external dependency, mobile capability, stablecoin rail, admin primitive, or public API surface has partial implementation that changes risk today?
