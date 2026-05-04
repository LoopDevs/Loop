# Granular Audit Checklist

Use this checklist with the phase notes, file disposition register, and journey maps. A checked item must have evidence, not memory.

## Universal Checks for Every Phase

- Confirm baseline commit and worktree state before recording evidence.
- List files reviewed and update `inventory/file-disposition.tsv`.
- Record commands, runtime checks, and manual reasoning in phase evidence.
- Identify cross-file interactions and link them to the owning phase.
- Verify docs and tests only after verifying code.
- Separate logic correctness from code quality in notes.
- Separate documentation accuracy from documentation coverage in notes.
- Separate test coverage from test accuracy in notes.
- File findings in `findings/register.md` with `A4-###` IDs.
- Complete second-pass questions before phase closure.
- For any feature, control, endpoint, worker, screen, or doc claim that is planned/deferred/future-facing, add a Phase 24 disposition.

## 00. Inventory and Freeze

- Capture `git rev-parse HEAD`, `git status --short`, `git ls-files`, `rg --files`, root counts, package counts, and directory map.
- Classify tracked, untracked, ignored, generated, binary, dependency, build, and artifact files.
- Assign every tracked file a primary audit phase.
- Mark secondary phases for files that cross boundaries, such as OpenAPI, shared types, tests, scripts, docs, and native wrappers.
- Identify generated files that still need source-of-truth review, including proto output, mobile generated native projects if tracked, lockfiles, and migration snapshots.
- Record exclusions and the reason each exclusion is safe.

## 01. Governance and Repo Hygiene

- Verify `.github/CODEOWNERS`, issue templates, PR template, labeler, Dependabot, branch policy claims, root policy docs, and repo standards.
- Check if critical paths have enforceable review ownership: auth, admin writes, DB, migrations, credits, payments, payouts, mobile native, CI, deploy, secrets, docs policy.
- Scan for stale docs, duplicate instructions, archived guidance that can mislead, old audit files presented as current, and naming drift.
- Review `.gitignore`, `.gitattributes`, `.dockerignore`, `.npmrc`, `.prettierrc`, `.husky`, commitlint, license, security, conduct, contributing, changelog, README, AGENTS.
- Verify no sensitive files are tracked and no important source-of-truth files are ignored.

## 02. Architecture and ADR Truth

- Reconcile root AGENTS, package AGENTS, architecture docs, ADRs, roadmap, API compatibility docs, standards, and actual code.
- Verify layer boundaries: web as API client, backend owns upstream calls, shared package owns shared contracts, Capacitor plugins only in wrappers.
- Verify auth architecture, payment topology, stablecoin topology, admin architecture, public API policy, mobile security deferrals, CI CLI policy, and known limitations against code.
- Build an ADR-to-code matrix with each ADR marked implemented, partially implemented, deferred, obsolete, or contradicted.
- Identify undocumented architecture decisions and code paths whose behavior is not described anywhere.

## 03. Build, Release, and Reproducibility

- Run or inspect `npm run verify`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, docs lint, bundle budget, admin split, proto generation, mobile sync, e2e helpers.
- Review root package scripts and workspace package scripts for parity with docs.
- Audit backend and web Dockerfiles, `fly.toml`, docker-compose, environment assumptions, build args, cache, runtime user, health checks, ports, and static assets.
- Verify SSR build and mobile static export behavior are isolated and documented.
- Confirm generated overlays and proto outputs are reproducible from source and checked by CI where needed.

## 04. Dependencies and Supply Chain

- Review every direct dependency and dev dependency for purpose, package owner risk, install scripts, native code, transitive weight, and duplication across workspaces.
- Inspect lockfile integrity, pinned versions, npm audit output, known vulnerabilities, overrides, package manager behavior, and workspace hoisting assumptions.
- Audit `@capacitor`, `@aparajita`, `@capgo`, `@stellar/stellar-sdk`, React Router, Hono, Drizzle, Pino, Sentry, Zod, TanStack Query, Playwright, Vite, TS, ESLint, and GitHub Actions dependencies.
- Verify third-party license docs match packages and binary assets that ship.
- Check workflow-installed CLIs, SBOM, provenance, CodeQL, gitleaks, trivy, and audit gates.

## 05. Backend Request Lifecycle

- Map every route registered in `apps/backend/src/app.ts` and `apps/backend/src/routes/**`.
- Verify middleware order: CORS, headers, body limit, request ID, logger, rate limits, circuit breakers, auth, and route-specific behavior.
- Verify every request validates input, validates upstream responses, returns `{ code, message }` on errors, uses timeouts, and avoids bare `fetch` except documented exceptions.
- Check CORS origins, trusted proxy behavior, secure headers, request IDs, log redaction, body size, rate limit keys, Retry-After, and circuit-open responses.
- Reconcile route implementation with OpenAPI, shared types, error docs, tests, and architecture docs.

## 06. Auth, Identity, and Sessions

- Trace Loop-native email OTP, legacy CTX proxy OTP, refresh, logout, session delete, social login, account linking, JWT signing, key rotation, previous-key validation, replay guards, and client IDs.
- Verify token storage: access in memory, refresh in secure storage on native, sessionStorage on web, migration from legacy storage, logout cleanup, concurrent refresh handling.
- Audit OTP generation, expiry, rate limiting, enumeration resistance, delivery, brute force, replay, and logging.
- Check JWT issuer, audience, subject, user identity mapping, home currency, admin identification, session restoration, stale token behavior, and test coverage.
- Confirm every auth failure has safe user-facing and machine-readable errors.

## 07. Admin Surface and Operator Controls

- Inventory every admin backend handler, route, OpenAPI registration, web service, web route, and component.
- Verify admin read authz, sensitive-data minimization, pagination, filtering, CSV exports, cache policy, and auditability.
- Verify every admin write has actor binding, `Idempotency-Key`, reason, validation, transaction boundary, audit-envelope write, replay behavior, rate limit, OpenAPI, docs, and tests.
- Review credit adjustments, refunds, withdrawals, payout retry/compensation, cashback config, merchant resync, Discord notifiers, stuck orders, stuck payouts, treasury, assets, operators, users, audit tail.
- Compare actual step-up auth behavior with the step-up ADR and docs.

## 08. Public API and Public Surfaces

- Inventory `/api/public/*`, unauthenticated merchant endpoints, sitemap, robots, manifest, public images, favicon, public stats, preview calculators, home and cashback marketing routes.
- Verify never-500 guarantees, last-known-good fallback, cache-control, stale data semantics, no PII, no sensitive business leakage, rate limits, and safe error envelopes.
- Confirm public routes cannot call CTX directly from web and cannot rely on SSR loaders except documented exceptions.
- Check image proxy allowlist, URL parsing, content type, size, timeout, caching, SSRF, redirect, and SVG/script risk.

## 09. Orders, Procurement, and Redemption

- Trace legacy and Loop-native order creation, merchant lookup, amount validation, cashback split, payment quote, memo, idempotency, status transitions, fulfillment, redemption output, and listing/detail authz.
- Audit order state machine under duplicate submit, payment timeout, reload, background app, upstream failure, worker crash, replay, partial DB write, and concurrent workers.
- Validate CTX request/response schemas, gift card fields, currency fields, timestamps, barcode fields, redemption challenge, and user-specific visibility.
- Reconcile backend orders, web services, purchase store, purchase components, e2e tests, OpenAPI, docs, and shared order types.

## 10. Payments, Payouts, and Stellar Rails

- Audit Horizon clients, payment watcher bootstrap, inbound matching, memo parsing, asset support, balance cache, price feed, XLM/USDC conversion, asset floor, trustline checks, and transaction submission.
- Verify payout worker selection, pending payout transitions, compensation, retry classification, memo idempotency, duplicate worker safety, permanent failure handling, and Discord alerts.
- Check Stellar secret handling, signing location, env gating, testnet/public network assumptions, address validation, issuer mapping, and key rotation runbooks.
- Reconcile worker code, DB tables, shared payout states, OpenAPI/admin surfaces, tests, and runbooks.

## 11. Data Layer and Migrations

- Compare Drizzle schema with every SQL migration, migration journal, migration snapshots, DB tests, and runtime migration loader.
- Verify constraints, indexes, partial unique indexes, checks, triggers, audit tables, enum-like text checks, currency checks, address checks, FK behavior, and timestamp defaults.
- Test fresh database bootstrap, repeat boot idempotency, failed migration behavior, rollback docs, and local/prod parity.
- Review transaction boundaries, isolation assumptions, advisory locks, row locks, lost update risk, and data retention.

## 12. Financial Invariants and Reconciliation

- Prove balances equal transaction sums for credits and liabilities.
- Verify cashback earned, pending, paid, refunded, withdrawn, compensated, accrued interest, and recycled metrics are internally consistent.
- Check rounding, BigInt use, minor-unit handling, FX conversion, basis points, negative amounts, overflow, currency mismatch, and home-currency asset mapping.
- Audit treasury snapshot, supplier spend, settlement lag, asset circulation, drift watcher, reconciliation reports, CSV exports, and admin charts.
- Stress concurrent writes, duplicate idempotency keys, multi-user writes, daily caps, retries, and crash windows.

## 13. Workers, Schedulers, and Background Jobs

- Inventory all startup tasks from `index.ts`, worker bootstrap files, schedulers, watchers, sync loops, cleanup jobs, and health probes.
- Verify `LOOP_WORKERS_ENABLED`, production/dev defaults, duplicate process safety, cadence, backoff, timeout, abort, observability, alerts, and graceful shutdown.
- Audit merchant sync, location clustering sync, procurement worker, payment watcher, payout worker, asset drift watcher, stuck payout watchdog, stuck procurement sweeps, interest scheduler, cleanup.
- Check each worker against DB locks, idempotency, state transitions, partial failures, dead-letter or operator recovery path, and runbooks.

## 14. Web Runtime and UX State

- Inventory every React Router route, loader, meta, error boundary, service call, hook, query key, mutation, store transition, and component with side effects.
- Verify service-only API calls, no direct CTX calls, no direct fetch from components except explicitly justified local browser APIs.
- Audit auth, onboarding, home, map, gift card, purchase, payment, redeem, orders, cashback, wallet, trustlines, settings, admin, privacy, terms, not-found, sitemap.
- Check query stale times, retry behavior, invalidation, optimistic updates, hydration, SSR headers, mobile static export, native nav hiding, loading/error/empty states, accessibility, keyboard, mobile viewport, and localization.
- Verify token handling, secure storage wrappers, purchase store persistence, toasts, offline banner, Sentry scrubbing, and image URL behavior.

## 15. Mobile Shell and Native Bridges

- Audit `apps/mobile` package, Capacitor config, Android and iOS generated files if tracked, native overlays, overlay script, permissions, backup rules, file provider, Info.plist additions, release config, icons, splash assets.
- Audit every `apps/web/app/native/**` wrapper for lazy import, web fallback, error handling, platform detection, permission behavior, lifecycle cleanup, and tests.
- Review secure storage, biometrics, app lock, task switcher overlay, haptics, clipboard, share, keyboard, network, notifications, status bar, back button, webview, purchase storage.
- Verify mobile package dependency parity with web, static export sync, production host assumptions, deep links, privacy manifests if applicable, and native test or manual verification plan.

## 16. Shared Contracts and Serialization

- Inventory every shared export and identify backend producers and web consumers.
- Reconcile shared types with Zod schemas, OpenAPI registrations, generated proto, route handlers, web services, tests, and docs.
- Audit enums and state unions for exhaustiveness: order states, payout states, credit transaction types, LOOP assets, home currencies, API error codes.
- Verify money-format helpers, slug/search helpers, public shapes, admin shapes, `/me` shapes, orders, merchants, proto binary/JSON fallback.
- Check generated proto source and output parity and package exports map behavior.

## 17. Security, Privacy, and Abuse Resistance

- Threat-model unauthenticated users, authenticated users, admins, malicious operators, compromised mobile devices, hostile networks, upstream failures, dependency compromise, and CI attackers.
- Audit auth abuse, OTP spam, brute force, credential stuffing, session fixation, token replay, CSRF, CORS, XSS, open redirect, SSRF, path traversal, cache poisoning, prototype pollution, request smuggling assumptions, resource exhaustion, and fraud.
- Check secrets, env vars, logs, Sentry, Discord webhooks, CI secrets, mobile storage, private keys, PII retention, public PII leakage, privacy docs, and redaction tests.
- Review rate limits, body limits, size limits, timeouts, origin policy, trusted proxy, allowlists, CSP/security headers, dependency attack surface, and admin data access.

## 18. Testing and Regression Confidence

- Inventory unit, integration, property, mocked e2e, real e2e, flywheel tests, fixtures, mocks, test setup, environment mocks, and CI invocation.
- Map tests to high-risk surfaces rather than counting files.
- Verify tests assert negative paths, concurrency, idempotency, authz, rate limit, retries, stale data, failed upstream, DB constraints, mobile wrappers, SSR/static split, and docs lint.
- Identify brittle tests, false confidence from overmocking, missing real DB coverage, missing e2e coverage, duplicate low-value tests, and untested generated artifacts.
- Verify `npm test`, `go test` if applicable, `npm run test:e2e:mocked`, real e2e contract, Playwright configs, and coverage expectations.
- Audit test accuracy: mocks reflect production contracts, assertions would fail for real regressions, fixtures match schema, tests do not assert implementation trivia, async tests wait for the right effects, and skipped/flaky tests are justified.
- Audit test coverage: every high-risk route, worker, state transition, DB constraint, admin write, auth branch, native wrapper, public guarantee, and CI/doc lint policy has an appropriate test type or documented manual verification.

## 19. Observability and Operations

- Audit logs, Pino config, request IDs, scrubbers, metrics, health endpoints, runtime health, Sentry init, Sentry environment, Discord notifiers, alert thresholds, and dashboards if referenced.
- Verify every serious failure mode has detection, severity, alert target, runbook, owner, and recovery or rollback procedure.
- Review SLO, alerting, on-call, log policy, runbooks for circuit open, health degraded, payout failure, stuck payment watcher, stuck procurement, ledger drift, asset drift, USDC floor, JWT rotation, Stellar operator rotation, mobile cert renewal, disaster recovery, rollback, deployment spotcheck.
- Check operational docs against code paths, env vars, webhook names, command names, and worker behavior.

## 20. CI/CD and Release Controls

- Audit every workflow, trigger, job permission, checkout depth, cache, artifact, matrix, environment, secret, fork behavior, PR behavior, and deploy gate.
- Verify required status checks match docs and branch protection claims.
- Review quality, unit, flywheel, audit, secret scan, container scan, SBOM/provenance, build, e2e mocked, e2e real, notify, CodeQL, PR review, labeler, Dependabot.
- Check pinned CLIs, lockfile installs, `npm ci`, `--ignore-scripts` policy, action pinning, token permissions, path filters, concurrency groups, and artifact retention.
- Verify release and rollback docs match actual automation for backend, web, and mobile.

## 21. Documentation Truth and Supportability

- Audit every doc under `docs/**`, root docs, package READMEs, AGENTS, comments that define policy, env examples, deployment docs, standards, testing, architecture, roadmap, changelog.
- Mark old audits and archives as historical or stale where needed.
- Reconcile env var tables with `env.ts`, `.env.example`, Docker/Fly config, CI secrets, and frontend `VITE_*` use.
- Verify docs do not promise controls that code or GitHub settings do not enforce.
- Check support docs for exact commands, paths, owners, severities, alert targets, and current behavior.
- Audit documentation coverage: every current endpoint, worker, money path, admin write, env var, build command, deploy control, alert, runbook-worthy failure, and planned/deferred feature has an appropriate documentation home.
- Audit documentation accuracy: claims are backed by code, config, tests, command output, or external-setting evidence captured during this audit.
- Extract every planned, future, deferred, known-limitation, Phase 2/Phase 3, TODO, follow-up, and roadmap claim into the Phase 24 planned-feature matrix.

## 22. Bottom-Up File Pass

- Sort `inventory/file-disposition.tsv` by unreviewed files and close every row.
- For each file, identify whether it is source, test, config, doc, generated, binary, asset, fixture, artifact, or policy.
- Review orphaned imports, dead exports, unreachable routes, stale fixtures, unused assets, duplicate types, and package-boundary violations.
- Confirm every generated or binary file has either source-of-truth verification or explicit exclusion.

## 23. Journey and Cross-File Pass

- Execute the journey maps in `journeys/` against code, tests, docs, and operations.
- Trace user journeys, admin journeys, operational journeys, data journeys, and adversarial journeys end to end.
- For every journey, list entry points, trust boundaries, storage, network calls, DB writes, state transitions, observability, tests, docs, and failure handling.
- Identify interaction bugs that are invisible in isolated file review.

## 24. Planned Features and Current Feature Set

- Build a current feature inventory from route maps, web screens, backend handlers, workers, DB tables, shared exports, CI workflows, mobile wrappers, tests, and deployment config.
- Build a planned feature inventory from `docs/roadmap.md`, ADR future-phase sections, known limitations, AGENTS, README files, runbooks, archived docs, old audit plans, TODO comments, and user-facing product copy.
- Classify every planned/current item as `implemented`, `partial`, `planned-not-started`, `deferred`, `stale`, `contradictory`, `undocumented-current`, or `removed`.
- Identify feature risk: hidden reachable code, docs promising absent behavior, partial financial rails, partial auth/admin controls, deferred mobile hardening, partial observability, partial CI/release controls.
- Reconcile planned user journeys against current user journeys: signup/auth, merchant discovery, purchase, payment, redemption, cashback, wallet/trustline, admin, operations, mobile.
- Reconcile planned system capabilities against current code: stablecoins, CTX operator pool, credits ledger, payouts, procurement, public API, admin panel, social login, step-up auth, tax/regulatory reporting, mobile platform security.
- Produce a planned-vs-current matrix and link every risk to findings or accepted limitations.

## 25. Synthesis and Sign-Off

- Dedupe findings and merge duplicate root causes.
- Re-score severity based on exploitability, blast radius, financial impact, privacy impact, and operational detectability.
- Run second-pass and third-pass gates from `protocol/second-third-pass.md`.
- Verify planned-vs-current reconciliation is complete and reflected in the final risk summary.
- Verify scaffold self-review is complete for every file in `inventory/scaffold-disposition.tsv`.
- Verify every phase has explicitly considered logic correctness, code quality, documentation accuracy, documentation coverage, test coverage, and test accuracy where applicable.
- Verify no old finding was copied without independent evidence.
- Produce final summary, remediation queue, accepted-risk list, operator handoff list, and unresolved gaps.
