# Audit Checklist

This checklist replaces the legacy `docs/audit-checklist.md` for the 2026-04-29 cold audit. The old checklist was used as seed material, then expanded to match the current repo.

## How to use this checklist

For every section:

- do a top-down pass
- do a bottom-up file pass
- do at least one end-to-end journey pass
- record exclusions explicitly
- attach evidence refs, not memory

## 1. Inventory, governance, and repo hygiene

- Confirm branch protection, required checks, CODEOWNERS, PR template, review flow, and ownership boundaries.
- Scan for generated residue, ignored-but-important artifacts, dead files, archived drift, and misleading names.
- Verify root docs, package guides, and actual repo structure agree.
- Record the exact frozen commit SHA and any dirty-worktree caveats.

## 2. Architecture and ADR truth

- Reconcile root `AGENTS.md`, package `AGENTS.md`, `docs/architecture.md`, and ADRs against live code.
- Verify the documented auth model reflects current dual-path reality.
- Verify boundaries: web as API client, native wrappers only under `app/native`, shared logic in `packages/shared`.
- Record every material documentation drift and every undocumented architecture change.

## 3. Build, release, and reproducibility

- Verify dev, build, verify, and mobile-export commands actually work as documented.
- Compare backend/web Dockerfiles and deploy config for parity drift.
- Review static-export assumptions for mobile versus SSR web output.
- Check bundle-budget, proto-generation, and overlay application flows.

## 4. Dependencies and supply chain

- Review direct deps by purpose and necessity.
- Check audit posture, overrides, pinning, heavy transitive risk, and native/plugin risk.
- Review workflow-installed tooling, global installs, scanners, SBOM/provenance, and signing posture.
- Confirm third-party license docs match what ships.

## 5. Backend request lifecycle and middleware

- Audit middleware order, request ID, logging, secure headers, body limits, rate limiting, and trusted-proxy assumptions.
- Verify every handler validates inputs and emits the documented error envelope.
- Check route registration against OpenAPI registration.
- Confirm circuit-breaker, timeout, retry, and upstream error handling are consistent and deliberate.

## 6. Auth, identity, and session handling

- Trace both auth paths: Loop-native and legacy CTX proxy.
- Audit OTP request/verify, refresh, logout, session restore, social login, and account-link assumptions.
- Verify token storage tiers, rotation, revocation, reuse handling, and concurrent-refresh behavior.
- Check issuer/audience/subject assumptions, client-id mapping, replay handling, and logout cleanup.

## 7. Admin surface and operator controls

- Audit every admin route for authz, scope, and sensitive-data exposure.
- Check step-up auth expectations against ADR 028 and actual implementation state.
- Verify write-path actor pinning, `Idempotency-Key`, audit-envelope writes, and replay protection.
- Review CSV exports, drill-down endpoints, and admin-side observability/Discord side effects.

## 8. Public API and marketing surface

- Audit `/api/public/*` against ADR 020 guarantees: never-500 behavior, cache policy, and no-PII output.
- Verify rate limits, fallback behavior, stale-data semantics, and failure isolation.
- Check coupling between public API outputs and SSR marketing routes/copy.

## 9. Orders, procurement, redemption, and business flows

- Trace merchant browse to order creation to payment to procurement to redemption.
- Check status transitions, polling, terminal states, backgrounding/reload recovery, and duplicate submission risk.
- Review upstream contract mapping for amounts, currencies, memos, and timestamps.
- Verify authz on list/detail endpoints and no unintended data disclosure.

## 10. Payments, payouts, and money rails

- Review Horizon/payment watcher inputs, inbound matching, payout submission, and retry behavior.
- Audit payout-intent creation, payout-worker transitions, memo idempotency, and failure classification.
- Verify home-currency to LOOP-asset mapping and reserve/floor behavior.
- Check Discord or operator notification side effects for safety and completeness.

## 11. Data layer, schema, and migration correctness

- Reconcile Drizzle schema with hand-written SQL migrations.
- Check `_journal.json` ordering and fresh-deploy behavior.
- Verify CHECK constraints, partial indexes, triggers, and audit tables are represented and tested.
- Review transaction boundaries, row-level race windows, and boot migration semantics.

## 12. Financial correctness and invariants

- Verify `balance == sum(credit_transactions)` and similar derived invariants.
- Check cashback split math, multi-currency correctness, accrual logic, and rounding behavior.
- Probe concurrency: duplicate writes, lost updates, stale reads, and inconsistent payout state.
- Review reconciliation and drift-detection surfaces, including operator and treasury reporting.

## 13. Background workers and schedulers

- Audit merchant/location refresh cadence, startup ordering, and hot-swap safety.
- Review procurement worker, payout worker, Horizon watcher, and accrual jobs.
- Verify duplicate-run safety, idempotency, backoff, dead-letter behavior, and observability.
- Check behavior under partial outage, stale dependencies, and restart during in-flight work.

## 14. Web runtime, UX integrity, and state management

- Audit routes, loaders, error boundaries, and service-only fetch discipline.
- Review TanStack Query keys, invalidation, retry policy, and stale-data behavior.
- Review Zustand store invariants, persistence boundaries, and impossible-state prevention.
- Trace auth, purchase, orders, cashback, wallet, and admin UI flows across loading/error/slow states.

## 15. Mobile shell and native integration

- Review Capacitor config, native wrappers, generated overlays, and plugin inventory.
- Check secure storage, deep links, browser/webview handoff, clipboard/share, biometrics, and app lifecycle hooks.
- Audit iOS/Android permissions, entitlements, backup posture, and production host assumptions.
- Verify static export and native shell assumptions stay in sync.

## 16. Shared contracts, OpenAPI, and serialization

- Reconcile `packages/shared` exports with backend producers and web consumers.
- Verify shared admin and `/me*` shapes, enums, proto, and money-format helpers.
- Compare handler outputs to `openapi.ts`, `docs/error-codes.md`, and documented status codes.
- Confirm no unstable internals leak through barrels and no silent contract drift exists.

## 17. Security, privacy, and abuse resistance

- Threat-model unauthenticated, authenticated, admin, upstream, insider, and mobile-device adversaries.
- Audit CORS, headers, SSRF defenses, XSS/open-redirect/path-injection surfaces, and abuse limits.
- Review secret handling, logging/redaction, webhook secrecy, privacy posture, and PII retention.
- Probe brute force, OTP spam, order fraud, resource exhaustion, and forged-header assumptions.

## 18. Testing and regression confidence

- Inventory coverage by risk, not file count.
- Check unit, integration, and e2e assertions for real failure-mode coverage.
- Review mocked versus real-postgres / real-upstream assumptions and any false-confidence gaps.
- Identify missing tests, brittle tests, redundant tests, and low-value thresholds.

## 19. Observability, operations, and incident readiness

- Review logs, Sentry, metrics, request IDs, alerting, and webhook coverage.
- Check whether auth, money-flow, worker, and upstream-failure incidents are visible.
- Audit runbooks, rollback, disaster recovery, key rotation, and reconciliation docs.
- Verify SLO, alerting, on-call, and log-policy docs match code and workflow reality.

## 20. CI/CD, release controls, and deployment safety

- Review workflows, triggers, caches, environments, secrets, branch rules, and path filters.
- Check secret scanning, CVE scanning, SAST, SBOM/provenance, and review automation.
- Verify deployment docs against actual backend/web/mobile release automation.
- Confirm rollback and preview/staging assumptions are realistic.

## 21. Documentation truth and roadmap alignment

- Reconcile docs with code for architecture, development, deployment, testing, and standards.
- Check env var docs, examples, defaults, and required/optional status.
- Review roadmap and archived docs for claims that no longer match reality.
- Check support artifacts and operator docs for stale or misleading instructions.

## Mandatory deep-dive passes

- top-down architecture pass
- bottom-up file pass
- user-journey pass
- admin/operator-journey pass
- hostile-environment pass
- documentation-truth pass
- negative-space pass

## Mandatory reconciliation passes

- code vs docs
- code vs tests
- tests vs CI
- shared types vs backend outputs
- OpenAPI vs handlers
- web vs mobile assumptions
- ADRs vs implementation
