# Phase 25 - Synthesis and Sign-Off

Status: complete
Owner: lead (Claude)
Audit baseline commit: `13522bb4ee8279336fb143c5c0f33bbbf6ef205b`
Audit window: 2026-05-03

## Final summary

Independent cold audit. 71 findings filed across the eight review dimensions (logic correctness, code quality, security/privacy, documentation accuracy, documentation coverage, test coverage, test accuracy, planned-feature fit). All findings independently rediscovered from the current baseline; none copied from prior audits. The parallel Codex audit workspace at `docs/audit-2026-05-03/**` was excluded from inputs per the isolation rule.

Severity distribution at sign-off:

| Severity | Count |
| -------- | ----: |
| Critical |     0 |
| High     |    12 |
| Medium   |    32 |
| Low      |    23 |
| Info     |     4 |
| Total    |    71 |

No critical findings — the codebase has substantive defence-in-depth (boot-time env validation refusing dangerous configs, partial unique indexes guarding ledger writes, advisory-locked admin idempotency, per-endpoint circuit breakers, body limit, rate limiter, kill switches, secure headers, secure-storage on native, JWT iss/aud exact match, replay-defence on social id_tokens). High-severity findings cluster in three areas: (a) operational drift between docs and enforced controls (rate-limit per-IP not per-route, CODEOWNERS team unconfigured, CSP geolocation block contradicts UI), (b) admin-write UX without confirmation gates (credit adjustment + withdrawal forms), (c) gaps in observability (health endpoint doesn't probe Postgres, Sentry scrubber bypass on TanStack errors).

## Top remediation queue (by risk-weighted urgency)

1. **A4-034** /health does not probe Postgres — risk of silent ledger outage. Fix immediately; small change.
2. **A4-038** CODEOWNERS points to non-existent team — every "required-review" rule on auth/admin/payments is currently inert. Either create the team or rewrite CODEOWNERS to existing reviewers.
3. **A4-001** Per-IP rate-limit shared across routes — hands DOS-of-auth to any co-located IP. Re-key the bucket map.
4. **A4-052/A4-053** Admin credit-adjust + withdrawal forms have no confirmation step — single fat-finger ships an irreversible payout. Add `ReasonDialog`-style confirmation.
5. **A4-051** Sentry scrubber bypass on TanStack Query path — PII (emails, OTPs, refresh tokens) reaches Sentry untouched. Route every capture through `scrubErrorForSentry`.
6. **A4-019** Admin refund handler skips `withIdempotencyGuard` — concurrent retries can write distinct refund rows. Migrate to the guard.
7. **A4-023** `markOrderFulfilled` ledger write fires but on-chain payout silently skipped on home-currency drift — peg break. Either write a compensating off-chain stub or refuse fulfilment.
8. **A4-020/A4-021/A4-022** payout-compensation primitive: bypasses daily cap, doesn't verify amount/userId/currency vs locked payout. Tighten primitive invariants.
9. **A4-061/A4-062** ADR-020 references a `/api/public/stats` route that doesn't exist; ADR-026 quarterly tax CSV emitter never shipped. Either implement or strike the ADR claims.
10. **A4-063** ADR-028 step-up auth designed but unimplemented; admin destructive endpoints ship without a step-up gate. Largest doc-vs-code security gap.

## Accepted-risk list (Info severity, no action required for Phase 1)

- A4-012 (memo entropy at 100 bits — adequate today; defence-in-depth uniqueness index recommended)
- A4-013 (rate-limit docs vs code drift — covered by remediation of A4-001)
- A4-015 (overpayment accepted — UX tradeoff)
- A4-064 (issuer optional — boot warning is defensive but not blocking)

## Operator handoff list (blocked-on-operator)

- A4-038 — CODEOWNERS team creation
- A4-014 — audit-2026-05-03 working files tracked in main
- A4-065 — roadmap.md update for shipped /metrics

## Pass-by-pass closure

### First pass — inventory + primary disposition

Every tracked file was assigned a primary phase via `inventory/file-disposition.tsv` (1,222 rows seeded at scaffold time, plus the 4 Codex-audit files explicitly out of scope). Cross-references to secondary phases preserved on auth, OpenAPI, shared types, tests, scripts, native wrappers, docs.

### Second pass — file-disposition gap closure + reconciliation

Reviewed the highest-risk lanes (auth, admin writes, payments/payouts, orders, public surfaces, data layer, web/mobile, CI/CD, docs/ADRs) end-to-end. File dispositions for the surfaces audited are now `reviewed-with-finding` or `reviewed-no-finding`. Cross-file interactions (e.g. `withIdempotencyGuard` shared by adjustments + refunds + withdrawals; `issueTokenPair` shared by native + social; CORS + secure-headers + body-limit + rate-limit middleware chain) reconciled.

### Third pass — negative-space review

- Money-moving paths without idempotency: A4-019 (refunds), A4-003 (payout retry), A4-022 (compensation) flagged.
- Trust without validation: A4-005 (requireAuth fall-through), A4-008 (X-Request-Id from client), A4-021 (compensation primitive trusts caller amount).
- Public-path failure modes: A4-035 (/health 200 on degraded), A4-034 (/health doesn't probe DB).
- Admin paths exposing data without business need: not found — admin reads consistently flow through `requireAdmin` and the read-audit middleware.
- Impossible-state state machines: A4-023 (cashback ledger write without on-chain payout under home-currency drift).
- Code shipped but not tested / docs-but-not-implemented: A4-061, A4-062, A4-063.
- Generated/binary drift: proto file regenerated by `proto:generate`; mobile native overlays re-applied by `mobile:sync`; both have lint-doc parity gates.

### Fourth pass — planned vs current

- See `inventory/planned-feature-matrix.tsv` (extended) and `evidence/phase-24-planned-features/notes.md`.
- Gaps: ADR-020 promised endpoint absent (A4-061), ADR-026 emitter absent (A4-062), ADR-028 implementation absent (A4-063), partial Phase-2 mobile-security deferrals still valid (A4-064 issuer-warn only).

### Fifth pass — scaffold self-review

- `inventory/scaffold-disposition.tsv` covers the 68 scaffold files. Every phase notes file references at least one finding or one explicit no-finding closure. Findings template, severity model, evidence protocol, journey maps, planned-feature protocol all internally consistent.

## Review-dimension coverage proof

| Dimension              | Coverage proof                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Logic correctness      | A4-001, A4-019, A4-022, A4-023, A4-026, A4-034, A4-047 — every flagged code-logic bug carries reproduction or reasoning.                       |
| Code quality           | A4-009 (orphan export), A4-026 (substring vs error code), A4-030 (schema vs migration drift), A4-054 (timer leak), A4-006 (timer not unrefed). |
| Security / privacy     | A4-001, A4-004, A4-005, A4-008, A4-017, A4-039, A4-042, A4-050, A4-051, A4-055, A4-057.                                                        |
| Documentation accuracy | A4-013, A4-014, A4-018 (cashback comment drift), A4-041, A4-061, A4-065, A4-066, A4-067, A4-068, A4-069.                                       |
| Documentation coverage | A4-013, A4-029, A4-064, A4-068.                                                                                                                |
| Test coverage          | A4-001 lacked an isolation test; A4-046, A4-048, A4-049 cover CI / SLO instrumentation gaps.                                                   |
| Test accuracy          | A4-049 (mocked e2e disables limiter — limiter code path untested); A4-036 (notify job marks PASSED on skipped jobs).                           |
| Planned-feature fit    | A4-061 (ADR-020 endpoint), A4-062 (ADR-026 emitter), A4-063 (ADR-028 step-up), A4-064 (issuer config), A4-065 (roadmap drift).                 |

## No-finding-but-reviewed

Surfaces explicitly audited and confirmed sound:

- Public never-500 path (`apps/backend/src/public/cashback-stats.ts:118-141` and siblings) — verified fallback to last-known-good.
- Image proxy SSRF guard (`images/ssrf-guard.ts`) — IPv4 + IPv6 ranges + IPv4-embedded forms covered; documented TOCTOU is mitigated by env-validated allowlist that refuses to boot in production without it (env.ts:528-539).
- JWT verify (`auth/tokens.ts`) — HS256-only, iss/aud exact-match, expiry check, type check, current-and-previous-key acceptance for rotation.
- Stellar payout-submit error classification (`payments/payout-submit.ts:191-235`) — comprehensive transient/terminal split, fee-bump strategy in place.
- Drizzle schema CHECK constraints — every money column is non-negative, currency enum-checked, type-sign coherent, payment-memo-coherent.
- Admin idempotency guard (`admin/idempotency.ts:125-191`) — advisory-locked lookup→write→store. Two consumers (refunds, payout-compensation, payouts-retry) bypass it — see findings.
- Boot-time env validation: refuses production with DISABLE_RATE_LIMITING, refuses production without IMAGE_PROXY_ALLOWED_HOSTS, validates Stellar address shapes, JWT key length, refresh-cadence positivity.

## Final sign-off

Audit ready for operator review. All 71 findings are open and pending triage. The lead recommends:

- Address A4-034, A4-038, A4-001, A4-052/053, A4-051, A4-019 within the next sprint.
- Treat A4-063 (ADR-028 step-up) as a blocker for any wider admin-tier rollout.
- Run a follow-up ADR review pass to either implement or strike A4-061, A4-062, A4-063 promises.

This audit's deliverables (plan, tracker, register, evidence notes, planned-feature matrix, file-disposition register, scaffold disposition) live entirely under `docs/audit-2026-05-03-claude/`. No file outside this directory was modified during the audit.

---

## Addendum — second-look pass closure

Triggered by the operator's self-assessment review on 2026-05-03 evening. The first synthesis pass closed with 71 findings; this addendum captures the deep follow-up pass that found 23 additional findings (A4-072 through A4-094), bringing the total to 94.

### What the deep pass surfaced

The follow-up systematically closed the gaps the first pass acknowledged but didn't drive to ground:

1. **Web bundle ships without Sentry observability** (A4-072, High) — verified by reading apps/web/Dockerfile + apps/web/fly.toml; only `VITE_API_URL` is plumbed through the build, so `Sentry.init` never runs in the production bundle.
2. **Docker + Fly health checks accept HTTP 200 from /health regardless of degraded body** (A4-073, High) — verified by reading the HEALTHCHECK instruction in apps/backend/Dockerfile:60-62 against health.ts:206 (always status 200). Compounds A4-034 + A4-035.
3. **Sentry scrubber doesn't walk `event.exception.values[].value`** (A4-074, High) — verified by reading sentry-scrubber.ts:45-67. The web's per-call `scrubErrorForSentry` runs only on the ErrorBoundary path; backend has no per-call scrubber. Broadens A4-051.
4. **Hono parametric route shadowing** (A4-075, High) — verified by my own systematic Python scan of every `routes/*.ts` file. Two real bugs: `/api/orders/loop` and `/api/admin/payouts/settlement-lag` both unreachable. Cross-listed with the parallel Codex audit.
5. **Prometheus metrics colon-collision** (A4-076, Medium) — verified by reading metrics.ts:48 + observability-handlers.ts:53. Routes containing `:id` corrupt the label split.
6. **Lint-docs §9 OpenAPI drift gate scans only app.ts** (A4-077, Medium) — verified by reading scripts/lint-docs.sh:229. ~80 routes/\*.ts endpoints uncovered.
7. **DSR delete doesn't block on failed/uncompensated withdrawals** (A4-078, Medium) — verified by reading dsr-delete.ts:91-128. User can anonymise out of recoverable balance.
8. **Android `cleartextTrafficPermitted=true` ships in production** (A4-079, Medium) — verified by reading network_security_config.xml.
9. **Android FileProvider exposes the entire external-storage and cache dirs** (A4-080, Low).
10. **iOS missing `ITSAppUsesNonExemptEncryption`** (A4-081, Low).
11. **iOS `UIRequiredDeviceCapabilities=armv7` is stale** (A4-082, Low).
12. **upstream-body-scrub regex doesn't redact Stellar address/secret/Discord webhook URL/private IP** (A4-083, Low).
13. **JWKS invalidate-and-refetch isn't debounced** (A4-084, Low).
14. **operatorFetch retry can double-request CTX if first response was lost** (A4-085, Low) — mitigated by Idempotency-Key header IF CTX honors it.
15. **DSR delete two-phase failure: txn commit + revoke is not atomic** (A4-086, Low).
16. **Trivy + gitleaks Docker images use mutable tags** (A4-087, Medium).
17. **Third-party-licenses.md misses @capgo/inappbrowser MPL-2.0** (A4-088, Medium).
18. **Backend Sentry has no per-call scrubber** (A4-089, Medium) — broader than A4-074.
19. **Live branch protection state not verified in this audit** (A4-090, Info — operator handoff).
20. **Per-handler Cache-Control sweep was sampled** (A4-091, Info — audit coverage acknowledgement).
21. **Test suite was inspected, not executed during this audit** (A4-092, Info — audit coverage acknowledgement).
22. **Email provider has no production implementation** (A4-093, Medium) — Loop-native auth is unreachable in production until an email-provider PR lands.
23. **Public 4xx envelope cache-control coverage was sampled** (A4-094, Info — audit coverage acknowledgement).

### Confidence statement

After the second-look pass:

- **Highest-risk surfaces** (auth verify path, admin idempotency primitives, DB schema CHECK constraints, payments watcher, payout submit, FX-pin, financial invariants) were exhaustively walked file-by-file. Findings filed are concrete with file:line evidence.
- **Cross-cutting concerns** (CORS, secure-headers, body-limit, kill-switch, request-id, access-log, logger redact, Sentry scrubber) were all read end-to-end.
- **Surfaces I cannot eliminate without operator action**: live branch protection state (A4-090), execution of `npm run verify` (A4-092), the exhaustive sweep of every Cache-Control header on every endpoint (A4-091).
- **Diminishing-returns surfaces**: ~80 admin read handlers and CSV exports, web component leaves, low-traffic shared package modules. Patterns are well-established and findings would be marginal.

### Honest assessment

I cannot say "very low likelihood of further findings." The codebase is large (557 backend src files; 346 web app files; 67 OpenAPI registrations; 94 admin handlers; 29 migrations), and 94 findings against ~1,200 in-scope tracked files is a finding-density of ~8%. A line-by-line pass against every admin reader handler and every web component would likely surface another 15-30 findings, but the ratio of HIGH-severity findings to LOW would skew heavily toward LOW (admin reads inherit auth + audit middleware; web components inherit error-boundary patterns; low-impact surface).

What I CAN say:

- Every High and Medium finding has been independently verified by reading the relevant code at the cited file:line.
- The remaining 4 Info entries explicitly mark the audit-coverage gaps that need operator follow-up.
- The remediation-queue is risk-weighted; treating the top 10 findings (A4-001, A4-019, A4-034, A4-038, A4-050, A4-051, A4-052, A4-053, A4-061, A4-062, A4-072, A4-073, A4-074, A4-075) closes the highest-impact production-blockers.
- The deep follow-up pass found ~25% more findings than the first pass; a third pass would likely find another ~10–20% more, but the impact distribution is skewing toward documentation drift, defense-in-depth gaps, and ops nuances rather than security or correctness primitives.

### Coverage proof at finalisation

| Area                                          | Pass 1 coverage | Pass 2 deep coverage                                                                                            |
| --------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| Backend lifecycle, middleware, route mounting | exhaustive      | re-verified                                                                                                     |
| Auth (Loop-native + CTX-proxy + social)       | exhaustive      | re-verified                                                                                                     |
| Admin writes + idempotency                    | exhaustive      | re-verified                                                                                                     |
| Payments + payouts + Stellar                  | exhaustive      | re-verified (added: multi-instance worker safety analysis confirming idempotency; A4-085 retry edge case filed) |
| Orders + procurement                          | exhaustive      | re-verified (added: route-shadow scan A4-075)                                                                   |
| DB schema + migrations                        | exhaustive      | re-verified                                                                                                     |
| Public surface + image proxy                  | exhaustive      | re-verified                                                                                                     |
| DSR (export + delete)                         | shallow         | deep — A4-078, A4-086 filed                                                                                     |
| Sentry scrubbers (backend + web)              | shallow         | deep — A4-074, A4-089 filed                                                                                     |
| Pino redact paths                             | shallow         | deep — re-verified A4-017 against actual list                                                                   |
| Logger / Discord / observability              | shallow         | deep                                                                                                            |
| CI workflows                                  | subagent        | re-verified key claims; A4-087 confirmed (Trivy/gitleaks digest pinning)                                        |
| Mobile native                                 | subagent        | deep — A4-079, A4-080, A4-081, A4-082 filed                                                                     |
| Web build/deploy                              | shallow         | deep — A4-072, A4-073 filed                                                                                     |
| Hono route registration                       | sampled         | exhaustive systematic scan                                                                                      |
| Metrics / health endpoint                     | sampled         | deep — A4-073, A4-076 filed                                                                                     |
| Lint-docs script all sections                 | sampled         | deep — A4-077 filed                                                                                             |
| Email provider                                | not opened      | deep — A4-093 filed                                                                                             |
| iOS / Android manifests + overlays            | sampled         | deep                                                                                                            |
| Network-security config                       | not opened      | deep — A4-079 filed                                                                                             |
| Capacitor config                              | not opened      | deep                                                                                                            |
| Husky hooks                                   | not opened      | deep (no findings)                                                                                              |
| Third-party-licenses.md                       | not opened      | deep — A4-088 filed                                                                                             |
| Branch-protection live state                  | not in scope    | deferred to operator (A4-090)                                                                                   |

### Remaining gaps the operator must close

- A4-090 — `gh api repos/LoopDevs/Loop/branches/main/protection` to capture live state.
- A4-091 — Cache-Control header per-handler audit at request-trace level.
- A4-092 — Execute `npm run verify` end-to-end and report any failures.

### Sign-off

Audit closes with 94 findings, every one independently rediscovered from baseline `13522bb4`, no copies from prior audits or the parallel Codex workspace. The remediation queue at `findings/remediation-queue.md` is risk-ordered. The lead auditor confirms this audit is sufficient to drive the project to production readiness when the top-10 findings are remediated and the operator-deferred items above are closed.

---

## Addendum 3 — Codex audit cross-merge (A4-095 → A4-123)

After completing the deep follow-up pass, the operator authorised reading the parallel Codex audit register at `docs/audit-2026-05-03/findings/register.md` to surface any findings my passes missed. I verified each of Codex's 42 findings against current code:

- **13 pure duplicates** of findings already in my register at the same defect / same file:line — not re-filed: Codex A4-002, A4-004, A4-005, A4-006, A4-008, A4-009, A4-010, A4-011, A4-032, A4-033, A4-036, A4-037, A4-038.
- **29 filed in my register as A4-095 → A4-123**, all verified against current code at the cited file:line before merging. Of these:
  - 24 were entirely new defects my passes had missed.
  - 5 overlapped an existing finding of mine but captured a meaningfully different angle / severity worth filing separately:
    - A4-095 — broader live branch-protection state vs. my narrower A4-037/A4-038
    - A4-099 — payout-compensation idempotency gap broadening my A4-019/A4-003
    - A4-113 — generated-vs-overlay FileProvider drift, downgrading my A4-080 assumption
    - A4-119 — sharper README contradiction angle vs. my general A4-066
    - A4-123 — retained payout `to_address` on terminal rows vs. my A4-078 failed-uncompensated-withdrawal angle
- 0 were rejected as not real / not reproducible.

Math: 13 + 29 = 42. (My earlier "~16 duplicates" message was wrong — 16 was an off-the-cuff count that doesn't reconcile with the 42 total. The correct count is 13.)

Filed as A4-095 through A4-123 in the register's Addendum 2 section.

### Critical finding: A4-110 (cashback double-credit)

**This is the one Critical finding in the entire 123-item register.** It was missed by both my first pass AND my deep follow-up pass. Verified path:

1. `markOrderFulfilled` in `apps/backend/src/orders/fulfillment.ts:86-110` writes `creditTransactions` (`type='cashback'`, +amount) AND increments `user_credits.balanceMinor` for the cashback amount.
2. The same transaction (line 143-160) inserts a `pending_payouts` row for the on-chain LOOP-asset payout when the user has a linked Stellar address + matching home currency + configured issuer.
3. `markPayoutConfirmed` (`pending-payouts-transitions.ts:85-100`) ONLY transitions state to `confirmed` and sets `tx_hash` — does NOT write a negative ledger entry, does NOT decrement `user_credits`.
4. After payout confirmation, the user has the LOOP asset on Stellar AND the same amount as spendable off-chain credit. They can use the off-chain credit to buy another order or initiate a withdrawal.

Net effect: every fulfilled order with a linked-wallet user whose home currency has a configured issuer is a double-credit. No race or privileged access required once payout workers are enabled.

Why I missed it on my first pass: I read `fulfillment.ts` and noted A4-023 (the OPPOSITE-direction risk: if `chargeCurrency != homeCurrency` the on-chain payout silently skips while the off-chain ledger still writes). I correctly identified the off-chain ledger writing unconditionally, but I did NOT trace `markPayoutConfirmed` to verify the corresponding ledger reversal at confirmation time. Codex traced the full path and surfaced the actual double-credit.

This is the kind of cross-file invariant violation where a single auditor's reading-window bias causes a miss. Two independent audits with different lenses caught what one couldn't.

### High-severity findings I missed

- **A4-104** (Payout idempotency uses issuer not operator account) — High; financial integrity.
- **A4-106** (XLM oracle whole-cent rounding underpayment) — High; ~4.5% revenue leak per XLM order.
- **A4-107** (Watcher accepts mismatched assets) — High; deliberate underpayment exploit.
- **A4-109** (Production image doesn't ship migration files) — High; release-blocker.
- **A4-101** (Operator-pool transient outage doesn't trigger retry) — High; paid orders silently fail.
- **A4-103** (Backend doesn't enforce merchant denomination limits) — High; bypass via modified client.
- **A4-113** (Generated FileProvider XML grants broader access than overlay claims) — High; my A4-080 was Low under the (incorrect) assumption that the generated tree matched the overlay.
- **A4-121** (Loop-native UI hardcodes USDC) — High; planned-feature gap.
- **A4-095** (Live branch protection state has multiple drift items) — High; supersedes my deferred A4-090.

### Final severity distribution

| Severity  |   Count | % of total |
| --------- | ------: | ---------: |
| Critical  |       1 |       0.8% |
| High      |      22 |      17.9% |
| Medium    |      50 |      40.7% |
| Low       |      43 |      35.0% |
| Info      |       7 |       5.7% |
| **Total** | **123** |       100% |

### What this teaches about audit completeness

I previously said "I cannot truthfully say very low likelihood of further findings." The Codex cross-merge proves the value of that hedge: 29 new findings = ~31% increase over my 94. The Critical (A4-110) was particularly significant — a double-credit on the primary cashback-recipient flow.

For genuine completeness on a system this size:

- **Single-auditor passes will miss cross-file invariants** that depend on tracing 3+ files end-to-end (e.g. fulfillment → pending-payouts → markPayoutConfirmed). Two audits with different starting lenses catch more.
- **Defense-in-depth gaps disguised as "looks fine"** (e.g. the price-feed whole-cent rounding) only surface when an auditor writes out the arithmetic with adversarial inputs.
- **Drift between overlay-source and generated-output** (A4-113) requires comparing the two artifacts, not just reading one.

Recommended for production launch: at least one more independent pass focused specifically on financial-flow end-to-end traces (fulfilment → ledger → on-chain → reconciliation) before any payout worker is turned on in production.

### Final remediation queue priorities (post-merge)

1. **A4-110** Critical — cashback double-credit. Must fix before enabling payout workers.
2. **A4-109** High — production image missing migration files. Release-blocker.
3. **A4-104** High — payout idempotency account. Financial integrity.
4. **A4-106** High — XLM oracle rounding underpayment.
5. **A4-107** High — watcher accepts mismatched assets.
6. **A4-073** High — health probe accepts degraded as 200.
7. **A4-072** High — web bundle ships without Sentry.
8. **A4-101** High — operator-pool outage stuck in procuring.
9. **A4-103** High — backend doesn't enforce denomination limits.
10. **A4-001** High — per-IP rate-limit shared across routes.
11. **A4-038/A4-095** High — branch protection + CODEOWNERS not enforced.
12. **A4-052/A4-053** High — admin write forms have no confirmation.
13. **A4-051/A4-074/A4-089** High — Sentry scrubber gaps.
14. **A4-019/A4-099** Medium-High — admin write idempotency primitives bypassed.
15. **A4-098** Medium — refresh-token rotation race.
16. **A4-075** High — route-shadow on `/api/orders/loop` + `/api/admin/payouts/settlement-lag`.
17. **A4-113** High — FileProvider overlay drift.
18. **A4-121** High — Loop-native UI exposes only USDC.

Cross-merge complete. Audit register holds at 123 findings.
