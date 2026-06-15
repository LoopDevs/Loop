# V-Admin — Admin & Staff vertical (cold audit raw)

> Cold adversarial audit, 2026-06-15. Vertical owner: Admin & Staff (V8).
> Branch audited: `fix/stranded-order-hardening`. Staff-roles findings are
> branch-only (`origin/feat/staff-roles-backend` + `origin/feat/staff-dashboard-web`)
> and prefixed `[BRANCH-ONLY]`.
>
> Severity rubric: **P0** money loss / security breach / data loss / authz
> bypass / ledger divergence · **P1** incorrect behavior on real traffic /
> missing critical control / silent failure · **P2** correctness edge / weak
> control / missing test on risky path · **P3** quality / docs / nit.

---

## Coverage

**Files examined (read in full or materially): ~118.**

Backend authz/primitives (read in full): `auth/require-admin.ts`, `auth/admin-step-up.ts`,
`auth/admin-step-up-middleware.ts`, `auth/require-auth.ts` (LoopAuthContext), `auth/otps.ts`
(findLiveOtp scoping), `admin/audit-envelope.ts`, `admin/idempotency.ts`,
`admin/idempotency-store.ts`, `admin/idempotency-constants.ts`, `admin/step-up-handler.ts`,
`admin/read-audit.ts`.

Destructive writers (read in full): `admin/credit-adjustments.ts` + `credits/adjustments.ts`,
`admin/refunds.ts` + `credits/refunds.ts`, `admin/withdrawals.ts`, `admin/payout-compensation.ts`,
`admin/payouts-retry.ts`, `admin/home-currency-set.ts`, `admin/reconciliation.ts`.

Route mounts (read in full): `routes/admin.ts`, `admin-credit-writes.ts`, `admin-user-writes.ts`,
`admin-payouts.ts`. Remaining mounts (`admin-dashboard`, `admin-fleet-monthly`, `admin-operator`,
`admin-ops-tail`, `admin-order-drill`, `admin-per-merchant`, `admin-treasury`,
`admin-user-cluster`, `admin-cashback-config`) covered via the analytics sub-agent.

Analytics/CSV surface (~78 files): covered by sub-agent — every `admin/*-csv.ts`, every mix-axis /
drill / list / snapshot / time-series handler, `csv-escape.ts`. Web admin (~31 files): covered by
sub-agent — routes/components/services/hooks/stores. OpenAPI parity + tests (90 mounts, 87 test
files): covered by sub-agent. Staff branch (~31 files across two branches): covered by sub-agent.

ADR cross-refs read: ADR 017 (header), ADR 024, ADR 028 (full), ADR 037 (via branch sub-agent).

**Not separately deep-read** (delegated, sampled, or out-of-vertical): the ~78 analytics handlers
individually (sampled + sub-agent); web component internals beyond sub-agent; the full openapi
module set beyond the parity sub-agent's spot-checks.

---

## Findings

### P0 — none

No authz bypass, money-loss, or ledger-divergence defect found on the main branch. The
foundational controls are strong: `requireAdmin` 404-masks non-admins and fails closed on
missing/non-loop auth; `withIdempotencyGuard` serialises lookup→write→store under a pg advisory
lock with corrupt-snapshot fail-loud; the cap/lock derivations are sound; double-entry writers lock
`user_credits FOR UPDATE`; step-up subject-pins to the bearer `sub`.

---

### P1 — High

**P1-1 — Admin refund write is NOT gated by step-up (ADR 028), unlike its sibling money-up writers.**
`apps/backend/src/routes/admin-credit-writes.ts:58-62` — `POST /api/admin/users/:userId/refunds`
mounts with `rateLimit` + `adminRefundHandler` but **no `requireAdminStepUp()`**, whereas
credit-adjustments (`:49`), withdrawals (`:72`), payout-retry, and home-currency all carry it.
Refund issues a **positive `credit_transactions` row** that bumps `user_credits.balance_minor`
(`credits/refunds.ts:79-108`).
_Impact:_ A captured admin bearer alone can credit balances via the refund path with no
authentication-freshness check — the exact threat ADR 028 exists to stop. ADR 028's "Excluded" list
does not name refund; it is simply unaddressed, so this is a gap, not an accepted deferral. Refund
is the **least-defended money-up primitive** (see P1-2 / P1-3 which compound it).
_Fix:_ Wrap the refund route in `requireAdminStepUp()`; add the route + 401/503 to ADR 028's
gated-surface list; declare 503 in the openapi registration.

**P1-2 — Admin refund does not bind to the daily-adjustment cap; it bypasses the magnitude
circuit-breaker entirely.** `credits/refunds.ts` (whole file) performs no cap check, and the cap
query in `credits/adjustments.ts:117-139` filters on `type='adjustment'` AND
`referenceType='admin_adjustment'` — refund rows (`type='refund'`, `referenceType='order'`) are
invisible to it. credit-adjustments (per-admin cap) and payout-compensation (fleet-wide cap, via the
adjustment path) are both capped.
_Impact:_ The `ADMIN_DAILY_ADJUSTMENT_CAP_MINOR` circuit-breaker (A2-1610) that bounds how much a
stolen/coerced session can move per day does not apply to refunds. Each refund is bounded only by
the per-call 10M-minor cap and the per-order uniqueness fence — so total per-day refund volume is
unbounded by count of distinct order ids. Combined with P1-1 (no step-up) this is the soft underbelly
of the admin money surface.
_Fix:_ Route refunds through the same per-admin daily-cap check, or add a separate refund cap;
include `type='refund'` in the cap aggregate.

**P1-3 — Admin refund never validates that `orderId` exists or belongs to the target user (IDOR /
fabrication).** `admin/refunds.ts:99-156` + `credits/refunds.ts:48-130` — `userId` comes from the
path, `orderId` from the body; the writer inserts `referenceType='order', referenceId=<orderId>`
with **no lookup** confirming the order exists or that `orders.user_id === userId`. The only fence is
the partial unique index on `(type, reference_type, reference_id)` (migration 0013).
_Impact:_ An admin (or a captured bearer, given P1-1) can mint a refund credit to any user against
any arbitrary or unrelated order id — one positive credit per fabricated UUID. There is no
"refunded amount ≤ order charge amount" check either, so a refund can exceed what the order ever
cost. Breaks the ADR-017/009 intent that a refund "reverses the spend of the order it's bound to."
_Fix:_ In the writer, load the order, 404 if missing, 409/400 if `order.user_id !== userId`, and
bound `amountMinor ≤ order.charge_amount_minor` (less any prior refund). Add a regression test.

**P1-4 — Admin payout-compensation is NOT gated by step-up (ADR 028).**
`apps/backend/src/routes/admin-payouts.ts:99-104` — `POST /api/admin/payouts/:id/compensate` mounts
with `killSwitch('withdrawals')` + `rateLimit` but **no `requireAdminStepUp()`**, while the sibling
`/payouts/:id/retry` (`:90-95`) is step-up-gated. Compensation re-credits the user's balance via a
positive `type='adjustment'` row (`admin/payout-compensation.ts:166-172`).
_Impact:_ A money-up ledger write reachable with a captured bearer alone. Lower exploitability than
refund because it requires a real `state='failed'` withdrawal payout row and is fleet-cap-bounded
(P1-2 does not apply here — it does hit the cap), but it is still a destructive write ADR 028
should cover and currently does not.
_Fix:_ Add `requireAdminStepUp()` to the compensate route; declare 503/401 in openapi; list in
ADR 028.

**P1-5 — Step-up "re-authentication" factor is the same email OTP as login — no purpose binding;
weakens the ADR-028 threat model for a passwordless deployment.** `admin/step-up-handler.ts:84`
calls `findLiveOtp({ email, code })`; `auth/otps.ts:87-117` scopes OTP rows by email + code +
liveness only, **not by purpose** — a login OTP and a step-up OTP are interchangeable. Loop has no
passwords (`step-up-handler.ts:10-14` "password-only admins don't exist on Loop").
_Impact:_ ADR 028's stated value — "the attacker needs the password too, which is in 1Password /
Keychain, not the browser session" — does not hold: the second factor is an OTP delivered to the
same email inbox. An attacker who has already compromised the session/laptop is well-positioned to
also obtain a fresh OTP (same inbox, or by triggering `request-otp` and reading it), collapsing
step-up to a single factor. Defense-in-depth is real (separate signing key, 5-min TTL, subject
pinning, the bearer must still be valid) but the "second independent factor" claim is overstated.
_Fix:_ Bind OTP purpose (add a `purpose` column / separate request endpoint for step-up so a login
OTP can't satisfy step-up and vice versa); fast-follow WebAuthn (ADR 028 Phase-2 #2) for a genuinely
independent factor; correct ADR 028's threat-model prose for the passwordless reality.

**P1-6 — Read-audit Discord exfil tripwire fires only on `.csv`, not on large JSON list pulls — the
documented behavior is not implemented.** `routes/admin.ts:137-166` computes
`isCsv = path.endsWith('.csv')` and only `notifyAdminBulkRead`s when `isCsv`, but the adjacent
comment (`:131-136`) and file header (`:31`) promise "CSV downloads **+ sufficiently-large list
pulls**" alert to #admin-audit. _(sub-agent: analytics P1-1)_
_Impact:_ PII bulk-exfil via cursor-walking JSON list endpoints (`/users`, `/top-users`,
`/recycling-activity` — all email-bearing) produces only a Pino line, never the human-visible
Discord signal. The unmonitored channel is the JSON path, not CSV.
_Fix:_ Implement the large-list heuristic (alert when a non-CSV GET returns ≥N rows / hits the page
cap) or correct the comment+header to "CSV-only" and accept the gap explicitly.

**P1-7 — Admin web writes regenerate the Idempotency-Key on every call; ADR-017 double-apply
protection does not hold for the post-completion re-click case.** `admin-write-envelope.ts:57`
(`generateIdempotencyKey`) is invoked inside each writer service body (`admin-user-credits.ts:88,115`,
`admin-user-home-currency.ts:34`, `admin-payouts.ts:117`, `admin-cashback-config.ts:107`,
`admin-merchants-resync.ts:51`); none accept a caller-supplied key. _(sub-agent: web P1-1)_
_Impact:_ Button-disable only covers the in-flight window; once a request settles, a second click
mints a brand-new key the backend has never seen → server-side dedup is bypassed → the mutation
applies twice. The correct pattern already exists in `orders-loop.ts:60-68` (caller-supplied key).
_Fix:_ Mint the key once per logical action (when the operator confirms / `pendingPayload` is set)
and thread it through `options.idempotencyKey`, reusing it on every retry incl. the step-up retry.

**P1-8 — Step-up mint handler (`adminStepUpHandler`) has ZERO tests** despite minting the token that
gates every destructive admin write. `admin/step-up-handler.ts` is referenced by no test;
`admin-writes.test.ts:87-89` falsely claims it's "covered by unit tests." _(sub-agent: openapi/tests B-P1)_
_Impact:_ Untested branches include 503-unconfigured, non-loop-kind 401, wrong/expired-OTP →
`incrementOtpAttempts`, and `markOtpConsumed`+mint. A regression that mints without consuming the
OTP, or fails open when unconfigured, would silently weaken the whole step-up control.
_Fix:_ Add `admin/__tests__/step-up-handler.test.ts` covering all branches; correct the false comment.

---

### P2 — Medium

**P2-1 — `user-cashback-by-merchant` casts a `text` column to `::uuid`; one malformed ledger row
500s a support-triage endpoint.** `admin/user-cashback-by-merchant.ts:115` —
`JOIN orders ON orders.id = credit_transactions.reference_id::uuid`; `reference_id` is `text`
(`schema.ts:167`). A non-UUID value throws `invalid input syntax for type uuid` for the whole
request. _(sub-agent: analytics P2-1)_ _Fix:_ guard the cast (`WHERE reference_id ~` UUID regex, or
join on `::text`).

**P2-2 — `user-credits.csv` has no window/cursor; the full-liability export silently truncates at
10k holders with no way to page the remainder.** `admin/user-credits-csv.ts:40-67`. _(sub-agent:
analytics P2-2)_ _Impact:_ per-currency liability reconciliation becomes permanently incomplete past
10k balance-holders. _Fix:_ add a cursor or currency filter.

**P2-3 — `merchant-flows` runs an unbounded full-table aggregate (no LIMIT, no window) on a
page-load endpoint.** `admin/merchant-flows.ts:49-64` — `GROUP BY (merchant_id, charge_currency)`
over all fulfilled orders for all time; siblings (supplier-spend, merchant-stats) all cap at 366d.
_(sub-agent: analytics P2-3)_ _Fix:_ add the 366-day window cap + a bucket-row cap.

**P2-4 — Mix-axis `:id` existence is never checked; a typo'd operatorId/merchantId returns 200 with
`rows:[]` indistinguishable from "real id, no activity."** `merchant-operator-mix.ts`,
`operator-merchant-mix.ts`, `user-operator-mix.ts`. _(sub-agent: analytics P2-5, ADR 023)_
_Impact:_ silent empty masks operator typos during the incidents these endpoints exist to triage —
worst for the free-form CTX `operatorId`. _Fix:_ validate `operatorId` against `CTX_OPERATOR_POOL`
and 404 unknown; optionally check merchant catalog membership.

**P2-5 — Drill-quartet 404 semantics are inconsistent across the user vs merchant axes (ADR 022).**
Per-user drills 404 on unknown id (explicit probe or LEFT-JOIN-empty); identically-shaped
per-merchant drills never 404 and return empty. _(sub-agent: analytics P2-4)_ _Fix:_ document the
axis-level decision in ADR 022 or add a cheap catalog-membership check to the merchant drills for
symmetry.

**P2-6 — Step-up store is never cleared on logout, contradicting its own docstring.**
`admin-step-up.store.ts:26-31` documents `clear()` as "called explicitly on admin logout" but no
logout/`clearSession`/cross-tab path calls it. _(sub-agent: web P1-2 — downgraded to P2 here:
bounded by 5-min `exp` + backend `STEP_UP_SUBJECT_MISMATCH`)_ _Impact:_ a logged-out/account-switched
tab keeps a valid step-up JWT in memory up to 5 min. _Fix:_ call `clear()` from the logout +
cross-tab-logout paths.

**P2-7 — OpenAPI: credit-adjustments and payouts/:id/retry omit the reachable 503
STEP_UP_UNAVAILABLE.** `openapi/admin-credit-writes.ts:144-176` and
`openapi/admin-payouts-cluster-writes.ts:67-93` declare no 503 though both wrap
`requireAdminStepUp()` which 503s when the key is unset. _(sub-agent: openapi A-P2)_ _Fix:_ add 503
(mirror `admin-user-writes.ts:111-114`).

**P2-8 — Step-up middleware's 503-unconfigured fail-closed branch is untested.**
`auth/__tests__/admin-step-up-middleware.test.ts` pins the key in `vi.hoisted`, so the
`STEP_UP_UNAVAILABLE` branch (`admin-step-up-middleware.ts:54-64`) is never exercised by any test.
_(sub-agent: openapi/tests B-P2)_ _Fix:_ add a key-unset test asserting 503.

**P2-9 — `pendingResolve` held in React state creates a lost-update race in the step-up retry hook.**
`use-admin-step-up.ts:56-61` — a second `runWithStepUp` before the first resolves can drop the
earlier pending promise (hung mutation, spinner never clears). _(sub-agent: web P2-1)_ _Fix:_ hold
the pending entry in a `useRef` / queue rather than overwrite.

---

### P3 — Low / quality / docs

- **P3-1 — Step-up subject-pinning is skipped when `auth.userId` is undefined**
  (`admin-step-up-middleware.ts:105`, `if (auth?.userId !== undefined && ...)`). Safe in practice —
  `requireAdmin` rejects all non-`loop` kinds (401) before step-up runs and `kind:'loop'` always
  carries `userId` (`require-auth.ts:46-52`) — but the guard reads as fail-open if the ordering ever
  changes. _Fix:_ assert `userId` present (fail closed) rather than skip the check.
- **P3-2 — OpenAPI: `merchants/resync` omits the 400 it returns** for missing Idempotency-Key /
  invalid body (`merchants-resync.ts:62`). _(sub-agent: openapi A-P3)_
- **P3-3 — Imprecise 401 descriptions on step-up routes** — they describe only "missing/invalid
  bearer," not the `STEP_UP_REQUIRED/INVALID/SUBJECT_MISMATCH` sub-codes the same 401 carries.
  `home-currency` gets this right. _(sub-agent: openapi A-P3)_
- **P3-4 — `listConfigsHandler` / `configHistoryHandler` return raw Drizzle rows** (`handler.ts:23-26`,
  `config-history-handler.ts:44-50`) instead of explicit field maps — any new schema column leaks onto
  the wire and bypasses the openapi shape. _(sub-agent: analytics P3-1)_
- **P3-5 — `treasury-snapshot-csv` re-invokes `treasuryHandler` and re-parses its JSON** body
  (`treasury-snapshot-csv.ts:60-65`) — double-runs the aggregate + Horizon read and couples CSV
  correctness to the JSON envelope shape. _(sub-agent: analytics P3-2)_
- **P3-6 — No direct `csv-escape.test.ts`** — escape logic only tested indirectly via per-handler CSV
  tests; the formula-injection prefix set (`= + - @ \t \r`) is OWASP-core but a direct unit test
  would lock the contract. _(sub-agent: analytics P3-4)_
- **P3-7 — StepUpModal error text is not announced** to assistive tech (plain `<p>`, no
  `role="alert"`/`aria-live`); sibling forms get this right. _(sub-agent: web P2-2)_
- **P3-8 — `supplier-spend.ts:35-37` header comment is stale** ("No upper bound" — code caps at
  366d). _(sub-agent: analytics P3-3)_

---

### Staff roles (ADR 037) — branch-only

Audited via `git show` against `origin/feat/staff-roles-backend` + `origin/feat/staff-dashboard-web`.
**Verdict: SAFE TO MERGE (backend → web).** The least-privilege model is correctly implemented and
well-tested; no P0/P1 found on the branches.

- **[BRANCH-ONLY] No privilege escalation.** Independent enumeration of all 100 `/api/admin` mounts:
  33 admin-tier (every money write, every `.csv`, Discord, step-up mint, role mgmt), 7 explicit
  support-tier (lookups, watcher-skips, wallet reads, refetch-redemption), 60 blanket GET reads. **No
  POST/PUT/DELETE and no CSV rides the support blanket.** `requireStaff` fails closed (401 on missing
  auth / non-loop / no row; 404 — never 403 — for non-staff and wrong-tier). `requireAdmin` becomes a
  pure alias of `requireStaff('admin')`, preserving `main` semantics. Role grant/revoke are admin-tier
  - step-up-gated + audited; last-admin/self-revoke guarded under an advisory lock. Migration 0039
    matches `schema.ts` (no default role = fail-closed). DTO parity holds.
- **[BRANCH-ONLY] P2 — `home-currency` tier is not covered by ADR 037 §3's money-writes row** though
  the code gates it `requireStaff('admin')` + step-up (the safe choice). _Fix:_ add home-currency to
  ADR §3 so the matrix is exhaustive.
- **[BRANCH-ONLY] P2 — `requireStaff` 500s the whole `/api/admin/*` namespace on a transient
  users-table blip** (it runs `getUserById` on the blanket for every request). Acceptable (fail-closed)
  but worth a one-line note in the oncall/revocation runbook.
- **[BRANCH-ONLY] P3 — trivial `users-me.ts` comment-only drift** between the two branches → near-certain
  trivial merge conflict on the second merge. **P3 — `staff-route-gating.test.ts:335` hard-codes
  `toHaveLength(33)`** (good tripwire, manual bump on new endpoints).

---

## Tooling utility / coverage gaps

The admin tooling is genuinely strong for ops: the ADR-022 drill quartet (fleet → per-merchant →
per-user → per-operator) and ADR-023 mix matrices are near-complete; order↔payout cross-drill works;
every velocity feed has a finance CSV (minted / settled / supplier-paid / net); treasury, drift,
reconciliation, settlement-lag, and stuck-order/stuck-payout triage are all first-class. An engineer
can resolve most cashback/payout/treasury tickets end-to-end without a DB console.

Concrete gaps worth tickets:

1. **No lookup by CTX-side id.** You can go Loop order id → payout, but a CTX support ticket quoting
   _their_ `ctxOrderId` is a dead end — no endpoint resolves CTX id → Loop order/payout.
2. **Two money-movement primitives have no web UI** (orphaned tooling): `POST .../refunds` and
   `POST /payouts/:id/compensate` exist on the backend but have no frontend service/route — ops must
   curl the admin API to issue a refund or compensate a failed withdrawal, which is itself an
   auditing-consistency and operational-risk concern. _(sub-agent: web tooling gap)_
3. **No withdrawal-specific drill or CSV** — withdrawals only appear mixed into the payouts list via
   `?kind=withdrawal`.
4. **`user-credits.csv` can't window or page** (P2-2), so per-currency liability reconciliation breaks
   past 10k holders.
5. **Mix/drill endpoints silently return empty on a typo'd operator/merchant id** (P2-4) — exactly
   when an engineer is most likely to mistype during an incident.
6. **No fleet-wide "orders by failure_reason" aggregate** — `failure_reason` is in the orders CSV and
   single-order drill but there's no grouped "top failure mode this week" view without export+pivot.

---

## Summary

| Severity | Count                                    |
| -------- | ---------------------------------------- |
| P0       | 0                                        |
| P1       | 8                                        |
| P2       | 9                                        |
| P3       | 8 (+ 2 branch-only P2, 2 branch-only P3) |

**Launch-readiness verdict for V8:** The admin surface is disciplined and largely production-ready —
no P0s, excellent idempotency/audit/cap engineering, correct 404-masking, and a clean staff-RBAC
branch. The blocking concern is the **refund primitive (P1-1/2/3)**: it is the one money-up write with
no step-up, no daily cap, and no order ownership/amount validation — a captured admin bearer's softest
path to mint credits. Close the refund triad and the payout-compensation step-up gap (P1-4) before any
admin surface is exposed to real money. P1-5 (OTP-as-step-up) is a threat-model honesty issue to fix
before relying on step-up as a true second factor on a passwordless deployment. P1-6/7/8 are real but
lower-blast-radius (observability gap, web double-apply, untested mint handler).
