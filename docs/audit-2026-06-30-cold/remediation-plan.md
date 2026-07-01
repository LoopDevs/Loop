# Cold Audit 2026-06-30 — Remediation Plan

Sequenced against `findings.md`'s 122 unique findings. Unlike the 06-15 plan
(severity-ordered waves), this plan is **dependency-ordered first, severity
second** — a wave only starts once everything it structurally depends on has
landed. Review tags unchanged: ✅ self-contained/CI-mergeable · 🔒 money/auth/
Stellar → Ash review before merge.

## Dependency graph (the load-bearing relationships)

```
CF-04 (audit gate RED) ─────────────────────► blocks EVERY PR below, including itself
                                                 being fixed (chicken-and-egg — see Wave 0)

CTX-02 (Retry-After not enforced) ──┬───────► accelerates CF2-01 (breaker can't self-heal)
CF2-01 (breaker can't self-heal) ───┘          → fix together, same files (Wave 2)

CF-14 reopen (SKIP LOCKED not tx-wrapped) ──► DOWNGRADED P1→P3 after Phase-5 skeptic
                                                check: markPayoutSubmitted's pre-existing
                                                CAS already prevents double-pay regardless.
                                                No longer load-bearing for Wave 3 — see
                                                revised Wave 3 below. CF2-07 (auto-comp on
                                                ambiguous retry) is unrelated, still real,
                                                stands alone in Wave 3.

CF-18 hardening (payout-worker tx-hash) ────► W-05's wallet branches were built BEFORE
                                                this hardening; rebasing the branches is
                                                a prerequisite for merging CF-05/CF-32
                                                fixes (Tranche-2 track) — NOT for Wave 3
                                                itself, which only touches main

CF-20 (auto-refund on post-pay-ctx fail,
       already closed) ─────────────────────► CF2-05 (pre-pay-ctx refund gap) extends
                                                the SAME refund primitive — no new
                                                infra needed, just widen the trigger
                                                condition (Wave 4)

ADM-01 (no daily withdrawal cap) ───────────► MUST land before PLAT-30-03's better-fix
                                                (auto-withdraw-on-DSR-delete), else a
                                                burst of disposable-account deletions
                                                could drain treasury through the one
                                                withdrawal path with no daily ceiling
                                                (Wave 5 → Wave 6 ordering)

CF-31 reopen (country-blind catalog) ───────► backend contract change (add `country`
                                                param to 2 public endpoints) MUST land
                                                before the frontend fix that consumes it
                                                (two-step within Wave 7)

CF2-10 (per-machine rate limiter) ──────────► shares root cause with CF2-11..15 (breaker
                                                state, cashback-stats cache, watcher
                                                dedup, image cache — all per-Fly-machine
                                                in-memory state). Building ONE shared
                                                store once and migrating every consumer
                                                is the better fix for all six at once
                                                (Wave 9)

CF-23 reopen (bigint money, 6+ files) ──────► touches EarnedCashbackCard/LoopOrdersList/
CF2-08 (Phase-1 gating leak) ────────────────  CashbackCalculator — same files as CF2-08.
                                                Sequence CF-23 first in the same wave to
                                                avoid two PRs editing the same lines
                                                (Wave 8)

W-05 (wallet branches predate CF-14/15/18) ─► rebase is a hard prerequisite for the
                                                whole Tranche-2 track (CF-05, CF-32,
                                                CF-01) — nothing in that track should be
                                                finalized pre-rebase

CF2-02 / CF2-03 (terms/age-gate, sanctions) ► long-lead legal/product work, independent
                                                of all code waves — start NOW in parallel,
                                                don't block on anything above
```

## Wave 0 — Unblock CI (keystone, land first) 🔒-adjacent but mechanical

- **PR A · CF-04** — `npm audit --omit=dev` shows only 2 dev-only highs (already
  allowlisted) + 1 real production high (`hono`). Bump `hono` to the patched
  minor (non-breaking per their changelog); switch the policy script's
  primary signal to `--omit=dev` so dev-tooling CVEs stop redding the gate;
  re-add a justified entry for any genuinely-dev-only chain that remains.
  Add a weekly scheduled `npm audit` → Discord-monitoring alert so this
  doesn't silently regress a third time. Files: `scripts/check-audit-policy.mjs`,
  root `package.json` (hono bump), new `.github/workflows/audit-cron.yml`.
  **Unblocks every other wave.** Land this alone, merge, then proceed.

## Wave 1 — Independent, fast, no dependencies (parallelizable, stack freely) ✅

- **PR B · CF-11 reopen** — write the missing `admin/step-up-handler.ts` unit
  tests (mint/verify/expiry/purpose-binding/reuse); delete the false
  "covered by unit tests" comment. Pure test-add, zero behavior change.
- **PR C · AUTH-01 reopen** — `incrementOtpAttempts` must target the row for
  the _specific code being verified_, not "newest live row for the email."
  Closes both the known-email DoS and the decoy-OTP brute-force-cap evasion.
- **PR D · WUI-01** — fix `useFocusTrap`'s `tabbables()` selector to exclude
  `tabindex="-1"` correctly (the CSS union currently re-includes them via the
  `button:not([disabled])` clause); add a fixture test with a roving-tabindex
  child to catch this class going forward.
- **PR E · DB-01** 🔒 — `loop_readonly`'s column-level REVOKE is a no-op
  against the table-level GRANT; either restructure the grant
  (REVOKE ALL + explicit per-column GRANT) or move to a view-based read
  surface that omits the two columns entirely. Add a test that actually
  connects as `loop_readonly` and asserts the SELECT fails.
- **PR F · CF-33 reopen** — fix the third `$LOOP_STELLAR_OPERATOR_ID`
  reference in `docs/runbooks/disaster-recovery.md` (the P0 DR runbook —
  worst place for a dead command); grep the whole `docs/runbooks/` tree for
  the same dead var one more time to be sure.
- **PR G · TOOL-03/TOOL-04 reopen** — `demo-seed.mjs`'s prod guard must
  resolve the real upstream host through a `flyctl proxy` tunnel, not just
  check for the literal string `localhost`; redact proxy credentials in
  `scrape-media-proxied.mjs:206`'s log line (this is a straight re-open of a
  06-15 finding the remediation PR didn't actually touch).
- **PR H · CF2-17** — JWT/step-up signing-key validation: add a minimum
  Shannon-entropy or character-class-diversity check alongside the existing
  length check, centralize the 4 duplicated validation call sites.
- **PR I · ADM-01** — add `ADMIN_DAILY_WITHDRAWAL_CAP_MINOR` (fleet
  aggregate, mirroring the existing adjustment cap) to `applyAdminWithdrawal`.
  **Land before Wave 6.**

## Wave 2 — CTX/operator-pool resilience 🔒

- **PR J · CF2-01 + CTX-02** (same files, one PR) — `pickHealthyOperator`
  must call through the breaker's real `isAvailable()`/cooldown check
  instead of a permanent `state !== 'open'` filter; wire the parsed
  `Retry-After` into an actual deferred-retry delay in `procure-one.ts`
  instead of an immediate re-pick. Add an integration test using the real
  `circuit-breaker.ts` (not a full mock) that proves OPEN→HALF_OPEN recovery
  after cooldown. Add breaker state to `/health` so Fly can detect and
  restart a stuck instance. Files: `ctx/operator-pool.ts`,
  `circuit-breaker.ts`, `orders/procure-one.ts`, `runtime-health.ts`.

## Wave 3 — Payout-worker concurrency 🔒

**Revised after Phase-5 adversarial verification (2026-07-01):** CF-14's
transaction-wrap claim does not affect financial safety — `markPayoutSubmitted`'s
pre-existing atomic CAS already prevents double-claim/double-pay independent
of whether the SKIP-LOCKED read-lock survives. That part is now a P3 doc/
efficiency nit (quality tail), not a Wave-3 blocker. CF2-07 is unrelated and
still real — it stands alone in this wave.

- **PR K · CF2-07 only** — fix `payout-worker-pay-one.ts`'s ambiguous-failure
  path to re-check the authoritative tx-hash (CF-18's primitive) before
  auto-compensating, so a `transient_horizon` failure at retry-exhaustion
  can't re-pay a withdrawal that actually landed. Add a test for the
  ambiguous-failure-at-retry-exhaustion case specifically (the existing
  suite only covers the safe `transient_rebuild`-at-cap case). File:
  `payments/payout-worker-pay-one.ts`.
- **PR K2 · CF-14 nit (optional, can move to the quality tail)** — wrap
  `listClaimablePayouts` in `db.transaction()` anyway for the originally-
  intended efficiency win (fewer wasted concurrent Horizon reads / less
  `tx_bad_seq` churn), and correct the PR's own docstring so it no longer
  reads as a safety mechanism. Not safety-blocking; sequence opportunistically.

## Wave 4 — Orders resilience 🔒

- **PR L · CF2-04** — `procureOne` must revert `procuring→paid` on
  `PayoutSubmitError('transient_horizon')` like it already does for the
  CF-12/13 CTX-resilience cases, instead of terminal-failing; preserve the
  CTX order id on this path.
- **PR M · CF2-05** — widen the existing CF-20 auto-refund trigger to cover
  pre-pay-ctx procurement failures (CTX 4xx, schema-drift, missing-
  paymentUrls, bad-SEP7), not just the post-pay-ctx case; add the same
  operator-debt Discord alert CF-20 added, since this is the larger share of
  real failures. Update ADR-010 to describe the actual (off-chain ledger
  credit, not on-chain) refund mechanism — closes the new ADR-010 doc gap
  from the same PR.
- **PR N · CF2-06** — add a sanity bound (e.g. reject/alert on >X% deviation
  from the last N successful rates, or a hard min/max plausible range) to
  both `price-feed.ts` (XLM) and `price-feed-fx.ts` (FX); cap the blast
  radius of the existing 60s cache by re-validating on every cache refresh,
  not just first fetch.

## Wave 5 — Admin-write safety tail 🔒

(ADM-01 already landed in Wave 1, listed here for completeness.) Remaining
sub-items, can stack as disjoint PRs:

- **PR O · ADMIN-01-reads** — fix `merchant-stats`/`merchant-stats-csv` to
  group by `orders.chargeCurrency`, matching every sibling handler.
- **PR P · ADMIN-02-reads** — lower `admin/user-search`'s row cap below the
  20-row floor only as a stopgap; the real fix is making the CF-10 tripwire
  threshold-independent of any single endpoint's page size (track cumulative
  rows-returned per admin per window, not per-call).
- **PR Q · PLAT-30-16, PLAT-30-17** — supplier-spend CSV honors its
  `?currency=` filter; interest-mint-forecast fails closed (alert + abort)
  instead of fabricating `poolStroops=0` on a Horizon read failure.

## Wave 6 — Privacy/DSR (depends on Wave 5 for the better-fix half) 🔒

- **PR R · PLAT-30-03 (minimal, ship immediately)** — reject self-delete
  with a clear `BALANCE_NOT_ZERO` error when `user_credits` is non-zero,
  pointing the user to withdraw first.
- **PR S · PLAT-30-03 (better fix, after Wave 5/PR-I lands)** — auto-trigger
  a withdrawal-to-last-known-address (or require a fresh address) on delete
  when balance is non-zero, now safe because the daily withdrawal cap from
  Wave 1 bounds the blast radius of a delete-and-drain pattern.
- **PR T · W30-02** — native DSR export: use the existing
  `app/native/share.ts` Filesystem+Share primitive (ADR-008 pattern) instead
  of `console.log`; add a native-path test.
- **PR U · CF2-09** — port the backend Sentry scrubber's breadcrumb handling
  to the web `sentry-lazy.ts`/scrubber so the two stay in sync per the
  existing (currently-violated) docblock invariant; this closes the leak
  vector even before PR T ships, so land U first if sequencing within the
  wave matters.

## Wave 7 — Catalog country-scoping (two-step) ✅/🔒

- **PR V · backend** — add a `country` query param to
  `/api/public/top-cashback-merchants` and `/api/public/merchants/:id`,
  scoping results the same way `home.tsx`'s already-correct pattern does.
- **PR W · frontend (after V merges)** — wire `/calculator`, `/cashback`,
  `/cashback/:slug` to pass the route's country into the now-available
  param, closing CF-31 systemically instead of the single `brand.$slug.tsx`
  point-fix from the prior round. Also fix `brand.$slug.tsx`'s
  case-sensitivity gap (CAT-03) in the same PR since it's adjacent code.

## Wave 8 — Money display + Phase-1 gating (CF-23 first, same files) ✅

- **PR X · CF-23 reopen** — migrate the remaining 6+ call sites
  (`CashbackRealizationCard`, `LoopPaymentStep`, `LoopOrdersList`,
  `CashbackCalculator`, `PendingCashbackChip`, `admin.treasury.tsx` + the 4
  unguarded `BigInt()` parses) onto the canonical `formatMinorCurrency`;
  add a lint rule or grep-based CI check banning `Number(` within 2 lines of
  a `Minor`/`Stroops` identifier to stop this class regenerating a 6th time.
- **PR Y · CF2-08 (after X, same files)** — gate `EarnedCashbackCard`,
  `OrderPayoutCard`'s "credited" copy, and `/calculator` behind
  `Phase2Gate`/`LOOP_PHASE_1_ONLY`, matching every other Phase-2 surface.

## Wave 9 — Multi-machine shared state (infra-first, then migrate consumers)

- **PR Z · immediate mitigation (ship before the infra work, ✅)** — for
  CF2-10 specifically: either pin `max_machines_running` until the real fix
  lands, or scale every per-route rate-limit constant down by the current
  machine count as a stopgap with a comment explaining why.
- **PR AA · shared-store infra** 🔒 — stand up a Postgres-backed (reuse the
  existing pool, no new infra dependency) or Upstash-Redis-backed counter
  service behind a small interface (`increment(key, windowMs): count`).
- **PR AB..AF · migrate consumers (after AA, can parallelize)** — rate
  limiter (closes CF2-10 for real), circuit-breaker state (CF2-11),
  cashback-stats TTL cache (CF2-12/PUB-01/02), watcher cursor/dedup state
  (CF2-13), image-proxy cache (CF2-14/15). Each is a disjoint PR once the
  shared interface exists.

## Wave 10 — Operator tooling (operational urgency, independent of code waves)

- **PR AG · TOOL-01** — `ctx-apply.mjs`'s `runInfo()` must actually read the
  review UI's decisions file before writing description/instructions/terms
  to production; currently decorative.
- **PR AH · TOOL-02** — sanitize/length-cap supplier-feed titles before they
  reach `POST /merchants` in the allocator scripts (tillo/svs/ezpin); route
  through the same review gate as the scraped-content pipeline, or add a
  narrower automated sanitizer if full human review isn't operationally
  viable for allocator volume.

## Wave 11 — Mobile Apple Sign-In rework (needs a design decision first)

**Revised after Phase-5 tie-breaker re-investigation (2026-07-01):** the root
cause is sharper than "swap window.open for an in-app-browser plugin" would
fix. Apple's Service ID "Return URLs" require a verified, internet-routable
HTTPS domain — `capacitor://localhost`/`https://localhost` (what the native
shell's `redirectURI: window.location.origin` evaluates to) can never be
registered with Apple, so the OAuth flow fails server-side validation
regardless of how the popup/window is opened on-device. The `window.open()`
popup-delegate gap is real but secondary.

Before writing code, decide between: (a) **backend-hosted callback** — add
a real HTTPS endpoint (e.g. `https://api.loopfinance.io/auth/apple/callback`)
registered as the Apple Return URL; the native app opens the Apple auth flow
via `@capgo/inappbrowser` (the plugin Loop's own redemption flow already
uses for the identical native-WebView problem — `apps/web/app/native/`)
pointed at that backend URL, and the backend redirects back into the app via
a universal link / custom URL scheme once Apple completes the handshake —
this is the standard mobile-OAuth pattern and needs no new Capacitor
dependency beyond what's already installed; or (b) a dedicated native
Capacitor plugin (e.g. `@capacitor-community/apple-sign-in`) that handles
the native `ASAuthorizationController` flow directly, bypassing the web SDK
entirely — new dependency, needs an ADR per repo policy. (a) is likely less
work given the existing in-app-browser infrastructure; flagged for Ash
decision; not sequenced as a PR until chosen. Either way, add
`Capacitor.isNativePlatform()` branching to `AppleSignInButton.tsx` (it
currently has none, unlike every other native-aware component in the
codebase) and a real-device test before claiming this closed again.

## Launch-gate legal/product track (parallel from day 1, blocks public launch not CI)

- **CF2-02** — terms-acceptance + age-gate UI + `termsAcceptedAt` schema
  column; needs final legal copy before implementation, start that now.
- **CF2-03** — sanctions/OFAC/geo-eligibility screening at signup + payout
  destination; needs a vendor/provider decision (this is normally a
  third-party screening API, not in-house logic) — flagged for Ash/legal,
  more urgent than 06-15 rated it given ADR-035's AE/IN/SA markets.

## Tranche-2 / cashback-mode track (gated on product decision + Privy DD, not on any wave above)

1. **W-05** — rebase all 6 wallet branches + `fix/adr036-emission-burn` onto
   `main` post-Wave-3 (CF-14/18 hardening) before any further work on them —
   they currently predate that concurrency model.
2. **CF-05** — after rebase, fix `interest-mint.ts` to mint only GBPLOOP
   on-chain per ADR-031 v7; rename retired `USDLOOP`/`EURLOOP` codes.
3. **CF-32 cluster** — add the Privy `privy-authorization-signature` header
   - P-256 auth key/env; build the Privy webhook handler; fix the
     APY-labeled-as-APR web copy + missing disclaimer; gate WalletCard behind
     `LOOP_PHASE_1_ONLY` like every other Phase-2 surface. Blocked on Privy
     Soroban due-diligence (external, not Loop's timeline).
4. **CF-01** — merge the burn fix from `fix/adr036-emission-burn` (now
   rebased); verify it closes CF-17's drift-equation gap; resolve the
   deposit==operator co-location question (split accounts, or confirm burn
   makes co-location safe) before flipping any cashback-mode flag in
   production. **Urgency note (Phase-5 re-verification):** this is not
   safely dormant behind a flag — `loop_asset` is a fully-wired, unflagged
   payment method, and only a client-side UI hardcode currently prevents a
   direct API caller from triggering it in any deployment where cashback
   issuance is already active. If any environment has `LOOP_WORKERS_ENABLED`
   on with real LOOP-asset balances in circulation, treat this as
   immediately actionable, not "whenever Tranche-2 starts."

## Quality tail (P2/P3, fill CI capacity between waves above, no dependencies) ✅

Remaining ~80 P2/P3 findings from `findings.md` — auth retention sweeps,
OpenAPI contract-drift cleanup (incl. withdrawal step-up doc gap), web a11y/
i18n nits, shared-package DRY cleanup (Eurozone-list duplication, dead
narrowing helpers), DB down-migration story, observability notifier-coverage
gate (`check:notifier-coverage`, promised after CF-33/34 and still not
built), doc-index gaps (`AGENTS.md` missing 49/86 env vars — by far the
biggest single P2, do this one early since it's pure-doc and fast), test-
vacuity fixes from `x-docs-tests.md` and the peer `x-tests-credits-vacuity-
external.md` report (liabilities/adjustments currency-isolation tests,
accrue-interest single-row test). No fixed order — assign opportunistically.

## Execution protocol

1. Land Wave 0 alone first — nothing else can merge until CF-04 is green.
2. Waves 1 stack freely as disjoint PRs (no dependencies between them).
3. Waves 2-4 are independent of each other (different subsystems) — can run
   in parallel once Wave 0 is in, but each wave's own PRs are sequential
   internally where noted (e.g. Wave 7's V before W).
4. Wave 5 PR-I (the daily withdrawal cap) must land before Wave 6 PR-S — the
   only hard cross-wave gate besides Wave 0.
5. Wave 9 is its own track — ship PR Z immediately as a stopgap, then AA
   before AB-AF.
6. Launch-gate and Tranche-2 tracks run in parallel with everything else,
   on their own (slower, externally-gated) timelines.
7. 🔒 PRs open for Ash review; ✅ PRs can merge on green checks per standing
   policy.
8. Flip findings → resolved in `findings.md` as each PR merges; this audit's
   own claimed-closures should themselves get spot-re-verified by the NEXT
   cold audit, given this round found 18 of the last round's closures didn't
   fully hold.
