# Cold Comprehensive Audit — 2026-06-15 — Master Checklist

> The complete enumeration of **what gets checked**. Two halves:
> **Part 1** = universal dimensions (any code project); **Part 2** = Loop-specific
> dimensions (every vertical, every cross-file seam, every ADR invariant).
> Part 3 = the cross-vertical interaction matrix. Part 4 = coverage-against-proposals.
> Part 5 = the per-file 100%-coverage method + scoring rubric.
>
> Scope of the surface: 580 backend `.ts`, 407 web `.ts/.tsx`, 37 shared `.ts`,
> 35 migrations, 19 backend route modules, 40 web routes, 5 CI workflows, 35 ADRs,
> 24 runbooks, ~20 backend verticals, the `tools/ctx-catalog` operator tooling, and
> the mobile native layer. Nothing is out of scope.

---

## PART 1 — Universal audit dimensions (every code project)

### 1. Correctness & logic

- [ ] Business rules implemented as specified; no off-by-one, inverted conditionals, wrong operators
- [ ] Boundary conditions (empty, single, max, overflow, negative, zero, null/undefined)
- [ ] Numeric correctness: integer vs float, rounding mode, precision loss, `bigint` past 2^53
- [ ] String handling: encoding, normalization, locale-aware case, trimming, truncation mid-grapheme
- [ ] Date/time correctness (see §28)
- [ ] Enum exhaustiveness (`assertNever`), discriminated-union completeness
- [ ] Dead/unreachable branches; impossible states made unrepresentable
- [ ] Return-value handling — no ignored results, no swallowed `Promise`s (floating promises)
- [ ] Default values correct and safe; fail-closed defaults
- [ ] Pure functions actually pure; no hidden mutation/aliasing of shared objects
- [ ] Copy/serialization correctness (deep vs shallow), JSON round-trip fidelity
- [ ] Algorithmic correctness of any non-trivial algo (clustering, grouping, dedup, FX)

### 2. Security

- [ ] **AuthN**: every protected route requires a valid token; no auth bypass; token verification (sig, exp, iat, iss, aud, alg-confusion, `none` alg)
- [ ] **AuthZ / IDOR**: every resource access scoped to owner; admin/staff gating; horizontal & vertical privilege escalation; object-level access on every `:id`
- [ ] **Input validation**: every external input Zod-validated (body, query, params, headers, webhooks, upstream responses)
- [ ] **Injection**: SQL (parameterization / Drizzle), command, header, log, NoSQL, template
- [ ] **XSS**: output encoding, `dangerouslySetInnerHTML`, SSR injection, user-content rendering
- [ ] **CSRF**: state-changing requests, CORS as CSRF control, SameSite, origin checks
- [ ] **SSRF**: image proxy, any server-side fetch of user-supplied URLs, allowlist, DNS rebinding, redirects, private/loopback/IPv6 ranges
- [ ] **Path traversal**: file reads, order-id/param sanitization
- [ ] **ReDoS**: user-influenced regex; catastrophic backtracking
- [ ] **Open redirect / clickjacking**: redirects, `X-Frame-Options`/CSP
- [ ] **Secrets**: none hardcoded; env-only; never logged; never committed (gitleaks); `.env` ignored; key files ignored
- [ ] **Crypto**: correct primitives, no Web Crypto for Stellar, constant-time compares for tokens/OTP, secure random, hashing (OTP/refresh-token SHA-256), salt
- [ ] **Rate limiting / DoS**: per-route, per-IP, body-size limit, expensive endpoints, OTP/enumeration abuse
- [ ] **CORS**: allowlist correctness, no wildcard in prod, credentials handling, native origins
- [ ] **Security headers**: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, CSP
- [ ] **Deserialization / mass-assignment**: only whitelisted fields persisted
- [ ] **Replay**: OTP, social id_token, webhooks, payment idempotency
- [ ] **Dependency vulns / supply chain**: see §10
- [ ] **Error/info leakage**: stack traces, internal IDs, upstream bodies, timing oracles
- [ ] **Multi-tenant / brand isolation** (single-brand here, but check no cross-user leakage)

### 3. API design & contract

- [ ] REST conventions, correct HTTP verbs and status codes for every outcome
- [ ] **OpenAPI parity**: every mounted route registered; every status code declared (429 on rate-limited, 502 upstream, 503 circuit-open, 404 not 403 on admin)
- [ ] Idempotency on all writes (Idempotency-Key handling, semantics)
- [ ] Pagination (limit/cursor), bounded result sizes
- [ ] Response shape stability; shared-type ↔ OpenAPI ↔ client parity (ADR 019)
- [ ] Backward compatibility / versioning; no breaking change without migration
- [ ] Cache-Control correctness per endpoint
- [ ] Consistent error envelope `{code, message}` per error-codes.md
- [ ] Content negotiation (protobuf vs JSON) correctness
- [ ] Never-500 guarantee on public surface (ADR 020)

### 4. Error handling & resilience

- [ ] Errors caught at the right boundary; no swallowed errors that hide failures
- [ ] Fail-closed vs fail-open chosen correctly per context (security → closed)
- [ ] Timeouts on every network/IO call; AbortSignal usage
- [ ] Retries with backoff; jitter; max attempts; idempotent on retry
- [ ] Circuit breakers per upstream; half-open probes; independent breakers
- [ ] Partial-failure handling; poison-message isolation; dead-letter / skip table
- [ ] Graceful degradation; last-known-good fallbacks
- [ ] User-facing error messages safe and actionable
- [ ] Error → observability (logged with context, alerted if actionable)
- [ ] `Response` body read-once correctness (no "Body already read")
- [ ] Cleanup on error (timers, connections, locks) — `finally`/`unref`

### 5. Documentation integrity, maintainability & coverage

- [ ] Docs match code (no stale claims, file:line drift, renamed symbols)
- [ ] Every code change updates the docs the doc-update-rules table requires
- [ ] ADR completeness: every architectural decision has an ADR; ADRs current
- [ ] Runbook coverage: every alert/notifier has a runbook; runbook steps correct
- [ ] Env var parity: `.env.example` ↔ `env.ts` ↔ docs ↔ AGENTS summary ↔ deployment table
- [ ] AGENTS.md / per-package AGENTS.md accurate (middleware order, rate limits, commands)
- [ ] README / architecture / development / deployment / testing / standards accurate
- [ ] Inline comments truthful, non-obvious-why documented, no lies
- [ ] No dead links; no references to deleted files; doc index complete
- [ ] Examples & commands actually run; sample payloads valid
- [ ] TODO/FIXME hygiene (ticket ref + date; no orphan TODOs)
- [ ] Superseded docs clearly marked; historical vs active distinguished
- [ ] Comment density matches surrounding code; maintainability

### 6. Observability & alerting

- [ ] Logging: levels correct, structured, request-correlated (`X-Request-Id`)
- [ ] **Redaction**: tokens, OTPs, redeem codes/PINs, PII, secrets never logged (log-policy.md)
- [ ] Access logs + app logs share service/env/redaction
- [ ] Metrics / health endpoints; worker liveness + staleness; OTP-delivery surface
- [ ] Alerting coverage: every actionable failure pages; thresholds sane; dedup/cooldown
- [ ] Alert → runbook linkage; severity tiers (SLO/alerting/oncall docs)
- [ ] No alert gaps (silent failures) and no alert storms (noise)
- [ ] Tracing/Sentry wired both sides; sample rates; env tagging
- [ ] Log retention windows + access RBAC (log-policy.md)
- [ ] SLO instrumentation present for each stated SLO (availability/latency/freshness/settlement)
- [ ] Drift/reconciliation alerts structurally recoverable (don't page permanently)

### 7. Infrastructure, config & deploy

- [ ] Dockerfile correctness (multi-stage, non-root, minimal, pinned base digest)
- [ ] **Backend↔web fly.toml/Dockerfile parity** (drift has happened — PRs #149/#150/#151)
- [ ] Env management: required-at-boot validation; safe defaults; prod-only requirements
- [ ] Secrets management (Fly secrets), rotation, no plaintext
- [ ] Migrations run on deploy; ordering; failure handling; rollback story
- [ ] Resource limits (cpu/mem), scaling, regions, connection pool sizing
- [ ] Health checks wired; zero-downtime / rolling deploy
- [ ] DNS + TLS for every host; cert automation
- [ ] Static asset hosting; GeoLite2 mmdb refresh cadence/staleness
- [ ] Web deploy actually performed (loopfinance-web) + DNS pointed
- [ ] Preflight gates (secret presence) before deploy

### 8. Build & CI

- [ ] Every required check present and gating (Quality, Unit, Security audit, Build, E2E-mocked)
- [ ] CI ↔ local parity (verify.sh mirrors CI)
- [ ] Caching correctness; reproducible builds; lockfile honored
- [ ] SBOM + provenance + signing (cosign) integrity
- [ ] Container CVE scan (trivy), secret scan (gitleaks) — advisory vs gating clarity
- [ ] Branch protection ruleset matches docs; force-push/deletion blocked; stale-review dismissal
- [ ] CI permissions minimal; secrets scoped; no secret leakage in logs
- [ ] Flaky-test detection; deterministic e2e; isolated ports
- [ ] Bundle-budget gate; migration-parity gate; openapi-parity gate; shared-type-parity gate; env-perms gate; lint:docs gate
- [ ] `npm audit` policy gate state (currently failing — high=7 esbuild chain)
- [ ] Pre-commit (lint-staged) + pre-push (verify.sh) hooks correct; no `--no-verify` culture

### 9. Schema & migrations

- [ ] Migration chain replays 0000→latest cleanly; matches schema.ts (migration-parity gate)
- [ ] Forward/backward compatibility; expand-contract for breaking changes
- [ ] Reversibility / documented irreversibility
- [ ] Data migrations safe (batched, idempotent, no lock storms)
- [ ] Indexes for every hot query; partial indexes correct; no unused indexes
- [ ] Constraints: CHECKs, FKs, unique (incl. partial unique for at-most-once), NOT NULL, defaults
- [ ] Type correctness: `bigint` mode, `numeric` precision/scale, `char(3)` currency, timestamptz
- [ ] Triggers (cashback-config history) correct + preserved across migrations
- [ ] Nullability matches code assumptions
- [ ] **CHECK constraints vs ADR 035** — currency CHECKs (USD/GBP/EUR) vs extended markets
- [ ] No orphan rows; referential integrity; cascade behavior intentional

### 10. Dependencies & supply chain

- [ ] Vulnerability audit (high/critical = 0 policy); accepted-advisory list justified & current
- [ ] License compliance (third-party-licenses.md complete & accurate)
- [ ] No duplicate deps across packages; version alignment (capacitor plugins web+mobile)
- [ ] Lockfile integrity; pinned versions; node engine pin
- [ ] Transitive-risk review; unused/dead deps removed
- [ ] New dep → ADR justification (policy adherence)
- [ ] Peer-dep conflicts (e.g. hono ↔ @hono/zod-openapi)
- [ ] Repo-managed CLIs for secret-bearing workflows (ADR 029)

### 11. Concurrency & consistency

- [ ] Race conditions on shared state; check-then-act; TOCTOU
- [ ] Locking: `FOR UPDATE`, advisory locks, compare-and-set (refresh rotation, idempotency guard)
- [ ] Transaction boundaries correct; atomic multi-row writes (ledger double-entry)
- [ ] Idempotency under concurrent retries (orders, payouts, credits, admin, webhooks)
- [ ] Worker coordination: single-flight, claim-by-update, no double-processing
- [ ] Cursor advancement safety (watcher) — no skipped/lost records
- [ ] Deadlock potential; lock ordering
- [ ] No long locks across network hops
- [ ] Concurrent-refresh guards (merchant sync), coalescing

### 12. Test coverage & quality

- [ ] Unit coverage of logic + error paths (not just happy path)
- [ ] Integration (real-postgres flywheel) + e2e (mocked + real + loop-native flywheel)
- [ ] Branch/edge-case coverage; boundary tests
- [ ] No vacuous/misleading/tautological tests (asserting mocks)
- [ ] Mocks faithful to real contracts; fixtures realistic
- [ ] Regression test for every fixed bug (esp. the stranded-order/pay-ctx class)
- [ ] Contract tests (upstream CTX shape, OpenAPI)
- [ ] Determinism (no Date.now/random flakiness); isolation
- [ ] Coverage of security controls (SSRF, rate-limit, authz)
- [ ] Tests import from `app.ts` not `index.ts`
- [ ] a11y tests; visual/SSR-hydration tests where relevant

### 13. Performance

- [ ] N+1 queries; batch/join; query plans on hot paths
- [ ] Index usage; full-table scans
- [ ] Caching (TanStack Query keys, server Cache-Control, last-known-good, in-memory stores)
- [ ] Payload sizes; protobuf for clusters; compression
- [ ] Web bundle budget (SSR client dir, per-chunk); code-split; tree-shake
- [ ] Memory: leaks, unbounded maps (rate-limit LRU cap), large in-memory catalogs
- [ ] Blocking I/O on hot path; connection pool exhaustion; statement_timeout
- [ ] Horizon/CTX call efficiency (page caps, throttle, backoff)
- [ ] Image proxy/optimization cost
- [ ] Algorithmic complexity (clustering at zoom, grouping, dedup over full catalog)
- [ ] Cold-start / LCP / Core Web Vitals (hero, fonts, images)

### 14. Code quality, DRY & maintainability

- [ ] DRY — duplicate logic consolidated (shared package usage per ADR 019)
- [ ] Naming clarity & consistency; no misleading names
- [ ] Module boundaries / layering (web = pure API client; native boundary; no cross-import)
- [ ] Cohesion / coupling; file size; function complexity
- [ ] `any` only where allowed (proto bridge); type-safety
- [ ] Lint clean (eslint . max-warnings 0); format clean (prettier)
- [ ] Magic numbers/strings extracted; constants centralized
- [ ] Dead code, commented-out code, unused exports
- [ ] Consistent patterns across siblings (handlers, sweeps, notifiers)
- [ ] Error-prone idioms avoided; defensive where external

### 15. Accessibility (web + mobile)

- [ ] Semantic HTML; landmark roles; heading order
- [ ] ARIA correctness; no redundant/incorrect ARIA
- [ ] Keyboard nav; focus management; focus trap (modals/step-up)
- [ ] Color contrast (WCAG AA); not color-only signaling
- [ ] Screen-reader labels; form labels/associations; error announcements
- [ ] Alt text on images (merchant logos/covers)
- [ ] Reduced-motion; no motion-only info
- [ ] Touch targets; mobile a11y; dynamic type
- [ ] i18n/RTL readiness; lang attributes per locale

### 16. Data handling, privacy & compliance

- [ ] PII inventory & classification; minimization
- [ ] Encryption in transit (TLS) + at rest (keychain, DB)
- [ ] Redaction in logs/alerts (codes, PINs, tokens, emails)
- [ ] Retention windows + deletion (GDPR/data-subject); right-to-erasure path
- [ ] Consent; privacy policy/terms accuracy & legal review
- [ ] Data residency; backups; restore tested
- [ ] Audit trails for sensitive reads/writes (admin)
- [ ] Tax/regulatory reporting data model (ADR 026) completeness
- [ ] KYC/AML posture; sanctions/OFAC/geo restrictions (where applicable)
- [ ] e-money / custody framing (LOOP assets, GBPLOOP) legal posture

### 17. Admin & staff tooling — coverage & utility

- [ ] Every operational task has a tool (no DB-console-only ops)
- [ ] Drill quartet (fleet/per-merchant/per-user/self) complete per ADR 022
- [ ] Mix-axis matrices complete per ADR 023
- [ ] Destructive actions gated by step-up (ADR 028); idempotency guard; audit envelope
- [ ] RBAC: admin vs customer-support (ADR 037) least-privilege
- [ ] CSV/compliance exports correct (RFC 4180, caps, windows, filenames)
- [ ] Reconciliation/treasury visibility; drift surfaced
- [ ] Order/payout triage; stuck-row recovery; compensation
- [ ] Refund/credit-adjust/withdrawal writers safe
- [ ] Observability into ops actions (who/when/why)
- [ ] Usefulness: can support resolve common tickets end-to-end?

### 18. Stellar / blockchain integration

- [ ] Private keys never leave device/operator env; never in DB; never logged
- [ ] Signing via `@stellar/stellar-sdk` only (no Web Crypto)
- [ ] Network passphrase correct (PUBLIC vs TEST) everywhere
- [ ] Sequence-number handling; account reload; collision under concurrency
- [ ] Fee strategy / fee-bump; base reserve; min-balance
- [ ] Idempotency: find-outbound-by-memo (memo + **amount + asset** post-hardening)
- [ ] Memo correctness: type (text vs id/hash), per-order uniqueness, matching
- [ ] Trustline setup & checks; issuer pinning; asset spoofing prevention
- [ ] Asset issuance / mint (emission, interest); sub-minor carry; drift-neutral
- [ ] **Burn / issuer-return** on redemption (ADR 036)
- [ ] Reserve/float management; USDC↔XLM rail; below-floor handling
- [ ] Circulation vs liability reconciliation (drift watcher) correctness & recoverability
- [ ] Sponsored account creation (CAP-33) for users
- [ ] Horizon resilience (timeouts, schema-drift Zod, pagination caps, transient classes)
- [ ] Payout state machine; retry classes; stuck watchdog; compensation
- [ ] Operator vs deposit account topology (currently same account — ADR 010 note)
- [ ] SEP-7 URI parse correctness (destination/amount/memo/memo_type)

### 19–21. Coverage-against-proposals, ADR invariants, completeness

- See **Part 4** (ADR-by-ADR) and **Part 5** (completeness sweep).

### 22. Type-contract integrity (web ↔ backend ↔ shared)

- [ ] Shared types are the single source; no drift (shared-type-parity gate)
- [ ] Re-export rule honored; three-part test for shared placement (ADR 019)
- [ ] OpenAPI schemas match shared types match client expectations
- [ ] Proto types regenerated & not drifted (buf)

### 23. Internationalization / localization

- [ ] i18n string coverage; no hardcoded UI copy; pluralization
- [ ] Currency/number/date formatting per locale (money-format)
- [ ] Locale routing (ADR 034) correctness; hreflang reciprocity; x-default
- [ ] Per-country content correctness (titles, prices, merchant filtering)
- [ ] Translation completeness across supported locales
- [ ] RTL where needed; encoding

### 24. Mobile / native

- [ ] Capacitor plugin boundary (only in app/native/); ESLint enforced
- [ ] Native overlays survive regeneration (apply-native-overlays.sh) — A-033/A-034
- [ ] Secure storage (Keychain / EncryptedSharedPreferences) + migration
- [ ] App-lock/biometric; task-switcher privacy overlay; bearer-in-memory
- [ ] Platform security deferrals (ADR 027) — triggers met? tamper for sideload
- [ ] Static-export constraint (no SSR loaders) honored
- [ ] Deep links / universal links; app lifecycle; offline behavior
- [ ] Version skew: static bundle vs backend API compat (mobile can't force-update)
- [ ] Plugin version parity web+mobile package.json

### 25. Financial integrity / ledger correctness

- [ ] Double-entry invariants; sum(transactions) == materialized balance (ledger-invariant)
- [ ] No money created/destroyed across emission/redemption/burn/interest/refund/withdrawal
- [ ] At-most-once crediting (partial unique index); idempotent webhooks
- [ ] Rounding mode consistent; minor-unit/bigint everywhere; no float money
- [ ] FX conversion correctness & pinning (extended markets)
- [ ] Reconciliation: off-chain mirror ↔ on-chain tokens (ADR 036)
- [ ] Settlement to CTX (XLM/USDC) correctness; principal-switch float
- [ ] Non-negative balance CHECK vs spend paths (poison-payment class)

### 26. Time, dates & scheduling

- [ ] UTC everywhere; timestamptz; no naive local time
- [ ] Expiry/TTL (OTP, step-up JWT, payment URI countdown, refresh)
- [ ] Scheduling correctness (nightly interest midnight UTC; period cursor idempotency)
- [ ] Clock skew tolerance (JWT iat/exp); monotonic vs wall clock
- [ ] DST/leap safety; cron overlap/missed-run handling

### 27. Feature flags / kill switches

- [ ] Runtime-read (no redeploy); fail-closed on unknown value
- [ ] Coverage of all dangerous paths (orders/auth/withdrawals + per-path)
- [ ] No dead flags; gating consistency across routes + workers
- [ ] `LOOP_PHASE_1_ONLY`, `LOOP_AUTH_NATIVE_ENABLED`, `LOOP_WORKERS_ENABLED`, on-chain flags

### 28. Upstream (CTX) integration resilience

- [ ] All upstream responses Zod-validated before use/forward
- [ ] Circuit breaker per upstream endpoint; operator-pool health & exhaustion
- [ ] Token rotation persistence (refresh rotates each call)
- [ ] X-Client-Id ↔ JWT clientId pairing (401 keystone)
- [ ] Idempotency-Key on procurement; SSE stream handling; body-scrub of upstream errors
- [ ] Rate-limit/429 handling toward upstream; throttle/backoff

### 29. Webhooks & external callbacks

- [ ] Inbound HMAC + timestamp verification; replay protection; idempotency
- [ ] Privy webhook handler (wallet.created/recovered) — exists? verified?
- [ ] Outbound (Discord) delivery failure handling; no PII

### 30. Resilience / operational readiness

- [ ] Every alert has a runbook; runbook steps correct & current
- [ ] On-call rotation, severity SLAs, incident template, post-mortem policy
- [ ] Backups/restore; disaster recovery; data-loss scenarios
- [ ] Idempotent, resumable workers; graceful shutdown

### 31. Legal / regulatory / business

- [ ] Privacy/terms live + legally reviewed; mailboxes provisioned
- [ ] License attributions complete
- [ ] Custody/e-money/yield framing reviewed (ADR 030/031)
- [ ] Geo/sanctions restrictions; age/eligibility

### 32. UX correctness (web + mobile)

- [ ] Loading / empty / error / success states for every async surface
- [ ] Double-submit prevention; idempotent user actions; optimistic-update rollback
- [ ] Form validation parity with backend; inline errors
- [ ] Payment countdown/expiry UX; polling stop conditions
- [ ] Copy accuracy (amounts, currency, cashback %, disclaimers)
- [ ] Navigation correctness; back behavior; deep-link entry

---

## PART 2 — Loop-specific vertical deep-dives

> Each vertical audited against: correctness, security/authz, error handling,
> concurrency/idempotency, tests, observability, docs, ADR invariants, completeness.

### V1. Auth (`apps/backend/src/auth/`, web auth)

- Two coexisting paths (loop-native + CTX-proxy) both functional; flag gating
- OTP: generation, SHA-256 hash storage, TTL, attempt cap, consume-once, enumeration resistance
- JWT: HS256 active / RS256+JWKS (branch); claims; rotation (current/previous); alg-confusion
- Refresh rotation: single-use, CAS revoke, reuse-detection → session-wide revoke
- Social: Google + Apple id_token verify (JWKS, aud per platform), replay table, identity linking
- Step-up (ADR 028) JWT gating; kill switch (LOOP_KILL_AUTH) leaves refresh/logout open
- Operator-pool credential model; X-Client-Id pairing
- Token storage (memory access / keychain refresh / cross-tab logout)

### V2. Orders & procurement (`apps/backend/src/orders/`)

- State machine `pending_payment→paid→procuring→fulfilled/failed`; guards
- Both paths (legacy proxy + loop-native); pre-procurement payment gate
- procureOne ladder; pay-ctx (idempotency + amount/asset post-hardening + memo_type)
- waitForRedemption (SSE + poll, body-read, terminal handling) + backfill sweeper + cap/alert
- Sweeps: stuck-procurement, expired-orders, transitions
- Kill switches (combined + per-path); worker gating; fulfilled⟹paid invariant integrity
- Stranded-order class (pre-#1366) — residue handling

### V3. Stellar / payments (`apps/backend/src/payments/`)

- Payout submit (native + asset), retry classification, idempotency, fee strategy
- Inbound watcher: cursor persistence, skip table, poison isolation, amount/memo matching
- Drift watcher (circulation vs liability) recoverability; cursor watchdog; stuck-payout watchdog
- Horizon helpers (balances, trustlines, circulation, find-outbound, asset-balance)
- Stroops/decimal conversion; price-feed FX; interest-pool watcher
- Asset-drift incl. burn + interest mint accounting

### V4. Credits / ledger (`apps/backend/src/credits/`)

- credit_transactions invariants; user_credits materialization; non-negative CHECK
- Cashback split (ADR 011) + history trigger; emission at fulfillment
- Redemption/spend (extinguish); issuer-return burn (ADR 036)
- Interest: accrue/scheduler/pool/mint/snapshot/forecast; APY; sub-minor carry
- Refunds; withdrawals writer; pending_payouts (user/admin/transitions); compensation
- Liabilities; ledger-invariant; reconciliation endpoint

### V5. Wallet / Privy (`apps/backend/src/wallet/`, branch)

- provider abstraction; privy adapter (create/raw_sign/external_id, idempotency)
- user-signer pipeline (hash→rawSign→verify→addSignature→submit)
- provisioning (sponsored account, CAP-33); webhook handler (gap)
- web WalletCard/use-wallet/settings.wallet; trustline card

### V6. Merchants & catalog (`apps/backend/src/merchants/`, clustering, public)

- Sync pagination/validation/atomic store/coalesce; denylist; refresh cadence/force
- Clustering (protobuf + JSON, bbox buffer, zoom clamp, cache)
- Variant grouping (ADR 032); eviction (ADR 021); slugs (country-aware)
- **Catalog content quality** (in-flight): logos/covers/text/domains accuracy, dedup, naming, supplier joins

### V7. Public API (`apps/backend/src/public/`, routes/public.ts)

- Never-500; last-known-good; Cache-Control; no-PII; rate limit
- geo (MaxMind), cashback stats/preview, top-merchants, merchant detail, loop-assets, flywheel

### V8. Admin & staff (`apps/backend/src/admin/`, routes/admin-\*, web admin)

- Credit-adjust/withdrawal/refund/payout-retry writers; step-up; idempotency; audit envelope
- Drill quartet; mix-axis; treasury; ops-tail; order-drill; per-merchant; user-cluster
- CSV exports; cashback-config admin + audit; reconciliation
- requireAdmin (404-mask) / requireStaff (ADR 037, branch); RBAC

### V9. Web client (`apps/web/app/`)

- Pure-API-client rule (only sitemap + home-geo-redirect loaders fetch)
- Routes (40), locale layout/routing, SSR vs static, purchase flow, components, stores, services, hooks, i18n, utils
- TanStack Query usage; auth guards; a11y; bundle budget; native boundary

### V10. Mobile (`apps/mobile/`, web native/)

- Capacitor shell; overlays; icons/splash; signing; native plugins; secure storage; platform security

### V11. CTX integration (`apps/backend/src/ctx/`)

- operator-pool; stream (SSE); upstream URL; body-scrub; circuit breaker; token rotation

### V12. Shared package (`packages/shared/src/`)

- Type parity; slugs; money-format; countries/regions; order/payout state; loop-asset; proto; admin DTOs

### V13. DB (`apps/backend/src/db/`)

- schema.ts; client (pool, statement_timeout, lazy); 35 migrations; parity; seed/fixtures

### V14. Middleware (`apps/backend/src/middleware/`)

- Order: CORS→secure-headers→body-limit→request-id→logger→rate-limit→circuit-breaker
- Each correct; kill-switch middleware; admin step-up middleware

### V15. Observability (`apps/backend/src/discord/`, runtime-health, logger)

- 40+ notifiers; channels; dedup/cooldown; redaction; health; worker liveness

### V16. Config / env (`apps/backend/src/config/`, env.ts)

- Boot validation; prod-required; perms (check-env-perms); parity gates

### V17. Webhooks (`apps/backend/src/webhooks/`)

- hmac-verify; privy handler (gap); replay/idempotency

### V18. Images (`apps/backend/src/images/`)

- Proxy SSRF allowlist; optimization; cache; content-type

### V19. OpenAPI (`apps/backend/src/openapi/`, openapi.ts)

- Registration parity; status codes; schema ↔ shared types

### V20. Catalog operator tooling (`tools/ctx-catalog/`)

- Scripts that **write to production CTX** — idempotency, dry-run, guards, auth handling, blast radius, no-secret-leak, review-gating; the live content pass artifacts

---

## PART 3 — Cross-vertical interaction matrix (the seams)

Audit each end-to-end flow as a unit (data integrity + failure at every hop):

1. **Purchase (discount)**: web → /api/orders(loop) → order row → inbound watcher → paid → procureOne → CTX create → pay-ctx → redemption → fulfilled → web poll → barcode
2. **Cashback emission**: fulfillment → credit_transactions(cashback) + user_credits + pending_payouts → payout worker → Stellar mint → drift watcher
3. **Redemption/spend**: web pay-with-balance → markOrderPaid(loop_asset) → debit credits + inbound LOOP → **burn/issuer-return** → drift
4. **Interest**: scheduler → snapshot balances → mint on-chain → credit mirror → APY/forecast → drift
5. **Withdrawal**: admin/user → withdrawal writer → debit + pending_payout(withdrawal) → payout worker → Stellar → compensation on fail
6. **Auth**: request-otp → email → verify-otp → JWT → requireAuth on every protected route → refresh rotation → social linking
7. **Catalog**: CTX sync → in-memory store → public API → web (locale filter, grouping, eviction) → merchant detail → order
8. **Merchant content**: operator tooling → CTX PUT → sync → public/web rendering (logos/covers/text)
9. **Geo/locale**: `/` → geo-redirect (MaxMind) → `/:country/:lang` → merchant filter → SEO hreflang/canonical → sitemap
10. **Config/flags**: env.ts → kill switches/flags → routes + workers (consistent gating)
11. **Types**: shared → backend (handlers/openapi) + web (services/components) — parity
12. **Migrations**: migration chain → schema.ts → drizzle queries → API responses → shared types
13. **Mobile**: web static build → capacitor → native overlays → plugins (secure storage, biometric) → backend API (version skew)
14. **Observability**: any failure → logger (redacted) → Discord notifier (dedup) → runbook → on-call
15. **Idempotency web**: client UUID → /orders/loop → DB unique → payout memo → Stellar find-outbound (no double-charge/double-pay end to end)

---

## PART 4 — Coverage against proposals (ADR-by-ADR invariants)

For **each** ADR 001–037: (a) decision implemented? (b) invariants enforced in code? (c) tested? (d) docs current? (e) deferrals tracked? Key invariants to verify:

- 001 static-export over remote URL · 002 TS backend · 003 protobuf clusters + JSON fallback
- 004 security-hardening set · 005 known-limitations still intentional & accurate
- 006 keychain refresh tokens · 007 native overlays survive regen · 008 capacitor filesystem share
- 009 off-chain ledger + cashback capture invariants · 010 principal-switch pay-ctx + topology note
- 011 cashback-config sum≤100 + audit trail · 012 drizzle+fly-postgres
- 013 loop-owned auth + operator pool · 014 social verified server-side
- 015 stablecoin topology/assets · 016 payout submit retry+idempotency
- 017 admin-write invariants (actor/idempotency/reason/audit) · 018 admin drill/triage/CSV
- 019 shared three-part test + re-export + parity · 020 public never-500/cache/no-PII
- 021 eviction (admin fallback / public drop / pin) · 022 drill quartet · 023 mix-axis matrix
- 024 withdrawal writer (debit + queue) · 025 LLM PR review scope · 026 tax/regulatory model
- 027 mobile security deferrals + **triggers met?** · 028 step-up gating (impl vs deferred)
- 029 repo-managed CLIs · 030 Privy wallet (+ dfns fallback) · 031 per-currency yield (DeFindex/GBPLOOP)
- 032 grouping reversibility · 033 geo first-guess (superseded by 034) · 034 locale routing/SEO
- 035 extended markets display + **order-path gap** · 036 emission/redemption/burn/interest lifecycle · 037 staff roles

Plus roadmap/tranche acceptance:

- Tranche-1 acceptance checks (install, buy XLM gift card, redeem) — each verifiable?
- Orphaned-work register items (web deploy, keystore escrow, GeoLite2 cadence, thin-currency promotion, ADR 027 trigger)
- Comprehensive-audit-2026-06-11 Part IV remediation — which items landed, which open
- Prior audit trackers reconciled (no regressions re-introduced)

---

## PART 5 — 100% file-coverage method, completeness sweep & rubric

### Per-file coverage method

Every one of the ~1,030 source files + 35 migrations + 5 workflows + configs + 35 ADRs + 258 docs is assigned to exactly one vertical owner and gets:

- read in full; purpose understood; checked against the relevant Part-1 dimensions
- inbound/outbound dependency edges enumerated (who calls it, what it calls)
- dead-code / unused-export / orphan check
- test-existence check (is there a test? is it meaningful?)
- doc-linkage check (is its behavior documented where the rules require?)

Coverage is tracked in `tracker.md` as `<file> — <vertical> — <status> — <findings>` with a final count proving 100% (files audited / total).

### Completeness sweep (stubs & half-built)

- [ ] TODO/FIXME/HACK/XXX inventory with ticket+date validation
- [ ] `throw new Error('not implemented')` / stubs / empty handlers
- [ ] Gated-off code (flags永 off), dead feature branches' intent vs main
- [ ] Unreachable code; unwired routes; registered-but-unused
- [ ] Half-built features (wallet/staff/ADR-036 on branches) — merge-readiness
- [ ] Orphaned files (no importers); orphaned migrations; orphaned env vars
- [ ] Documented-but-unimplemented (burn, DeFindex, Privy webhook, extended order-path)

### Severity rubric

- **P0 / Critical** — money loss, security breach, data loss, auth bypass, ledger divergence
- **P1 / High** — incorrect behavior on real traffic, missing critical control, silent failure
- **P2 / Medium** — correctness edge case, weak control, missing test on risky path, perf cliff
- **P3 / Low** — quality, docs, minor inconsistency, nit
- Each finding: `id, severity, vertical, file:line, description, impact, evidence, fix, ADR/req ref`

### Cross-cutting passes (run over the whole tree, not per-file)

1. Secrets/credential leak sweep (all files + git history)
2. `any`/type-escape sweep · 3. Floating-promise / unawaited sweep
3. Error-swallow (`catch {}` / empty catch) sweep · 5. Money-as-float sweep
4. Missing-timeout-on-fetch sweep · 7. Missing-Zod-on-input sweep
5. authz-on-every-:id sweep · 9. idempotency-on-every-write sweep
6. log-redaction sweep · 11. doc↔code drift sweep · 12. dead-code/unused-export sweep
7. migration↔schema↔type drift sweep · 14. kill-switch/flag coverage sweep
8. test-vacuity sweep · 16. accessibility sweep · 17. ADR-invariant sweep

---

## Deliverables of the audit

1. `findings.md` — every finding, severity-ranked, with evidence + fix
2. `tracker.md` — per-file/per-vertical coverage proving 100%
3. `coverage-matrix.md` — ADR/proposal × status
4. Executive summary — P0/P1 count, launch-readiness verdict per tranche
