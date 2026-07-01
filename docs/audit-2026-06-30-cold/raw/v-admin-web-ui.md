# Vertical Web admin panel UI — raw findings

Cold adversarial audit, 2026-06-30. Vertical: **Web admin panel UI**
(`apps/web/app/components/features/admin/**` + `apps/web/app/routes/admin*.tsx`

- paired tests). Backend admin primitives (`apps/backend/src/admin/**`,
  `routes/admin-*`) are a different vertical's scope — referenced here only as
  read-only context to judge whether the web client calls/wires them correctly.

Files examined: **138/138** (full list at the bottom). All files were opened
and read in full — 52 directly by the lead agent (all 17 routes, all 9 route
tests, every write-triggering component + its test, plus the step-up
infrastructure these depend on), 86 by two parallel sub-agent passes over the
remaining read-only display components (charts, sparklines, cards, tables) +
their tests. Every sub-agent P1 claim was independently spot-verified by the
lead agent by re-reading the cited file before being accepted into this
report (see inline evidence).

---

## Write-surface inventory

| Route / component                                                  | Action                                             | Step-up (ADR 028)?                                                | Idempotency-key stable?                                                                                                                            | Double-submit guard?                                                                       | Server-validated?                                                                           |
| ------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `CreditAdjustmentForm.tsx` (on `admin.users.$userId.tsx`)          | `POST /api/admin/users/:userId/credit-adjustments` | **Yes** — `useAdminStepUp` + `<StepUpModal>`                      | **Yes** — minted once at `pendingPayload` (confirm-dialog open), reused via closure on step-up retry                                               | Yes — `mutation.isPending` disables submit; native `<dialog>` confirm gate blocks re-entry | Yes — reason 2–500 chars, amount regex + `MAX_ABS_MINOR` client-side, backend authoritative |
| `AdminWithdrawalForm.tsx` (on `admin.users.$userId.tsx`)           | `POST /api/admin/users/:userId/withdrawals`        | **Yes**                                                           | **Yes** — same pattern                                                                                                                             | Yes                                                                                        | Yes — amount, `STELLAR_PUBKEY_REGEX`, reason                                                |
| `HomeCurrencyForm.tsx` (on `admin.users.$userId.tsx`)              | `POST /api/admin/users/:userId/home-currency`      | **Yes**                                                           | **Yes** — same pattern                                                                                                                             | Yes                                                                                        | Yes — reason, no-op guard (`target === currentHomeCurrency`)                                |
| `admin.payouts.tsx` (list) — Retry button                          | `POST /api/admin/payouts/:id/retry`                | **Yes**                                                           | **Yes** — minted in `handleReasonResolve`, reused across `runWithStepUp` retry                                                                     | Yes — `retryingId === p.id` disables the row button                                        | Yes — reason 2–500 via `ReasonDialog`                                                       |
| `admin.payouts.$id.tsx` (detail) — Retry button                    | `POST /api/admin/payouts/:id/retry`                | **Yes**                                                           | **Yes** — identical pattern, and the one with a dedicated regression test (`reuses the same Idempotency-Key across the step-up retry (CF-09)`)     | Yes — `retrying` disables the button                                                       | Yes                                                                                         |
| `MerchantResyncButton.tsx` (on `admin.cashback.tsx`)               | `POST /api/admin/merchants/resync`                 | **No** — by design, ADR-028 excludes resync ("read-only effects") | Fresh-per-call (no caller-supplied key threaded) — acceptable: no step-up interruption to survive, backend coalesces concurrent sweeps server-side | Yes — `mutation.isPending` disables the button                                             | Yes — reason via `ReasonDialog`                                                             |
| `admin.cashback.tsx` — Save button                                 | `PUT /api/admin/merchant-cashback-configs/:id`     | **No** — by design, ADR-028 excludes config edits ("reversible")  | Fresh-per-call (no caller-supplied key threaded)                                                                                                   | Partial — single shared `useMutation` instance across all table rows; see F-WEBADMIN-27    | Yes — reason via `ReasonDialog`, pct bounds client + server                                 |
| `CsvDownloadButton.tsx` (used on 9+ pages)                         | `GET /api/admin/*.csv`                             | N/A (read)                                                        | N/A                                                                                                                                                | Yes — `busy` disables the button                                                           | N/A                                                                                         |
| `admin.users.tsx` — "Find by email"                                | `GET /api/admin/users/by-email`                    | N/A (read)                                                        | N/A                                                                                                                                                | Yes — `byEmailMutation.isPending` disables submit                                          | N/A                                                                                         |
| **Refund** — `POST /api/admin/users/:userId/refunds`               | money-up write, backend exists                     | n/a — **no web UI at all**                                        | n/a                                                                                                                                                | n/a                                                                                        | n/a                                                                                         |
| **Payout compensation** — `POST /api/admin/payouts/:id/compensate` | money-up write, backend exists                     | n/a — **no web UI at all**                                        | n/a                                                                                                                                                | n/a                                                                                        | n/a                                                                                         |

No `DELETE` admin action exists anywhere in this vertical (grepped for
`method: 'DELETE'` across every service/component/route — zero hits).

---

## Findings

34 findings total: **P1 × 4, P2 × 11, P3 × 19.** No P0s — no authz bypass, no
IDOR (every `:id`/`:userId` scope is enforced server-side; the web layer
correctly treats `RequireAdmin` as UX-only, never as the security boundary),
no XSS (`dangerouslySetInnerHTML` grep across all 138 files: zero hits), no
secret leakage, no CSRF-relevant gap (bearer-token API, not cookie-based).

### P1

#### F-WEBADMIN-01 [P1 · LIVE] CF-23 ("bigint-exact currency rendering") is incompletely applied — `admin.treasury.tsx` still uses its own lossy `Number()` formatter on the highest-value monetary aggregates in the whole admin panel

- File: `apps/web/app/routes/admin.treasury.tsx:31-47` (function `fmtMinor`), used at lines 163, 213, 292–301, 345, and throughout the "Outstanding credit," "Ledger movements (all-time)," "Supplier flow (fulfilled)," and "LOOP-asset liabilities" sections.
- Description: The delta-manifest's CF-23 commit (`3df0e386`, "fix(web): bigint-exact currency rendering across money displays") rewrote `packages/shared/src/money-format.ts#formatMinorCurrency` to be bigint-exact past `Number.MAX_SAFE_INTEGER`, and its own commit message lists `WEB-M4 MonthlyCashbackChart.formatMinor (admin monthly + treasury charts): delegate with fractionDigits:0` as one of the fixed sites. Every other admin route file that needed a local minor-currency formatter was migrated and left a breadcrumb comment (`// A2-1520: local fmtMinor replaced with bigint-safe shared helper.`) — confirmed present in `admin._index.tsx`, `admin.assets.tsx`, `admin.assets.$assetCode.tsx`, `admin.operators.$operatorId.tsx`, `admin.orders.tsx`, `admin.orders.$orderId.tsx`. `admin.treasury.tsx` is the one route file that still carries its own hand-rolled `fmtMinor`:
  ```ts
  function fmtMinor(minor: string, currency: string): string {
    const negative = minor.startsWith('-');
    const digits = negative ? minor.slice(1) : minor;
    const padded = digits.padStart(3, '0');
    const whole = padded.slice(0, -2);
    const fraction = padded.slice(-2);
    const sign = negative ? '-' : '';
    const symbol =
      currency === 'GBP' ? '£' : currency === 'EUR' ? '€' : currency === 'USD' ? '$' : '';
    return `${sign}${symbol}${Number(whole).toLocaleString(ADMIN_LOCALE)}.${fraction} ${currency}`;
  }
  ```
  `git blame` confirms this function predates CF-23 (introduced 2026-04-21) and was never migrated when CF-23 landed two months later. `Number(whole)` is exactly the anti-pattern CF-23's own commit message calls out: "any total above ~9e15 minor units (≈$90T in cents) silently lost precision."
- Impact: `admin.treasury.tsx`'s "Outstanding credit" card is the company-wide solvency figure ("what Loop owes users right now") and "Ledger movements (all-time)" is an all-time, no-window aggregate — exactly the "fleet/solvency aggregates" the shared helper's docstring says it exists to protect. Unlike `fmtStroops` (Stellar amounts, hard-capped by the protocol's int64 stroop limit — provably safe even at full circulation), Loop's off-chain credit ledger has **no protocol-enforced ceiling**, so this is the one place on the page where the unbounded-aggregate risk is real in principle. At current Loop transaction volume this will not manifest (nowhere near $90T), so it's not an active incident, but it is a concrete, well-evidenced case of a claimed-closed CF item not actually being closed everywhere it needs to be, on the single most monetarily sensitive page in the admin panel.
- Evidence: see code excerpt above; `packages/shared/src/money-format.ts:14-17` explicitly documents "the bar charts **and treasury summaries** now delegate here instead of carrying their own lossy `Number()/100` helpers" — a claim that is false for `admin.treasury.tsx`'s own `fmtMinor`. (See also F-WEBADMIN-09 — this same anti-pattern recurs in 4+ more files across the vertical; this finding is the flagship instance because of where it renders.)
- Minimal fix: Delete the local `fmtMinor` in `admin.treasury.tsx` and import `formatMinorCurrency as fmtMinor` from `@loop/shared`, matching every sibling route file (one-line import swap; the local function's `(minor: string, currency: string) => string` signature is API-compatible).
- Better fix (if different): Same — there is no better fix here, this is a straight delegation that should have shipped with CF-23. Add a `grep`-based CI check (e.g. in `scripts/lint-docs.sh` or a new script) that fails if any `apps/web` file defines a function matching `/function fmtMinor\(/` outside `@loop/shared`, so a future "I'll just inline a quick formatter" can't silently reintroduce the bug class CF-23 was meant to eliminate fleet-wide.

#### F-WEBADMIN-02 [P1 · LIVE] Highest-stakes money-write surface (`admin.users.$userId.tsx` + `HomeCurrencyForm`) has zero render-level regression coverage

- File: `apps/web/app/routes/admin.users.$userId.tsx` (no `admin.users.$userId.test.tsx` exists in `routes/__tests__/`); `apps/web/app/components/features/admin/HomeCurrencyForm.tsx` (no `HomeCurrencyForm.test.tsx` exists at all); `CreditAdjustmentForm.test.tsx` / `AdminWithdrawalForm.test.tsx` only import and test the pure `parseAmountMajor` / `parseUnsignedAmountMajor` helper functions, never rendering `<CreditAdjustmentForm>` / `<AdminWithdrawalForm>`.
- Description: `admin.users.$userId.tsx` is the single page hosting three of the six true money-moving admin writers in the entire web admin panel: `CreditAdjustmentForm` (signed credit/debit), `AdminWithdrawalForm` (queues an irreversible on-chain payout), and `HomeCurrencyForm` (currency migration with a 409 safety preflight). All three correctly wire `useAdminStepUp`, `ConfirmDialog`, a stable per-intent `Idempotency-Key`, and `ReplayedBadge` per manual trace (see write-surface inventory above) — but none of that wiring is exercised by any automated test. Compare to `admin.payouts.$id.test.tsx`, which has a dedicated `describe('<AdminPayoutDetailRoute /> step-up retry (W-01 / CF-09)')` block asserting the modal opens on `STEP_UP_REQUIRED` and the idempotency key is reused byte-for-byte across the retry — that is the bar the three forms on this page should be held to and currently are not.
- Impact: A future refactor that accidentally drops the `stepUp.runWithStepUp(...)` wrap, breaks the `pendingPayload`/`ConfirmDialog` gate, or reintroduces a fresh-key-per-render bug (the exact class of regression the 06-15 audit's P1-7 flagged and CF-09/10 fixed) on any of these three forms would ship to production undetected by CI. This is the page where such a regression is most expensive — it directly debits/credits real user balances and queues real Stellar payouts.
- Evidence: `find apps/web/app/components/features/admin -maxdepth 1 -name "*.tsx"` vs `__tests__/` shows `HomeCurrencyForm.tsx`, `ConfirmDialog.tsx`, `ReasonDialog.tsx`, `RequireAdmin.tsx`, `CreditTransactionsTable.tsx`, `PayoutsByAssetTable.tsx` have no matching test file; `routes/__tests__/` contains tests for only 9 of 17 admin routes, and `admin.users.$userId.test.tsx` is not among them.
- Minimal fix: Add `admin.users.$userId.test.tsx` mirroring `admin.payouts.$id.test.tsx`'s step-up/idempotency assertions (mock `applyCreditAdjustment` / `applyAdminWithdrawal` / `setUserHomeCurrency` to reject once with `STEP_UP_REQUIRED`, assert the modal opens and the retry carries the same key). Add a minimal render test for `HomeCurrencyForm` (happy path + 409 same-currency rejection + reason-length validation).
- Better fix (if different): Extract a shared `expectStepUpRetryReusesKey(Component, mutationMock, triggerSubmit)` test helper (ADR-018 already admits this debt: "No admin-route test harness... extract a `test-utils/admin-mocks.ts`" once a 2nd test needs the same stubs — there are now 4+ near-identical step-up test setups) so the step-up/idempotency contract is asserted once per write surface with minimal boilerplate.

#### F-WEBADMIN-03 [P1 · LIVE] Unguarded `BigInt()` parsing on server-supplied numeric strings crashes the entire admin page on a single malformed field (4 files)

- File: `apps/web/app/components/features/admin/CreditFlowChart.tsx:150-151,182-184`; `AssetCirculationCard.tsx:109-112`; `AssetDriftBadge.tsx:77`; `SupplierSpendActivityChart.tsx:117-133`.
- Description: Every other money-bearing component in this vertical (12+ call sites across `AdminUserFlywheelChip`, `CashbackSummaryChip`, `CashbackRealizationCard`, `CashbackSparkline`, `FleetFlywheelHeadline`, `MerchantCashbackPaidCard`, `MerchantFlywheelChip`, `MerchantTopEarnersCard`, `MerchantsFlywheelShareCard`, `MerchantRailMixCard`, `PayoutsSparkline`) wraps `BigInt(serverString)` in `try/catch` and degrades gracefully (renders `null`/`'—'`/skips the row) with explicit comments like "Malformed bigint from server — bail out rather than render NaN." These four files call `BigInt(...)` directly on server-supplied strings with **no guard at all**:
  ```ts
  // CreditFlowChart.tsx — unguarded
  const c = BigInt(d.creditedMinor);
  const deb = BigInt(d.debitedMinor);
  // AssetCirculationCard.tsx — unguarded
  onChainStroops: BigInt(query.data.onChainStroops),
  ledgerLiabilityMinor: BigInt(query.data.ledgerLiabilityMinor),
  // AssetDriftBadge.tsx — unguarded
  const variant = VARIANTS[classifyDrift(BigInt(query.data.driftStroops))];
  // SupplierSpendActivityChart.tsx — unguarded, twice (max-reduce + per-row)
  const v = BigInt(d.wholesaleMinor);
  ```
  Confirmed by direct re-read of all four files (independent of the sub-agent reports that originally surfaced this) — no `try`/`catch` present at any of the cited lines.
- Impact: A single malformed/empty/null-ish numeric field in an otherwise-200 response (partial aggregation result, future schema drift, an unexpected Horizon-read shape surfacing through `AssetCirculationCard`) throws a `SyntaxError` mid-render. No admin route defines its own `ErrorBoundary` (confirmed: `grep -rn "ErrorBoundary" apps/web/app/root.tsx apps/web/app/routes/admin*.tsx` returns only `root.tsx`), so the crash propagates all the way to the app-root boundary and blanks the **entire** `/admin/treasury` or `/admin/assets/:code` page — not just the one widget — exactly the dashboard ops needs most during an incident. `AssetCirculationCard`'s own doc comment claims "other failures degrade silently (render nothing)," which this code doesn't actually deliver for malformed-but-200 payloads. None of the four components' test files exercise a malformed-numeric fixture (contrast `CashbackSparkline.test.tsx`'s "ignores rows with malformed amounts" test, which exists precisely because this bug class is known and was fixed elsewhere).
- Evidence: see excerpts above; `grep -rn "ErrorBoundary" apps/web/app/routes` confirms no per-route boundary exists for any `admin*.tsx`.
- Minimal fix: Wrap each `BigInt(...)` call site in `try/catch`, returning `null` (cards) or skipping the row (chart days), matching the pattern already used 12+ times elsewhere in this same directory.
- Better fix (if different): Extract a shared `safeBigInt(value: string): bigint | null` helper (currently reimplemented ad hoc per file with inconsistent guard coverage) and require its use for any `*Minor`/`*Stroops` field via lint rule or review checklist; backfill malformed-input tests for all four components; consider adding a route-level `ErrorBoundary` on the admin layout so a future instance of this bug class degrades to "this widget failed to load" instead of blanking the whole page.

#### F-WEBADMIN-04 [P1 · LIVE] Triage-tier landing cards (`StuckOrdersCard`, `StuckPayoutsCard`) don't poll, contradicting ADR-018's Triage-tier definition and their own doc comments

- File: `apps/web/app/components/features/admin/StuckOrdersCard.tsx:25-31`; `apps/web/app/components/features/admin/StuckPayoutsCard.tsx` (matching pattern).
- Description: ADR-018 explicitly classifies stuck-orders/stuck-payouts as the canonical **Triage tier**: _"Triage endpoints poll — they have a `refetchInterval` in the client so ops sees backlogs drain in real time... a tab left open on `/admin` doesn't eat a user's budget."_ Both `/admin`-landing cards use only `staleTime: 60_000` with **no `refetchInterval`** — confirmed by direct re-read:
  ```ts
  const query = useQuery({
    queryKey: ['admin-stuck-orders'],
    queryFn: getStuckOrders,
    retry: shouldRetry,
    staleTime: 60_000, // no refetchInterval
  });
  ```
  The dedicated `/admin/stuck-orders` page (`routes/admin.stuck-orders.tsx:53-59,187-194`) correctly implements `staleTime: 15_000, refetchInterval: 30_000` for the identical underlying data — proving the polling pattern was known and applied elsewhere but missed on these two landing-page cards. Worse, `StuckOrdersCard.tsx`'s own docstring asserts behavior it doesn't have: _"Polls the dashboard endpoint every 60s (matches the admin-treasury cadence)"_ — confirmed false by the code immediately below it.
- Impact: Ops watching the `/admin` landing page during an active incident (the explicit scenario ADR-018 calls out) won't see the stuck-order/payout count change until they navigate away and back or the tab regains focus. The at-a-glance triage signal looks frozen exactly when real-time visibility matters most.
- Evidence: see code excerpt above vs. `admin.stuck-orders.tsx:57-58`.
- Minimal fix: Add `refetchInterval: 30_000` (matching the dedicated page) to both queries.
- Better fix (if different): Same change, plus a fake-timer regression test asserting the interval fires (neither test file currently exercises this, which is consistent with how the regression shipped unnoticed).

### P2

#### F-WEBADMIN-05 [P2 · LIVE] 8 of 17 admin routes have no route-level test; `admin.payouts.tsx` (list, a delta-flagged file) duplicates CF-09's step-up logic with zero coverage of its own

- File: `apps/web/app/routes/admin._index.tsx`, `admin.cashback.tsx`, `admin.merchants.tsx`, `admin.merchants.$merchantId.tsx`, `admin.payouts.tsx`, `admin.treasury.tsx`, `admin.users.$userId.tsx` — none have a matching file in `routes/__tests__/`.
- Description: Of these, `admin.payouts.tsx` is the most concerning: it is one of the two delta-flagged files for this audit (explicitly called out for "extra adversarial scrutiny" alongside `admin.payouts.$id.tsx`), and it re-implements the identical CF-09 step-up-retry + stable-idempotency-key pattern as the well-tested detail route (`retryMutation` wrapping `stepUp.runWithStepUp(() => retryPayout(args))`, key minted once in `handleReasonResolve`) — as a separate, independently-maintained copy of the logic with no test asserting it behaves the same way. Manual trace confirms the list route's implementation is correct today, but a future edit to one copy without the other would go undetected.
- Impact: Regression risk on the second of two delta-flagged files; asymmetric test coverage between near-identical implementations of the same money-write retry logic.
- Evidence: `routes/__tests__/admin.payouts.$id.test.tsx` exists with a full step-up suite; `routes/__tests__/admin.payouts.test.tsx` does not exist.
- Minimal fix: Add `admin.payouts.test.tsx` covering at minimum: state/kind filter rendering, the retry-button → `ReasonDialog` → step-up-retry flow with the same `idempotencyKey`-reuse assertion as the detail-route test.
- Better fix (if different): Factor the shared retry-mutation logic (currently duplicated verbatim between the two routes — same `useMutation` shape, same `handleReasonResolve`, same comments) into a single `usePayoutRetry()` hook so the CF-09 contract is implemented and tested exactly once, then both routes consume it.

#### F-WEBADMIN-06 [P2 · LIVE] Admin step-up token store is never cleared on logout, despite its own docstring — confirmed still open from the 06-15 audit (P2-6)

- File: `apps/web/app/stores/admin-step-up.store.ts:26-31`.
- Description: The docstring says `clear()` is "called explicitly on admin logout, on `STEP_UP_INVALID` / `STEP_UP_SUBJECT_MISMATCH` responses, and when the UI detects an already-expired token before the next call." Grepping every consumer of `useAdminStepUpStore` (`apps/web/app/hooks/use-admin-step-up.ts`, `apps/web/app/services/api-client.ts`) shows `clear()`/`clearStepUp` is only invoked from inside `runWithStepUp`'s catch block on a step-up failure response — never from any logout, session-clear, or cross-tab-logout path.
- Impact: A logged-out (or account-switched) browser tab keeps a valid step-up JWT sitting in memory for up to its 5-minute TTL. Blast radius is bounded (5 min, and the backend still independently checks the bearer access token + step-up `sub` match), but it contradicts the documented invariant and is a real gap on a shared/kiosk admin workstation.
- Evidence: `grep -rn "useAdminStepUpStore" apps/web/app` returns exactly 3 non-store call sites, none in a logout path.
- Minimal fix: Call `useAdminStepUpStore.getState().clear()` from wherever the access-token/session logout action lives (`auth.store`'s clear/logout), and from any cross-tab logout broadcast handler.
- Better fix (if different): Additionally have the admin shell call `clear()` whenever `useAuth().isAuthenticated` transitions `true → false`, so the invariant holds even if a future logout path is added that doesn't go through the canonical `auth.store` action.

#### F-WEBADMIN-07 [P2 · LIVE] `useAdminStepUp`'s `pendingResolve` is held in `useState`, not a ref/queue — a second concurrent `runWithStepUp` call silently drops the earlier pending mutation — confirmed still open from the 06-15 audit (P2-9)

- File: `apps/web/app/hooks/use-admin-step-up.ts:56-61,89-113`.
- Description: `pendingResolve` is `useState<{ fn, resolve, reject } | null>`. If `runWithStepUp` is invoked a second time on the same hook instance before the first invocation's promise has resolved, `setPendingResolve` overwrites the first entry — the earlier pending mutation's `resolve`/`reject` closures are orphaned and that caller's `await` never settles. Implementation is unchanged from the 06-15 audit's finding.
- Impact: A hung mutation/spinner that never clears for whichever caller's request was clobbered. Currently low practical likelihood since each write surface creates its own `useAdminStepUp()` instance and each form independently disables its submit control while its single mutation is pending, but the hook's contract doesn't actually prevent the race and there's no test asserting single-flight behavior.
- Evidence: `use-admin-step-up.ts:56-61` uses `useState`, not `useRef`; no test in `use-admin-step-up.test.ts` exercises two overlapping `runWithStepUp` calls.
- Minimal fix: Hold pending entries in a `useRef<Array<{...}>>([])` (small FIFO queue) instead of `useState`, processing them in order on `handleStepUpConfirm`/`handleStepUpCancel`.
- Better fix (if different): Same; add a regression test firing two `runWithStepUp` calls back-to-back before the modal resolves and asserting both eventually settle.

#### F-WEBADMIN-08 [P2 · LIVE] Two ADR-017 money-movement primitives (refund, payout-compensation) have no admin web UI anywhere — confirmed still open from the 06-15 audit ("Tooling utility gap #2")

- File: n/a (absence) — verified via `grep -rli "refund\|compensat" apps/web/app/components/features/admin apps/web/app/routes/admin*.tsx apps/web/app/services/admin*.ts`, which only turns up `refund` as a _display_ label (`CreditTransactionsTable.tsx`'s type pill, `admin.treasury.tsx`'s ledger-movements column header, `CreditTransactionType` in `services/admin.ts`) — no form, button, or service writer exists for `POST /api/admin/users/:userId/refunds` or `POST /api/admin/payouts/:id/compensate`.
- Description: Both backend endpoints exist as ADR-017-compliant, step-up-gated money-up writers (per ADR 028's gated-surface list and the prior backend audit) but neither has a corresponding `ConfirmDialog` + `ReasonDialog` + `StepUpModal` + `ReplayedBadge`-wrapped form anywhere in the web admin surface, unlike credit-adjust/withdrawal/home-currency.
- Impact: Ops must `curl` the raw API (including manually crafting and threading the `X-Admin-Step-Up` header and an `Idempotency-Key`) to issue a goodwill refund or compensate a stuck withdrawal — the two most support-ticket-relevant money-up actions in the product. Operational-friction and audit-trail-consistency concern: every other ADR-017 write gets a guided, validated UI; these two are curl-only, an out-of-band path prone to typos, missing reasons, or accidental cap evasion.
- Evidence: grep above; no `refunds` or `compensate` path string appears in any `services/admin*.ts` writer function.
- Minimal fix: None possible client-side-only — requires shipping a `RefundForm` (mirrors `CreditAdjustmentForm`, positive-only, with an `orderId` field) and a `CompensatePayoutButton`/dialog (mirrors `MerchantResyncButton`'s reason-dialog pattern, mounted on `admin.payouts.$id.tsx` for `state==='failed'` rows), plus their `services/admin-*.ts` writer functions with the same `Idempotency-Key`/step-up wiring as the existing four writers.
- Better fix (if different): Same; land both as a single PR following the exact `CreditAdjustmentForm`/`AdminWithdrawalForm` template so the UI inherits the established, tested pattern.

#### F-WEBADMIN-09 [P2 · LIVE] Systemic duplication of a lossy local `fmtMinor`-style money formatter across at least 5 more files beyond F-WEBADMIN-01

- File: `apps/web/app/components/features/admin/CreditFlowChart.tsx:25-38`; `SupplierSpendActivityChart.tsx:32-40`; `TopUsersTable.tsx:22-34` (`fmtPositiveMinor`); `UserCashbackByMerchantTable.tsx:17-25` (`fmtCashback`).
- Description: Each of these files independently hand-rolls a minor-unit → currency-string formatter using `Number(whole).toLocaleString(...)` instead of importing `formatMinorCurrency` from `@loop/shared`, which exists specifically to retire this anti-pattern (CF-23). `SupplierSpendCard.tsx`, `UserOrdersTable.tsx`, and `UsersRecyclingActivityCard.tsx` in the same directories already correctly import the shared helper, showing the better pattern is well-established and simply not applied uniformly. The `TopUsersTable`/`UserCashbackByMerchantTable` versions at least guard with `isFinite`/em-dash fallback (fail safe on bad input, unlike F-WEBADMIN-01/03's unguarded sites), but all four still lose precision via `Number(whole)` past 2^53.
- Impact: Low practical risk at Loop's current per-user/per-window cashback scale, but it's the same bug class CF-23 was meant to retire fleet-wide, now confirmed surviving in at least 5 files across this vertical (this finding + F-WEBADMIN-01's `admin.treasury.tsx` instance), plus inconsistent currency-symbol/locale handling between the hand-rolled versions (e.g. `CreditFlowChart`'s 3-entry hardcoded `$`/`£`/`€` map vs. `Intl.NumberFormat`'s locale-aware symbol placement in the shared helper).
- Evidence:
  ```ts
  // CreditFlowChart.tsx
  function fmtMinor(minor: string, currency: Cur): string {
    ...
    return `${sign}${SYMBOL[currency]}${Number(whole).toLocaleString(ADMIN_LOCALE)}.${fraction}`;
  }
  ```
- Minimal fix: Swap all four to `formatMinorCurrency` from `@loop/shared` (verify output format parity with existing test snapshots before swapping, since exact string output may shift slightly e.g. narrow vs. wide currency symbol).
- Better fix (if different): Add the CI grep check proposed in F-WEBADMIN-01 to prevent further instances; treat this as a single cleanup PR across all 6 known offending files (this finding's 4 + F-WEBADMIN-01's 1 + any others a full-repo grep for `Number(whole)` / `Number(...).toLocaleString` surfaces).

#### F-WEBADMIN-10 [P2 · LIVE] Flywheel/cashback percentage formatters aren't clamped to `[0, 100]`, unlike the analogous success-rate helpers in the same vertical

- File: `apps/web/app/components/features/admin/FleetFlywheelHeadline.tsx:77`; `MerchantFlywheelChip.tsx:83`; `MerchantsFlywheelShareCard.tsx:85`; `packages/shared/src/money-format.ts:153-158` (`pctBigint`, consumed by 4+ files in this vertical).
- Description: `OperatorStatsCard.successRatePct`, `MerchantOperatorMixCard.successPct`, and `OperatorMerchantMixCard.successPct` all explicitly clamp with `Math.max(0, Math.min(100, pct))`. The flywheel/cashback "X% by count" / "Y% by charge" computations (`(recycled/total)*100`, and the shared `pctBigint`) do not clamp at all.
- Impact: `recycledOrderCount`/`recycledChargeMinor` should be a subset of `totalFulfilledCount`/`totalChargeMinor` by definition, but if the backend computes these via two separate aggregate queries with no transactional guarantee, a timing skew could transiently show e.g. "112.4% of spend" on a financial dashboard — confusing during exactly the incident-triage moments these cards exist for.
- Evidence:
  ```ts
  // FleetFlywheelHeadline.tsx — no clamp
  const pctOrders = ((loopAssetCount / snap.totalOrders) * 100).toFixed(1);
  // packages/shared/src/money-format.ts — no clamp
  export function pctBigint(numerator: bigint, denominator: bigint): string | null {
    if (denominator <= 0n) return null;
    const bp = (numerator * 10000n) / denominator;
    return `${(Number(bp) / 100).toFixed(1)}%`;
  }
  ```
- Minimal fix: Clamp the rendered count percentages in the three components to `[0, 100]`, matching the operator-mix helpers.
- Better fix (if different): Add clamping to the shared `pctBigint` itself so every caller gets it for free, plus a test fixture where `numerator > denominator`.

#### F-WEBADMIN-11 [P2 · LIVE] `MerchantCashbackPaidCard` has no drill-down link, violating the ADR-018 "must be a link" invariant

- File: `apps/web/app/components/features/admin/MerchantCashbackPaidCard.tsx:81-124`.
- Description: ADR-018: "when an aggregate row's value is queryable on a detail endpoint, the row **must** be a link... `SupplierSpendCard` currency cells link to `/admin/orders?chargeCurrency=<code>`." This card renders a per-currency table (currency, fulfilled count, cashback paid out, % of spend) on `/admin/merchants/:merchantId` but has no `Link` import at all — no way to drill from a currency row into the underlying orders.
- Impact: An operator looking at "GBP: £36.00 cashback paid, 6.0% of spend" has no one-click path to the orders behind that number, unlike every sibling card on the same page (`MerchantRailMixCard` links by paymentMethod, `MerchantTopEarnersCard` links by user) — breaks the documented one-click triage UX, and the working precedent for stacking filters (`merchantId` + a second filter) already exists elsewhere (`UserCashbackByMerchantTable` stacks `merchantId&userId`).
- Evidence: No `import { Link }` in the file; `<td>{bucket.currency}</td>` renders plain text.
- Minimal fix: Wrap the currency cell in `<Link to={`/admin/orders?merchantId=${encodeURIComponent(merchantId)}&chargeCurrency=${encodeURIComponent(bucket.currency)}&state=fulfilled`}>`.
- Better fix (if different): Same fix, plus a test asserting the constructed href (matching `MerchantRailMixCard.test.tsx`'s existing "drill links include..." pattern).

#### F-WEBADMIN-12 [P2 · LIVE] `AdminUserFlywheelChip` silently presents lifetime totals while its ADR-022 sibling (`MerchantFlywheelChip`) uses a disclosed 31-day window — shape-parity gap

- File: `apps/web/app/components/features/admin/AdminUserFlywheelChip.tsx:30-102`; `apps/web/app/services/admin-user-drill.ts:58-67`; `apps/web/app/services/admin-merchant-drill.ts:40-50`.
- Description: `AdminMerchantFlywheelStats` (merchant axis) has a `since: string // ISO-8601 start of the 31-day window` field, and `MerchantFlywheelChip.tsx` renders copy like "...none paid in the last 31 days." `AdminUserFlywheelStats` (user axis) has **no `since` field at all**, and `AdminUserFlywheelChip.tsx`'s copy never mentions any time period — it is a lifetime aggregate.
- Impact: ADR-022 mandates "shape parity across the four [viewports]: same response field names... same defaults where applicable." An operator pivoting between `MerchantFlywheelChip` (31d) and `AdminUserFlywheelChip` (lifetime) on adjacent drill pages, comparing the same nominal metric, has no UI signal that the denominators cover different time ranges — risk of a wrong inference during a support investigation.
- Evidence:
  ```ts
  // admin-merchant-drill.ts — has `since`
  export interface AdminMerchantFlywheelStats { merchantId: string; since: string; ... }
  // admin-user-drill.ts — no `since` field
  export interface AdminUserFlywheelStats { userId: string; currency: string; recycledOrderCount: number; ... }
  ```
- Minimal fix: Add a "lifetime" qualifier to `AdminUserFlywheelChip`'s copy/`aria-label` so the scope difference is visible without reading source.
- Better fix (if different): Decide whether the per-user endpoint should also window to 31 days for true ADR-022 parity, or formally document the intentional divergence in ADR-022's "Status of this pattern" section.

#### F-WEBADMIN-13 [P2 · LIVE] `SettlementLagCard` per-asset rows are missing the ADR-018 drill-down link

- File: `apps/web/app/components/features/admin/SettlementLagCard.tsx:90-99`.
- Description: `PayoutsByAssetTable.tsx` (same directory) already links its `assetCode` cell to `/admin/payouts?assetCode=<code>`, and `TopUsersByPendingPayoutCard` links to the identical URL shape. `SettlementLagCard`'s per-asset table renders `r.assetCode` as plain text with no link despite the same detail endpoint/filter existing.
- Impact: Ops looking at a slow p95 for `GBPLOOP` has no one-click path into the underlying payout rows from this card, undermining ADR-018's "one click to the rows behind it" promise.
- Evidence: `<td className="py-0.5 font-mono">{r.assetCode}</td>` — plain text, no `Link`.
- Minimal fix: Wrap in `<Link to={`/admin/payouts?assetCode=${encodeURIComponent(r.assetCode ?? '')}`}>`.
- Better fix (if different): Same, with an `aria-label` matching the `TopUsersByPendingPayoutCard` convention (`Review in-flight ${assetCode} payouts`).

#### F-WEBADMIN-14 [P2 · LIVE] `RealizationSparkline`'s "X% today" label can silently show a stale day mislabeled as today

- File: `apps/web/app/components/features/admin/RealizationSparkline.tsx:72-74`.
- Description: `latest` is `values[values.length - 1]`, i.e. the last day that has any rows in the 30-day window — `toDailyBps` only includes days present in the backend's `rows` array. If today (UTC) hasn't accrued any cashback-realization activity yet, there's no row for today, so `values[length-1]` is actually yesterday's (or older) rate, but the UI unconditionally labels it `"${latestPct}% today"` with no date shown.
- Impact: Ops reads a number labeled "today" that's actually from a prior day, with no visual cue it's stale — the same "silent staleness" class ADR-022's "zero-volume should show 'no data yet'" principle exists to prevent, here manifesting via the "no data for the latest period" angle instead.
- Evidence:
  ```tsx
  const values = query.data !== undefined ? toDailyBps(query.data.rows) : [];
  const latest = values.length > 0 ? values[values.length - 1]! : 0;
  ...
  subtitle={`${latestPct}% today`}
  ```
- Minimal fix: Track the actual day-string for the last entry and only render "today" when it equals the caller's UTC-today; otherwise render "as of `<date>`".
- Better fix (if different): Have the backend response include an explicit `asOf`/`day` field per data point so the FE never has to infer "is this today" from array position.

#### F-WEBADMIN-15 [P2 · LIVE] `UserOrdersTable` / `UserPayoutsTable` silently truncate at 25 rows with no pagination affordance despite the backend supporting a cursor

- File: `apps/web/app/components/features/admin/UserOrdersTable.tsx:34-40`; `UserPayoutsTable.tsx:28-34`.
- Description: Both call their list endpoints with a fixed `limit: 25` and never use the `before` cursor that `services/admin-orders.ts` / `services/admin-payouts.ts` both support. Neither shows a "showing latest 25" indicator, a "load more" control, or any signal that older rows exist.
- Impact: A support agent investigating a specific older order/payout for an active user with >25 more-recent rows sees no trace of it and no indication the table is truncated — risk of incorrectly concluding the row doesn't exist, directly undercutting the component's stated triage purpose.
- Evidence:
  ```tsx
  const query = useQuery({
    queryKey: ['admin-user-orders', userId, LIMIT], // LIMIT = 25, no cursor, no "more" UI
    queryFn: () => listAdminOrders({ userId, limit: LIMIT }),
    ...
  });
  ```
- Minimal fix: Add a "Load more" button wired to `before: <last row's createdAt>` when `rows.length === LIMIT` (heuristic for "might have more"), matching the pattern `CreditTransactionsTable.tsx` already uses.
- Better fix (if different): Have the backend return an explicit `hasMore`/cursor token (consistent with ADR-018's CSV-export truncation-sentinel philosophy) so the FE doesn't have to guess from a full page.

### P3

#### F-WEBADMIN-16 [P3 · LIVE] StepUpModal's error text is not announced to assistive tech — confirmed still open from the 06-15 audit (P3-7)

- File: `apps/web/app/components/features/admin/StepUpModal.tsx:162`.
- Description: `{error !== null && <p className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}` has no `role="alert"`/`aria-live`, unlike every sibling write form (`CreditAdjustmentForm`/`AdminWithdrawalForm`/`HomeCurrencyForm` wrap `formError` in `<div role="alert">`).
- Impact: A screen-reader user who mistypes the OTP or hits 503 `STEP_UP_UNAVAILABLE` gets no announcement of the failure.
- Evidence: compare `StepUpModal.tsx:162` (plain `<p>`) to `CreditAdjustmentForm.tsx:247-252` (`<div role="alert">`).
- Minimal fix: Add `role="alert"` to the `<p>`.
- Better fix (if different): Same, plus a regression test asserting `screen.getByRole('alert')` after an OTP rejection.

#### F-WEBADMIN-17 [P3 · LIVE] OTP input in `StepUpModal` lacks `autoComplete="one-time-code"` / `inputMode="numeric"` (WCAG 2.2 SC 3.3.8 / checklist Part-6 §37)

- File: `apps/web/app/components/features/admin/StepUpModal.tsx:134-141`.
- Description: The verification-code `<Input type="text" label="Verification code" .../>` passes no `autoComplete`/`inputMode`. `Input.tsx` forwards arbitrary `...props` to the underlying `<input>`, so this is a missing prop, not a component limitation.
- Impact: No one-tap OTP autofill offer on supporting platforms; on-screen keyboard defaults to full QWERTY instead of numeric — friction, not a security issue, but a real accessible-authentication regression relative to WCAG 2.2 intent.
- Evidence: `StepUpModal.tsx:134-141`.
- Minimal fix: Add `autoComplete="one-time-code"` and `inputMode="numeric"`.
- Better fix (if different): Also add `pattern="[0-9]*"` for older Android numeric-keypad heuristics.

#### F-WEBADMIN-18 [P3 · LIVE] Nested `<form>` elements in three write forms (invalid HTML content model)

- File: `apps/web/app/components/features/admin/CreditAdjustmentForm.tsx`, `AdminWithdrawalForm.tsx`, `HomeCurrencyForm.tsx` (each renders `<form onSubmit={...}>...<ConfirmDialog/>...</form>`, and `ConfirmDialog.tsx` itself renders `<dialog><form method="dialog">...</form></dialog>`).
- Description: HTML5 forbids nested `<form>` elements. React's imperative DOM construction (not the HTML parser) means this doesn't trip the parser's "drop the nested tag" behavior — Enter-to-submit inside `ConfirmDialog`'s controls correctly resolves to the dialog's own inner form (nearest-ancestor-form semantics) — but it's still invalid markup outside the spec's defined behavior for DOM-API-constructed trees.
- Impact: Low in current rendering mode; not exploitable; an HTML validator or some AT form-landmark heuristics would flag it.
- Evidence: `AdminWithdrawalForm.tsx:164-178` (outer `<form>` containing `<ConfirmDialog/>`); `ConfirmDialog.tsx:62-97` (`<dialog><form method="dialog">`).
- Minimal fix: Document the constraint with a one-line comment so a future maintainer doesn't "fix" it by moving the dialog inline into the form's submit flow in a way that changes behavior.
- Better fix (if different): Move `<ConfirmDialog>`/`<StepUpModal>` to a portal (`createPortal(..., document.body)`) so the JSX/DOM nesting matches the actual UI semantics (top-layer overlay, not a form descendant).

#### F-WEBADMIN-19 [P3 · LIVE] `isFresh()` on the step-up store is dead code; `api-client.ts` sends a possibly-expired step-up token instead of pre-emptively minting a fresh one

- File: `apps/web/app/stores/admin-step-up.store.ts:33,41-49` (`isFresh()`); `apps/web/app/services/api-client.ts:247-254` (step-up header attachment).
- Description: `isFresh()` is fully implemented but `grep -rn "isFresh" apps/web/app` shows it is never called anywhere. `api-client.ts`'s header-attachment logic only checks `stepUpToken !== null && length > 0` — not freshness — so a held-but-expired token is optimistically sent, the backend 401s, and only then does the catch-and-retry path kick in (after first an unrelated access-token-refresh round trip, since the generic 401-retry logic doesn't distinguish "access token expired" from "step-up token expired").
- Impact: Pure latency/round-trip inefficiency on the unhappy path; no security impact (backend remains the authoritative `exp` check).
- Evidence: `grep -rn "isFresh" apps/web/app` returns only the definition site.
- Minimal fix: Call `isFresh()` before attaching the header in `api-client.ts`, skipping straight to the step-up-required path on a known-stale token; or delete `isFresh()` if unused.
- Better fix (if different): Use `isFresh()` to short-circuit, and separately track "is this 401 a step-up failure vs. an access-token failure" in the generic retry path.

#### F-WEBADMIN-20 [P3 · LIVE] Three independent, slightly-divergent relative-time formatters across the vertical (now beyond the "deliberate duplication" threshold)

- File: `apps/web/app/components/features/admin/UserCashbackByMerchantTable.tsx:27-36`; `UserOperatorMixCard.tsx:17-27`; `UsersRecyclingActivityCard.tsx:120-140` (plus a fourth/fifth near-identical copy already present in `AdminAuditTail.tsx`/`ConfigsHistoryCard.tsx`, covered separately in F-WEBADMIN-02's scope but the same pattern).
- Description: All three implement "relative time ago" independently and diverge subtly — `UserOperatorMixCard` has an explicit `mins < 1 → 'just now'` branch the other two lack or implement differently; `UsersRecyclingActivityCard` adds a `>7-day` locale-date fallback the others don't have. `UserCashbackByMerchantTable`'s own docstring acknowledges the duplication is deliberate ("kept independently refactorable"), but with two more near-duplicates beyond that one, the pattern has drifted past "deliberate" into genuine inconsistency (an order 30 seconds old can read "0m ago" in one table and "just now" in another).
- Impact: Inconsistent operator-facing copy for the same concept across adjacent admin pages; any future bugfix (e.g. a negative-duration guard) has to be applied three-plus times.
- Minimal fix: No immediate action required given the documented rationale, but flag for ADR-019's "third consumer" promotion threshold — three-plus consumers now exist.
- Better fix (if different): Extract one `formatRelativeTime(iso, opts?)` into `@loop/shared` or `~/utils/`, used by all instances.

#### F-WEBADMIN-21 [P3 · LIVE] `fmtRelative`/`successPct` duplicated verbatim across `MerchantOperatorMixCard`, `OperatorMerchantMixCard`, `OperatorStatsCard`

- File: `apps/web/app/components/features/admin/MerchantOperatorMixCard.tsx:21-31`; `OperatorMerchantMixCard.tsx:18-28`; `OperatorStatsCard.tsx:23-33`.
- Description: Identical function bodies (byte-for-byte) for both the relative-time formatter and the clamped success-rate formatter exist in three sibling files.
- Impact: Three independent places to keep in sync; ADR-022 explicitly anticipates this exact situation ("A frontend helper... should be shared across all four UI callers rather than duplicated") and ADR-019's three-part rule triggers extraction once a third consumer emerges — there are now three.
- Evidence: identical `function fmtRelative(iso: string): string { ... }` blocks in all three files.
- Minimal fix: Extract both helpers into a shared module (e.g. `./mix-card-format.ts`) and import from the three call sites.
- Better fix (if different): Promote to `@loop/shared` once a 4th consumer (e.g. a future asset-mix card per ADR-023's "how to add a fourth axis") appears, per ADR-019.

#### F-WEBADMIN-22 [P3 · LIVE] `dayTotalStroops` (`PayoutsSparkline`) and `dayTotalMinor` (`CashbackSparkline`) are near-identical duplicate reducers

- File: `apps/web/app/components/features/admin/PayoutsSparkline.tsx:21-31`; `CashbackSparkline.tsx:16-29`.
- Description: Both sum a per-currency/per-asset minor-unit array into a single bigint-safe `Number`, with identical try/catch-skip-bad-row logic and an identical doc-comment caveat about `Number(BigInt)` lossiness past 2^53. Only the field names differ.
- Impact: Low risk, but exactly the duplication `Sparkline.tsx`'s own docstring says it was built to stop for chart chrome — the per-day-sum helper itself didn't get consolidated.
- Minimal fix: Extract a generic `sumBigintField<T>(rows: T[], pick: (r: T) => string): number` helper shared by both.

#### F-WEBADMIN-23 [P3 · LIVE] `SettlementLagCard.formatSeconds` boundary rounding mislabels near-minute values

- File: `apps/web/app/components/features/admin/SettlementLagCard.tsx:115-119`.
- Description: For `s` in `[59.5, 60)`, the function takes the `s < 60` branch and returns `Math.round(s)` = `60`, producing the label `"60s"` instead of crossing into the minutes bucket (`"1.0m"`).
- Impact: Cosmetic — a p95 of 59.6s displays as "60s" rather than "1.0m"; could read as a typo to an operator scanning the dashboard.
- Evidence:
  ```ts
  export function formatSeconds(s: number): string {
    if (s < 60) return `${Math.round(s)}s`; // 59.6 → "60s"
    if (s < 3600) return `${(s / 60).toFixed(1)}m`;
    return `${(s / 3600).toFixed(1)}h`;
  }
  ```
- Minimal fix: Branch on the rounded value: `const rounded = Math.round(s); if (rounded < 60) return `${rounded}s`;`.

#### F-WEBADMIN-24 [P3 · LIVE] Inconsistent `encodeURIComponent` usage on `Link` path segments across the vertical (10+ sites)

- File: `apps/web/app/components/features/admin/TopUsersByPendingPayoutCard.tsx:73`; `TopUsersTable.tsx:133`; `UserOrdersTable.tsx:88`; `UserPayoutsTable.tsx:82`; `PayoutsByAssetTable.tsx:84,103`; `apps/web/app/routes/admin.stuck-orders.tsx:268`.
- Description: These interpolate a backend-sourced id/code directly into a route path (`/admin/users/${row.userId}`, `/admin/payouts?assetCode=${row.assetCode}`, etc.) without `encodeURIComponent`, while sibling components in the same directories (`UserCashbackByMerchantTable`, `UserOperatorMixCard`, `UserRailMixCard`, `UsersRecyclingActivityCard`, `admin.assets.tsx`, `admin.treasury.tsx`) consistently encode every id-bearing path/query segment.
- Impact: Low in practice — these ids/codes are either UUIDs/opaque order ids from trusted authenticated backend JSON, or closed-enum asset codes, not raw user input, so there's no real injection/IDOR path today. It's an inconsistent defensive posture that the next person copying the pattern for a less-constrained value would inherit.
- Minimal fix: Wrap all interpolations in `encodeURIComponent` for consistency with the rest of the directory.

#### F-WEBADMIN-25 [P3 · LIVE] `OrdersSparkline`'s two-series chart relies solely on color to distinguish lines

- File: `apps/web/app/components/features/admin/OrdersSparkline.tsx:36-49`.
- Description: The `Created`/`Fulfilled` series differ only by `colorClass` (blue vs green); neither sets a `dashArray`. `PayoutsSparkline`/`CashbackSparkline` both deliberately give their secondary series a `dashArray: '3 3'` + thinner `strokeWidth` specifically so the two lines "read distinctly" without relying on color alone, per `PayoutsSparkline`'s own docstring.
- Impact: Minor a11y/usability gap for colorblind operators relative to its sibling charts; mitigated somewhat by legend text labels.
- Minimal fix: Give the `Fulfilled` series a `dashArray` (or differing `strokeWidth`) matching the sibling charts' pattern.

#### F-WEBADMIN-26 [P3 · LIVE] Two components implement an incomplete ARIA-tabs pattern for a currency picker (`CreditFlowChart`, `SupplierSpendActivityChart`)

- File: `apps/web/app/components/features/admin/CreditFlowChart.tsx:75-111`; `SupplierSpendActivityChart.tsx:72-108`.
- Description: Both `CurrencyPicker` implementations use `role="tablist"` / `role="tab"` / `aria-selected`, which signals the full ARIA Tabs pattern to assistive tech (arrow-key roving-tabindex navigation, an associated `tabpanel`). Neither implements arrow-key handling or `aria-controls`/`role="tabpanel"`; selection is plain `onClick`. `TopUsersTable.tsx`'s own window-toggle in the same vertical already uses the simpler, correctly-scoped `aria-pressed` button-group pattern instead.
- Impact: Screen-reader users land on a tablist that doesn't behave like one — a known axe/`eslint-plugin-jsx-a11y` anti-pattern; functional via mouse/Tab+Enter, so not a hard blocker.
- Minimal fix: Drop the `tablist`/`tab` roles in both files in favor of a plain button group with `aria-pressed`, matching `TopUsersTable`'s already-precedented pattern.
- Better fix (if different): Or implement the full ARIA Tabs contract (arrow-key nav + `aria-controls` → `role="tabpanel"`) in both — the drop-the-roles fix is lower-risk and there's no cross-file consistency cost either way since no other tab pattern exists to match.

#### F-WEBADMIN-27 [P3 · LIVE] `admin.cashback.tsx` shares one `useMutation` instance across every table row — the per-row "Saving…" indicator can misrepresent a still-in-flight earlier save

- File: `apps/web/app/routes/admin.cashback.tsx:118-137,269`.
- Description: All merchant rows share the single `saveMutation` object (`saving = saveMutation.isPending && saveMutation.variables?.merchantId === m.id`). If an operator confirms a save on merchant A, then before it settles confirms a save on merchant B, calling `.mutate()` again does not cancel A's in-flight request (it still completes and its shared `onSuccess`/`onError` still fires) — but `saveMutation.variables` now reflects B, so A's row stops showing "Saving…" the instant B's click registers.
- Impact: Cosmetic only — both writes apply correctly (each mints its own fresh `Idempotency-Key`, no double-apply risk) — but the UI under-represents in-flight state for the non-latest row, which could lead an operator to believe a save failed/never started when it's actually still completing.
- Minimal fix: None required given correctness is unaffected; if polish is wanted, track in-flight merchantIds in a `Set` updated via `onMutate`/`onSettled` instead of relying on `saveMutation.variables`.

#### F-WEBADMIN-28 [P3 · LIVE] `RequireAdmin` collapses "transient network/server error" and "confirmed non-admin" into identical denial copy

- File: `apps/web/app/components/features/admin/RequireAdmin.tsx:71-86`.
- Description: `denied = me.data === undefined || me.data.isAdmin === false || (me.error instanceof ApiException && (status===401||403))`. Any query failure (network timeout, 500, malformed-response parse failure) leaves `me.data === undefined`, treated identically to "signed-in account is not marked as admin" — same "Admin access required" banner either way.
- Impact: This is the _correct_ security posture (fail closed, never flash the admin shell on an ambiguous state) and is explicitly documented as intentional. The only issue is the copy: a legitimate admin hitting a backend blip sees a message reading as "you are not an admin" rather than "couldn't verify, try again" — mildly confusing during exactly the kind of incident an admin would be using this page for.
- Minimal fix: None required for security; optionally branch the copy for the non-`ApiException`/5xx case ("Couldn't verify admin access — try reloading") vs. the explicit 401/403/`isAdmin:false` case.
- Better fix (if different): Add a "Retry" button for the ambiguous case so an admin doesn't need a full page reload to re-fire the `/me` query.

#### F-WEBADMIN-29 [P3 · LIVE] `DiscordNotifiersCard`'s channel→class lookup has no fallback for an unrecognized channel; the response isn't runtime-validated

- File: `apps/web/app/components/features/admin/DiscordNotifiersCard.tsx:20-24,110-116`; `apps/web/app/services/admin-discord.ts:21`.
- Description: `CHANNEL_CLASSES: Record<AdminDiscordNotifier['channel'], string>` is indexed directly with no `?? fallback`. `getAdminDiscordNotifiers()` is a TS-generic-cast-only call with no Zod/runtime schema. If the backend's `DISCORD_NOTIFIERS` catalog ships a 4th channel before the frontend's hardcoded union is updated (plausible — backend/web deploy independently), `CHANNEL_CLASSES[n.channel]` is `undefined` and the literal string `"undefined"` splices into the className.
- Impact: Cosmetic only (pill loses color styling), but reachable and has zero test coverage pinning the fallback behavior.
- Minimal fix: `${CHANNEL_CLASSES[n.channel] ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`.
- Better fix (if different): Add a Zod schema for the notifiers response, consistent with the project-wide "all upstream responses are Zod-validated" principle.

#### F-WEBADMIN-30 [P3 · LIVE] `MerchantStatsTable`'s drill target no longer matches ADR-018's documented example

- File: `apps/web/app/components/features/admin/MerchantStatsTable.tsx:90-103`; `docs/adr/018-admin-panel-architecture.md:41-42`.
- Description: ADR-018 documents: "`/admin/cashback` MerchantStatsTable rows link to `/admin/orders?merchantId=<slug>`." The current code links to `/admin/merchants/${merchantId}` instead, per an in-file comment explaining the deliberate change (#621).
- Impact: Low functional risk (the new behavior is arguably better), but it's a literal example in a load-bearing architecture doc that's now stale — exactly the class of drift AGENTS.md's "Documentation update rules" table exists to prevent.
- Minimal fix: Update the ADR-018 example to `/admin/merchants/<slug>` with a note that `/admin/orders?merchantId=<slug>` remains reachable via the drill page's "See all orders" link.

#### F-WEBADMIN-31 [P3 · LIVE] No `<th scope="col">` on any table across 10 components in this vertical

- File: `MerchantStatsTable.tsx`, `OperatorStatsCard.tsx`, `MerchantOperatorMixCard.tsx`, `OperatorMerchantMixCard.tsx`, `MerchantRailMixCard.tsx`, `MerchantCashbackPaidCard.tsx`, `MerchantTopEarnersCard.tsx`, `MerchantsFlywheelShareCard.tsx`, `CashbackRealizationCard.tsx`, `DiscordNotifiersCard.tsx`.
- Description: Zero `scope=` attributes across all `<th>` elements in every table-rendering component in this batch.
- Impact: Minor — simple single-header-row tables are usually still parsed correctly by screen readers without `scope`, but it's standard zero-cost a11y practice, and its complete absence across all 10 tables suggests no lint rule currently catches it.
- Minimal fix: Add `scope="col"` to every `<th>` in these files; consider enabling the `jsx-a11y/scope` ESLint rule if not already on.

#### F-WEBADMIN-32 [P3 · LIVE] `OperatorMerchantMixCard` rebuilds the full merchant-name `Map` on every render

- File: `apps/web/app/components/features/admin/OperatorMerchantMixCard.tsx:44-45`.
- Description: `const nameById = new Map(merchants.map((m) => [m.id, m.name] as const));` runs on every render with no `useMemo`, rebuilding a `Map` over the entire merchant catalog (1,000+ entries per ADR-032) on each re-render.
- Impact: Minor perf nit, not currently a hot path.
- Minimal fix: `const nameById = useMemo(() => new Map(...), [merchants]);`.

#### F-WEBADMIN-33 [P3 · LIVE] `MerchantFlywheelChip` hardcodes "31 days" as a magic literal and silently diverges by one day from its sibling sparkline's window

- File: `apps/web/app/components/features/admin/MerchantFlywheelChip.tsx:66,77-79`; `MerchantFlywheelActivityChart.tsx:11,64-67`.
- Description: `MerchantFlywheelChip` embeds the literal string "31 days" twice in JSX copy with no named constant, unlike `MerchantFlywheelActivityChart` which defines `const WINDOW_DAYS = 30`. Both cards sit on the same `/admin/merchants/:merchantId` page, both badged "flywheel," covering windows one day apart.
- Impact: Low-severity but a real "is this number actually consistent with that chart?" trap for an operator correlating the two cards, and a maintenance hazard if the backend's window ever changes (the chip's copy won't move with it).
- Minimal fix: Define `const WINDOW_DAYS = 31` (or derive display text from `stats.since`) and interpolate, matching the sibling chart's pattern.

#### F-WEBADMIN-34 [P3 · LIVE] `AdminAuditTail` and `ConfigsHistoryCard` each carry their own copy of `fmtRelative` — third+ instance of the relative-time duplication pattern

- File: `apps/web/app/components/features/admin/AdminAuditTail.tsx:37-47`; `ConfigsHistoryCard.tsx:101-111`.
- Description: Both define and export their own `fmtRelative(iso: string): string`, byte-for-byte identical to each other and to the pattern flagged in F-WEBADMIN-20/21 (`UserOperatorMixCard`, `MerchantOperatorMixCard`, `OperatorStatsCard`, `UserCashbackByMerchantTable`, `UsersRecyclingActivityCard`) — bringing the total independent copies of "relative time ago" formatting across this vertical to 7+.
- Impact: Same as F-WEBADMIN-20/21 — consistency/maintenance burden, not a functional bug; included separately here because these two are in the write-surface/infra file set (read directly by the lead agent) rather than the sub-agent batches, confirming the duplication is vertical-wide, not isolated to the read-only display-component batches.
- Minimal fix / Better fix: Same as F-WEBADMIN-20/21 — extract one shared `formatRelativeTime` helper used by all 7+ call sites.

---

## Delta re-verification

**CF-09/10 (step-up modal mount on payouts route + stable Idempotency-Key per
intent so a post-completion re-click doesn't double-apply): CLOSED. Verified
on both delta-flagged files.**

Evidence:

1. **`admin.payouts.tsx`** (list route) and **`admin.payouts.$id.tsx`**
   (detail route) both mount `<StepUpModal>` conditionally on
   `stepUp.modalOpen` (`useAdminStepUp()` hook), and both mint the
   `Idempotency-Key` exactly once, at the moment the operator confirms the
   reason in `<ReasonDialog onResolve={handleReasonResolve}>`:
   ```ts
   // admin.payouts.tsx:155-164 / admin.payouts.$id.tsx:108-116 (identical pattern)
   const handleReasonResolve = (reason: string | null): void => {
     const id = reasonDialogId;
     setReasonDialogId(null);
     if (id === null || reason === null) return;
     setRetryingId(id);
     setRetryError(null);
     retryMutation.mutate({ id, reason, idempotencyKey: generateIdempotencyKey() });
   };
   ```
2. The minted key is captured in the `useMutation`'s `args` closure;
   `runWithStepUp` (`use-admin-step-up.ts:89-113`) re-invokes the **same**
   `fn` (i.e. the same `() => retryPayout(args)` closure, with the same
   `args.idempotencyKey`) when the step-up modal resolves successfully — it
   does not regenerate `args`, so the retry-after-step-up genuinely re-sends
   the identical `Idempotency-Key` header
   (`services/admin-payouts.ts:117-132`:
   `headers: { 'Idempotency-Key': args.idempotencyKey ?? generateIdempotencyKey() }`,
   and the route always supplies `args.idempotencyKey`, so the `??` fallback
   never triggers in this call path).
3. This is **directly asserted by a passing test**, not just inferred from
   reading the code: `routes/__tests__/admin.payouts.$id.test.tsx`, test
   `'reuses the same Idempotency-Key across the step-up retry (CF-09)'`
   (lines 240–290) mocks `retryPayout` to reject once with
   `STEP_UP_REQUIRED` then resolve, drives the full Send-code → enter-OTP →
   Confirm flow through the real `<StepUpModal>`, and asserts
   `secondArgs?.idempotencyKey === firstArgs?.idempotencyKey`.
4. The same pattern (mint-once-at-confirm, reuse-via-closure,
   `useAdminStepUp` wrap) is consistently applied to the other three
   step-up-gated writers in this vertical — `CreditAdjustmentForm.tsx`,
   `AdminWithdrawalForm.tsx`, `HomeCurrencyForm.tsx` — confirming this isn't
   a one-off fix scoped narrowly to payouts but a vertical-wide pattern.

**Caveats (not a regression of CF-09/10, but adjacent gaps surfaced during
re-verification — see the findings above for full detail):**

- `admin.payouts.tsx` (the list route, one of the two delta-flagged files)
  has **no test of its own** asserting this — only the detail route does
  (F-WEBADMIN-05). The list route's implementation is correct by manual
  trace, but the identical logic exists twice with asymmetric coverage.
- `MerchantResyncButton` and `admin.cashback.tsx`'s Save action still mint a
  fresh key per call with no caller-supplied-key threading — correct and
  expected, since ADR-028 deliberately excludes both surfaces from step-up
  (resync = read-only effect, cashback-config = reversible/audited), so
  there is no step-up-interruption case to survive for either. Not a finding
  against CF-09/10's actual scope.
- Two sibling money-up backend primitives (refund, payout-compensation) have
  no web UI at all, so CF-09/10's pattern was never extended to them on the
  frontend — pre-existing gap (F-WEBADMIN-08), not a CF-09/10 regression.

---

## Coverage confirmation

**138/138 files read.** Breakdown:

**Routes (17/17)** — read directly by the lead agent: `admin._index.tsx`,
`admin.assets.tsx`, `admin.assets.$assetCode.tsx`, `admin.audit.tsx`,
`admin.cashback.tsx`, `admin.merchants.tsx`, `admin.merchants.$merchantId.tsx`,
`admin.operators.tsx`, `admin.operators.$operatorId.tsx`, `admin.orders.tsx`,
`admin.orders.$orderId.tsx`, `admin.payouts.tsx`, `admin.payouts.$id.tsx`,
`admin.stuck-orders.tsx`, `admin.treasury.tsx`, `admin.users.tsx`,
`admin.users.$userId.tsx`.

**Route tests (9/9)** — read directly: `admin.assets.test.tsx`,
`admin.assets.$assetCode.test.tsx`, `admin.audit.test.tsx`,
`admin.operators.test.tsx`, `admin.operators.$operatorId.test.tsx`,
`admin.orders.$orderId.test.tsx`, `admin.payouts.$id.test.tsx`,
`admin.stuck-orders.test.tsx`, `admin.users.test.tsx`.

**Components — write-surface + infra (16/16, read directly)**:
`AdminAuditTail.tsx`, `AdminNav.tsx`, `AdminWithdrawalForm.tsx`,
`ConfigsHistoryCard.tsx`, `ConfirmDialog.tsx`, `CopyButton.tsx`,
`CreditAdjustmentForm.tsx`, `CreditTransactionsTable.tsx`,
`CsvDownloadButton.tsx`, `HomeCurrencyForm.tsx`, `MerchantResyncButton.tsx`,
`PayoutsByAssetTable.tsx`, `ReasonDialog.tsx`, `ReplayedBadge.tsx`,
`RequireAdmin.tsx`, `StepUpModal.tsx`.

**Component tests — write-surface + infra (10/10, read directly)**:
`AdminAuditTail.test.tsx`, `AdminNav.test.tsx`, `AdminWithdrawalForm.test.tsx`,
`ConfigsHistoryCard.test.tsx`, `CopyButton.test.tsx`,
`CreditAdjustmentForm.test.tsx`, `CsvDownloadButton.test.tsx`,
`MerchantResyncButton.test.tsx`, `ReplayedBadge.test.tsx`,
`StepUpModal.test.tsx`. (6 components have no test file at all —
`ConfirmDialog`, `ReasonDialog`, `RequireAdmin`, `HomeCurrencyForm`,
`CreditTransactionsTable`, `PayoutsByAssetTable` — see F-WEBADMIN-02.)

**Components — read-only display surfaces, batch A (22/22, sub-agent + lead
spot-check on P1 claims)**: `AdminMonthlyCashbackChart`, `AdminUserFlywheelChip`,
`AssetCirculationCard`, `AssetDriftBadge`, `AssetDriftWatcherCard`,
`CashbackRealizationCard`, `CashbackSparkline`, `CashbackSummaryChip`,
`CreditFlowChart`, `DiscordNotifiersCard`, `FleetFlywheelHeadline`,
`MerchantCashbackMonthlyChart`, `MerchantCashbackPaidCard`,
`MerchantFlywheelActivityChart`, `MerchantFlywheelChip`,
`MerchantOperatorMixCard`, `MerchantRailMixCard`, `MerchantsFlywheelShareCard`,
`MerchantStatsTable`, `MerchantTopEarnersCard`, `OperatorMerchantMixCard`,
`OperatorStatsCard`, each with its `.test.tsx` (22/22 tests).

**Components — read-only display surfaces, batch B (21/21, sub-agent + lead
spot-check on P1 claims)**: `OrdersSparkline`, `PaymentMethodActivityChart`,
`PaymentMethodShareCard`, `PayoutsSparkline`, `RealizationSparkline`,
`SettlementLagCard`, `Sparkline`, `StuckOrdersCard`, `StuckPayoutsCard`,
`SupplierSpendActivityChart`, `SupplierSpendCard`,
`TopUsersByPendingPayoutCard`, `TopUsersTable`, `TreasuryReconciliationChart`,
`UserCashbackByMerchantTable`, `UserCashbackMonthlyChart`,
`UserOperatorMixCard`, `UserOrdersTable`, `UserPayoutsTable`,
`UserRailMixCard`, `UsersRecyclingActivityCard`, each with its `.test.tsx`
(21/21 tests).

Total: 17 + 9 + 16 + 10 + 22 + 22 + 21 + 21 = **138/138**.

Both sub-agent passes' top (P1) claims were independently re-verified by the
lead agent re-reading the cited source files directly (not just trusting the
sub-agent's excerpt) before being included in this report — see
F-WEBADMIN-03 and F-WEBADMIN-04's evidence sections, both confirmed via a
fresh `grep`/`Read` pass by the lead agent.
