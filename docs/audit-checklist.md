# Audit Checklist

Use this with [docs/codebase-audit.md](docs/codebase-audit.md) and record progress in [docs/audit-tracker.md](docs/audit-tracker.md).

## How To Use This Checklist

For each workstream, do not stop after a single pass. Review it at:

- high level: architecture, responsibility split, lifecycle, and failure model
- low level: file-by-file implementation, tests, config, and edge-case handling
- end-to-end level: how the behaviour actually unfolds across boundaries

The goal is to find both obvious defects and the subtler reasons the project may still feel incomplete, fragile, inconsistent, or unready.

## 1. Repository Hygiene And Governance

- Confirm branch strategy, CODEOWNERS, PR template, labeler, and review automation match actual team practice.
- Check git hygiene: generated files, lockfiles, coverage/build artifacts, ignored files, and accidental committed state.
- Check for local-noise artifacts and stale residue such as `.DS_Store`, temporary reports, editor state, and legacy generated files.
- Identify dead files, orphaned scripts, stale docs, duplicate concepts, and misleading names.
- Verify package ownership boundaries are clear and stable.
- Check whether repo conventions in `README.md`, `AGENTS.md`, and `docs/standards.md` are mutually consistent.

## 2. Architecture And Boundary Compliance

- Verify the web app behaves as a pure API client and does not fetch server-side in loaders.
- Verify all Capacitor imports are isolated under `apps/web/app/native/`.
- Verify backend auth remains a proxy and does not mint its own tokens.
- Verify protobuf and JSON fallback behaviour matches stated architecture.
- Trace shared-package exports and confirm there is no duplicated cross-app logic outside `packages/shared`.
- Compare live code to ADRs and flag undocumented architecture drift.

## 3. Backend Correctness And Resilience

- Audit route registration, middleware order, and request lifecycle in `apps/backend/src/app.ts`.
- Validate all request parsing, Zod schemas, response shaping, and error mapping.
- Check upstream call discipline: circuit breaker, timeouts, headers, path construction, retries, and failure handling.
- Reconcile backend assumptions against actual upstream CTX contract shape, pagination rules, status values, and undocumented edge cases.
- Verify merchant sync, location sync, cache replacement, refresh cadence, and startup race handling.
- Audit clustering correctness, bbox expansion, zoom rules, and protobuf negotiation.
- Audit image proxy SSRF controls, protocol rules, cache controls, memory pressure, content validation, and resize limits.
- Check health endpoint semantics, dependency probing, and behaviour during partial upstream outages.
- Review logging, request IDs, metrics hooks, and alert-worthy failure paths.

## 4. Web Correctness And UX Integrity

- Audit route composition, error boundaries, navigation flows, and loader usage.
- Verify services are the only backend-call path and that components do not bypass them.
- Review TanStack Query usage, cache keys, invalidation, retries, stale data, and race conditions.
- Audit Zustand stores for state invariants, reset logic, persistence scope, and cross-tab/native assumptions.
- Trace purchase flow state machine and confirm impossible states are prevented.
- Review map, search, order history, and auth flows for empty, loading, slow, and failed states.
- Check design consistency, safe-area handling, keyboard behaviour, and scroll restoration.
- Audit runtime feature detection and any web/native branching logic.

## 5. Mobile Shell And Native Integration

- Review `apps/mobile` config, plugin inventory, and platform-specific release assumptions.
- Verify static export assumptions between web build and Capacitor shell.
- Audit native wrappers for graceful web fallback, lazy import safety, and platform checks.
- Check secure storage assumptions for refresh tokens and any pending-order or app-lock storage.
- Review deep links, in-app browser usage, clipboard/share flows, splash/status bar, and app lifecycle handling.
- Check iOS and Android project files for entitlements, permissions, hardcoded hosts, and debug-only settings.
- Verify app-store readiness risks: privacy manifest needs, permission copy, and production server configuration.

## 6. Shared Types, Contracts, And Serialization

- Reconcile shared types with backend mapping logic and web consumption.
- Verify barrel exports are complete and not exporting unstable internals.
- Check proto generation workflow, generated file hygiene, and import ergonomics.
- Review slug logic, order/status enums, API error contracts, and compatibility assumptions.
- Confirm no runtime-only dependency leaked into `packages/shared`.

## 7. Auth, Session, Identity, And Token Handling

- Trace request OTP, verify OTP, refresh, logout, and session restore flows end to end.
- Check platform-specific `clientId` mapping and propagation.
- Verify access tokens stay memory-only and refresh tokens stay in the intended storage tier.
- Audit silent refresh behaviour, refresh storms, concurrent 401 handling, and logout cleanup.
- Review auth error mapping, user messaging, rate-limit feedback, and replay/failure cases.
- Check whether session state can become inconsistent between memory, sessionStorage, and native storage.

## 8. Orders, Payment, Redemption, And Business Flows

- Trace merchant browse to order creation to payment to status polling to redemption completion.
- Check upstream field mapping for amount, status, currency, challenge codes, memo, and timestamps.
- Verify polling cadence, timeout rules, retry rules, and terminal-state handling.
- Audit recovery paths after app reload, app backgrounding, native/browser handoff, and network loss.
- Review idempotency expectations and whether duplicate order submission is possible.
- Verify order list/detail auth boundaries and exposure of any sensitive data.
- Check Discord/order notifications and side-effect safety if enabled.

## 9. Security, Privacy, Abuse, And Trust Boundaries

- Review secret handling, env validation, and accidental secret exposure in code or docs.
- Check for secret exposure in git history, examples, test fixtures, workflow logs, and generated artifacts.
- Audit CORS, secure headers, rate limiting, request body limits, and origin assumptions.
- Threat-model the image proxy, auth proxy, order proxy, and native bridges.
- Check for XSS, URL injection, open redirect, path traversal, and unsafe HTML handling.
- Review logging for sensitive data leakage.
- Check privacy posture for email, payment metadata, device identifiers, and notification channels.
- Consider abuse paths: OTP spam, brute force, order fraud, image proxy abuse, and map scraping.

## 10. Performance, Caching, And Runtime Efficiency

- Review bundle boundaries, lazy loading, route splits, and heavy dependencies.
- Check image sizes, asset loading, map performance, and mobile startup cost.
- Audit backend cache hit strategy, memory growth, and refresh work cost.
- Verify no accidental polling storms, redundant requests, or broad invalidations.
- Check expensive computations in render paths and re-render hotspots.
- Measure build times and note unusually slow or flaky steps.

## 11. Accessibility, Responsiveness, And Degraded-Network Behaviour

- Check semantic structure, headings, landmarks, labels, focus order, and keyboard support.
- Review screen-reader announcements for toasts, errors, and auth/payment state changes.
- Verify colour contrast, reduced-motion handling, and touch-target adequacy.
- Audit offline banners, retry behaviour, and partial-connectivity UX.
- Check responsive layout quality on narrow mobile widths and large desktop widths.

## 12. Tests, Test Quality, And Regression Confidence

- Inventory test coverage by risk, not just file count.
- Verify high-risk flows have meaningful assertions and not only happy-path mocks.
- Check backend tests for real validation of status codes, schema errors, and upstream failure behaviour.
- Check web tests for realistic state transitions, not only shallow render outcomes.
- Review native wrapper tests for platform-specific branches.
- Audit Playwright coverage for the highest-value user flows and failure scenarios.
- Identify missing tests, redundant tests, brittle tests, and false-confidence tests.

## 13. CI/CD, Release Safety, And Deployment Correctness

- Review GitHub workflows, triggers, path filters, required jobs, caches, and secret usage.
- Review automation beyond CI itself: PR labeling, PR-size bots, AI review workflows, and their trust/injection boundaries.
- Verify that PR-only e2e coverage is intentional and assess release risk from skipped paths.
- Check build, test, lint, docs lint, audit, and deployment steps for order and completeness.
- Review release assumptions and concrete deploy assets for backend, web, and mobile separately, including Dockerfiles, `fly.toml`, and Capacitor config.
- Verify dependency update automation, review automation, and branch protection expectations.
- Check deployment docs against actual workflow configuration.

## 14. Observability, Alerting, And Incident Readiness

- Audit logs, request IDs, monitoring hooks, Sentry integration, and Discord alert wiring.
- Check whether critical failures are observable: upstream outage, sync failure, auth degradation, image proxy abuse.
- Review health checks, readiness assumptions, and monitor blind spots.
- Check operational runbooks, rollback clarity, disaster-recovery assumptions, and manual recovery steps in docs.
- Identify places where silent failure would leave the team blind.

## 15. Dependencies, Supply Chain, Licenses, And Update Posture

- Review every dependency by purpose and necessity.
- Check for duplicate capability across packages and unnecessary heavy dependencies.
- Review npm audit posture, overrides, pinned versions, and known risky packages.
- Review dependency provenance and transitive risk, especially for native, auth, image, and crypto-related packages.
- Check license compatibility and any missing notices for shipped dependencies.
- Verify generated or vendored assets are understood and intentional.

## 16. Documentation Accuracy And Operational Usability

- Reconcile every key doc with current code and workflow reality.
- Include non-`docs/` operational artifacts in that pass: `README.md` and `CONTRIBUTING.md` (plus `ctx.postman_collection.json` if present locally — it is gitignored). Legacy one-offs (`claude-audit.md`, pre-implementation `RESEARCH.md`) were removed/archived to `docs/archive/` as part of finding A-035.
- Verify commands actually exist and behave as documented.
- Check env var docs, examples, defaults, and required/optional status.
- Audit whether docs are enough for onboarding, debugging, deployment, and incident response.
- Flag stale roadmap or migration items that no longer reflect the product.

## 17. Backlog, Roadmap, And Delivery-Risk Alignment

- Compare current code against roadmap claims and phase boundaries.
- Identify hidden work implied by architecture but missing from roadmap.
- Check whether TODOs, comments, or partial implementations point to untracked risks.
- Review whether "single-brand only" and other product constraints are actually enforced.
- Identify places where future Phase 2 wallet/cashback work could invalidate current assumptions.

## Mandatory Reconciliation Pass

Before calling the plan complete, perform one explicit pass for gaps across:

- code vs docs
- code vs tests
- tests vs CI
- architecture rules vs implementation
- web vs mobile assumptions
- backend contracts vs shared types
- roadmap claims vs actual delivered capability

## Mandatory Deep-Dive Passes

Before calling the audit complete, confirm that these depth passes happened:

- top-down pass: from product and architecture down into implementation
- bottom-up pass: from concrete files and functions back up into system behaviour
- user-journey pass: browse, auth, purchase, payment, redemption, history, failure, recovery
- operator-journey pass: setup, verify, deploy, monitor, alert, rollback, investigate
- hostile-environment pass: slow network, offline, upstream outage, partial deploy, bad input, abuse
- documentation-truth pass: docs and support artifacts checked against real behaviour
