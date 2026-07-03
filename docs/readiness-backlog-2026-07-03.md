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

- [ ] **Status:** ☐ Not started

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

- [ ] **Status:** ☐ Not started

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

- [ ] **Status:** ☐ Not started
      **Why:** The `redemption-backfill` worker shipped and runs in prod, but the original symptom (fulfilled order with `redeem_code/pin/url` all null) has not been re-smoke-tested since the fix. Must be green before public order traffic. `docs/roadmap.md` orphaned-work + CTX-R2.
      **Do:** run one real fulfilled order (`scripts/e2e-real.mjs` or the `e2e-real.yml` workflow — Aerie $0.02) and confirm the redemption fields populate directly or via the backfill sweep. Also fix the related `Body has already been read` polling-fallback bug (grep for the double-`.json()`/`.text()` read in the redemption polling path). Add this assertion to the Tranche-1 acceptance checklist.
      **Done when:** a real order fulfils with non-null redemption fields; the polling-fallback bug is fixed + tested.

### C2-2 · Apple Sign-In native rework (CF-27) `[operator decision]`→`[code]`

- [ ] **Status:** ☐ Blocked on owner decision
      **Why:** Dead on iOS/Android — `AppleSignInButton.tsx:113` sets `redirectURI: window.location.origin` → `capacitor://localhost`, which Apple can't register, so the flow fails server-side; the button is a silent no-op. Native users are effectively email-OTP-only. `needs-operator.md` §1.
      **Do:** owner picks **(a)** a backend-hosted HTTPS callback (`https://api.loopfinance.io/auth/apple/callback`) that bridges back via a universal link/custom scheme (no new dep; uses `@capgo/inappbrowser`), or **(b)** a native plugin (new dep → ADR). **(a) requires deep-linking (M-3) to exist first.** Not strictly launch-blocking (OTP works).
      **Done when:** native Apple Sign-In completes on a real device, or the owner explicitly accepts OTP-only on native for launch (record it).

---

## Tier 3 — Reliability & correctness follow-ups (before real-money volume)

> Most are `[code]` on the money/upstream paths → **all money items need review (guardrail #3).**

### R3-1 · Operator XLM/USDC float reconciliation `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** The only automated reconciliations are mirror=ledger (INV-1) and on-chain-LOOP-vs-mirror (INV-4). **Neither covers the operator/deposit wallet** through which every real deposit dollar flows (deposits in, CTX settlements out, refunds out, fees). No aggregate "deposits-for-paid-orders ≈ CTX-paid + refunds + fees + float" check. Money-P2-1.
      **Do:** add a scheduled reconciliation (model on `asset-drift-watcher.ts` / `ledger-invariant-watcher.ts`, `withAdvisoryLock` single-flight, persist state, page on breach) that sums the operator wallet's inbound/outbound (Horizon) against the recorded deposits/settlements/refunds and alerts on drift beyond a threshold. Surface it on the Treasury admin page.
      **⚠️** Money-review; it's a _detection_ addition (no writes) but its threshold logic must not false-page on normal float.
      **Done when:** a watcher computes operator-float conservation daily and alerts on drift; visible on Treasury.

### R3-2 · Auto-refund delivers the wrong asset in Phase-1 `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `credits/refunds.ts:118-137` `applyOrderAutoRefund` credits `user_credits` (mirror LOOP) by `chargeMinor` with **no `payment_method` branch**. For an xlm/usdc payer that mints an invisible/unspendable balance under `LOOP_PHASE_1_ONLY` instead of returning their on-chain funds; for a loop_asset payer (tokens already burned at `markOrderPaid`) it pushes mirror > chain → negative drift page. Money-P2-2.
      **Do:** branch the refund by `orders.payment_method`: xlm/usdc → on-chain refund to sender (reuse the A6 `refundDeposit`/`submitPayout` machinery); loop_asset → re-mint/re-credit consistently with the burn; credit-method → mirror credit (current behaviour, correct). Coordinate with T0-1 (same "return what they paid, in what they paid" principle).
      **⚠️** Money-review. Must remain idempotent (auto-refund already has a partial-unique-index guard — don't break it). Don't create a double-refund with the A5 procurement-crash path.
      **Done when:** each payment method's failed order refunds in the same asset it was paid; integration test per method; money-review posted.

### R3-3 · CTX: warm-start the merchant/location catalog from Postgres `[code]`

- [ ] **Status:** ☐ Not started
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

- [ ] **Status:** ☐ Not started
      **Why:** Procurement pays CTX the amount from CTX's own SEP-7 URI (`procure-one.ts:287-299` → `pay-ctx.ts`) with **no upper-band check** against expected wholesale cost. A CTX mispricing or a spike between browse and settle makes Loop overpay from the operator wallet (user is protected — they paid the pinned face value; Loop's treasury eats it). CTX-R4.
      **Do:** before submitting the CTX payment, assert the amount is within a sane band of the expected wholesale (e.g. ≤ face value × a configurable ceiling, and ≥ a floor). On breach: fail the order + auto-refund + page, don't pay.
      **⚠️** Money-review. Don't reject legitimate FX movement — set the band from real spread data + a margin; make it a boot-configured constant.
      **Done when:** an out-of-band CTX quote fails-safe (refund + page) instead of silently overpaying; test with a mocked inflated URI.

### R3-6 · CTX: page the drift channel on money-path contract drift `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `notifyCtxSchemaDrift` fires for browse/auth surfaces, but the two money-critical operator-pool responses — `POST /gift-cards` (`procure-one.ts:259-267`) and `GET /gift-cards/:id` (`procurement-redemption.ts:77-83`) — **only log** on Zod failure. So "CTX changed their schema on the money path" has no dedicated signal. CTX-R5.
      **Do:** wire both Zod-failure branches to `notifyCtxSchemaDrift` (behaviour is already fail-safe; this just adds the alert). Confirm `ctx-contract.test.ts` still covers the fixtures.
      **Done when:** a simulated schema change on either money-path response fires a drift page.

### R3-7 · Pin production to native auth at boot `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `LOOP_AUTH_NATIVE_ENABLED` schema default is `false` (`env/sections/auth.ts:90`). An unset flag on a new prod deploy silently reverts auth to the **CTX-coupled** legacy path → a CTX outage becomes a total login outage. CTX-R3.
      **Do:** add a boot assertion in `env.ts` (or a `parseEnv` cross-check) that in `NODE_ENV=production`, `LOOP_AUTH_NATIVE_ENABLED` must be `true` unless an explicit `DISABLE_...` escape is set (mirror the existing prod boot-fail guards, e.g. the step-up-key one). Update `.env.example` + docs.
      **Done when:** a production boot with native auth off fails fast with a clear error (unless deliberately overridden).

### R3-8 · Align admin step-up OTP with the B5 per-email lockout `[code]`

- [ ] **Status:** ☐ Not started
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

- [ ] **Status:** ☐ Not started
      **Why:** Order create only dedups when the client sends `Idempotency-Key` (`orders/loop-handler.ts:179-201`). Without it, a double-submitted **credit**-method order writes two orders + two `user_credits` debits — a double-charge of the user's own balance. Money-P2-3.
      **Do:** derive a server-side idempotency key (e.g. `userId+merchant+denomination+minute` bucket, or require the header) so a double-click can't double-debit. Prefer requiring the header from the web client + a short server-side dedup window.
      **⚠️** Money-review.
      **Done when:** a double-submitted credit-method order creates one order/one debit; test.

### R3-11 · Note/accelerate the legacy-order-path ownership gap `[code]`/doc

- [ ] **Status:** ☐ Not started
      **Why:** `orders/get-handler.ts` + `list-handler.ts` do **no local ownership check** — IDOR defense is fully delegated to CTX bearer-scoping + UUID unguessability (contrast the loop-native path which pins `and(eq(id), eq(userId))`). Not exploitable from Loop's code; it's an upstream trust assumption. Authz-F1.
      **Do:** document the trust boundary explicitly in the handler, and prioritise ADR-039 legacy-path retirement (which removes this path entirely). No urgent code change while the path is being retired.
      **Done when:** the assumption is documented and the retirement criteria (ADR-039) are being tracked.

### R3-12 · Guard the step-up middleware CTX fail-open `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `auth/admin-step-up-middleware.ts:84-86` allows `auth.kind === 'ctx'` through. Safe only because every step-up route currently sits behind a loop-anchored `requireStaff` that 401s a `ctx` bearer first. If a future `requireAdminStepUp(...)` is mounted without a preceding staff gate, an unverified CTX bearer sails through with no staff check. Authz-F3.
      **Do:** make the CTX branch fail-closed (reject) rather than allow, or add an assertion that a staff gate ran. Verify no legitimate flow relies on the exemption.
      **⚠️** Auth-review.
      **Done when:** the exemption can't act as a standalone gate; `staff-route-gating.test.ts` still green.

### R3-13 · Origin-check the redemption WebView postMessage `[code]`

- [ ] **Status:** ☐ Not started
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

- [ ] **Status:** ☐ Not started
      **Why:** `wallet/provisioning.ts:405-511` has **no** advisory lock / `SKIP LOCKED` / in-flight guard (unlike every other worker). At 2 machines both pick the same oldest users and both submit a sponsored activation tx from the shared operator account → `tx_bad_seq`/`op_already_exists`, burned fees, sequence thrash, false "stuck" pages. Correctness holds (CAS-fenced) but throughput halves. **Not in the risk register.** Scale-#3.
      **Do:** wrap the provisioning tick in `withAdvisoryLock` (the primitive from A8 already exists; copy the payout-worker pattern). A few lines.
      **⚠️** Bites the moment Phase-2 turns on. Money/Stellar-review the lock placement.
      **Done when:** two machines running the tick submit each activation once; test the race.

### S4-3 · Single-flight the interest-mint Horizon reads `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `credits/interest-mint.ts` isn't single-flighted → every machine does a Horizon trustline read per activated wallet each run (safe — DB-fenced against double-mint — but N× wasteful). Scale-#7.
      **Do:** wrap the tick in `withAdvisoryLock` (same pattern as S4-2).
      **Done when:** only one machine performs the mint sweep per run.

### S4-4 · Rate-limiter shared store (accuracy under auto-scale) `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** In-memory per-machine limiter divided by a _static_ `RATE_LIMIT_MACHINE_COUNT_ESTIMATE` (prod=2); `fly.toml` `auto_start_machines=true` makes limits wrong the moment real machine count diverges — too loose under exactly the spike you'd want them tight; the 10k-entry `rateLimitMap` also thrashes under high IP diversity. Wave 9 / Scale-#2 / ADR-005 #4.
      **Do:** interim (cheap) — pin `min`/`max` machines so the estimate stays accurate. Durable — a shared counter (Postgres or Redis; Redis needs an ADR as a new dep). Keep per-route keys (A4-001).
      **Done when:** per-IP limits are accurate regardless of machine count; documented.

### S4-5 · Raise the DB pool; plan PgBouncer `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `db/client.ts:57` `max: DATABASE_POOL_MAX` default **10** vs `fly.toml` `hard_limit=250` concurrency — a 25× admission gap; a spike of concurrent authed/admin work queues on 10 connections while CPU idles. Scale-#4.
      **Do:** raise `DATABASE_POOL_MAX` (mind Postgres `max_connections` = pool × machines). Plan PgBouncer for later. ⚠️ **PgBouncer transaction-mode disables session advisory locks** — `withAdvisoryLock` (payout/provisioning/interest/ledger single-flight) would silently degrade; the money path needs care/testing before that migration.
      **Done when:** pool sized to actual concurrency; PgBouncer risk documented for the money path.

### S4-6 · Bound the admin ledger-drift scan `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `admin/reconciliation.ts:74` → `credits/ledger-invariant.ts:141` runs an unbounded `GROUP BY` over **all** `credit_transactions` synchronously on the admin request path, holding a pool connection for a multi-second scan (`credit_transactions` grows ~1 row/user/night). Scale-#5.
      **Do:** quick — add a statement timeout + short cache to the admin call. Durable — incremental/materialised reconciliation. Bites ~10M+ rows.
      **Done when:** the admin call can't monopolise a connection with a full scan.

### S4-7 · Trim the client-side catalog fetch `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** `use-merchants.ts:65` → `/api/merchants/all` ships `description/instructions/terms` (each capped 50k chars) that no browse surface renders — ~0.5-1MB now, ~10-20MB at 34k merchants — JSON-parsed on the main thread + localStorage-seeded; the directory renders un-virtualized DOM cards; mobile search is undebounced. Scale-#6 (catalog size is operator-controlled).
      **Do (cheap→structural):** (1) a `fields=lite` server projection stripping the long text — biggest single win, few lines in `merchants/handler.ts`; (2) debounce mobile search; (3) virtualize the directory + add server-side search (later).
      **Done when:** the browse payload excludes unrendered long text; mobile search is debounced.

### S4-8 · Dedupe per-machine watchers/alerts `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** Non-single-flighted watchers (payment-watcher, asset-drift, redemption-backfill) run on every machine → N× Horizon/CTX reads; the cursor + stuck-payout Discord watchdogs gate on a per-process boolean → **N duplicate pages** at N machines. Scale-#7.
      **Do:** apply `withAdvisoryLock` (or a DB dedup) to the duplicated watchers/alerts. Location sync's doubled ~500-page CTX sweep is architectural (leave for later; cheap today).
      **Done when:** watchers run once per fleet per tick; no duplicate pages.

---

## Tier 5 — Admin / support tooling (make the dashboard self-sufficient)

> Backend money-writes are the best-tested thing in the repo; the gap is the **operator UI** and a few missing endpoints. Use `/add-endpoint` for any new endpoint; admin routes need `requireStaff` + (for writes) `requireAdminStepUp`.

### A5-1 · Order re-drive lever (biggest hole) `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** A stuck `paid`/`procuring` order has **no** operator action — no requeue/reprocure/manual-fulfill/cancel. Resolution relies on the worker eventually retrying, else raw SQL/kill-switch.
      **Do:** add admin endpoint(s) + UI to re-drive a stuck order: re-enqueue procurement, or (with step-up + reason + audit) mark for retry/cancel-and-refund. Reuse the procurement worker path; don't duplicate its money logic.
      **⚠️** Money-review — a re-drive must be idempotent (can't double-procure/double-pay CTX; the `ctx_settlements` guard must hold).
      **Done when:** an operator can unstick a paid/procuring order from `/admin/orders/:id` without SQL; test.

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

- [ ] **Status:** ☐ Not started — it's mocked in every unit test; add real assertions for the settlement-idempotency logic (the ADR-038 durable double-pay guard). Move a slice into the counted unit suite so it's gated (see T0-3).

### Q6-2 · Raise counted coverage on money/auth workers `[code]`

- [ ] **Status:** ☐ Not started — `payout-worker.ts` (42%), `ledger-invariant-watcher.ts` (50%), `payout-submit.ts` (61%), `otp-attempt-counter.ts` (22%). Either add unit tests or promote a slice of their integration coverage into the counted suite.

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

- [ ] **Status:** ☐ Not started
      **Why:** Dead scaffolding — `notifications.ts` creates channels but **nothing** calls `PushNotifications.register()`, requests permission, or listens; no device-token upload, no APNs/FCM backend send. "Your gift card is ready" can't fire.
      **Do:** decide in-or-out. In → wire register/permission/listeners + a backend send path + token storage. Out → remove the channel scaffolding so the code is honest. ⚠️ APNs needs the push entitlement (currently unhandled by the overlay script — see M-4).
      **Done when:** push either works end-to-end or is removed; no dead channels.

### M-3 · Deep linking (entirely absent) `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** No `App.addListener('appUrlOpen')`, no applinks/`associated-domains` entitlement, no Android intent-filters. Blocks the CF-27 Apple fix (C2-2), app-open from email/order links, and the SEP-7 wallet return path.
      **Do:** add `@capacitor/app` `appUrlOpen` handling + universal-links (iOS `associated-domains`) + Android `intent-filter`s in the native overlays; route incoming URLs to the right screen.
      **Done when:** an `https://loopfinance.io/...` link opens the app to the right screen on both platforms.

### M-4 · CI/checklist guard for operator-once overlay steps `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** A bare `cap sync` (without `apply-native-overlays.sh`) silently drops **all** overlays; and several store-critical steps aren't enforced by the script _or_ CI: the iOS `.pbxproj` `baseConfigurationReference` → `release.xcconfig`, `PrivacyInfo.xcprivacy` Copy-Bundle-Resources membership, and the (unhandled) APNs entitlement. These regress invisibly on a clean regeneration.
      **Do:** add a `mobile:sync` wrapper guard / CI check that fails if overlays are missing after sync; extend `apply-native-overlays.sh` to assert (fail-loud) the pbxproj xcconfig ref + PrivacyInfo membership; handle the push entitlement if M-2 lands.
      **Done when:** a native regeneration that drops an overlay fails loudly.

### M-5 · Add `@capacitor/app` lifecycle handling `[code]`

- [ ] **Status:** ☐ Not started — no foreground/background `appStateChange` handling beyond the Android back button (e.g. for refreshing on resume, re-locking). Add as part of M-3's `@capacitor/app` wiring.

---

## Tier 8 — Blind-spot categories (never on the board)

### B-1 · Load / stress / soak testing (absent) `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** Zero capacity evidence for a payment system on a single 512MB/1-cpu VM (`fly.toml`). You don't know the breaking point or autoscale behaviour. Compounds S4-4 (per-machine rate limits).
      **Do:** add a k6 (or artillery) suite hitting the hot paths (browse, order-create, auth) at increasing concurrency; run it against staging (see below) or a scratch deploy; record the breaking point + autoscale behaviour. New tool → note it in docs (k6 is a binary, not an npm dep, so no ADR needed, but document how to run).
      **Done when:** there's a documented capacity number + autoscale behaviour for the hot paths.

### B-2 · Accessibility (absent, + EU legal exposure) `[code]`

- [ ] **Status:** ☐ Not started
      **Why:** No axe/jsx-a11y/pa11y/keyboard tests. Consumer finance app targeting the Eurozone — the **European Accessibility Act** mandates accessibility for e-commerce/banking there. Compliance, not nice-to-have.
      **Do:** add `eslint-plugin-jsx-a11y` (lint gate) + `axe`/`jest-axe` on key routes; do a keyboard + screen-reader pass on onboarding/purchase/wallet; fix the findings. (New devDeps → ADR per policy, but a11y tooling is low-controversy.)
      **Done when:** a11y lint + automated checks gate CI on the core routes; a manual audit is recorded.

### B-3 · User-level fraud/abuse controls (absent) `[code]`

- [ ] **Status:** ☐ Not started — no velocity limits, duplicate-account detection, or chargeback handling (`loop-create-checks.ts` only does a balance + first-order check). Pairs with L1-1. Add per-user order/day + per-device caps, dup-account signals, and a chargeback/dispute flow. ⚠️ Money + abuse-model review.

### B-4 · DR: PITR + offsite backup `[operator]`+`[code]`

- [ ] **Status:** ☐ Not started
      **Why:** 24h RPO (Fly daily snapshot) on the money ledger; **all** backups inside Fly → a vendor/account compromise is total data loss (the DR runbook's own "whole-environment compromise" case can't restore what only lived in the compromised vendor). `docs/runbooks/disaster-recovery.md` is otherwise strong.
      **Do:** enable Postgres PITR; add a scheduled cross-cloud `pg_dump` (e.g. to S3/GCS/B2) with a tested restore. `[operator]` for the vendor/bucket, `[code]` for the job + runbook update.
      **Done when:** PITR is on + an offsite backup exists with a rehearsed restore.

### B-5 · Observability depth `[code]`+`[operator]`

- [ ] **Status:** ☐ Not started
      **Why:** No distributed tracing (a multi-worker money incident = grep-by-request-id); alerting is Discord-webhook-only (no paging/escalation — a missed message is a missed page, `docs/alerting.md`); SLOs are defined (`docs/slo.md`) but nothing computes burn-rate or alerts.
      **Do:** add OpenTelemetry tracing across the order→payment-watcher→procurement→payout chain; add a paging tier (PagerDuty/Twilio) for P0 signals (payout-failed, over-mint drift); wire burn-rate alerts to the SLOs. `[operator]` for the paging vendor.
      **Done when:** a money incident is traceable end-to-end and a P0 alert actually pages a human.

### B-6 · i18n is English-only behind a good scaffold `[code]` (large)

- [ ] **Status:** ☐ Not started — `SUPPORTED_LANGS=['en']` (`packages/shared/src/countries.ts:49`), copy hardcoded in JSX, no i18n framework, RTL unconsidered despite AE/SA. Routing/formatting scaffold is excellent; a second language is a from-scratch build. Scope: pick a framework (i18next/formatjs → ADR), extract copy to catalogs, add RTL. Large; only if a second-language market is prioritised.

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

- [ ] **Status:** ☐ In progress (only home + one product page checked; T0-2 brand-imagery is the first finding)
      **Do:** systematically walk, on desktop **and** a mobile viewport, screenshotting + noting every broken / empty / loading / error state:
- Home (hero, featured cards, footer) · Directory / brand grid · Map view (clustering, markers, empty-region) · Search (results, no-results, debounce feel) · Merchant/gift-card detail (imagery, denominations, price display) · Onboarding flow · Auth (email-OTP screen, wrong-OTP error, resend) · Purchase flow to the payment wall (amount select, payment step, countdown, expiry) · Order history + redemption reveal · Settings/privacy · 404/error routes.
- Check: responsive layout, image loading, focus/keyboard (ties to B-2), copy consistency, currency/locale display per country, loading skeletons vs blank flashes.
  **Done when:** a written UX findings list exists with severities; concrete bugs (like T0-2) are filed as their own items.

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
