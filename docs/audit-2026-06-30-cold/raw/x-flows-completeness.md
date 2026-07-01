# Sweep: Flows + completeness — raw findings

**Method.** Read all 20 vertical raw reports in full (via 5 parallel digest
agents, cross-checked against direct source reads), the 06-30 checklist, the
06-15 checklist Part 3/Part 5, and the 06-15 findings.md (for CF-number
context). Then traced the 10 named flows end-to-end in current `main` source
(reading actual files at every hop, not vertical summaries), looking
specifically for seam bugs invisible to a single-vertical read. Where a
vertical's raw report already covered a flow defect in isolation, I do not
re-file it as a new finding unless tracing the full chain surfaced a
materially different/sharper conclusion (noted inline). One direct factual
conflict between two vertical reports is resolved below with evidence
(XFC-03).

---

## Flow-by-flow trace notes

### 1. Purchase (discount): web → /api/orders(loop) → order row → inbound watcher → paid → procureOne → CTX create → pay-ctx → redemption → fulfilled → web poll → barcode

Hops read: `apps/web/app/components/features/purchase/PurchaseContainer.tsx`
→ `apps/web/app/services/orders-loop.ts` → `orders/loop-handler.ts` →
`orders/repo.ts` (`createOrder`) → `payments/watcher.ts`
(`runPaymentWatcherTick` → `processPayment` → `markOrderPaid`) →
`orders/transitions.ts` → `orders/procure-one.ts` → `orders/pay-ctx.ts` →
`orders/procurement-redemption.ts` (`waitForRedemption`) →
`orders/fulfillment.ts` (`markOrderFulfilled`) → `orders/loop-read-handlers.ts`
→ web `LoopPaymentStep.tsx`/`RedeemFlow.tsx`.

This is the most heavily hardened flow in the delta (12 of the 22 commits
touch it). CF-12/13/18/20/28 all verified fixed at the code level by direct
read — `procureOne` correctly distinguishes 429/pool-unavailable (revert to
`paid`, retry) from genuine failure (`markOrderFailed` + `autoRefundAfterCtxPaid`
when `ctxPaid===true`), and `pay-ctx.ts`'s idempotency reconciliation
fail-closes on an amount/asset mismatch rather than silently treating a memo
collision as "already paid." No new seam bug found in the happy-path chain
itself. Two residual items, both already filed by `v-orders.md`/`v-ctx.md`
and re-confirmed true by direct read, not re-filed here: (a) ORD-001 —
`procure-one.ts`'s catch around `payCtxOrder` treats `PayoutSubmitError(kind=
'transient_horizon')` (the SDK's own contract: ambiguous, retry-safe) the same
as a terminal failure, discarding the one piece of information (CF-18's
authoritative tx-hash class) that would let a retry distinguish "actually
unpaid" from "ambiguous, check Horizon first"; (b) CTX-01 — the operator
circuit breaker can never self-heal because `pickHealthyOperator` filters out
`state==='open'` operators before calling `.fetch()` again, but the only
OPEN→HALF_OPEN transition lives inside `.fetch()` — once CF-13's `forceOpen()`
fires on a single 401, that operator is permanently stranded for the process
lifetime (this is a real regression-by-effect: pre-CF-13 it took 5 consecutive
failures to open a breaker permanently; post-CF-13 it takes exactly 1 bad 401).

### 2. Cashback emission: fulfillment → credit_transactions(cashback) + user_credits + pending_payouts → payout worker → Stellar mint → drift watcher

Hops read: `orders/fulfillment.ts` → `credits/payout-builder.ts` →
`payments/payout-worker.ts` → `credits/pending-payouts.ts` →
`payments/payout-worker-pay-one.ts` → `payments/payout-submit.ts` →
`payments/asset-drift-watcher.ts`.

Two findings here, both load-bearing for Tranche-2 readiness:

- **XFC-03** — resolves a direct contradiction between this round's
  `v-payments.md` (V3-02, "lock released before claim begins, P1 defect") and
  `v-credits.md` ("fully closed, no new issue found") about the same function,
  `credits/pending-payouts.ts:listClaimablePayouts`. Verified by reading
  `db/client.ts` + the call site: the `SELECT ... FOR UPDATE SKIP LOCKED` is a
  bare `db.select()` **not** wrapped in `db.transaction()`. A single statement
  issued outside an explicit `BEGIN` runs in its own implicit, single-statement
  transaction that **commits as soon as the statement completes** — so the row
  lock is gone before `runPayoutTick` even receives the `rows` array, let alone
  before it starts the slow per-row work (Horizon trustline read, idempotency
  scan, `markPayoutSubmitted`). `v-payments.md` is correct.
- **XFC-04** — confirms CF-01 (redemption-burn conservation gap) is still
  open on `main`, traced end-to-end rather than by file inspection alone: see
  Findings below for the full chain and the concrete "same coins recirculate"
  framing that neither `v-credits.md`'s P1-01 nor `v-wallet.md`'s W-07 stated
  explicitly.

`fulfillment.ts`'s CF-16 peg-break fix (durable `pending_payouts` row in the
order's `chargeCurrency`) reads correctly — traced the full transaction body,
confirms the `onConflictDoNothing({target: pendingPayouts.orderId})` makes the
row write idempotent against a re-run.

### 3. Withdrawal: admin/user → withdrawal writer → debit + pending_payout(withdrawal) → payout worker → Stellar → compensation on fail

Hops read: `credits/withdrawals.ts` → `credits/pending-payouts.ts` →
`payments/payout-worker-pay-one.ts` (`handleSubmitError` →
`autoCompensateFailedWithdrawal`) → `credits/payout-compensation.ts`.

`applyAdminWithdrawal`'s two-row write (queue payout + debit ledger, same txn,
`SELECT...FOR UPDATE` on the balance row first) is correct and matches the
ADR-024 §3 contract. `v-credits.md`'s V4-01 (compensation can double-pay when
the exhausted-attempts path hits an _ambiguous_ `transient_horizon`
classification without first checking `getOutboundPaymentByTxHash` on the
just-stamped hash) is real — verified the call chain in
`payout-worker-pay-one.ts:296-420` — and is the sharpest P1 in this flow; not
re-filed, already fully evidenced there. `LOOP_KILL_WITHDRAWALS` is read once
per payout-worker tick (confirmed `isKilled('withdrawals')` in
`payout-worker.ts:129`) and correctly scoped to `kind==='withdrawal'` rows
only — CF-15 holds.

### 4. Auth: request-otp → email → verify-otp → JWT → requireAuth on every protected route → refresh rotation → social linking

Hops read: `auth/native-request-otp.ts` → `auth/email.ts` → `auth/otps.ts` →
`auth/native.ts` → `auth/issue-token-pair.ts` → `auth/require-auth.ts` →
`auth/require-admin.ts` → `auth/identities.ts` (social linking + admin grant).

CF-30 (native auth had no admin-grant path) is genuinely fixed: traced
`db/users.ts:isAdminEmail` → `auth/identities.ts:reconcileAdmin`, which
re-syncs `users.is_admin` against the `ADMIN_EMAILS` allowlist on every login
(not just first-create), so an operator can promote/demote by editing the env
var and the next login picks it up. `requireAuth`/`requireAdmin` correctly
restrict admin decisions to `auth.kind==='loop'` (cryptographically verified)
contexts only. AUTH-01 (`v-auth.md`: the OTP attempt-counter bumps the single
newest live row for an email with no `codeHash` predicate, so a "decoy" OTP
request absorbs the attempt budget meant for a concurrently-live legitimate
code) is real and the sharpest finding in this flow; not re-filed.

### 5. Catalog: CTX sync → in-memory store → public API → web (locale filter, grouping, eviction) → merchant detail → order

Hops read: `merchants/sync.ts` → `clustering/data-store.ts` →
`public/merchant.ts` / `public/top-cashback-merchants.ts` →
`packages/shared/src/countries.ts` (`merchantInCountry`) → web
`brand.$slug.tsx` / `cashback.tsx` / `calculator.tsx` → `orders/loop-handler.ts`.

CF-31 (brand-page country leak) is genuinely fixed at `brand.$slug.tsx`, but
`v-catalog.md`'s CAT-02 is correct that the fix is local, not systemic: I
independently re-derived the same three downstream symptoms by reading
`public/top-cashback-merchants.ts` and `public/merchant.ts` directly — neither
accepts a `country`/`currency` filter, so `/calculator` (live, **not**
`Phase2Gate`-wrapped — confirmed by grep) and `/cashback` render the full
global top-cashback list with no market scoping. This is also the seam behind
**XFC-02** below: the same ungated cashback-rate surface that breaks country
scoping is what feeds the post-purchase "earned cashback" UI a number with no
relationship to what Phase 1 actually recorded on the order.

### 6. Geo/locale: `/` → geo-redirect (MaxMind) → `/:country/:lang` → merchant filter → SEO hreflang/canonical → sitemap

Hops read: `routes/home-geo-redirect.tsx` → `public/geo.ts` →
`i18n/locale.ts` → `packages/shared/src/countries.ts` /
`packages/shared/src/regions.ts` → `routes/sitemap.tsx` →
`i18n/seo.ts` (`hreflangAlternates`).

Traced `sitemap.tsx` directly: it calls the same
`/api/public/top-cashback-merchants` endpoint as `/cashback`/`/calculator`
(CAT-02's blast radius), so the merchant URLs it lists are also
country-agnostic by construction (intentionally documented as `x-default`
only — not a new bug, but it means the SEO surface and the live UI bug share
one root cause: the public top-cashback-merchants endpoint has never taken a
country argument). Confirmed `SHARED-05`'s duplicate Eurozone country list
(`regions.ts` vs `countries.ts`, both within `packages/shared`) feeds two
different consumers of this flow (`/api/public/geo`'s `region` field vs ADR
034 path routing) — a real intra-package drift risk, already filed by
`v-shared.md`, not re-filed.

### 7. Config/flags: env.ts → kill switches/flags → routes + workers (consistent gating)

This is where the sweep earned its keep. Traced `LOOP_PHASE_1_ONLY` from its
single read site that actually changes financial state
(`orders/repo.ts:153-156`, the Tranche-1 instant-discount conversion) forward
through every UI surface that talks about cashback. Result: **XFC-02** — a
concrete, verifiable, live discrepancy between what the backend records and
what two web components claim, full chain below.

Also traced `LOOP_KILL_*`: `kill-switches.ts`'s `isKilled()` reads
`process.env` directly per call (correctly shared, not per-machine-stale) and
is honored consistently at every site I checked (`orders/loop-handler.ts`,
`payments/payout-worker.ts`, `auth` routes). No new gating gap found beyond
what `v-platform.md`/`v-wallet.md` already filed (rate-limiter and several
watchers' alert-dedup state are per-Fly-machine — PLAT-30-01/AUTH-06/ADM-01's
shared observation, not re-filed; W-05's branch-only "no kill-switch entry for
`burn`/`interest_mint`" is real but doesn't apply to `main`).

### 8. Idempotency end-to-end: client UUID → /orders/loop → DB unique → payout memo/tx-hash → Stellar find-outbound (no double-charge/double-pay across the WHOLE chain)

Traced the full chain: web mints `crypto.randomUUID()` once per purchase
attempt (`PurchaseContainer.tsx`, held in a ref, only cleared on success) →
`orders/repo-idempotency.ts` enforces `(user_id, idempotency_key)` partial
unique index, walks the Drizzle/postgres-js cause chain for `23505` rather
than string-matching (A4-026) → `orders/pay-ctx.ts` reconciles CTX's
per-order memo against Horizon via `findOutboundPaymentByMemo`, fails closed
on amount/asset mismatch → `payments/payout-worker-pay-one.ts` (CF-18) stamps
an authoritative `tx_hash` on `pending_payouts` before submit and checks
`getOutboundPaymentByTxHash` first on retry. Each individual link is solid.
The chain-level gaps already filed and re-confirmed true by direct read:
ORD-010 (`v-orders.md`: a replayed Idempotency-Key returns the prior order
unconditionally, without comparing the replay request's
merchantId/amount/currency/paymentMethod against the original — a client bug
sending a stale key with different params gets silently coerced onto the
wrong order) and the `v-orders.md` note that `pay-ctx.ts` never adopted CF-18's
tx-hash-persistence half (no column on `orders` to stash a pending CTX
payment hash), so its retry safety still depends entirely on the
depth-limited Horizon memo scan, unlike the payout worker's now-authoritative
path. Neither re-filed (fully evidenced in `v-orders.md`).

### 9. DSR/privacy: user requests deletion/export → backend DSR endpoints → web UI (settings.privacy.tsx) → native (mobile) → actual data removed/exported correctly everywhere it's duplicated (caches, Discord logs, etc.)

Hops read: `users/dsr-export.ts` / `users/dsr-delete.ts` / `users/dsr-handler.ts`
→ `apps/web/app/routes/settings.privacy.tsx` → `apps/web/app/services/user.ts`
→ (native path) `apps/web/app/utils/sentry-lazy.ts` /
`apps/web/app/utils/sentry-scrubber.ts`.

This is **XFC-01**, the flagship finding of this sweep: the native DSR-export
path's `console.log(payload)` (already filed as P1 by `v-web-routes.md`'s
W30-02, framed there purely as "not actually retrievable by the user") feeds
directly into a second, independent defect this sweep found by crossing into
the observability vertical's territory — the web Sentry pipeline never scrubs
breadcrumbs, so that same `console.log` call becomes a verbatim Sentry
breadcrumb on the very next captured exception. Full chain in Findings below.
Also confirmed PLAT-30-03 (DSR self-delete has no precondition on non-zero
`user_credits.balanceMinor`, contrast `home-currency-change.ts`'s correct
`balanceMinor !== 0n` block) is real by reading `dsr-delete.ts` directly —
already filed, not re-filed.

### 10. Observability: any failure in flows 1-9 → logger (redacted) → Discord notifier (dedup) → runbook → on-call

Traced `notifyPegBreakOnFulfillment` (new this round, closes 06-15's O-P1-01)
end to end: `orders/fulfillment.ts:277` → `discord/monitoring.ts` →
`peg-break-on-fulfillment.md` runbook — wired correctly. ADMIN-04
(`v-admin-reads.md`: this exact notifier emits full unredacted
`orderId`/`userId` UUIDs via plain `escapeMarkdown()`, regressing the file's
own last-8-truncation convention used two functions away in the same file)
is real and is the sharpest finding in this flow — confirmed by reading
`discord/monitoring.ts` directly; not re-filed. The Sentry-breadcrumb gap
(XFC-01) is also, structurally, an observability-flow defect — it is the
"failure → logger/Sentry" hop leaking exactly the class of data
`docs/log-policy.md` exists to protect, via a path (Sentry breadcrumbs) the
log-policy doc doesn't mention at all.

---

## Findings

### XFC-01 [P1 · LIVE] Web Sentry pipeline never scrubs breadcrumbs; native DSR data-export console.log puts a user's full personal-data export into the breadcrumb trail

**Evidence / chain:**

1. `apps/web/app/routes/settings.privacy.tsx:91-100` — on native, the data-export
   handler does `console.log('[loop] your data export', payload)` where
   `payload` is the full JSON body from `GET /api/users/me/dsr/export`
   (`apps/backend/src/users/dsr-export.ts` documents the export as "every row
   Loop holds keyed to the caller" — profile incl. email/Stellar address,
   full credit ledger, full order history, payouts).
2. `apps/web/app/utils/sentry-lazy.ts:48-84` — `Sentry.init({ integrations:
[Sentry.browserTracingIntegration(...)] , ... })`. Per `@sentry/react`
   v10's documented behavior, passing a custom `integrations` array does
   **not** disable `defaultIntegrations` (only `defaultIntegrations: false`
   does that) — it merges with, rather than replaces, the default set. The
   default set for a browser SDK includes the `Breadcrumbs` integration
   (console/dom/fetch/xhr/history capture is on by default). No
   `beforeBreadcrumb` hook exists anywhere in the web app (confirmed via
   `grep -rn "beforeBreadcrumb" apps/web`, zero hits) — so every
   `console.log`/`console.warn`/`console.error` call in the app is captured
   into Sentry's breadcrumb buffer verbatim, attached to whatever event fires
   next.
3. `apps/web/app/utils/sentry-scrubber.ts:31-40` — the `beforeSend` scrubber's
   own `SentryEventLike` interface only declares `request` / `extra` /
   `contexts` / `tags`. It has **no `breadcrumbs` field at all** and
   `scrubSentryEvent` never touches `event.breadcrumbs`.
   `apps/web/app/utils/sentry-error-scrubber.ts` (the other half of the web
   scrubbing story, `scrubErrorForSentry`) only normalises the object passed
   directly to `Sentry.captureException()` — it has no path to the
   breadcrumb buffer either.
4. Contrast: `apps/backend/src/sentry-scrubber.ts:74-78,142-148` (A4-074)
   explicitly walks `event.breadcrumbs[].message` and `.data` and applies the
   same free-text PII regex set (`EMAIL_RE`/`BEARER_RE`/`STELLAR_SECRET_RE`/
   `LONG_HEX_RE`) used elsewhere in that file. The web scrubber's own header
   comment claims `"Sibling to sentry-error-scrubber.ts ... Mirror of
apps/backend/src/sentry-scrubber.ts"` — it is not a mirror on this point;
   the backend already solved exactly this problem and the fix was never
   ported to web.
5. The team is otherwise aware that `console.*` becomes a Sentry breadcrumb
   and relies on it intentionally for low-sensitivity signals —
   `apps/web/app/services/api-client.ts:180-185` has an explicit comment:
   `"log the upstream rejection code ... so a deactivation event isn't
indistinguishable from a network blip in Sentry breadcrumbs / dev
console."` That establishes the console→breadcrumb pipeline is a known,
   relied-upon mechanism — which makes the unscrubbed DSR-export console.log
   a clear regression against the team's own established pattern, not an
   exotic edge case.

**Impact:** any native user who exports their data and then triggers _any_
subsequent Sentry-captured exception (a route error, a failed fetch, a React
error boundary) during the same session uploads a breadcrumb containing their
serialized profile, ledger, and order history to Sentry. This is exactly the
data class `docs/log-policy.md` was written to keep out of telemetry, via a
path that document doesn't enumerate at all (it covers app/access logs and
Discord, not Sentry breadcrumbs). Independently, the _general_ gap (no
breadcrumb scrubbing on web at all) means any other present-or-future
`console.*` call carrying a token, email, or amount also reaches Sentry
unredacted — the DSR case is simply the worst currently-known instance.

**Minimal fix:** add a `breadcrumbs` field to `apps/web/app/utils/
sentry-scrubber.ts`'s `SentryEventLike` and port the exact
`event.breadcrumbs[].message`/`.data` walk from
`apps/backend/src/sentry-scrubber.ts:142-148` (reuse the same
`scrubStringForSentry`/`scrubObject` pattern already in the web file). That
alone closes the general gap. Separately, stop `console.log`-dumping the DSR
export payload on native (W30-02's own fix path: write to a file via
Capacitor Filesystem + share sheet, matching the ADR-008 pattern already used
elsewhere for share-image writes, instead of `console.log`).

**Better fix:** extract one shared `scrubSentryEvent` implementation (the
backend version is already a strict superset of the web one: message,
request, extra, contexts, tags, exception.values, breadcrumbs) into
`packages/shared/`, satisfying ADR 019's three-part test (used by both apps,
no per-app divergence risk, single source of truth) — eliminates the
"keep these two files in sync" maintenance burden the web file's own header
comment currently relies on a human remembering to do. Add a `beforeBreadcrumb`
hook as defense-in-depth (drop `console` category breadcrumbs above a size
threshold, or down-rank `category==='console'` breadcrumbs from `level:
'log'` data entirely) so a future regression of this exact kind degrades
gracefully instead of leaking by default.

---

### XFC-02 [P1 · LIVE] Post-purchase "earned cashback" UI claims a balance credit that Phase-1 mode never makes — and links to a page that contradicts it

**Evidence / chain (5 hops, 4 verticals — orders, catalog/merchants,
web-ui-money, web-routes):**

1. `apps/backend/src/orders/repo.ts:131-156` — when `LOOP_PHASE_1_ONLY=true`
   (the documented current production default per `AGENTS.md`), `createOrder`
   converts the merchant's configured cashback split into an **instant
   discount applied to the charge the user pays at order-creation time**:
   `chargeMinor = requestedChargeMinor - split.userCashbackMinor`, and
   explicitly zeroes the row: `userCashbackMinorOnRow = 0n`,
   `userCashbackPctOnRow = '0.00'`. The comment is explicit: _"Fulfillment.ts
   already gates `pending_payouts` insertion on `userCashbackMinor > 0n`, so
   zeroing it here also turns off the on-chain emission for free."_
2. `apps/backend/src/orders/fulfillment.ts:97-110` — confirmed: the
   `credit_transactions`/`user_credits`/`pending_payouts` writes are gated on
   `order.userCashbackMinor > 0n`. Since that field is always `0n` in Phase 1
   (per step 1), **none of those writes ever fire** for a Phase-1 order — no
   ledger row, no balance bump, nothing "credited."
3. `apps/backend/src/merchants/cashback-rate-handlers.ts` — the
   `GET /api/merchants/:id/cashback-rate` endpoint that backs
   `useMerchantCashbackRate()` has **no `LOOP_PHASE_1_ONLY` check anywhere**
   (confirmed via grep) — it always returns the merchant's live configured
   `user_cashback_pct`, regardless of phase.
4. `apps/web/app/components/features/purchase/EarnedCashbackCard.tsx:37-77` —
   rendered unconditionally from `PurchaseContainer.tsx`'s post-purchase
   `'complete'` step (no `Phase2Gate`, no `phase1Only` check). It does
   **not** read `order.userCashbackMinor` (the authoritative, correctly-zeroed
   field) at all. Instead it independently re-fetches the _live_ rate via
   `useMerchantCashbackRate(merchantId)` and computes its own client-side
   estimate (`amount × pct / 100`), then renders: _"You earned {symbol}{X}
   cashback"_ / _"Credited to your Loop balance."_ and a `<Link to=
"/settings/cashback">View →</Link>`. The component's own doc comment only
   acknowledges one drift source ("an admin changed the merchant's rate after
   the order was placed") — it never considers that Phase-1 mode itself
   zeroes the authoritative field by design.
5. `apps/web/app/routes/settings.cashback.tsx:21,86-88` — wrapped in
   `<Phase2Gate>`, which (per `apps/web/app/components/Phase2Gate.tsx:26-39`)
   renders a "Coming soon... Cashback rewards... are launching with the next
   release" panel whenever `phase1Only` is true (the default).

**Impact:** a real user, in the live default configuration, completes a
purchase from any merchant with an active cashback config and is told _"You
earned $X cashback. Credited to your Loop balance."_ with a "View →" link.
Nothing was credited — the $X was already folded into the discounted price
they just paid in the same transaction (step 1), and no ledger row exists
(step 2) to view. Clicking "View" lands on a page that says the feature
hasn't launched yet, directly contradicting the message the user just read.
This is a financial-communication bug, not a cosmetic one: it tells users
their money did something it did not do, on the one money-moving screen in
the entire Phase-1 product. (`OrderPayoutCard.tsx`, rendered from
`routes/orders.$id.tsx`, has the identical structure/gap and should be fixed
in the same change — `v-web-ui-money.md`'s WUM-05 flagged both components as
missing a phase gate but did not trace why the underlying number is wrong, not
just unguarded; that's the half this sweep adds.)

**Minimal fix:** wrap both `EarnedCashbackCard` and `OrderPayoutCard` in
`Phase2Gate` (or simply `return null` early when `useAppConfig().config.
phase1Only` is true) so the false claim stops rendering. This alone is
enough to stop the active harm.

**Better fix:** make `EarnedCashbackCard` read the order's own recorded
`userCashbackMinor`/`userCashbackPct` (expose them on the `Order`/
`LoopOrderView` wire type if not already present — `PUB-03`/`CAT-04`'s
finding that `merchantId`-vs-`slug` field-naming is already loose in this
area is a related symptom of the same "derive client-side instead of trusting
the authoritative row" anti-pattern) instead of re-deriving from the live
rate. In Phase 1, that authoritative value is correctly `0`, so the card
naturally renders nothing (matching its own "empty card > misleading $0"
philosophy) instead of fabricating a number. This also closes the
admin-rate-changed-after-order drift the component's current comment already
worries about, for free.

---

### XFC-03 [P1 · GATED] CF-14's payout-worker row-claim lock is released before any row processing begins — resolves a direct conflict between this round's payments and credits vertical reports

**Evidence:** `apps/backend/src/credits/pending-payouts.ts:116-147`
(`listClaimablePayouts`) issues `db.select()...for('update', { skipLocked:
true })` as a bare call against the module-level `db` from
`apps/backend/src/db/client.ts:69` — it is **not** wrapped in
`db.transaction()` anywhere in the call chain
(`apps/backend/src/payments/payout-worker.ts:107-116` calls it directly, then
iterates `rows` and calls `payOne(row, args)` per row in a separate `for`
loop, each with its own internal Horizon calls and its own separate
`markPayoutSubmitted` UPDATE).

A single SQL statement issued outside an explicit `BEGIN` block runs inside
Postgres's own implicit, single-statement transaction, which **commits as
soon as that one statement finishes**. The `FOR UPDATE SKIP LOCKED` row locks
it acquired are released at that commit — i.e., before the `await
db.select()` call in JS even resolves, and certainly before `runPayoutTick`
starts the slow per-row work the docstring claims the lock protects.

This directly contradicts the function's own docstring (lines 96-105): _"this
lock is what stops the two instances from each running the (wasteful)
trustline + idempotency Horizon reads on a row the other is about to win...
leaves the second instance with nothing to pick, so the operator sequence
stays serialised."_ That claim only holds if the lock survives into the
processing phase — it does not.

**This round's two payments/credits vertical reports directly disagree on
this exact function:** `v-payments.md`'s V3-02 calls it a P1 defect with this
same reasoning; `v-credits.md`'s delta-reverification calls CF-14 "fully
closed... no new issue found." Having read the actual code and
`db/client.ts`'s transaction semantics directly, **`v-payments.md` is
correct.**

**Money-safety scope:** this is _not_ a double-pay bug. `payOne`'s
`markPayoutSubmitted` is a genuine atomic `UPDATE ... WHERE state='pending'`
compare-and-set, independent of the upstream lock, and still guarantees a row
is claimed by at most one machine. What CF-14 was actually filed to fix —
"legit payouts go terminal `failed` under scale" from `tx_bad_seq` churn when
two machines both build+sign a competing tx for the same row off the same
stale sequence number — is **not** fixed by this change, because both
machines can still select the identical candidate batch (the lock is gone by
the time either one starts the slow work) and both can still attempt a submit
before the loser's `markPayoutSubmitted` CAS fails. The fix narrows the
_window_ (a literally-concurrent `SELECT` from two machines firing within the
same statement-execution instant would still see each other's locks) but does
not deliver the documented benefit for the realistic case (staggered ticks
racing during the multi-second Horizon-bound processing phase).

**Minimal fix:** correct the docstring to state the real (narrow) scope, and
re-open the underlying CF-14 ticket — the `tx_bad_seq`-under-scale risk this
was meant to close is still open. As a stopgap, lower
`LOOP_PAYOUT_WORKER_INTERVAL_SECONDS` variance / keep `min_machines_running=1`
as the documented mitigation (already true today) until the real fix lands.

**Better fix:** make the claim atomic in one statement so no held-open
transaction or session affinity is required: a single `UPDATE ... FROM
(SELECT id FROM pending_payouts WHERE <predicate> ORDER BY ... LIMIT N FOR
UPDATE SKIP LOCKED) AS claimed SET claimed_by = <machine-id>, claimed_at =
NOW() WHERE pending_payouts.id = claimed.id RETURNING *` — this performs the
select-and-mark in one round trip with no externally-visible lock window to
race, and gives the admin payout-health surface a real "which machine has
this row" signal for free. This is the same shape CF-14's own deferred
"single-flight worker" note gestures at, but doesn't require full leader
election.

---

### XFC-04 [P0 · GATED, trace-confirmation of CF-01/W-07 with new evidence] Redemption never burns the on-chain LOOP it receives — the redeemed coins are structurally recyclable into the next user's payout, not just a ledger-drift abstraction

**Evidence — confirmed no burn implementation exists anywhere on `main`:**
`grep -rn "burn" apps/backend/src` (excluding tests) returns only comments
and docstrings (`orders/transitions.ts:40` — _"routes the inbound LOOP-asset
to a treasury / burn account"_ — describes the **intended** design, not
implemented code). There is no module, function, or Stellar payment operation
anywhere in `apps/backend/src` that forwards an inbound LOOP-asset deposit to
an issuer or any dedicated burn/treasury destination. The real
issuer-return-burn implementation exists only on the unmerged
`origin/fix/adr036-emission-burn` branch (confirmed via `git log --all`),
matching `v-wallet.md`'s W-07 and `v-credits.md`'s P1-01.

**The mechanism, traced on `main`:**

1. `apps/backend/src/orders/transitions.ts:62-139` (`markOrderPaid`, the
   A4-110 fix) — when a user pays for a gift card with `paymentMethod ===
'loop_asset'` (spending previously-earned cashback), this function
   correctly debits the user's **off-chain** `user_credits` mirror
   (`credit_transactions` type='spend', `user_credits.balance_minor -=
chargeMinor`) inside the same transaction that flips the order to `paid`.
   This closes the double-spend hole A4-110 documents (paying via loop_asset
   used to leave the off-chain liability untouched).
2. But the **on-chain** LOOP-asset the user actually sent never goes
   anywhere else. `apps/backend/src/env.ts:355-364` (`LOOP_STELLAR_
DEPOSIT_ADDRESS`) and `:408-414` (`LOOP_STELLAR_OPERATOR_SECRET`,
   _"Signs LOOP-asset Payment ops from Loop's operator account"_) confirm —
   per ADR 010's own documented "Phase-1 account topology (known limitation)"
   section (`docs/adr/010-principal-switch-payment-rails.md:149-171`) — that
   the deposit account and the operator/payout account are **the same
   account**. The inbound LOOP simply increases that account's own balance.
3. `apps/backend/src/payments/asset-drift-watcher.ts:31` —
   `getLoopAssetCirculation` (Horizon `/assets`) counts **all** LOOP-asset
   held by any non-issuer account as "circulating," which **includes** the
   operator/deposit account. So the redeemed LOOP doesn't even register as
   "returned" in the reconciliation math — it's just more circulating supply,
   sitting in the one account the payout worker draws every future cashback
   payment from.

**Why this is sharper than "a drift-equation gap" (the framing in CF-01/W-07):**
because deposit==operator, the LOOP a user redeems isn't merely
mis-accounted — it is the _exact pool of funds_ `payments/payout-worker.ts`
draws from to pay the _next_ user's cashback emission. Money loss isn't
hypothetical or eventual: Loop has now (a) let user A extinguish their
off-chain liability and receive a gift card, while (b) the on-chain LOOP A
sent is still fully spendable supply that will fund user B's _unrelated_
cashback payout — for an asset that's supposed to be 1:1 fiat-backed and
extinguished on redemption. The drift watcher's
`driftStroops = onChain − pool − ledgerLiability×1e5` equation will read
"over" by exactly the cumulative redeemed-but-unburned total, permanently and
monotonically (every redemption adds to it, nothing on `main` ever subtracts
it) — eventually either paging ops into a permanent-incident "the drift
watcher is just always over now" desensitization (the inverse of the
intended alert), or prompting an operator to raise
`LOOP_ASSET_DRIFT_THRESHOLD_STROOPS` to silence it, which would also raise
the bar for detecting a _genuine_ over-mint incident hiding behind the same
noise.

**Gating:** discount-mode default (loop_asset spend requires a user to
already hold on-chain LOOP, which requires cashback emission to have run at
least once — `LOOP_WORKERS_ENABLED` / cashback-mode launch). Confirmed
**not** live today under `LOOP_PHASE_1_ONLY=true` (XFC-02 above shows
cashback never emits on-chain in Phase 1, so there is no LOOP for a user to
redeem yet). This is squarely a Tranche-2 launch blocker, consistent with the
06-15 audit's verdict — restated here with the concrete "same coins fund the
next payout" mechanism confirmed by reading the actual topology + drift-watch
code together, which the per-vertical reports (each looking at one half)
stated as separate facts without connecting them this explicitly.

**Minimal fix:** before enabling `LOOP_WORKERS_ENABLED` for cashback mode,
merge `origin/fix/adr036-emission-burn`'s burn-on-redeem path (already
reviewed by `v-wallet.md` as "real and reasonably well-built") so the inbound
LOOP forwards to a genuine issuer-return/burn destination in the same
transaction as the off-chain debit.

**Better fix:** split the deposit account from the operator/payout account
(ADR 010's own "known limitation" section already flags this as the
structurally cleaner fix) so that even a delayed or failed burn doesn't
co-mingle redeemed LOOP with the live payout float — the burn becomes a
pure accounting/compliance step rather than a fix for an active recycling
vector.

---

### XFC-05 [P3 · LIVE, completeness] The repo's only inline TODO violates the repo's own TODO-hygiene rule

**Evidence:** `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:261-269`:

```
TODO(adr-pending): integrate Stellar Wallets Kit v2 here for an
in-app "Connect wallet" flow. ...
```

No ticket reference, no date. `CLAUDE.md` §"What NOT to do" states: _"Write a
TODO without a ticket reference or date."_ A full-tree grep
(`grep -rnE "TODO|FIXME|HACK|XXX" apps/backend/src apps/web/app
packages/shared/src tools/ctx-catalog`, excluding tests) found exactly one
inline TODO in the entire ~1,050-file source tree (every other "XXX"/"TODO"-
looking match is a code comment using those letters literally, e.g. SEP-7
amount-format examples, IPv4-mapped-address notation, a marketing-copy
character count — none are markers). The one real TODO documents genuine,
well-scoped pending work (a stub file `apps/web/app/services/stellar-wallet.ts`
already exists with the full adoption plan written out, gated correctly on an
ADR-before-install per project policy) — the _content_ is fine, only the
ticket/date hygiene is missing.

**Impact:** negligible on its own (one TODO, well-documented intent) — flagged
because it's the literal counter-example to an otherwise extremely clean
sweep result (see Completeness sweep below) and because "TODO with no ticket"
is exactly the smell the project's own lint-docs/standards exist to catch and
evidently don't (no CI gate greps for bare TODOs).

**Minimal fix:** add a ticket reference and date to the comment.

**Better fix:** add a cheap CI grep (or extend `scripts/lint-docs.sh`) that
fails on `TODO(?!\(...\))` / any TODO/FIXME without a `(REF-NNN, YYYY-MM-DD)`-
shaped annotation, so this stays true going forward rather than by accident.

---

## Completeness sweep results

**TODO/FIXME/HACK/XXX inventory.** Full-tree grep across
`apps/backend/src`, `apps/web/app`, `packages/shared/src`,
`tools/ctx-catalog` (excluding `__tests__`/`.test.`): **1 real TODO** (XFC-05
above), 4 false-positive matches (variable names / format examples containing
the literal substring "XXX"). Zero FIXME, zero HACK. This is a genuinely
clean result — consistent with the project's stated zero-orphan-TODO policy
and the lack of any prior-audit carryover TODO debt.

**Stub / not-implemented handlers.** No `throw new Error('not implemented')`
or empty handler bodies found on `main`. The one deliberate, fully-documented
stub is `apps/web/app/services/stellar-wallet.ts` (every export throws,
explicitly gated behind an ADR + `npm install` per `CLAUDE.md`'s
new-dependency rule, with the adoption plan written inline) — this is
intentional scaffolding, not a defect. `apps/backend/src/webhooks/
hmac-verify.ts` is a complete, tested, generic HMAC-verification primitive
with **zero callers** anywhere in `apps/backend/src` on `main` (its consumer,
a Privy webhook handler, exists only on the unmerged wallet branches per
`v-platform.md`'s PLAT-30-15 / `v-wallet.md`'s W-03) — flagged as
orphaned-but-not-dead (kept deliberately visible per that file's own
comment), not re-filed as a new finding.

**Registered-but-unused routes.** None found. Cross-checked the
`check-openapi-parity.mjs` outcome cited by `v-platform.md` (28 findings, all
about _documentation_/status-code-declaration parity, not unreachable
routes) — every mounted `app.get/post/put/delete` in `apps/backend/src/routes/**`
has a live handler with at least one real caller path (web service or e2e
test). No dead route mounts found.

**Orphaned files (zero importers), consolidated from direct verification +
vertical digests:**

- `apps/web/app/services/geo.ts` (`fetchGeo` export) — zero importers;
  `home-geo-redirect.tsx`, the one logical consumer, calls `fetch()` directly
  instead (`v-public.md` PUB-11).
- `apps/web/app/components/features/FixedSearchButton.tsx` — zero importers,
  carried over unfixed from the 06-15 audit (`v-web-ui-browse.md` WUI-06).
- `apps/web/app/components/ui/index.ts` — orphaned barrel; every real
  consumer imports the specific component file directly (`v-web-ui-browse.md`
  WUI-07).
- `apps/web/app/components/features/home/CashbackStatsBand.tsx` and
  `FlywheelStatsBand.tsx` — fully built, tested, zero importers anywhere
  (`v-web-ui-browse.md` WUI-05).
- `apps/backend/src/credits/apy-snapshot.ts` — zero importers outside its own
  test file; pre-built ADR-031 scaffolding (`v-credits.md` V4-05).
- `packages/shared/src/credit-transaction-type.ts#isCreditTransactionType`,
  `order-state.ts#isOrderState` / `#isOrderPaymentMethod`,
  `payout-state.ts#isPayoutState` — four narrowing-helper exports with zero
  callers anywhere in the monorepo, breaking the package's own established
  precedent of deleting zero-caller exports (`v-shared.md` SHARED-06).
- `apps/backend/src/orders/transitions.ts:246-274` — two full orphaned JSDoc
  blocks describing `sweepStuckProcurement`/`sweepExpiredOrders`, which moved
  to `transitions-sweeps.ts` and left stale duplicate doc comments behind
  (`v-orders.md` ORD-008; doc hygiene, not a code defect).

None of the above are newly discovered by this sweep (all independently found
by the relevant vertical agent); listed here only to produce one consolidated
completeness count per the brief.

**Orphaned env vars.** Independently re-derived (not trusting any vertical's
claim): extracted every top-level key from `apps/backend/src/env.ts`'s Zod
schema (87 vars) and diffed against every key — commented or not — in
`apps/backend/.env.example`. **Zero vars are missing from `.env.example`**
(initial greps suggested ~80 were missing; that was a parsing artifact of the
file's `# VAR=value` commented-default convention, corrected and re-run).
Zero vars in `.env.example` that aren't in the `env.ts` schema (one
false-positive match, `CAP`, from a comment fragment, not a real key). Env
var parity between `env.ts` and `.env.example` is genuinely clean. The one
real doc gap in this space — `AGENTS.md`'s root "Environment variables"
summary table omits `ADMIN_EMAILS` (and the pre-existing `ADMIN_CTX_USER_IDS`)
even though `.env.example`/`docs/development.md`/`docs/deployment.md` all
document it correctly — was already found by `v-platform.md` (PLAT-30-07),
not re-filed.

**Orphaned migrations.** None. `v-db.md` independently confirmed all 38
migrations (0000–0037) are present in `meta/_journal.json`, replay cleanly
against `schema.ts` via `check-migration-parity.ts`, and migration 0037's
CHECK-constraint widening for ADR 035 extended markets exactly matches
`packages/shared/src/loop-asset.ts`'s `ORDERABLE_CURRENCIES` (cross-verified
independently by re-reading both files side by side — confirmed accurate).

**Half-built / documented-but-unimplemented features**, cross-checked against
`docs/adr/`: redemption burn (XFC-04 above), on-chain interest mint (branch-
only, `v-wallet.md` W-01, unbacked-mint bug confirmed not yet fixed), Privy
wallet signing pipeline (branch-only, `v-wallet.md` W-02, missing
`privy-authorization-signature` header), DeFindex vault integration (entirely
unbuilt, `v-wallet.md` W-10). ADR 036 and ADR 037 still have no file on
`main` (confirmed via `git show main:docs/adr/036-*` → does not exist),
matching the 06-30 checklist's own expectation that this would still be true.

---

## Coverage confirmation

- Read all 20 vertical raw reports in full (via 5 parallel digest passes,
  cross-referenced against direct source reads — not relied on as ground
  truth per the brief's instruction).
- Directly read, end to end, the actual current source for all 10 named
  flows: `orders/{loop-handler,repo,repo-idempotency,transitions,fulfillment,
procure-one,pay-ctx}.ts`, `payments/{watcher,payout-worker,payout-worker-
pay-one,asset-drift-watcher,pending-payouts→credits/pending-payouts}.ts`,
  `credits/{withdrawals,payout-compensation}.ts`, `auth/{require-auth,
require-admin,authenticated-user}.ts`, `db/users.ts`, `auth/identities.ts`,
  `routes/home-geo-redirect.tsx`, `i18n/locale.ts`, `routes/sitemap.tsx`,
  `env.ts` (env var schema in full), `kill-switches.ts`, `users/{dsr-export,
dsr-delete}.ts`, `routes/settings.privacy.tsx`, `utils/sentry-{lazy,
scrubber,error-scrubber}.ts`, `instrument.ts`/`sentry-scrubber.ts` (backend),
  `discord/monitoring.ts`, plus the web purchase-flow chain
  (`PurchaseContainer.tsx`, `AmountSelection.tsx`, `EarnedCashbackCard.tsx`,
  `Phase2Gate.tsx`, `settings.cashback.tsx`) and the cashback-rate/merchant
  handlers backing it.
- Resolved one direct factual conflict between two vertical reports
  (`v-payments.md` vs `v-credits.md` on `listClaimablePayouts`) by reading
  `db/client.ts`'s transaction semantics directly (XFC-03).
- Ran and hand-verified two independent completeness scripts (TODO/FIXME/HACK
  grep; env.ts ↔ `.env.example` diff), catching and fixing my own
  regex/parsing bugs before reporting results, rather than reporting the
  initial (incorrect) false-positive-heavy output.
- 5 findings written (XFC-01 through XFC-05): 1×P0(gated), 3×P1 (2 live, 1
  gated), 1×P3. All other defects surfaced during tracing that were already
  fully evidenced in a vertical's own raw report are cited by ID with
  file:line in the trace notes above, not duplicated as new findings.
- File written to
  `/Users/ash/code/loop-app/docs/audit-2026-06-30-cold/raw/x-flows-completeness.md`.
