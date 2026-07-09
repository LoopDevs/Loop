# Readiness Backlog & Tracker — 2026-07-03

> A **documented, self-contained tracker** consolidating two bodies of work:
>
> 1. The outstanding-work inventory from `docs/roadmap.md`, the 2026-06-30
>    cold-audit `docs/audit-2026-06-30-cold/needs-operator.md`,
>    `docs/adr/005-known-limitations.md`, `docs/threat-model.md`, and project memory.
> 2. The **2026-07-03 nine-lens readiness investigation** (test coverage, E2E,
>    admin/support, scale, completeness, money-correctness, authz/IDOR, CTX
>    resilience, mobile) + a code-verified **P0 stranded-deposit bug** + a
>    running-app UX pass.
>
> Every item is written to be closeable by an engineer **or a mid-tier agent
> (Sonnet/Opus-class)** without the original investigation context. Read the
> "How to work an item" section first. This tracker does **not** supersede the
> roadmap or the ADRs — it's the actionable superset. Completed 2026-07 hardening
> (40/40) and everything merged this session are excluded.

---

## How to work an item (READ FIRST — repo guardrails)

**These rules are non-negotiable and override any instinct to move fast.**

0. **Burn this down SERIALLY — one PR in flight at a time.** `branch from fresh main → PR → CI green → squash-merge → --delete-branch → git checkout main && git pull → next item`. **Never open a second branch before the first merges** — that's how the branch/PR pile-up (the thing this repo keeps having to untangle) happens. One item = one small PR; tick the item's checkbox in that same PR. A **blocked** item (needs an owner decision / vendor) stays an _unstarted checkbox_ — do not leave a half-done branch or draft PR. Some items here conflict if done together (e.g. **T0-1 + R3-9** both touch the watcher/redeem; **R3-2 + R3-4** both touch refunds) — do those **sequentially**, never in parallel. The `pre-push` hook warns if you already have an open PR (`ALLOW_STACKED_PRS=1` for a deliberate disjoint batch). See `AGENTS.md` §Git workflow + `docs/standards.md` §7.
1. **Never push to `main`.** Branch → PR → wait for CI green → squash-merge. (`git checkout -b <type>/<slug>`.)
2. **Run `npm run verify` before you open the PR.** It runs typecheck + lint + format + doc-lint + shared-type/openapi/migration parity + dead-flags + tests. A red `verify` will fail CI.
3. **Money / auth / Stellar changes REQUIRE an adversarial review before merge.** Any diff under `credits/`, `payments/`, `orders/`, `wallet/`, `stellar/`, or `auth/`: run the `/review-money-diff` skill (or spawn a `money-reviewer` / `auth-reviewer` subagent, refute-first) and **state in the PR which invariants (`docs/invariants.md`) the change preserves.** Never demote a DB- or test-enforced invariant to "convention."
4. **Commit format (commitlint enforced):** `type(scope): subject`. `type` ∈ feat/fix/refactor/docs/test/chore/ci. `scope` ∈ **web, mobile, backend, shared, infra, deps, deps-dev, ci** (NOT "roadmap"/"tooling"). Subject **lowercase**, imperative, ≤72 chars. Body wraps at ~72.
5. **Docs travel with code.** Changing an endpoint/env-var/shape? Update `docs/architecture.md`, `apps/backend/src/openapi.ts`, `.env.example`, and the shared type in the **same** PR. `scripts/lint-docs.sh` + the parity gates enforce this.
6. **Adding an endpoint?** Use the `/add-endpoint` skill or `node scripts/scaffold-endpoint.mjs` — it walks the 5-file fan-out (handler, route mount + `rateLimit(...)`, OpenAPI registration, shared type, web client) and the staff-tier/step-up gates. All are CI-gated.
7. **New dependency → ADR first** (`docs/adr/NNN-*.md`) before `npm install`. New architectural decision → ADR first.
8. **Integration tests need a disposable Postgres.** `docker run -d --name loop-pg -p 5434:5432 -e POSTGRES_USER=loop -e POSTGRES_PASSWORD=loop -e POSTGRES_DB=loop_test postgres:16`, then `LOOP_E2E_DB=1 DATABASE_URL='postgres://loop:loop@localhost:5434/loop_test' npx vitest run --config=vitest.integration.config.ts` from `apps/backend`. Recreate the DB between migration-replay runs.
9. **When an item says "money-review this," it is not optional.** The single failure mode this repo keeps hitting is a green-tests diff that silently strands or duplicates value.

**Legend:** `[code]` a code change · `[operator]` a human/console action · `[vendor]`/`[legal]` external · ⚠️ = do-not-skip warning · "Done when" = the acceptance check.
Priority tiers are ordered by when it bites; within a tier, top = higher leverage.

---

## Tier 0 — Fix now (correctness / integrity)

### T0-1 · Stranded late/duplicate deposits (VERIFIED P0 money bug) `[code]`

- [x] **Status:** ✅ Fixed — scoped to `expired` orders (money-reviewed SOUND: the
      `expired`-only guard is safe by construction — `expired` ⊥ `paid` with no reverse
      state edge, so the cursor-replay double-spend can't arise). Migration 0049 +
      `order_gone` reason + 3 real-pg tests. Two follow-ups spun out (T0-1b, T0-1c).

**Why (impact):** Real user funds can be permanently stranded with no record, no alert, and no possible refund. A user who pays after their order's 24h expiry, or whose duplicate payment lands after the order is already `paid`, has their XLM/USDC/LOOP sit at the operator deposit account forever. This **falsifies the "funds are never silently lost" guarantee** written in `payments/deposit-refund.ts:5-9` and `orders/redeem.ts:40-43`, and it's exactly the class the A6 refund feature was meant to cover — but A6 can't, because these deposits never enter its input table.

**Root cause (verified 2026-07-03):**

- `orders/repo.ts:224` `findPendingOrderByMemo` matches only `state='pending_payment'`. Once the order has expired or been paid, the memo no longer resolves.
- `payments/watcher.ts:187` then returns `{ kind: 'unmatched', memo }`.
- In the **main page loop**, the `unmatched` arm (`payments/watcher.ts:407-409`) does **only** `result.unmatchedMemo++; break;` — it does **not** call `recordSkip(...)`. The Horizon cursor then advances (`writeCursor`), so the payment is never seen again.
- A6's `refundDeposit` reads exclusively from `payment_watcher_skips` (`payments/deposit-refund.ts:135-147, 205-213`) → these deposits are unreachable.

Note the **sweep** arm already maps a skip-row that goes `unmatched` → `order_gone` (`watcher.ts:353-356`); the gap is only that a _fresh_ unmatched deposit never becomes a skip row in the first place.

**Do:**

1. In `payments/watcher.ts`, change the main-loop `unmatched` arm (line ~407) to `recordSkip(...)` the payment with a new reason (e.g. `'order_gone'` or `'late'`) instead of only incrementing the counter. Mirror the shape of the existing `skip`-arm `recordSkip` call (`watcher.ts:425`) and the poison-pill one (`:394`).
2. Add the new reason to the `WatcherSkipReason` union (`packages/shared/src/admin-support-ops.ts` — where the existing reasons live) and to the DB CHECK if reasons are constrained (grep the migrations for the `payment_watcher_skips` reason check).
3. Ensure `skipped-payments.ts`'s handling of an `order_gone`/`late` skip does the right thing: with `LOOP_DEPOSIT_REFUND_AUTO` off (default) → mark `abandoned` for operator review on `/admin/skips`; on → `tryAutoRefund`. (This path already exists for the sweep's `order_gone`; confirm the new fresh-deposit rows flow through it.)
4. Fire an alert when a fresh deposit is stranded (the `notifyDepositSkipAbandoned` path likely already covers it once it's a skip row — verify).
5. Update the accuracy of the guarantee comments in `deposit-refund.ts:5-9` and `redeem.ts:40-43` (they're now true again).
6. Add a real-Postgres integration test in `apps/backend/src/__tests__/integration/` proving: a deposit whose order is `expired` (and one whose order is `paid`) lands as a skip row and is reachable by `refundDeposit`.

**⚠️ Warnings:**

- **MONEY PATH.** Money-review before merge (guardrail #3). State that it preserves the "no value silently stranded" property and does not create a double-refund path (the A6 CAS + windowless-hash guard must still gate the actual refund).
- Don't refund automatically by default — the owner's standing decision is auto-refund **off**; abandoned deposits go to the operator's unmatched-payments tab (`/admin/skips`) for a human to click Refund.
- Deduplicate: a genuine duplicate payment and a late payment both land here — make sure the same physical deposit can't be recorded twice (key on the Horizon payment id).

**Done when:** the new integration test passes on real Postgres; a late/duplicate deposit appears on `/admin/skips` with the new reason and the Refund button works on it; `npm run verify` green; money-review posted on the PR.

### T0-1b · Duplicate deposit against an already-PAID order `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — migration 0050 adds nullable `orders.payment_received_horizon_id` / `payment_received_tx_hash`; the watcher stamps these when `markOrderPaid` transitions an order. Fresh unmatched deposits for paid/procuring/fulfilled orders are recorded as `order_gone` only when the Horizon operation id differs from the stored paying id, so genuine duplicates become refundable while a cursor re-read of the original paying deposit is ignored. Focused tests cover duplicate recording, original reread suppression, and legacy paid rows without stored paying id.

**Why:** T0-1 fixed the `expired`-order strand but deliberately does NOT record a deposit whose order is `paid`/`fulfilled` — because `markOrderPaid` doesn't persist which payment paid the order, so a genuine _second_ deposit can't be told apart from the _original paying_ deposit re-read after a cursor regression (recording the latter as refundable = double-spend). So a user who accidentally double-pays a real order is still stranded.

**Do:** persist the paying deposit's Horizon payment id (+ tx hash) on the order in `markOrderPaid` (schema + migration). Then in the watcher's `unmatched` arm, also record a deposit against a paid order **iff** its payment id ≠ the order's stored paying-payment id (a genuine duplicate) → `order_gone` → refundable. ⚠️ Money-review; the whole point is the paying-payment id, so get that linkage right first.

**Done when:** a duplicate deposit against a paid order is recorded + refundable, and the _original_ paying deposit re-read never is (integration test both ways).

### T0-1c · Don't record sub-dust `order_gone` deposits `[code]` (small)

- [x] **Status:** ✅ Fixed 2026-07-07 — the fresh unmatched/expired-order watcher path now reuses `REFUND_MIN_STROOPS` before writing an `order_gone` skip row. Sub-dust late deposits are still counted and cursor-advanced, but not recorded for admin/refund handling; deposits at or above the refund floor still record normally.

**Why:** T0-1's money-review flagged a self-funded nuisance vector: a user can expire their own order then send dust deposits to its memo, each recorded as `order_gone` and paging Discord on abandonment. Value-safe (the `REFUND_MIN_STROOPS` floor blocks the refund; attacker burns real XLM), but it bloats the skip table + alerts.

**Do:** in the watcher's `unmatched`/`order_gone` record path, skip recording deposits below `REFUND_MIN_STROOPS` (they can never be refunded via A6 anyway). Keep it value-safe.

**Done when:** a sub-dust late deposit is not recorded; a refundable one still is.

---

### T0-2 · Merchant brand images not rendering on beta `[code]`

- [ ] **Status:** ☐ Not started (diagnosis first)

**Why:** On beta, the homepage "Top cashback rates" cards fall back to letter-initials and the product page (e.g. `/gb/en/gift-card/xbox-game-pass-ultimate-3m-gb`) shows a **blank grey box** where the brand hero image belongs. For a cashback app, brand imagery on the landing + product pages is core trust/quality.

**Do (diagnose before fixing — the cause isn't yet confirmed):**

1. Reproduce: load beta home + a product page, open the browser Network tab, filter to `/api/image`. Earlier traces showed _some_ `/api/image?url=...` returning 200 — so it may be partial, lazy-load timing, or specific merchants lacking logos.
2. Determine which of these it is:
   - **Missing in catalog** — inspect a merchant object (`GET https://api.loopfinance.io/api/merchants/by-slug/<slug>`) for `imageUrl`/logo fields. If null, it's a CTX-media/catalog-population gap (see the CTX media pipeline; `tools/ctx-catalog`).
   - **Proxy failing** — a `/api/image` request returns 4xx/5xx. Check `IMAGE_PROXY_ALLOWED_HOSTS` on the deployed backend (must include the CTX S3 host) and `apps/backend/src/images/proxy.ts` behaviour.
   - **Render/lazy-load bug** — image URL present + proxy 200 but the card/detail component doesn't show it. Inspect `LazyImage.tsx` + the merchant-card and gift-card-detail components.
3. Fix per the confirmed cause. If it's catalog population, that's operator/media-pipeline work (flag it); if proxy/render, it's a code fix.

**⚠️ Warnings:** don't "fix" by hiding the image slot — the grey box means a real asset is expected. Confirm the actual failure layer first.

**Done when:** featured cards and product pages show real logos/hero art on beta for merchants that have them; any merchants genuinely missing art are listed for the media pipeline.

---

### T0-3 · Make the money-invariant DB layer a required merge check `[operator]`+`[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — `orders/redeem.ts` now uses the existing fleet-wide advisory lock primitive keyed by order id instead of a process-local `Set`. Contention returns `PAYMENT_IN_FLIGHT`; completion releases the lock so legitimate sequential retries still work. The redeem race test now exercises advisory-lock contention and proves two concurrent calls produce exactly one submit.

**Why:** The real-Postgres suite that enforces the money invariants (CHECK constraints, conservation trigger, CAS races) runs in the `flywheel-integration` job — which is **not** in the required-checks set. So the layer that guarantees money safety can go red and still merge. `ctx-settlements.ts` also sits at 0% counted coverage because its only real coverage is in this ungated suite.

**Do:**

1. Add `Flywheel integration (real postgres)` (and ideally `E2E tests (flywheel)`) to the required status checks: `gh api -X POST repos/LoopDevs/Loop/branches/main/protection/required_status_checks/contexts --input - <<< '["Flywheel integration (real postgres)"]'` (confirm the exact check name via `gh pr checks <any-pr>`). `[operator]` — this is a branch-protection change; per the owner's C9 decision, branch-protection hardening is deferred to production, **so confirm timing with the owner** (it may ride with the launch branch-protection pass).
2. Alternatively/additionally `[code]`: move a thin slice of the ctx-settlements idempotency coverage into the counted unit suite (see Q6-1) so it's gated regardless.

**⚠️ Warning:** coordinate with the owner — this is entangled with the deferred C9 branch-protection decision.

**Done when:** the flywheel job is required (or the owner explicitly re-defers), recorded here.

---

## Tier 1 — Public-launch blockers · operator / vendor / legal (long lead — start now)

> These are **not** code an agent closes — they need a human/vendor/lawyer. An agent's job here is to _prepare_ (wire the feature behind the missing input, draft the copy stub, script the console steps) and clearly hand off.

### L1-1 · Sanctions / OFAC / geo-eligibility screening `[vendor]`+`[code]`

- [ ] **Status:** ☐ Not started
      **Why:** None exists (only a _merchant_ denylist). Loop sends value cross-border to ~28 countries incl. AE/SA/IN/MX. This is table-stakes compliance and is **not even in the risk register**. `docs/audit-2026-06-30-cold/needs-operator.md` §2 (CF2-03).
      **Do:** owner picks a screening vendor (ComplyAdvantage / Chainalysis KYT / Trulioo) + obtains API creds. Then `[code]`: add a screening call at signup and before any payout/withdrawal, gated on env creds, fail-closed (block on hit, hold on error). Add a `sanctions_screening` audit record. ⚠️ Fail-closed, never fail-open; log decisions for audit.
      **Done when:** a screened signup + payout path exists behind vendor creds, with a documented decision trail.

### L1-2 · Terms of Service + age-gate capture `[legal]`+`[code]`

- [ ] **Status:** ☐ Not started
      **Why:** Nothing captured at signup. Schema/UI is mechanical; blocked on **legal copy** (+ jurisdiction variants). CF2-02.
      **Do (agent can pre-build):** add a `termsAcceptedAt`/`termsVersion` column + an onboarding gate + age-gate checkbox, wired to a copy constant that legal fills. Ship behind the copy being present.
      **Done when:** signup records acceptance of a versioned ToS + age confirmation; real copy dropped in by legal.

### L1-3 · Legal review of `/privacy` + `/terms` + provision mailboxes `[legal]`/`[operator]`

- [ ] **Status:** ☐ Not started
      Routes + placeholder copy exist with a "pending legal review" banner. Needs real wording + `privacy@`/`legal@`/`hello@loopfinance.io` mailboxes provisioned. `docs/roadmap.md` Mobile-submission section.

### L1-4 · Apple Developer enrollment → TestFlight `[operator]`

- [ ] **Status:** ☐ Not started
      Long pole (3–10 days incl. review). Register bundle ID `io.loopfinance.app`, archive in Xcode, upload, add internal testers. Mechanics: `docs/phase-1-while-apple-approves.md` Track C.

### L1-5 · Android release keystore + offline-escrow procedure `[operator]`

- [ ] **Status:** ☐ Not started
      ⚠️ One-time, **irreversible** — losing it forfeits Play package identity permanently. The owner does **not** use 1Password, so define a non-1Password offline-escrow procedure _before_ `keytool -genkeypair`. Then signed APK. `docs/roadmap.md` orphaned-work register + `phase-1-while-apple-approves.md` B.3.

### L1-6 · Google Play Console setup `[operator]`

- [ ] **Status:** ☐ Not started — package `io.loopfinance.app`.

### L1-7 · App Store + Play screenshots & metadata + submit `[operator]`

- [ ] **Status:** ☐ Not started — metadata drafted in `docs/app-store-connect-metadata.md`; capture screenshots after first TestFlight build; submit both.

### L1-8 · Demo video `[operator]`

- [ ] **Status:** ☐ Not started — real ~$5 purchase; script at `docs/phase-1-demo-script.md`.

### L1-9 · Apex DNS `loopfinance.io`/`www` → web `[operator]`

- [ ] **Status:** ☐ Not started — currently GitHub Pages; cut to the Fly web app (or Cloudflare, see S-CF) at public launch.

### L1-10 · Set Sentry DSNs `[operator]`

- [ ] **Status:** ☐ Not started — `SENTRY_DSN` (backend Fly secret) + `VITE_SENTRY_DSN` (web `--build-arg` at image build). ⚠️ Web Sentry is **build-time**; a forgotten arg = silently no error tracking.

### L1-11 · Verify prod secret set before next deploy `[operator]`

- [ ] **Status:** ☐ Not started — run `scripts/preflight-tranche-1.sh loopfinance-api`. ⚠️ `LOOP_ADMIN_STEP_UP_SIGNING_KEY` is now a **prod boot-fail** — a deploy without it crash-loops.

---

## Tier 2 — Public-launch blockers · code

### C2-1 · Redemption-null re-validation `[code]`

- [ ] **Status:** ◐ Code-side hardening + characterization landed 2026-07-09; live fulfilled-order validation still required. The redemption parser preserves code/PIN when CTX returns a non-absolute `redeemUrl` string (2026-07-07), and the polling fallback has regression coverage for fresh `Response` bodies / consumed-body recovery (2026-06-11, PR #1419).
      **Why:** The `redemption-backfill` worker shipped and runs in prod, but the original symptom (fulfilled order with `redeem_code/pin/url` all null) has not been re-smoke-tested since the fix. Must be green before public order traffic. `docs/roadmap.md` orphaned-work + CTX-R2.
      **Characterization (2026-07-09):** Traced the full body-read call graph (`orders/procurement-redemption.ts` `fetchRedemption`/`waitForRedemption`, `ctx/operator-pool.ts` `operatorFetch`, `circuit-breaker.ts`, `ctx/stream.ts`) and grepped every `.json()`/`.text()`/`.arrayBuffer()` call site in the backend: **no double-body-read exists in current production code.** The `Body has already been read` symptom traces to PR #1419 (2026-06-11, `fix(backend): redemption polling regression guard + null-redemption backfill sweeper`) — it was a **test-fixture bug**: the old polling test resolved ONE shared mock `Response` object across ticks, so every tick after the first threw on the second `.json()` read, silently swallowed by the polling loop's `catch`, meaning the retry path was never actually exercised even though the suite stayed green. #1419 fixed the fixtures to build a fresh `Response` per tick (matching what a real `fetch()` call always returns in production) and added two regression tests pinning the contract (`orders/__tests__/redemption.test.ts` — "each poll tick performs a genuinely fresh fetch+read" / "a consumed-body failure on one tick does not poison subsequent ticks"), still green today. Separately, fulfilled-with-null-redemption is a **deliberate design**, not a swallowed error: `procure-one.ts` awaits `waitForRedemption` (5-min budget, stream-first + 1s-poll fallback, explicitly logged at `warn` on exhaustion) and calls `markOrderFulfilled` unconditionally with whatever it returns — fulfilling on `ctxOrderId` rather than blocking a paid order indefinitely on CTX issuance latency. The `redemption-backfill` sweeper (`orders/redemption-backfill.ts`, added in the same PR, single-flighted fleet-wide by S4-8/#1585 on 2026-07-09) recovers these: 60s cadence, exponential backoff (1min·2^attempts, 8h cap, 10-attempt ceiling ≈17h), CAS-guarded idempotent persist, Discord page (`notifyRedemptionBackfillExhausted`) + ADR-037 admin one-shot re-drive on exhaustion — so the bug is bounded and alerted, not silent-forever.
      **Do (2026-07-09, this pass):** the actual gap was that nothing asserted this contract — added it: (1) `apps/backend/src/__tests__/integration/flywheel.test.ts` now asserts the fulfilled row's `redeemCode`/`redeemPin` match the mocked `waitForRedemption` payload (real-postgres CI job `flywheel-integration`, runs every PR); verified it fails against a deliberately-broken `fulfillment.ts` and passes against the real code. (2) `scripts/e2e-real.mjs`'s `pollForFulfilment` now hard-asserts a non-empty redemption payload once `state==='fulfilled'` (previously log-only), with a `REDEMPTION_GRACE_MS` (default 3 min) re-poll window so the backfill sweeper gets a couple of ticks before the run is failed — throws a `C2-1 regression:` error pointing at the exhaustion runbook if still empty. (3) Added log-safety regression tests (`orders/__tests__/redemption.test.ts`) pinning that `fetchRedemption`'s diagnostic log never fires — and the plaintext code/PIN never appear in any log call — once a redemption field is present (CF-25).
      **Still open — operator action:** run `scripts/e2e-real.mjs` (or the `e2e-real.yml` workflow) for a real Aerie $0.02 order against production/staging to confirm the now-hard assertion passes live; needs `E2E_REFRESH_TOKEN` + `STELLAR_TEST_SECRET_KEY`, which this sandboxed pass did not have access to.
      **Done when:** a real order fulfils with non-null redemption fields (or is recovered by the backfill sweep within the grace window) under the new hard assertion.

### C2-2 · Apple Sign-In native rework (CF-27) `[operator decision]`→`[code]`

- [ ] **Status:** ☐ Blocked on owner decision
      **Why:** Dead on iOS/Android — `AppleSignInButton.tsx:113` sets `redirectURI: window.location.origin` → `capacitor://localhost`, which Apple can't register, so the flow fails server-side; the button is a silent no-op. Native users are effectively email-OTP-only. `needs-operator.md` §1.
      **Do:** owner picks **(a)** a backend-hosted HTTPS callback (`https://api.loopfinance.io/auth/apple/callback`) that bridges back via a universal link/custom scheme (no new dep; uses `@capgo/inappbrowser`), or **(b)** a native plugin (new dep → ADR). **(a) requires deep-linking (M-3) to exist first** — M-3's code-side prerequisite is now met (2026-07-09: `appUrlOpen` handling + universal-links/App-Links wiring landed), though on-device verification is still blocked on the same `APPLE_TEAM_ID` / `ANDROID_CERT_SHA256` operator creds M-3 itself needs. Not strictly launch-blocking (OTP works).
      **Done when:** native Apple Sign-In completes on a real device, or the owner explicitly accepts OTP-only on native for launch (record it).

---

## Tier 3 — Reliability & correctness follow-ups (before real-money volume)

> Most are `[code]` on the money/upstream paths → **all money items need review (guardrail #3).**

### R3-1 · Operator XLM/USDC float reconciliation `[code]`

- [ ] **Status:** ◐ Partial 2026-07-07 — detection/indexing/read surface and audited baseline/manual write workflow landed; production baselines/cursors/thresholds and money review remain.
      **Why:** The only automated reconciliations are mirror=ledger (INV-1) and on-chain-LOOP-vs-mirror (INV-4). **Neither covers the operator/deposit wallet** through which every real deposit dollar flows (deposits in, CTX settlements out, refunds out, fees). No aggregate "deposits-for-paid-orders ≈ CTX-paid + refunds + fees + float" check. Money-P2-1.
      **Do:** add a scheduled reconciliation (model on `asset-drift-watcher.ts` / `ledger-invariant-watcher.ts`, `withAdvisoryLock` single-flight, persist state, page on breach) that sums the operator wallet's inbound/outbound (Horizon) against the recorded deposits/settlements/refunds and alerts on drift beyond a threshold. Surface it on the Treasury admin page.
      **⚠️** Money-review; it's a _detection_ addition (no writes) but its threshold logic must not false-page on normal float.
      **Done when:** a watcher computes operator-float conservation daily and alerts on drift; visible on Treasury.
      **Scoped 2026-07-07:** This is a historical conservation check, not
      a point-in-time balance card. For each asset (`xlm`, `usdc`) the
      watcher must compare:
      `actual operator balance ~= baseline balance + classified inbound - classified outbound +/- approved manual movement`.
      Persist:
      `operator_wallet_baselines` (asset, account, opening balance,
      Horizon cursor, chosen by, reason), `operator_wallet_movements`
      (Horizon op id, tx hash, paging token, from/to, asset, amount,
      direction, classification, order/refund/settlement/manual refs,
      raw payment json), `operator_manual_movements` (approved
      top-up/sweep/fee adjustment rows), and
      `operator_float_reconciliation_runs` (expected, actual, delta,
      thresholds, unclassified count, state, error).
      Classification rules:
      `user_deposit` = inbound memo matched to paid/procuring/fulfilled
      orders or recorded watcher skips; `ctx_settlement` = outbound CTX
      supplier payment; `deposit_refund` = outbound A6/R3-2 refund;
      `loop_asset_burn`/`interest_mint` = known non-XLM/USDC movement
      classes when the operator account is involved; `manual` = row
      approved by ops; `unclassified` = everything else and must keep
      the run degraded until explained.
      Worker: single-flight with advisory lock, page on `delta` beyond
      per-asset thresholds or any unclassified movement, persist every
      run, and preserve cursor idempotency by upserting Horizon
      movements by operation id before advancing.
      Admin: surface latest actual/expected/delta/state/unclassified
      count on Treasury; add movement drilldown for unclassified rows.
      Operator handoff still required before closing: initial baselines
      and cursors, asset thresholds, manual movement memo policy, and
      money-review sign-off on the write workflow. Until those are
      configured, code must fail closed as `needs_baseline` rather
      than claiming the float is healthy.
      **Partial 2026-07-07:** R3-1 now has durable schema + migration
      (`operator_wallet_baselines`, `operator_wallet_movements`,
      `operator_manual_movements`, `operator_float_reconciliation_runs`),
      a single-flighted worker that indexes Horizon XLM/USDC movements
      from the active baseline cursor, classifies movements against
      paid orders / abandoned deposits / deposit refunds / CTX
      settlements / approved manual rows, persists each run, pages
      Discord on drift or unclassified movement, and surfaces latest
      state in `/api/admin/treasury` plus
      `/api/admin/operator-float/movements`. Audited, idempotent,
      step-up-gated admin writes now exist for creating baselines
      (`POST /api/admin/operator-float/baselines`) and manual movement
      explanations (`POST /api/admin/operator-float/manual-movements`).
      It still remains open until the operator supplies production
      baselines/cursors/thresholds and money review signs off the
      workflow.
      **Money-review fixes 2026-07-08** (adversarial pass on PR #1581):
      classification is no longer compute-once — each tick re-runs the
      classifier over `unclassified` rows, healing watcher-lag deposits
      and the indexer-vs-manual-explanation race; manual-movement
      writes validate the linked movement (must exist, be
      `unclassified`, and match asset/account/direction/amount — no
      more blessing arbitrary drift or typo'd silent no-ops); baselines
      require `startingHorizonCursor` (an unanchored baseline walked
      the whole account history and double-counted pre-baseline flow)
      and a partial unique index (migration 0054) pins one ACTIVE
      baseline per (account, asset); a drift result is recomputed once
      before paging (kills the index-vs-balance-read false positive);
      the module docstring documents the unmodeled terms (tx fees,
      create_account, path payments) and the re-baseline-not-threshold-
      inflation policy. Remaining: production baselines/cursors/
      thresholds (operator) — the code side of the money review is
      addressed.

### R3-2 · Auto-refund delivers the wrong asset in Phase-1 `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `credits/refunds.ts:118-137` `applyOrderAutoRefund` credits `user_credits` (mirror LOOP) by `chargeMinor` with **no `payment_method` branch**. For an xlm/usdc payer that mints an invisible/unspendable balance under `LOOP_PHASE_1_ONLY` instead of returning their on-chain funds; for a loop_asset payer (tokens already burned at `markOrderPaid`) it pushes mirror > chain → negative drift page. Money-P2-2.
      **Do:** branch the refund by `orders.payment_method`: xlm/usdc → on-chain refund to sender (reuse the A6 `refundDeposit`/`submitPayout` machinery); loop_asset → re-mint/re-credit consistently with the burn; credit-method → mirror credit (current behaviour, correct). Coordinate with T0-1 (same "return what they paid, in what they paid" principle).
      **⚠️** Money-review. Must remain idempotent (auto-refund already has a partial-unique-index guard — don't break it). Don't create a double-refund with the A5 procurement-crash path.
      **Done when:** each payment method's failed order refunds in the same asset it was paid; integration test per method; money-review posted.
      **Partial 2026-07-07:** XLM/USDC failed-order auto-refunds now snapshot the
      paying Horizon payment on `orders` and reuse A6 `refundDeposit` to return
      the exact on-chain deposit to the original sender. `credit` remains mirror
      refund. `loop_asset` now fails closed for manual money-review handling
      rather than issuing the previous mirror-only refund that could create drift.
      R3-2 remains open until the loop-asset re-mint/re-credit branch and method
      integration coverage land.
      **Money-review fixes 2026-07-08** (adversarial pass on PR #1581): the
      on-chain branch no longer vacates INV-8 — a credit-ledger cross-check
      runs under the order-row lock in `applyOnChainOrderAutoRefund`,
      `refundDeposit`'s claim, and `applyAdminRefund`, so a mirror-credit
      refund and an on-chain refund for the same order are mutually exclusive
      in both orders of arrival (duplicate T0-1b deposits stay independently
      refundable). Pre-0050/0051 orders without a payment snapshot fail closed
      to a page + manual `applyAdminRefund` (documented deliberate posture for
      the deploy-transition cohort). The R3-5 band is now first-attempt-only:
      once a `ctx_settlements` intent row exists, a retry defers to
      `payCtxOrder`'s pinned-intent + landed-check instead of failing-and-
      refunding an order CTX may already have been paid for.

### R3-3 · CTX: warm-start the merchant/location catalog from Postgres `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — successful CTX merchant and location sweeps now persist compact last-good snapshots to Postgres (`ctx_catalog_snapshots`). Startup warm-starts both in-memory stores from those snapshots before attempting the next upstream refresh, so a restart during CTX outage retains the last-good storefront/map catalog instead of serving empty successful responses. Focused tests cover snapshot save and CTX-down warm-start for both stores.
      **Why:** The catalog caches are module-level in-memory with no persistent seed (`merchants/sync.ts:64-69`, `clustering/data-store.ts:54`), written only on a _successful_ sync. A Fly restart/redeploy **during a CTX outage** cold-starts empty, the boot refresh fails, and `/api/merchants` returns **HTTP 200 with an empty list** — a silently empty storefront with no error signal. CTX-R1.
      **Do:** persist the last-good merchant + location snapshot to Postgres on each successful sync; on boot, warm-start from it before the first upstream refresh; only serve empty if there's genuinely no snapshot. Consider returning `503`/a stale-flag rather than an empty `200` when the catalog is unpopulated.
      **Done when:** killing the process with CTX unreachable still serves the last-good catalog after restart; integration/e2e proof.

### R3-4 · CTX: decide auto-refund on redemption-null exhaustion `[code]` + policy

- [ ] **Status:** ☐ Not started
      **Why:** A paid order whose CTX code never arrives is marked `fulfilled` with null redemption fields; recovery is the backfill sweep (10 attempts/~17h) then a single ops page — **no automatic refund**. The user is out-of-pocket with no product until a human acts. CTX-R2.
      **Do:** decide policy with the owner: on backfill exhaustion, auto-refund (in the paid asset — see R3-2) or hold-and-page. Implement the chosen path idempotently.
      **⚠️** Money-review; must not double-refund if the code later arrives (reconcile before refunding).
      **Done when:** exhaustion has a defined, tested outcome (refund or explicit hold) rather than a silent stuck state.

### R3-5 · CTX: add an upper-band sanity check on pay-CTX amount `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — procurement now parses the CTX SEP-7 amount before `payCtxOrder`, converts it to stroops, and compares it against the expected wholesale quote with the boot-configured `LOOP_CTX_PAYMENT_MAX_BPS_OF_EXPECTED` ceiling (default 125%). Out-of-band or invalid amounts mark the order failed, auto-refund, page the existing procurement-failure path, and do not pay CTX; quote-computation failures revert to `paid` for retry.
      **Why:** Procurement pays CTX the amount from CTX's own SEP-7 URI (`procure-one.ts:287-299` → `pay-ctx.ts`) with **no upper-band check** against expected wholesale cost. A CTX mispricing or a spike between browse and settle makes Loop overpay from the operator wallet (user is protected — they paid the pinned face value; Loop's treasury eats it). CTX-R4.
      **Do:** before submitting the CTX payment, assert the amount is within a sane band of the expected wholesale (e.g. ≤ face value × a configurable ceiling, and ≥ a floor). On breach: fail the order + auto-refund + page, don't pay.
      **⚠️** Money-review. Don't reject legitimate FX movement — set the band from real spread data + a margin; make it a boot-configured constant.
      **Done when:** an out-of-band CTX quote fails-safe (refund + page) instead of silently overpaying; test with a mocked inflated URI.

### R3-6 · CTX: page the drift channel on money-path contract drift `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — `procureOne` now calls `notifyCtxSchemaDrift` on `POST /gift-cards` schema failure before the existing mark-failed + auto-refund path, and `fetchRedemption` calls the same notifier on `GET /gift-cards/:id` schema failure before returning the existing null redemption payload.
      **Why:** `notifyCtxSchemaDrift` fires for browse/auth surfaces, but the two money-critical operator-pool responses — `POST /gift-cards` (`procure-one.ts:259-267`) and `GET /gift-cards/:id` (`procurement-redemption.ts:77-83`) — **only log** on Zod failure. So "CTX changed their schema on the money path" has no dedicated signal. CTX-R5.
      **Do:** wire both Zod-failure branches to `notifyCtxSchemaDrift` (behaviour is already fail-safe; this just adds the alert). Confirm `ctx-contract.test.ts` still covers the fixtures.
      **Done when:** a simulated schema change on either money-path response fires a drift page.

### R3-7 · Pin production to native auth at boot `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — `parseEnv` now refuses production boots with `LOOP_AUTH_NATIVE_ENABLED=false`/unset unless `DISABLE_NATIVE_AUTH_ENFORCEMENT=1` is explicitly set. The override is typed as exact `"1"` in the env schema and documented in `.env.example`, `docs/development.md`, `docs/deployment.md`, and `AGENTS.md`.
      **Why:** `LOOP_AUTH_NATIVE_ENABLED` schema default is `false` (`env/sections/auth.ts:90`). An unset flag on a new prod deploy silently reverts auth to the **CTX-coupled** legacy path → a CTX outage becomes a total login outage. CTX-R3.
      **Do:** add a boot assertion in `env.ts` (or a `parseEnv` cross-check) that in `NODE_ENV=production`, `LOOP_AUTH_NATIVE_ENABLED` must be `true` unless an explicit `DISABLE_...` escape is set (mirror the existing prod boot-fail guards, e.g. the step-up-key one). Update `.env.example` + docs.
      **Done when:** a production boot with native auth off fails fast with a clear error (unless deliberately overridden).

### R3-8 · Align admin step-up OTP with the B5 per-email lockout `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — `adminStepUpHandler` now checks `isEmailOtpLocked` before OTP lookup, calls `registerFailedOtpAttempt` after a wrong OTP, returns `429 TOO_MANY_ATTEMPTS` with `Retry-After` when locked, and clears the counter after a successful step-up OTP.
      **Why:** `admin/step-up-handler.ts:95-101` verifies the admin's OTP with `findLiveOtp` + `incrementOtpAttempts` but does **not** call the B5 `isEmailOtpLocked`/`registerFailedOtpAttempt` counter that the main `verify-otp` path runs (`auth/native.ts:97-118`). Not exploitable today (tiny space, tight rate limits), but the two OTP-consuming surfaces should share one identity-level brute-force ceiling. Authz-F2.
      **Do:** wrap the step-up OTP verify with the same `otp-attempt-counter.ts` lockout as `native.ts`.
      **⚠️** Auth-review. Keep the lockout check _before_ the code compare (checking after is a bypass).
      **Done when:** step-up OTP honours the per-email lockout; test parity with the sign-in path.

### R3-9 · Redeem in-flight fence is process-local `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** The redeem duplicate-submit fence (`inFlightOrders` Set, `orders/redeem.ts`) is per-process. On the 2-machine fleet, two taps on different machines both build+submit a LOOP payment before the watcher flips state → the second lands as an unmatched duplicate, feeding T0-1. Money-P2-3.
      **Do:** replace the in-memory Set with a durable guard (a short-TTL DB row / advisory lock keyed on order id), or a DB CAS on an "in-redemption" state. Pair with T0-1 so a duplicate that slips through is at least recoverable.
      **⚠️** Money-review; must not deadlock a legitimate retry.
      **Done when:** two concurrent redeems of the same order on different machines produce exactly one submission; test the race.

### R3-10 · Make order-create idempotency default-on `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — client-supplied `Idempotency-Key` remains authoritative, and no-header `credit` orders now derive a short-window server fallback key from `userId + merchant + amount + currency`. The handler checks the current and previous fallback bucket before creation and passes the current derived key into the existing `(user_id, idempotency_key)` unique-index path, so duplicate no-header credit submits replay the first order instead of debiting twice.
      **Why:** Order create only dedups when the client sends `Idempotency-Key` (`orders/loop-handler.ts:179-201`). Without it, a double-submitted **credit**-method order writes two orders + two `user_credits` debits — a double-charge of the user's own balance. Money-P2-3.
      **Do:** derive a server-side idempotency key (e.g. `userId+merchant+denomination+minute` bucket, or require the header) so a double-click can't double-debit. Prefer requiring the header from the web client + a short server-side dedup window.
      **⚠️** Money-review.
      **Done when:** a double-submitted credit-method order creates one order/one debit; test.

### R3-11 · Note/accelerate the legacy-order-path ownership gap `[code]`/doc

- [x] **Status:** ✅ Done 2026-07-08 — trust boundary documented explicitly at
      the top of both `orders/get-handler.ts` and `orders/list-handler.ts`
      (referencing ADR-039), plus a new "Accepted risks" row in
      `docs/threat-model.md`. No code/behavior change; ADR-039's retirement
      criteria remain the tracked path to removing this boundary entirely.
      **Why:** `orders/get-handler.ts` + `list-handler.ts` do **no local ownership check** — IDOR defense is fully delegated to CTX bearer-scoping + UUID unguessability (contrast the loop-native path which pins `and(eq(id), eq(userId))`). Not exploitable from Loop's code; it's an upstream trust assumption. Authz-F1.
      **Do:** document the trust boundary explicitly in the handler, and prioritise ADR-039 legacy-path retirement (which removes this path entirely). No urgent code change while the path is being retired.
      **Done when:** the assumption is documented and the retirement criteria (ADR-039) are being tracked.

### R3-12 · Guard the step-up middleware CTX fail-open `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — `requireAdminStepUp(...)` now requires a
      Loop-native auth subject and fails closed for legacy `ctx` auth; focused
      middleware + route-gating tests cover the regression.
      **Why:** `auth/admin-step-up-middleware.ts:84-86` allows `auth.kind === 'ctx'` through. Safe only because every step-up route currently sits behind a loop-anchored `requireStaff` that 401s a `ctx` bearer first. If a future `requireAdminStepUp(...)` is mounted without a preceding staff gate, an unverified CTX bearer sails through with no staff check. Authz-F3.
      **Do:** make the CTX branch fail-closed (reject) rather than allow, or add an assertion that a staff gate ran. Verify no legitimate flow relies on the exemption.
      **⚠️** Auth-review.
      **Done when:** the exemption can't act as a standalone gate; `staff-route-gating.test.ts` still green.

### R3-13 · Origin-check the redemption WebView postMessage `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — native WebView messages are accepted only
      while the current WebView URL origin matches the original redeem URL
      origin; cross-origin navigation drops `messageFromWebview` events.
      **Why:** `RedeemFlow.tsx:88-100` `onMessage` has no origin check; `parseGiftCardMessage` validates payload _shape_ not _sender_. Any frame loaded in the in-app browser can post a `loop:giftcard`-shaped message. Low impact (drives display/clipboard of a code, not a money write). CF-02 reopen.
      **Do:** pin the injected scripts to the expected merchant host and verify `event.origin` against it before accepting a message.
      **Done when:** a message from an unexpected origin is ignored; the happy path still captures.

---

## Tier 4 — Scale & fleet-safety (before growth / Phase 2)

### S4-1 · Stellar payout throughput ceiling (the one architectural item) `[code]`

- [ ] **Status:** ☐ Not started (design/ADR first)
      **Why:** Every value-out flow (cashback emission, nightly interest mint, withdrawal) funnels through **one operator account, serially ~10/min** — the A8 advisory lock correctly makes it fleet-wide serial to protect the sequence number, so horizontal scaling doesn't help. 10k Phase-2 interest mints ≈ 16h (won't finish overnight); 100k impossible. Scale-#1.
      **Do:** design (ADR) + implement operator/issuer **account sharding** (by user/asset) or pre-signed sequence-number batching. Needed **before** Phase-2 interest crosses ~a few thousand active wallets.
      **⚠️** Money + Stellar review; sequence-number management across shards is the hard part — never let two writers share a sequence.
      **Done when:** payout throughput scales past a single account's serial limit; load-tested (see B-1).

### S4-2 · Wallet-provisioning fleet-lock (reads as a bug) `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07
      **Why:** `wallet/provisioning.ts:405-511` has **no** advisory lock / `SKIP LOCKED` / in-flight guard (unlike every other worker). At 2 machines both pick the same oldest users and both submit a sponsored activation tx from the shared operator account → `tx_bad_seq`/`op_already_exists`, burned fees, sequence thrash, false "stuck" pages. Correctness holds (CAS-fenced) but throughput halves. **Not in the risk register.** Scale-#3.
      **Do:** wrap the provisioning tick in `withAdvisoryLock` (the primitive from A8 already exists; copy the payout-worker pattern). A few lines.
      **⚠️** Bites the moment Phase-2 turns on. Money/Stellar-review the lock placement.
      **Done when:** two machines running the tick submit each activation once; test the race.
      **Done 2026-07-07:** `runWalletProvisioningTick` now takes a fixed
      fleet-wide `withAdvisoryLock` before selecting candidates and returns
      `skippedLocked=true` when another machine owns the sweep. Focused coverage
      proves the skipped path does not submit an activation transaction.

### S4-3 · Single-flight the interest-mint Horizon reads `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07
      **Why:** `credits/interest-mint.ts` isn't single-flighted → every machine does a Horizon trustline read per activated wallet each run (safe — DB-fenced against double-mint — but N× wasteful). Scale-#7.
      **Do:** wrap the tick in `withAdvisoryLock` (same pattern as S4-2).
      **Done when:** only one machine performs the mint sweep per run.
      **Done 2026-07-07:** `runInterestMintTick` now takes a fixed fleet-wide
      `withAdvisoryLock`; losing machines return `skippedLocked=true` before
      cursor/user/Horizon reads. Focused coverage proves the skipped path writes
      no snapshot or payout rows.

### S4-4 · Rate-limiter shared store (accuracy under auto-scale) `[code]`

- [x] **Status:** ✅ Fixed 2026-07-09 (dynamic estimator, PR pending auth-review merge)
      **Why:** In-memory per-machine limiter divided by a _static_ `RATE_LIMIT_MACHINE_COUNT_ESTIMATE` (prod=2); `fly.toml` `auto_start_machines=true` makes limits wrong the moment real machine count diverges — too loose under exactly the spike you'd want them tight; the 10k-entry `rateLimitMap` also thrashes under high IP diversity. Wave 9 / Scale-#2 / ADR-005 #4.
      **Do:** interim (cheap) — pin `min`/`max` machines so the estimate stays accurate. Durable — a shared counter (Postgres or Redis; Redis needs an ADR as a new dep). Keep per-route keys (A4-001).
      **Done when:** per-IP limits are accurate regardless of machine count; documented.
      **Done 2026-07-09:** implemented a **dynamic fleet-size estimator**
      (`apps/backend/src/middleware/fleet-size.ts`) instead of either interim
      option above. It queries Fly's private `<FLY_APP_NAME>.internal` DNS zone
      (one AAAA record per currently-started machine, fleet-wide) on a 30s
      background interval — never on the request path — and `rate-limit.ts`
      reads the cached estimate fresh on every request as the divisor. On
      DNS failure the last-known-good value is kept for a 5-minute grace
      period, then falls back to the static `RATE_LIMIT_MACHINE_COUNT_ESTIMATE`
      (which stays as the no-signal floor for local dev/CI/non-Fly hosts).
      `/health` exposes the live value (`rateLimitFleetEstimate` /
      `rateLimitFleetEstimateSource`). Per-route keys (A4-001) unchanged.
      **The durable shared-store (Redis/Postgres) option was deliberately
      rejected**, not deferred: it adds a hot-path round-trip to every
      rate-limited request and turns a volumetric flood into a database
      write storm — worse than the inaccuracy it would fix. ADR-040's
      planned Cloudflare edge (a single edge-side limiter ahead of the whole
      fleet) is the eventual durable answer once it lands. The interim
      min/max-machine-pinning option is now unnecessary — the dynamic
      estimator supersedes it (it's strictly more accurate and needs no
      manual pinning). The 10k-entry `rateLimitMap` thrash-under-IP-diversity
      half of the original "Why" is **not** addressed by this fix and remains
      open if it becomes a real problem.

### S4-5 · Raise the DB pool; plan PgBouncer `[code]`

- [ ] **Status:** ☐ Not started (docs half done 2026-07-09 — see below; operator sizing action stays open)
      **Why:** `db/client.ts:57` `max: DATABASE_POOL_MAX` default **10** vs `fly.toml` `hard_limit=250` concurrency — a 25× admission gap; a spike of concurrent authed/admin work queues on 10 connections while CPU idles. Scale-#4.
      **Do:** raise `DATABASE_POOL_MAX` (mind Postgres `max_connections` = pool × machines). Plan PgBouncer for later. ⚠️ **PgBouncer transaction-mode disables session advisory locks** — `withAdvisoryLock` (payout/provisioning/interest/ledger single-flight) would silently degrade; the money path needs care/testing before that migration.
      **Done when:** pool sized to actual concurrency; PgBouncer risk documented for the money path.
      **Progress note (2026-07-09) — docs landed, 🟢 half done:**
      `docs/deployment.md` §"Database pool sizing & PgBouncer (S4-5)" now
      has the verified current numbers (`DATABASE_POOL_MAX` default 10 —
      `apps/backend/src/env/sections/core.ts:239` — vs `fly.toml`
      `hard_limit=250`, the 25× gap), the sizing formula
      (`DATABASE_POOL_MAX × running machines + headroom ≤ Postgres
max_connections`, including the release-command migration machine
      as a temporary extra pool during deploys) with the `psql
"$DATABASE_URL" -c "SHOW max_connections;"` check, a **PROPOSED**
      ~25/machine starting point for the current 2-machine fleet (operator
      sets via `fly secrets set`, not a code-default change), and the full
      ⚠️ PgBouncer/session-advisory-lock writeup: every `withAdvisoryLock`
      call site (payout worker, wallet provisioning, interest-mint, the
      payment watcher, order-expiry sweep, redemption backfill,
      operator-float reconciliation, and the `orders/redeem.ts` redeem
      fence) degrades to running UNLOCKED with a `log.warn` under a
      transaction-mode pooler (`isPooledPostgresUrl()` in `db/client.ts`),
      while the transaction-scoped locks (`ledger-invariant-watcher.ts`,
      `cursor-watchdog.ts`, `stuck-payout-watchdog.ts`) are unaffected.
      Cross-linked from `docs/development.md` and
      `apps/backend/.env.example`'s `DATABASE_POOL_MAX` entries. **Still
      open (👤 operator):** actually read the live Postgres
      `max_connections` and set `DATABASE_POOL_MAX` against it — that's an
      operator call requiring `flyctl` access, not more engineering. No
      code default changed. S4-5 stays unchecked until that half lands.

### S4-6 · Bound the admin ledger-drift scan `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07
      **Why:** `admin/reconciliation.ts:74` → `credits/ledger-invariant.ts:141` runs an unbounded `GROUP BY` over **all** `credit_transactions` synchronously on the admin request path, holding a pool connection for a multi-second scan (`credit_transactions` grows ~1 row/user/night). Scale-#5.
      **Do:** quick — add a statement timeout + short cache to the admin call. Durable — incremental/materialised reconciliation. Bites ~10M+ rows.
      **Done when:** the admin call can't monopolise a connection with a full scan.
      **Done 2026-07-07:** `adminReconciliationHandler` now runs the drift/count
      queries inside a transaction-local `statement_timeout=2000ms` and caches the
      successful response for 30s, preserving the existing response shape. Focused
      unit coverage asserts the timeout path and immediate cache hit.

### S4-7 · Trim the client-side catalog fetch `[code]`

- [x] **Status:** ✅ Done — both "done when" criteria met: **(1) `fields=lite` projection** (`/api/merchants/all?fields=lite` strips description/instructions/terms; browse hook opts in; verified no browse surface renders them — detail uses `/by-slug` + `/:id`) + **(2) mobile search debounced** (150ms in `MobileHome`, mirrors Navbar; input stays responsive, filtering keys off the debounced value). (3) directory virtualization + server-side search deferred (explicitly "later"; not in the acceptance criteria).
      **Why:** `use-merchants.ts:65` → `/api/merchants/all` ships `description/instructions/terms` (each capped 50k chars) that no browse surface renders — ~0.5-1MB now, ~10-20MB at 34k merchants — JSON-parsed on the main thread + localStorage-seeded; the directory renders un-virtualized DOM cards; mobile search is undebounced. Scale-#6 (catalog size is operator-controlled).
      **Do (cheap→structural):** (1) a `fields=lite` server projection stripping the long text — biggest single win, few lines in `merchants/handler.ts`; (2) debounce mobile search; (3) virtualize the directory + add server-side search (later).
      **Done when:** the browse payload excludes unrendered long text; mobile search is debounced.

### S4-8 · Dedupe per-machine watchers/alerts `[code]`

- [x] **Status:** ✅ Done 2026-07-09
      **Why:** Non-single-flighted watchers (payment-watcher, asset-drift, redemption-backfill) run on every machine → N× Horizon/CTX reads; the cursor + stuck-payout Discord watchdogs gate on a per-process boolean → **N duplicate pages** at N machines. Scale-#7.
      **Do:** apply `withAdvisoryLock` (or a DB dedup) to the duplicated watchers/alerts. Location sync's doubled ~500-page CTX sweep is architectural (leave for later; cheap today).
      **Done when:** watchers run once per fleet per tick; no duplicate pages.
      **Done 2026-07-09** (revised same day after two adversarial
      money-reviews): `runPaymentWatcherTick` / `runAssetDriftTick` /
      `runRedemptionBackfillTick` (plus the expiry sweep, now the
      exported `runOrderExpirySweepTick`) wrap in a fixed fleet-wide
      `withAdvisoryLock`, copying the `interest-mint.ts` pattern —
      losing machines return `skippedLocked: true` with zero
      Horizon/CTX/DB-write calls — and each tick races a hard lease
      deadline (the payout-worker INV-9 pattern; 60-240s per cadence)
      so a hung-but-alive lock holder degrades to the pre-S4-8
      per-machine posture instead of stalling the fleet. The cursor +
      stuck-payout watchdogs single-flight on
      `pg_try_advisory_xact_lock` inside `db.transaction` (the
      `ledger-invariant-watcher.ts` pattern) with the fire-once state
      PERSISTED in the new `watchdog_alert_state` table (migration
      0055; the ADR-038 D2 `interest_pool_alert_state` shape) —
      contract: **at-least-once per incident, fleet-wide,
      confirmed-delivery** (`alert_active` flips only after the
      webhook confirms; a failed send is retried next tick; a healthy
      tick re-arms). /health honesty: lock-skipped ticks stamp
      liveness but are surfaced separately
      (`lastSkippedLockedAtMs`/`lastLeadTickAtMs`) so an always-losing
      machine can't masquerade as doing the work, and a healthy
      lock-loser never flips degraded (no false Fly restarts).
      Location sync's doubled sweep stays explicitly out of scope, per
      this item's original "Do." Per-watcher tests cover
      lock-skip-zero-calls, lease expiry, stale-fired-state re-arm,
      and failed-send retry.

---

## Tier 5 — Admin / support tooling (make the dashboard self-sufficient)

> Backend money-writes are the best-tested thing in the repo; the gap is the **operator UI** and a few missing endpoints. Use `/add-endpoint` for any new endpoint; admin routes need `requireStaff` + (for writes) `requireAdminStepUp`.

### A5-1 · Order re-drive lever (biggest hole) `[code]`

- [x] **Status:** ✅ Shipped 2026-07-09 (PR #1609 — review-first, not yet merged).
      **Why:** A stuck `paid`/`procuring` order has **no** operator action — no requeue/reprocure/manual-fulfill/cancel. Resolution relies on the worker eventually retrying, else raw SQL/kill-switch.
      **Do:** add admin endpoint(s) + UI to re-drive a stuck order: re-enqueue procurement, or (with step-up + reason + audit) mark for retry/cancel-and-refund. Reuse the procurement worker path; don't duplicate its money logic.
      **⚠️** Money-review — a re-drive must be idempotent (can't double-procure/double-pay CTX; the `ctx_settlements` guard must hold).
      **Done when:** an operator can unstick a paid/procuring order from `/admin/orders/:id` without SQL; test.
      **Shipped (paid-only after money-review):** `POST /api/admin/orders/:orderId/redrive` — admin-tier + step-up (`order-redrive` scope), ADR-017 envelope. Re-runs `procureOne` for a stuck **`paid`** order the worker never drained (the recovery sweep only touches `procuring` rows, so a paid order stranded by a downed worker otherwise sits forever). Safe under concurrency: `markOrderProcuring`'s `WHERE state='paid'` CAS is a hard single-flight gate — a live worker / another redrive all contend and exactly one wins the claim; the rest return `'skipped'` before reaching `payCtxOrder`, so never a double-procure or double-pay (INV-7). **`procuring` orders are refused** (`ORDER_REDRIVE_IN_PROGRESS`, 409): a money-reviewer found that force-reverting a `procuring` order to re-procure it can strand a CTX-paid order in `failed` with no refund (INV-6) and, in a narrow window, double-pay CTX (INV-7), because nothing reliably distinguishes a crashed worker from a genuinely-live one (`submitNativePayment`'s `loadAccount` has no client timeout). Stuck `procuring` orders already have the automatic recovery sweep as a backstop; safe manual re-procure needs a liveness signal + bounded Horizon I/O (core-payment-path follow-up). No new money logic — reuses `procureOne` + `ctx_settlements` unchanged. Web: admin-only `OrderRedrivePanel` on `/admin/orders/:orderId`, step-up + reason-dialog gated. **Scope decision:** cancel-and-refund also OUT of scope — deferred to A5-4. Tests: `apps/backend/src/admin/__tests__/order-redrive.test.ts` (state routing, procuring-refused, idempotent double-click) + `apps/web/app/components/features/admin/__tests__/OrderRedrivePanel.test.tsx` + `staff-route-gating.test.ts` / `rate-limit-route-inventory.test.ts` updates.

### A5-2 · Admin session-revocation UI `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `POST /api/admin/users/:userId/revoke-sessions` exists + is in OpenAPI but has **zero UI** (orphaned). Incident response requires curl.
      **Do:** add a "Revoke sessions" button on the user-360 page (`admin.users.$userId.tsx`) calling the existing endpoint.
      **Done when:** an operator can revoke a user's refresh tokens from the UI.

### A5-3 · Login/OTP support tooling `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** Can't-log-in / no-OTP is a **total dead-end** — no per-user OTP status, no resend/unlock. Send failures are swallowed (`auth/native-request-otp.ts:83`); the `otps` table has no delivery column.
      **Do:** add a `sent`/`delivery_status` column to `otps` (migration); record send outcome; add a support view (per-user OTP status) + a resend + an unlock-lockout action (support-tier). ⚠️ Don't leak OTP codes in the admin view — status only.
      **Done when:** support can see why a user didn't get an OTP and resend/unlock without SQL.

### A5-4 · Order-bound refund UI + fulfilled-order policy `[code]`+policy

- [ ] **Status:** ☐ Not started
      **Why:** `POST /api/admin/users/:userId/refunds` (admin + step-up, order-bound, dupe-guarded) has **no UI** — curl only — and it **never checks order state** and there's **no gift-card clawback** (`credits/refunds.ts` deliberately doesn't touch the order state machine): the user keeps the card _and_ the money; Loop eats it.
      **Do:** surface the endpoint as a button on the order/user page; decide + implement the fulfilled-order dispute policy (absorb vs require justification vs partial). ⚠️ Money-review; keep the existing dupe-guard.
      **Done when:** operators refund via UI, order-bound, with a defined fulfilled-order policy.

### A5-5 · Operator-mediated DSR `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** No `/api/admin/users/:userId/dsr/{export,delete}` — for an emailed `privacy@` request the runbook makes the operator replay the _user's_ endpoint with the user's bearer or hand-run SELECTs. Self-serve DSR exists + is solid; the operator-mediated path doesn't.
      **Do:** add admin DSR export/delete endpoints (admin + step-up, audited) reusing `dsr-export.ts`/`dsr-delete.ts` with the existing money-orphan 409 guards. Runbook: `docs/runbooks/dsr.md`.
      **Done when:** an operator can fulfil a DSR request for another user from the admin surface.

### A5-6 · Make stuck-orders/stuck-payouts support-visible `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `GET /api/admin/stuck-orders` is admin-only (`admin-dashboard.ts:39` `requireStaff('admin')`; `admin.stuck-orders.tsx` is `RequireAdmin`), so **support can't even see** a delayed order to explain it — contradicts its ADR-037 "find→explain→unstick" job.
      **Do:** downgrade the read to `requireStaff('support')` (keep any write actions admin-tier). Update `staff-route-gating.test.ts`.
      **Done when:** support can see stuck orders/payouts (read) without admin.

### A5-7 · Per-subject audit view `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `audit-tail.ts` filters only by `limit`/`before` — you can't pull "every admin action on customer X" or "everything actor Y did." No per-user audit on user-360.
      **Do:** add subject/actor filters to the audit-tail endpoint + a per-user audit panel on user-360.
      **Done when:** an operator can list all actions on/by a given user.

### A5-8 · Fleet-wide ledger browser `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `credit_transactions` is browsable per-user only; ADR-037 §4.2 listed a fleet-wide ledger browser, only the per-user slice shipped. Keyset-paginate (no OFFSET). `[code]`.

### A5-9 · Bulk actions + drift-correction action `[code]`

- [ ] **Status:** ☐ Not started
      Reopen/retry/refund are one-at-a-time; add bulk selection. There's no drift-correction action (reconciliation is read-only) — design a safe, audited, step-up-gated correction. ⚠️ Money-review any correction action heavily.

---

## Tier 6 — Test & E2E coverage

### Q6-1 · Direct test for `orders/ctx-settlements.ts` (0% counted) `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — added a direct counted unit suite for `orders/ctx-settlements.ts` covering lookup, first intent insert, insert-conflict re-read, impossible conflict failure, signed tx-hash persistence, confirmation marking, and confirmed chain backfill/upsert. This gates the ADR-038 durable double-pay guard outside the real-Postgres integration job.

### Q6-2 · Raise counted coverage on money/auth workers `[code]`

- [x] **Status:** ✅ Fixed 2026-07-07 — raised counted coverage for every named Q6-2 file. Added unit coverage for `auth/otp-attempt-counter.ts` (lockout read, failed-attempt upsert shape, clear, stale purge; targeted 94.44% lines / 80% branches), expanded `payments/payout-submit.ts` (native XLM, pre-signed submits, hash fallbacks, build/persist failures; targeted 98.8% lines / 79.16% branches), added `credits/ledger-invariant-watcher.ts` lifecycle coverage (start idempotence, immediate tick success/failure, stop; targeted 97.5% lines / 75% branches), and added `payments/payout-worker.ts` lifecycle/reset coverage (targeted 89.04% lines / 76.19% branches).

### Q6-3 · Web money-write client tests `[code]`

- [ ] **Status:** ☐ Not started — 40+ untested `admin-*` service files incl. `admin-write-envelope.ts` (step-up + `Idempotency-Key` header correctness) and `admin-step-up.ts`. A wrong header here silently breaks a money write.

### Q6-4 · Gating loop-native purchase-through-the-UI E2E `[code]`

- [ ] **Status:** ☐ Not started — the **actual production path** (`createLoopOrder`, gated on `config.loopOrdersEnabled`) is never browser-driven in CI; the mocked test drives the _legacy_ path. Add a mocked-CTX Playwright test that drives a loop-native order through the UI, and make it gate merges. ⚠️ A UI/config regression on the real path currently passes every gate.

### Q6-5 · Admin/support UI E2E smoke `[code]`

- [ ] **Status:** ☐ Not started — the best-tested backend surface has **zero** UI E2E. Add a smoke pass over the admin payouts/treasury/orders routes (they're also at 0% unit coverage).

### Q6-6 · Wallet-spend + on-chain-interest-mint coverage `[code]`

- [ ] **Status:** ☐ Not started — Pay-with-Loop-balance `/redeem` and the value-creating interest mint are unit-only; the mint has **no real-Postgres integration test exercising the conservation trigger** it must satisfy. Add one. ⚠️ A mint bug that trips/evades the trigger wouldn't be caught today.

### Q6-7 · Promote the real-chain run off manual-only `[code]`

- [ ] **Status:** ☐ Not started — `scripts/e2e-real.mjs` (the only true full-stack money E2E) runs on `workflow_dispatch` only. Schedule it (nightly/pre-release) so a real Stellar+CTX regression is caught off the merge path.

### Q6-8 · Ratchet web coverage floors `[code]`

- [ ] **Status:** ☐ Not started — web floors have only ~2-4 pts of headroom; raise them as Q6-3/4/5 close so regressions can't slip under.

---

## Tier 7 — Mobile

### M-1 · Device/simulator testing (headline mobile risk) `[operator]`+`[code]`

- [ ] **Status:** ☐ Not started
      **Why:** **Nothing native has run on hardware** — the redemption WebView (delivers real value), biometric app-lock, and keychain token storage are mock-tested only; there's no Detox/Appium/Maestro. Highest mobile risk before store submission.
      **Do:** run the redemption flow, biometric lock, and keychain persistence on a real iOS _and_ Android device; ideally add a Maestro/Detox smoke for the critical paths. Verify the `@capgo/inappbrowser` postMessage bridge actually delivers on-device.
      **Done when:** the three highest-risk native surfaces are verified on both platforms.

### M-2 · Push notifications: wire or remove `[code]`

- [x] **Status:** ✅ Done 2026-07-09 — removed the scaffolding (push is Phase 2)
      **Why:** Dead scaffolding — `notifications.ts` creates channels but **nothing** calls `PushNotifications.register()`, requests permission, or listens; no device-token upload, no APNs/FCM backend send. "Your gift card is ready" can't fire.
      **Do:** decide in-or-out. In → wire register/permission/listeners + a backend send path + token storage. Out → remove the channel scaffolding so the code is honest. ⚠️ APNs needs the push entitlement (currently unhandled by the overlay script — see M-4).
      **Done when:** push either works end-to-end or is removed; no dead channels. Resolved out: `apps/web/app/native/notifications.ts` deleted, `@capacitor/push-notifications` removed from both `package.json`s and `capacitor.config.ts`. Re-add in Phase 2 if needed (see go-live-plan §T2 mobile enhancements).

### M-3 · Deep linking (entirely absent) `[code]`

- [x] **Status:** ✅ Done 2026-07-09 — `App.addListener('appUrlOpen')` wired (`apps/web/app/native/deep-link.ts`, mirroring `back-button.ts`'s dynamic-import + disposer shape), validated with an exact-hostname allowlist (`loopfinance.io` / `www` / `beta`, `https:` only) before ever calling `navigate()` — never the raw string, path+search+hash only. iOS associated-domains entitlement (`native-overlays/ios/App/App/App.entitlements`, wired via `CODE_SIGN_ENTITLEMENTS` on both build configs) + Android `autoVerify` intent-filter, both patched by `apps/mobile/scripts/apply-native-overlays.sh` and grep-asserted by the `mobile-overlay-guard` CI job. Backend serves `apple-app-site-association` / `assetlinks.json` (`apps/backend/src/well-known/deep-link-verification.ts`), 404 until the operator sets `APPLE_TEAM_ID` / `ANDROID_CERT_SHA256`.
      **Why:** No `App.addListener('appUrlOpen')`, no applinks/`associated-domains` entitlement, no Android intent-filters. Blocks the CF-27 Apple fix (C2-2), app-open from email/order links, and the SEP-7 wallet return path.
      **Do:** add `@capacitor/app` `appUrlOpen` handling + universal-links (iOS `associated-domains`) + Android `intent-filter`s in the native overlays; route incoming URLs to the right screen.
      **Done when:** an `https://loopfinance.io/...` link opens the app to the right screen on both platforms.
      **⚠️ Operator follow-up:** code side is complete but on-device verification (Apple actually opening the app instead of Safari, Android actually opening the app instead of Chrome) is blocked on `APPLE_TEAM_ID` (Apple Developer Program enrollment, L1-4) and `ANDROID_CERT_SHA256` (release keystore, L1-5) — both currently unset, so both `.well-known/*` files 404 and neither OS will treat the domain as verified yet. Re-test after M-1 device testing once those creds land.

### M-4 · CI/checklist guard for operator-once overlay steps `[code]`

- [x] **Status:** ✅ Done 2026-07-09 — `apply-native-overlays.sh` now patches `project.pbxproj` itself (anchored, idempotent, fail-loud on drift) and a new advisory CI job proves it on a scratch `cap add` regeneration.
      **Why:** A bare `cap sync` (without `apply-native-overlays.sh`) silently drops **all** overlays; and several store-critical steps aren't enforced by the script _or_ CI: the iOS `.pbxproj` `baseConfigurationReference` → `release.xcconfig`, `PrivacyInfo.xcprivacy` Copy-Bundle-Resources membership, and the (unhandled) APNs entitlement. These regress invisibly on a clean regeneration.
      **Do:** add a `mobile:sync` wrapper guard / CI check that fails if overlays are missing after sync; extend `apply-native-overlays.sh` to assert (fail-loud) the pbxproj xcconfig ref + PrivacyInfo membership; handle the push entitlement if M-2 lands.
      **Done when:** a native regeneration that drops an overlay fails loudly. Resolved: `apps/mobile/scripts/apply-native-overlays.sh` patches `project.pbxproj` (PBXFileReference + baseConfigurationReference for release.xcconfig on every Release XCBuildConfiguration; PBXFileReference + PBXBuildFile + PBXResourcesBuildPhase membership for PrivacyInfo.xcprivacy), anchored on existing content (never hardcoded object ids) and verified post-patch; the `mobile-overlay-guard` CI job (`.github/workflows/ci.yml`) runs a scratch `npx cap add ios/android` + the overlay script on every push/PR and grep-asserts the wiring plus the pre-existing Android overlays. Push/APNs entitlement is moot — M-2 removed push notifications.

### M-5 · Add `@capacitor/app` lifecycle handling `[code]`

- [x] **Status:** ✅ Done 2026-07-09 — `App.addListener('appStateChange')` wired (`apps/web/app/native/app-state.ts`, same dynamic-import + disposer shape as M-3/back-button), forwards `isActive` to TanStack Query's `focusManager.setFocused()` so `refetchOnWindowFocus` (already relied on for pull-to-refresh) actually fires on resume — window focus/blur never fires for a backgrounded Capacitor app on its own. Registered in the same NativeShell native-mount effect as M-3's deep-link listener. Re-locking on resume was considered and deliberately deferred — `registerAppLockGuard` (`apps/web/app/native/app-lock.ts`) stays cold-start-only per its existing design-choice comment, now noting M-5 revisited and confirmed the same reasoning.

---

## Tier 8 — Blind-spot categories (never on the board)

### B-1 · Load / stress / soak testing (absent) `[code]`

- [ ] **Status:** ☐ Not started (harness half done 2026-07-09 — see below; real breaking-point run stays open)
      **Why:** Zero capacity evidence for a payment system on a single 512MB/1-cpu VM (`fly.toml`). You don't know the breaking point or autoscale behaviour. Compounds S4-4 (per-machine rate limits).
      **Do:** add a k6 (or artillery) suite hitting the hot paths (browse, order-create, auth) at increasing concurrency; run it against staging (see below) or a scratch deploy; record the breaking point + autoscale behaviour. New tool → note it in docs (k6 is a binary, not an npm dep, so no ADR needed, but document how to run).
      **Done when:** there's a documented capacity number + autoscale behaviour for the hot paths.
      **Progress note (2026-07-09) — harness landed, 🟢 half done:** `tools/load-test/` now has a k6 suite (`browse.js` — clusters/merchants/by-slug, staged 5→50→100 VUs, SLO-derived `p95<200ms` thresholds; `auth-order.js` — request-otp→verify-otp→order-create→poll, staged 2→10→25 VUs, `p95<1500ms` order-create threshold; both `<1%` error budget) + `config.js` (`BASE_URL`, `scaleStages()` for a `VUS_SCALE` knob) + `run-local.sh` (boots the same mocked stack as `test-e2e-mocked`: mock-ctx, backend NODE_ENV=test, docker-compose postgres; pinned-by-digest `grafana/k6` image, `K6_BIN=k6` PATH fallback; macOS/Docker-Desktop networking handled via `host.docker.internal`) + `.github/workflows/load-test.yml` (`workflow_dispatch`-only, scenario + `vu_scale_factor` inputs, NOT a required check). Measured dev-machine + mock-CTX baselines (NOT production numbers — see `docs/load-testing.md` for the full caveat list): `browse.js` `merchants_all` p95 7.06ms, `merchants_by_slug` p95 5.36ms, 0% errors at 100 VUs peak; `auth-order.js` `order_create` p95 6.28ms, 0% errors at 25 VUs peak — both from the same `./tools/load-test/run-local.sh both` run; full numbers in `docs/load-testing.md`. **Still open (👤 operator):** the real breaking-point measurement needs this harness (or a rate-limiter-on variant) pointed at a staging deploy or a scratch Fly app sized like production — that's infra provisioning, not more engineering. B-1 stays unchecked until that half lands.

### B-2 · Accessibility (absent, + EU legal exposure) `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** No axe/jsx-a11y/pa11y/keyboard tests. Consumer finance app targeting the Eurozone — the **European Accessibility Act** mandates accessibility for e-commerce/banking there. Compliance, not nice-to-have.
      **Do:** add `eslint-plugin-jsx-a11y` (lint gate) + `axe`/`jest-axe` on key routes; do a keyboard + screen-reader pass on onboarding/purchase/wallet; fix the findings. (New devDeps → ADR per policy, but a11y tooling is low-controversy.)
      **Done when:** a11y lint + automated checks gate CI on the core routes; a manual audit is recorded.
      **Progress note (2026-07-09):** WUM-10 residue closed — the CF-35 aria-live
      copy-confirmation pattern (`PaymentStep` / `LoopPaymentStep.Row`) is now
      rolled out to all 5 of 5 "copy to clipboard" sites in the web-ui-money
      vertical (`PurchaseComplete.CodeField`, `RedeemFlow`'s challenge-code copy,
      `LoopOrdersList.RedemptionField`, and the shared admin `CopyButton` that
      `TrustlineSetupCard` depends on for issuer-pubkey copy). See
      `docs/audit-2026-06-30-cold/raw/v-web-ui-money.md` WUM-10. This is one
      point fix within B-2's much larger scope — the axe/jsx-a11y/pa11y tooling
      and the full keyboard/screen-reader audit are still not started; B-2 stays
      unchecked.
      **Progress note (2026-07-09): tooling landed** — `eslint-plugin-jsx-a11y`
      (recommended set, `apps/web/app/**/*.tsx`, gates `npm run lint`) +
      `jest-axe` route smokes (`MobileHome`, `PurchaseContainer`, `AuthRoute`,
      `LoopOrdersList`, `Onboarding` — WCAG 2.1 A/AA tags) landed via ADR 042.
      Initial lint sweep found 26 violations across 4 rules: 2 were real gaps
      (fixed — `Navbar` combobox missing `aria-controls`, documented in ADR
      042); 24 were codebase-specific false positives (19× `role="list"` on
      `<ul>` — a deliberate Safari/VoiceOver fix that Tailwind Preflight's
      `list-style: none` would otherwise break; 5× `autoFocus` on the sole
      input of a freshly-active auth/onboarding step; 1× a modal
      stopPropagation handler) suppressed with scoped, reasoned
      `eslint-disable-next-line` comments rather than a blanket rule
      downgrade — the repo's `eslint . --max-warnings=0` gate means a
      rule-level `warn` would still fail CI on every existing hit, so a
      per-line documented exception was the only way to both keep the rule
      at `error` for new code and land a green `npm run verify`. All 5
      `jest-axe` route smokes pass with zero violations — no rule exclusions
      needed there. **Still missing** (B-2 stays unchecked): the manual
      keyboard-only navigation walkthrough, the screen-reader pass
      (VoiceOver/TalkBack/NVDA), and real-browser color-contrast checking
      (jsdom has no layout engine, so `jest-axe` structurally cannot catch
      contrast — see ADR 042's alternatives section for the pa11y/
      `@axe-core/playwright` follow-up that would close that gap).

### B-3 · User-level fraud/abuse controls (absent) `[code]`

- [ ] **Status:** ☐ Not started — no velocity limits, duplicate-account detection, or chargeback handling (`loop-create-checks.ts` only does a balance + first-order check). Pairs with L1-1. Add per-user order/day + per-device caps, dup-account signals, and a chargeback/dispute flow. ⚠️ Money + abuse-model review.

### B-4 · DR: PITR + offsite backup `[operator]`+`[code]`

- [ ] **Status:** ☐ Not started (docs/procedure half done 2026-07-09 — see below; operator execution stays open)
      **Why:** 24h RPO (Fly daily snapshot) on the money ledger; **all** backups inside Fly → a vendor/account compromise is total data loss (the DR runbook's own "whole-environment compromise" case can't restore what only lived in the compromised vendor). `docs/runbooks/disaster-recovery.md` is otherwise strong.
      **Do:** enable Postgres PITR; add a scheduled cross-cloud `pg_dump` (e.g. to S3/GCS/B2) with a tested restore. `[operator]` for the vendor/bucket, `[code]` for the job + runbook update.
      **Progress note (2026-07-09) — docs/procedure landed, 🟢 half done:**
      `docs/runbooks/disaster-recovery.md` rewritten with an operator checklist, a
      precise "what's actually at risk" table (ledger mirror / loop-native orders are
      the crown jewel — reasoned from ADR 036 / `invariants.md` INV-3's
      chain-is-a-floor-not-the-liability model), corrected + Fly-docs-cited
      current-posture facts (confirmed via Fly's own docs: unmanaged Fly Postgres — not
      Managed Postgres/MPG — does daily volume snapshots, 5-day default retention, **no
      offsite copy**, and an **opt-in but not-yet-enabled** WAL-based PITR path via
      `fly postgres backup enable`), a 3-layer target posture (snapshot retention → PITR
      → genuinely offsite cross-vendor `pg_dump`, credentials as GitHub secrets not Fly
      secrets), a restore-drill procedure (quarterly quick drill + the existing 180-day
      full rehearsal), PROPOSED RPO/RTO tables pending operator sign-off, and an incident
      decision tree wired to `docs/oncall.md` + the kill-switch-first step. Also fixed a
      pre-existing app-name/cadence drift between this runbook and
      `docs/runbooks/migration-rollback.md`. **Still open (👤 operator):** actually run
      `fly postgres backup enable`, set explicit snapshot retention, provision the
      offsite bucket + credentials, build the scheduled `pg_dump` GitHub Actions
      workflow (`[code]`), and run one real timed restore drill — see the operator
      checklist at the top of `disaster-recovery.md` for the exact steps. B-4 stays
      unchecked until that half lands.
      **Done when:** PITR is on + an offsite backup exists with a rehearsed restore.

### B-5 · Observability depth `[code]`+`[operator]`

- [ ] **Status:** ☐ Not started
      **Why:** No distributed tracing (a multi-worker money incident = grep-by-request-id); alerting is Discord-webhook-only (no paging/escalation — a missed message is a missed page, `docs/alerting.md`); SLOs are defined (`docs/slo.md`) but nothing computes burn-rate or alerts.
      **Do:** add OpenTelemetry tracing across the order→payment-watcher→procurement→payout chain; add a paging tier (PagerDuty/Twilio) for P0 signals (payout-failed, over-mint drift); wire burn-rate alerts to the SLOs. `[operator]` for the paging vendor.
      **Done when:** a money incident is traceable end-to-end and a P0 alert actually pages a human.
      **Progress note (2026-07-09) — scrape/dashboard 🟢 half done:**
      `docs/observability.md` (new) documents everything `/metrics`
      emits + its bearer-token scrape auth, and indexes two committed
      artifacts under `docs/observability/`: `prometheus.yml` (an
      example scrape config, `promtool check config`-validated
      locally) and `grafana-dashboard.json` (a schema-v39 dashboard,
      JSON-parse-checked in `scripts/lint-docs.sh` §11) with one row
      per `docs/slo.md` section (Availability / Latency / Freshness /
      Worker health / Infra). `/metrics` gained new gauges so those
      panels have real data to plot: `loop_catalog_stale` +
      `loop_catalog_loaded_timestamp_ms` (Freshness SLO — merchants +
      locations, same staleness formula as `/health` via the new
      shared `merchantCatalogStaleAfterMs()`/`locationCatalogStaleAfterMs()`
      helpers in `health.ts`), `loop_worker_stale` +
      `loop_worker_last_lead_tick_timestamp_ms` (surfaces S4-8's
      "alive but never leading" wedged-fleet signal, previously only
      in `/health`'s JSON body), `loop_geo_db_stale` +
      `loop_geo_db_build_age_days`, and `loop_rate_limit_fleet_estimate` + `loop_rate_limit_fleet_estimate_source` (S4-4's per-machine →
      fleet-wide divisor). All new reads are in-memory/cached (no new
      DB or upstream calls from a `/metrics` scrape) — see
      `docs/observability.md` for why settlement-lag and on-chain
      asset-drift stay un-panelled (they're DB-backed admin reads, not
      in-memory state, so wiring them in would change `/metrics`'s
      cost profile — flagged as a future follow-up, not invented here).
      **Still open (👤+`[code]`):** OpenTelemetry tracing across
      order→payment-watcher→procurement→payout, a paging tier
      (PagerDuty/Twilio) for P0 signals, burn-rate alerting wired to
      the SLOs, and actually standing up a Prometheus + Grafana
      instance (or Grafana Cloud) pointed at the committed config —
      see `docs/observability.md` "Operator actions". B-5 stays
      unchecked until that half lands.

### B-6 · i18n is English-only behind a good scaffold `[code]` (large)

- [ ] **Status:** 🟡 In progress (2026-07-10) — **framework + first extraction
      tranche done** (ADR 043): i18next + react-i18next chosen and wired into
      `root.tsx` (route-driven locale via `~/i18n/locale.ts#useLocale()`,
      synchronous bundled-resources init so both the SSR and static-mobile-export
      builds work with no async/Suspense gymnastics). First tranche extracted:
      `Footer.tsx`, `not-found.tsx`/`not-found-ssr.tsx`, `home.tsx`'s desktop
      hero + section headers, `auth.tsx` in full (OTP flow + Account view),
      `Onboarding.tsx`'s copy bank + CTA labels, `screens-trust.tsx`. Catalogs
      at `apps/web/app/i18n/locales/en/*.json`, English-only — see
      `docs/i18n.md`. Supersedes the old CF-22 `i18n/t.ts`/`messages.ts`
      scaffold (deleted; see ADR 034's updated "i18n seam status"). RTL wiring
      (`<html dir>`) predates this and is unchanged — still unverified against
      a real RTL language since none ships yet. **Still open:** the remaining
      customer-facing tranches (`MobileHome.tsx`, the other onboarding screens,
      `OnboardingDesktop.tsx`'s own OTP-capture copy, gift-card detail,
      purchase flow, orders, settings), and actual non-English translations —
      both gated on the 🧭 language-set decision (which language(s) to ship).
      Watch `scripts/check-bundle-budget.sh`'s `MAX_SSR_KB` — this tranche used
      56 of the prior 60 KB headroom (3296/3300 KB); the next web PR that adds
      client bytes may need to raise it (documented escape hatch in that
      script).

---

## Tier 9 — Accepted risks to revisit at launch (deliberate; don't "fix" blindly)

- [ ] **X-1 · Verify-OTP targeted-lockout** → add CAPTCHA / progressive backoff at public launch (B5). `[code]`. (Keep the lockout-before-compare ordering.)
- [ ] **X-2 · Advisory security scans** (gitleaks/trivy/npm-audit) → make **required** at launch. `[operator]`.
- [ ] **X-3 · Branch-protection (C9)** → flip `enforce_admins` + required checks at production (see T0-3). `[operator]` — owner-deferred.
- [ ] **X-4 · Mobile security deferrals** (SSL pinning, App Attest/Play Integrity, jailbreak-root, binary-tamper) — ADR 027 per-control triggers; re-check at each. `[code]`.
- [ ] **X-5 · Non-revocable 15-min access tokens** — keep (accepted per threat-model); listed for completeness only.

---

## Tier 10 — Running-app UX (needs a full pass)

### U-1 · Full customer-journey UX/visual pass `[code]` assessment

- [x] **Status:** ✅ Done 2026-07-09 — findings doc at `docs/ux-pass-2026-07-09.md`;
      9 findings (0 P0 / 2 P1 / 7 P2), concrete P1 bugs filed as U-2 and U-3
      below (P2s stay documented in the findings doc only, per its own
      severity rubric). Pass covered Home/Directory/Map/Search/Merchant
      detail/Onboarding/Auth/Purchase-to-payment-wall/Order history +
      redemption/Settings/404, at desktop (1440×900) + mobile (390×844),
      against both the live beta (read-only browse) and the local mocked
      stack (interactive auth/purchase/orders walk).
      **Do:** systematically walk, on desktop **and** a mobile viewport, screenshotting + noting every broken / empty / loading / error state:
- Home (hero, featured cards, footer) · Directory / brand grid · Map view (clustering, markers, empty-region) · Search (results, no-results, debounce feel) · Merchant/gift-card detail (imagery, denominations, price display) · Onboarding flow · Auth (email-OTP screen, wrong-OTP error, resend) · Purchase flow to the payment wall (amount select, payment step, countdown, expiry) · Order history + redemption reveal · Settings/privacy · 404/error routes.
- Check: responsive layout, image loading, focus/keyboard (ties to B-2), copy consistency, currency/locale display per country, loading skeletons vs blank flashes.
  **Done when:** a written UX findings list exists with severities; concrete bugs (like T0-2) are filed as their own items.

### U-2 · Onboarding marketing copy unconditionally promises Phase-2 cashback `[code]` (small)

- [x] **Status:** ✅ Done 2026-07-09 (PR #1595) — `getOnboardingCopy(phase1Only)`
      in `apps/web/app/components/features/onboarding/Onboarding.tsx` overlays
      Phase-1 (discount-framed) copy onto `COPY[1]`/`COPY[2]`/`COPY[3]`; both
      `Onboarding.tsx` (native/mobile) and `OnboardingDesktop.tsx` (web
      `SlidePanel`) call it instead of referencing `COPY` directly, so they
      can't drift apart again. Also threaded a `phase1Only` prop into
      `TrustWelcome`/`TrustHowItWorks` (`screens-trust.tsx`) for the two
      hardcoded (non-`copy`-sourced) strings the audit called out by name —
      the "Total cashback $2,847.00" receipt card (→ "Total saved") and the
      "Cashback lands in your bank" how-it-works step (→ "Your discount
      applies instantly"). Tests:
      `apps/web/app/components/features/onboarding/__tests__/onboarding-phase1-copy.test.tsx`
      asserts both phases on both surfaces; the existing a11y/skip-nav
      onboarding tests stay green unmodified.

**Why:** The onboarding slideshow's first screen (both the native
multi-screen `Onboarding.tsx` and the web `/onboarding` split-layout
`OnboardingDesktop.tsx`, which share the same `COPY`/`TrustWelcome`)
unconditionally shows a mocked "TOTAL CASHBACK $2,847.00" card under
"Shop. Save. Repeat." with the subcopy "earn cashback on every purchase,
paid by instant bank transfer" — Phase-2 language shown to every
brand-new sign-up on a Phase-1 (discount-gift-card) build. This is
inconsistent with `home.tsx`, which correctly branches its hero copy on
`config.phase1Only` (`apps/web/app/routes/home.tsx:64,73,143,146,160,240`).
Reproduced live on `beta.loopfinance.io/onboarding` and confirmed in code:
`Onboarding.tsx`'s existing `phase1Only` skip effect
(`Onboarding.tsx:354-359`) only skips the currency-picker (step 5) and
wallet-intro (step 7) steps — it never touches the trust-screen copy
(`COPY[1]`/`COPY[2]`/`COPY[3]`, steps 0-2), and `OnboardingDesktop.tsx`'s
`SlidePanel` doesn't reference `phase1Only` at all.

**Do:** branch `COPY[1]` / `COPY[2]` / `COPY[3]` (or the
`TrustWelcome`/`TrustHowItWorks`/`TrustMerchants` screens themselves) on
`phase1Only`, reusing the Phase-1 vs Phase-2 copy split `home.tsx`
already has ("save up to X% instantly" vs. "earn cashback… paid by
instant bank transfer"). Applies to both `Onboarding.tsx` (native) and
`OnboardingDesktop.tsx` (web) since they share the same `COPY` object and
trust-screen components.

**Done when:** a Phase-1 build (`LOOP_PHASE_1_ONLY=true`) shows
discount-flavoured onboarding copy with no cashback/bank-transfer
promises, on both native and web onboarding; `npm run verify` green.

### U-3 · `/calculator` is reachable in Phase 1 and shows a misleading empty state `[code]` (small)

- [x] **Status:** ✅ Done 2026-07-09 (PR #1595) — `apps/web/app/routes/calculator.tsx`
      now wraps its body in the same `Phase2Gate` `/cashback` uses (default
      export renders `<Phase2Gate><CalculatorRouteBody /></Phase2Gate>`), so
      `LOOP_PHASE_1_ONLY=true` shows the identical "Coming soon" panel
      instead of the live LOOP-stablecoin copy + misleading "No merchants
      available right now" empty state. Also fixed UX-03 (bundled per its
      own note — same file): `<main>` now takes `pt-20` so the H1 clears the
      fixed Navbar, matching `brand.$slug.tsx`'s existing offset. Verified no
      navbar/footer link exists to `/calculator` (grepped — none found) so
      there was no nav-link gating to match; the sitemap still lists
      `/calculator` unconditionally, consistent with how it already lists
      the equally-gated `/cashback` and `/trustlines`. Tests:
      `apps/web/app/routes/__tests__/calculator.test.tsx` adds a
      `<CalculatorRoute /> Phase-1 gate` block asserting the gate renders
      (and skips the merchants fetch) when `phase1Only` is true, and the
      real page renders when false.

**Why:** `/cashback` correctly Phase-1-gates with a clean "Coming soon —
this part of Loop is under construction" screen. `/calculator`
(`apps/web/app/routes/calculator.tsx`) has no equivalent
`phase1Only`/`Phase2Gate` check — it renders live with the heading
"Cashback calculator" and subcopy "Pick a merchant and see what you'd
earn on Loop — paid in LOOP-asset stablecoin you can spend on your next
order," followed by "No merchants available right now. Check back
shortly." A Phase-1 user who reaches this page (it's linked from the
merchant-detail footer nav) gets a broken-looking dead end instead of the
same clear "coming soon" messaging `/cashback` already has. Separately
(UX-03, bundle into the same PR since it's the same file): the page's H1
renders with its top ~15px clipped under the fixed navbar on load —
other routes account for the navbar's height with top padding and this
one appears to be missing it.

**Do:** wrap `/calculator` in the same `Phase2Gate` (or equivalent
`phase1Only` redirect/coming-soon render) `/cashback` uses; add the
standard top-padding offset so the H1 clears the fixed navbar.

**Done when:** `/calculator` shows the same Phase-1 "coming soon" gate as
`/cashback` when `LOOP_PHASE_1_ONLY=true`, and its heading is fully
visible (not clipped) on load; `npm run verify` green.

---

## Tier 11 — Deliberate deferrals (ADR 005 — tracked, not urgent)

Each is documented + accepted in `docs/adr/005-known-limitations.md` with a revisit trigger. Listed so they're not "rediscovered" as gaps:

- [ ] Barcode gift-card redemption (until a barcode-primary merchant lands) · eslint-plugin-react re-add (ESLint-10 compat) · image-proxy DNS-rebinding TOCTOU (mitigated by `IMAGE_PROXY_ALLOWED_HOSTS`) · circuit-breaker probe cooperation · manual proto generation · web vitest env default · no metrics exporter integration · Google Fonts / CARTO third-party (needs EU privacy disclosure) · upstream token transport (largely superseded by native auth).

---

## Tier 12 — Phase 2 (wallet / cashback / yield — ADR 030/031, gated on Privy DD)

> Detailed design lives in `docs/adr/030-integrated-wallet-via-privy.md` + `031-per-currency-yield-architecture.md`. Do **not** flip any cashback-mode flag in prod until the rebase chain + CF-01 land.

- [ ] Privy integration (RS256 JWT + JWKS, Custom Auth Provider, `stellar_address` webhook) · LOOPUSD + LOOPEUR DeFindex vaults (**vault-contract audit is critical-path**) · GBPLOOP nightly on-chain mint cron · treasury spread management · past-30-day APY compute + display · USDLOOP/EURLOOP retire.
- [ ] Privy/dfns **Soroban due-diligence** (external, critical-path) · multi-jurisdictional **regulatory review** (4–6 wks counsel).
- [ ] Rebase chain (order matters): **W-05** (rebase 6 wallet branches + `fix/adr036-emission-burn` onto current `main`) → **CF-05** (mint only GBPLOOP; retire USDLOOP/EURLOOP mint codes) → **CF-32** (Privy auth header / webhook / APY-labelled-as-APR copy fix + disclaimer / gate `WalletCard` behind `LOOP_PHASE_1_ONLY`) → **CF-01** (merge the burn fix; verify it closes the CF-17 drift-equation gap; resolve deposit==operator co-location). `needs-operator.md` §3.
- [ ] ⚠️ **LIVE-RISK:** `loop_asset` is a fully-wired, **unflagged** payment method — only a client-side UI hardcode stops a direct API caller. **Gut-check no environment runs `LOOP_WORKERS_ENABLED=true` with real LOOP balances before Tranche-2.**
- [ ] Auth upgrades · push (M-2) · Capacitor OTA live-update · deep linking (M-3).

---

## Tier 13 — Phase 3 (growth — Tranche 3 contract)

`docs/roadmap.md` §Tranche 3.

- [ ] Plaid open-banking rails (2–3 mo) · virtual cashback Visa/MC (BIN sponsor + KYC, 4–6 mo) · mainnet launch (audits + UK FCA EMI + per-jurisdiction posture) · four-country launch (US/UK/EU/CA).
- [ ] MapLibre GL swap (from Leaflet) · server-side merchant search (ties to S4-7) · referral program · privacy-respecting analytics · Core Web Vitals monitoring · WCAG 2.1 AA audit (ties to B-2).

---

## Tier 14 — Smaller backlog

- [ ] **Thin-currency promotion cadence** (ADR 035) — ~20 catalogue-only currencies below the 15-merchant threshold; promoting one is a one-line `packages/shared/src/countries.ts` addition. Define a review cadence (e.g. quarterly with the supplier sweep).
- [ ] **Multi-home-currency per user** — schema supports the composite key; UX not built.
- [ ] **Audit Wave 10** (operator-tooling TOOL-01/02) + the **~80-item P2/P3 quality tail** (doc-index gaps, OpenAPI drift cleanup, test-vacuity, shared-package DRY) — `needs-operator.md`.
- [ ] **D1 OpenAPI-from-Zod tail** — migrate the remaining `openapi/*` modules to derive from handler Zod schemas (pattern proven on the auth module this session; see `openapi-zod.ts` + `openapi-derivation.test.ts`).
- [ ] **Refund-order path** — on-chain refund of a paid-but-not-fulfilled order to the payer (the sibling to A6's refund-payment; scoped to paid-not-fulfilled; awaiting owner green-light). ⚠️ Money-review; must be one-time-use + not double-refund with T0-1/R3-2/R3-4.

---

## Change log

- **2026-07-03** — created; consolidates the outstanding-work inventory + the nine-lens readiness investigation + the verified P0 stranded-deposit bug + the running-app pass.
- **2026-07-09** — U-1 (full customer-journey UX/visual pass) closed; findings doc `docs/ux-pass-2026-07-09.md`; U-2 and U-3 added for the two P1 findings.
- **2026-07-09** (PR #1596) — the findings doc's remaining mechanical P2s (UX-05 search a11y, UX-06 search no-results state, UX-07 onboarding OTP resend, UX-08 locale-aware map center, UX-09 anonymous-visitor greeting) fixed; none were filed as their own Tier 10 items (documented-only per the findings doc's severity rubric), so there's no checkbox here to flip — see `docs/ux-pass-2026-07-09.md`'s per-finding "Fixed" notes. UX-04 (unpaginated home merchant grid) stays open, deliberately out of scope (pagination/virtualization project).
