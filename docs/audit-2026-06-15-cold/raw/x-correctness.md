# X-CORRECTNESS — Whole-tree correctness / code-smell cross-cutting sweep (cold audit 2026-06-15)

Branch `fix/stranded-order-hardening`. Adversarial grep-guided whole-tree sweep
across `apps/backend/src`, `apps/web/app`, `packages/shared/src`, `tools/`, then
per-hit judgement (intentional vs bug). Covers checklist §1 (correctness/logic),
§4 (error handling), and cross-cutting sweeps 2–7 (floating-promise, error-swallow,
money-as-float, missing-timeout, missing-Zod, off-by-one/operator, enum-exhaustiveness).

---

## Coverage

| #   | Sweep                              | Sites examined                                                                          | Verdict                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Floating / unawaited promises      | ~40 `notify*` fire-and-forget + 12 worker `setInterval(()=>void tick())` + DB writes    | **Clean.** Every `notify*` self-catches inside `sendWebhook` (try/catch wraps whole body + `AbortSignal.timeout(5000)`) → floating promise can never reject. Every worker tick self-catches with single-flight guard. No un-awaited `db.insert/update/delete` in credits/orders/payments. |
| 2   | Empty / swallowing catch           | 0 in app code; ~21 in `tools/` (operator scripts); ~16 `.catch(()=>null)` json-then-zod | **Clean in app code.** `.catch(()=>null)` before `safeParse` is the canonical safe pattern. `tools/` empty catches are lower-stakes operator scripts. 1 minor: `purchase.store.ts:143` chain-reset swallow [P3-04].                                                                       |
| 3   | **Money as float**                 | 60+ `*100`//`100`, `parseFloat`, `Number(` on minor/bigint                              | **See complete site list below.** All actual money MATH is bigint (cashback-split, FX, payout). Float sites are display-formatting, rate/percentage boundary conversions, or the documented legacy-proxy `amount:number` wire shape. 2 worth flagging.                                    |
| 4   | Missing fetch timeout              | 25 backend + 6 web fetch call sites                                                     | **1 real miss:** `sitemap.tsx:42` [P2-01]. 1 defense-in-depth gap: `ctx/stream.ts:104` [P3-01]. All others have `AbortSignal.timeout`.                                                                                                                                                    |
| 5   | Missing Zod on input               | every `c.req.json()` handler + ~36 upstream `.json()` files                             | **Clean.** 0 handlers read body without `safeParse`. Operator-pool config Zod-validated. Upstream Horizon/CTX/FX all Zod. Web is documented typed-cast pure-client [P3-02].                                                                                                               |
| 6   | Off-by-one / inverted / `==`/`===` | clustering bbox, amount-sufficient, slug/pagination, loose-eq grep                      | **Clean.** 0 loose `==`. Clustering bounds + zoom clamp correct. amount-sufficient fail-closed `>=`.                                                                                                                                                                                      |
| 7   | Enum non-exhaustiveness            | 8 backend + 2 web switches; 5 `assertNever`                                             | **1 minor:** `watcher.ts:376` second switch lacks `assertNever` [P3-03]. Currency/asset/credit-type switches TS-exhaustive (return-typed). `LoopOrdersList` uses `assertNever`.                                                                                                           |

---

## Findings

### [P2-01] SSR sitemap loader fetch has no timeout (sibling geo-redirect does)

- **severity:** P2
- **file:** `apps/web/app/routes/sitemap.tsx:42-45`
- **impact:** `sitemap.tsx` is one of only two documented loaders that fetch
  server-side. Its sibling `home-geo-redirect.tsx:34` correctly bounds its fetch
  with `AbortSignal.timeout(2000)`; the sitemap fetch to
  `/api/public/top-cashback-merchants` is **unbounded**. A hung/slow backend (or
  CTX behind it) hangs the sitemap SSR render indefinitely, tying up an SSR
  worker on a crawler-facing route. The asymmetry with the geo-redirect sibling
  makes this an oversight, not a deliberate choice.
- **evidence:** `fetch(\`${apiBaseUrl()}/api/public/top-cashback-merchants...\`, { headers: { Accept: 'application/json' } })`— no`signal`. Compare `home-geo-redirect.tsx:32-35`.
- **fix:** add `signal: AbortSignal.timeout(2000)` (or similar) to the fetch init; the existing `try/catch` already returns `null` → empty-but-valid sitemap on abort.
- **req ref:** AGENTS.md critical-rule #1 (loader exceptions); checklist §4 (timeouts on every IO).

### [P3-01] CTX SSE stream fetch enforces no default timeout of its own

- **severity:** P3
- **file:** `apps/backend/src/ctx/stream.ts:100-104`
- **impact:** `streamGiftCardStatus` only sets `init.signal` when the caller
  passes `opts.signal`; the bare `fetch(url, init)` has no internal failsafe. The
  sole live caller (`procurement-redemption.ts:171-177`) does pass an
  AbortController with `totalTimeoutMs`, so this is safe today — but a future
  internal caller that forgets the signal would hang the procurement worker on a
  stuck SSE connection-open. Defense-in-depth gap, not a live bug.
- **fix:** inject a default `AbortSignal.timeout(...)` (compose with caller's via `AbortSignal.any`) so the helper is safe regardless of caller discipline.
- **req ref:** checklist §4 (timeouts on every IO); §28 (CTX SSE handling).

### [P3-02] Web API client returns `response.json() as T` with zero runtime validation

- **severity:** P3
- **file:** `apps/web/app/services/api-client.ts:115`
- **impact:** Backend responses are trusted via a TypeScript cast, not parsed
  against a schema. This is the documented pure-API-client posture (the backend
  Zod-validates everything it sources from upstream), so it's acceptable by
  architecture — but it means a backend↔web contract drift surfaces as an
  undefined-access crash at render time, not a clean typed error at the seam. No
  defensive Zod on the highest-trust boundary the web has.
- **fix (optional/Phase-2):** validate at least the money/auth-bearing response shapes (orders, credits, wallet) with shared Zod schemas re-exported from `@loop/shared`.
- **req ref:** ADR 019 (shared types); checklist §22 (type-contract integrity).

### [P3-03] `watcher.ts` second outcome switch has no `assertNever` default

- **severity:** P3
- **file:** `apps/backend/src/payments/watcher.ts:376-406`
- **impact:** The first switch over `ProcessOutcome.kind` (line 321) is
  return-typed so TS forces exhaustiveness. The second switch (376) is a
  statement switch with no `default:` — adding a new `ProcessOutcome.kind`
  variant later would compile clean and silently fall through (no counter
  incremented, **no `recordSkip` written**), which in this exact file is the
  cursor-advance / orphaned-deposit failure class the surrounding CRIT #1/#2
  comments are guarding against.
- **fix:** add `default: return assertNever(outcome, 'ProcessOutcome')` (or `assertNever` in a final `else`) to the line-376 switch.
- **req ref:** checklist §1 (enum exhaustiveness / assertNever); §11 (cursor advancement safety).

### [P3-04] `purchase.store` persist-queue swallows the failing op silently

- **severity:** P3
- **file:** `apps/web/app/stores/purchase.store.ts:142-145`
- **impact:** `persistQueue = persistQueue.catch(() => {}).then(op)` resets the
  chain on failure (correct — one failed persist shouldn't poison subsequent
  ops), but the _rejection of the current op_ is never logged or surfaced. A
  Capacitor Preferences write that fails (native storage full / permission) is
  invisible: the pending-order persistence the comment says it's protecting can
  silently no-op. Low stakes (in-memory state still drives the UI), but it's a
  swallow with no observability.
- **fix:** `.catch((err) => log.warn(...))` instead of `() => {}`, or attach a `.catch` to the `op` result that logs.
- **req ref:** checklist §4 (no swallowed errors that hide failures); §6 (error → observability).

### [P3-05] Legacy CTX-proxy order path carries money as a JS float on the wire

- **severity:** P3
- **file:** `apps/backend/src/orders/get-handler.ts:64-71` (`parseMoney`), `list-handler.ts:72` (`parseMoneyOrNull`)
- **impact:** The legacy `/api/orders` + `/api/orders/:id` proxy path reads
  upstream `cardFiatAmount` via `parseFloat` into a `number` `amount` and forwards
  it in the legacy `Order` shape. No math is done on it (display-only forwarding),
  and the loop-native path uses bigint minor units, so there's no precision loss
  in a stored/computed value. But money-as-float on the wire is a smell and a
  divergence from the loop-native bigint discipline; flagged for completeness
  since the legacy path is still alive until the takeover completes.
- **fix:** none required while legacy path is display-only; track for retirement with the CTX-proxy path.
- **req ref:** ADR 010 (two order paths); checklist §25 (minor-unit/bigint everywhere; no float money).

---

## Money-as-float — COMPLETE site inventory (tree-wide)

Classification: **MATH-OK** = actual money arithmetic, done in bigint (safe);
**RATE/PCT** = float on a percentage/exchange-rate at the correct boundary (safe);
**DISPLAY** = float only for human-rendering / Intl.format (lossy only past ~2^53
minor units, documented & unrealistic); **WIRE** = float money on the API wire
(legacy path, P3-05); **INPUT-VALIDATION** = float used to bounds-check a bigint
input, not to compute a stored value (safe).

### Backend

| File:line                                                                                                           | Expression                                                      | Class                                                        |
| ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `orders/cashback-split.ts:56`                                                                                       | `100 - parseFloat(userCashbackPct) - parseFloat(loopMarginPct)` | RATE/PCT (env config pct → display string)                   |
| `orders/cashback-split.ts:71-85`                                                                                    | `applyPct` bigint `(face × hundredths)/10_000n`                 | **MATH-OK (bigint)**                                         |
| `orders/loop-handler.ts:116,118`                                                                                    | `BigInt(Math.round(denominations.min/max * 100))`               | INPUT-VALIDATION (catalog denom bounds)                      |
| `orders/loop-handler.ts:136-138`                                                                                    | `parseFloat(d)` … `BigInt(Math.round(n * 100))`                 | INPUT-VALIDATION (fixed-denom match)                         |
| `orders/loop-create-response.ts:103,115`                                                                            | `Number(order.faceValueMinor) / 100`                            | DISPLAY (Discord notify amount)                              |
| `orders/get-handler.ts:66` `parseMoney`                                                                             | `parseFloat(raw)` → `amount:number`                             | **WIRE (legacy, P3-05)**                                     |
| `orders/list-handler.ts:74` `parseMoneyOrNull`                                                                      | `parseFloat(raw)` → `amount:number`                             | **WIRE (legacy, P3-05)**                                     |
| `payments/price-feed-fx.ts:112`                                                                                     | `Math.ceil(100_000 / usdPerTarget)`                             | RATE/PCT (stroops-per-cent from rate)                        |
| `payments/price-feed-fx.ts:172,186`                                                                                 | `BigInt(Math.round(rate * Number(SCALE)))`                      | RATE/PCT (FX rate → scaled int; math then bigint)            |
| `payments/price-feed-fx.ts:151-192`                                                                                 | `convertMinorUnits` SCALE=1e9 bigint rationals                  | **MATH-OK (bigint)**                                         |
| `payments/interest-pool-watcher.ts:105`                                                                             | `Number(poolStroops)/Number(dailyInterestStroops)`              | DISPLAY (days-of-cover ratio, threshold metric)              |
| `admin/interest-mint-forecast.ts:127`                                                                               | `Number(poolStroops)/Number(dailyInterestStroops)`              | DISPLAY (forecast ratio)                                     |
| `admin/*-mix.ts`, `*-share.ts`, `payouts-*.ts`, `top-users*`, `merchant-*` (`toNumber` helpers)                     | `Number(bigint)` for counts/percentages                         | DISPLAY (admin aggregates; counts not money, or bounded pct) |
| `admin/operators-snapshot-csv.ts:90`                                                                                | `(f/o)*100`                                                     | DISPLAY (fulfillment rate %)                                 |
| `public/cashback-preview.ts:97-99`                                                                                  | `Number(pct)`, `Math.round(parsed*100)`                         | RATE/PCT (pct string → bps), then bigint preview math        |
| `public/cashback-stats.ts:54-56`, `flywheel-stats.ts:97`                                                            | `Number(bigint)` / `*100`                                       | DISPLAY (public stats; counts/percentages)                   |
| `merchants/sync-upstream.ts:122`                                                                                    | `savingsPercentage / 100`                                       | RATE/PCT (display fraction)                                  |
| `clustering/handler.ts:18-21`, `data-store.ts:139-140`                                                              | `parseFloat` lat/lng                                            | N/A (geo coords, not money)                                  |
| `env.ts:731-732`                                                                                                    | `parseFloat(DEFAULT_*_PCT)`                                     | RATE/PCT (env config percentage)                             |
| `discord/shared.ts:132,142` `formatAmount`                                                                          | `amount.toFixed(2)`                                             | DISPLAY (notify; bigint variant `formatMinorAmount` exists)  |
| `discord/shared.ts:172`                                                                                             | `Number(whole).toLocaleString`                                  | DISPLAY (separator only; lossy past ~9e15 minor)             |
| `credits/pending-payouts-user.ts:89`, `users/cashback-by-merchant.ts:151`, `admin/user-cashback-by-merchant.ts:138` | `Number(r.count/order_count)`                                   | DISPLAY (row counts, not money)                              |

### Shared

| `packages/shared/src/money-format.ts:54-72` `formatMinorCurrency` | bigint int/frac split, `Number` only for Intl | DISPLAY (canonical safe formatter) |
| `packages/shared/src/money-format.ts:96-105` `recycledBps` | `(num*10000n)/denom` bigint, `Number` on bounded [0,10000] | **MATH-OK (bigint ratio)** |
| `packages/shared/src/cashback-realization.ts:30-33` `recycledBps` | `(spent*10000n)/earned` bigint | **MATH-OK (bigint ratio)** |

### Web

| `components/features/home/MobileHome.tsx:112` | `Math.round(o.amount * 100 * (pct/100))` | DISPLAY (best-effort client fallback estimate while backend pending — comment documents) |
| `components/features/home/MobileHome.tsx:122,491,498,654` | `Number(lifetimeMinor)`, `cents/100`, `amount*(pct/100)` | DISPLAY (hero tile; comment notes safe-int range) |
| `components/features/purchase/AmountSelection.tsx:42,45,75,91,121` | `(amount*pct)/100`, `Math.round(amount*100)/100`, `parseFloat` | DISPLAY/INPUT-VALIDATION (cashback estimate + the documented IEEE-754 two-decimal input check) |
| `components/features/purchase/EarnedCashbackCard.tsx:45` | `Number(userCashbackPct)` | RATE/PCT (display pct) |
| `components/features/cashback/*`, `admin/*` (`CashbackBalanceCard`, `TopUsersTable`, `CreditTransactionsTable`, `CashbackRealizationCard`, `AssetCirculationCard`, `CreditFlowChart`, `MonthlyCashbackChart`, `PaymentMethodShareCard`, `TreasuryReconciliationChart`, `CashbackSparkline`, `PayoutsSparkline`, `CreditFlowChart`, `Merchant*`, `Operator*Mix`, `User*Mix`, `Supplier*`, `Fleet*`) | `Number(minor)/100`, `(v*10000n)/total`, `(count/total)*100` | DISPLAY (admin/cashback rendering; bps-via-bigint where precision matters — comments cite A2-1520/A2-1522) |

### Tools (operator scripts — not in product runtime)

| `tools/ctx-catalog/ezpin-allocate.mjs:113,133`, `svs-allocate.mjs:72`, `tillo-allocate.mjs:110` | `Math.round(Number(pct) * 100)` → basis-points | RATE/PCT (supplier discount % → bps; correct boundary) |
| `tools/ctx-catalog/demo-seed.mjs:137` | `(Number(balanceMinor)/100).toFixed(2)` | DISPLAY (seed-script log) |

**Net money-float verdict:** zero float arithmetic on a value that gets _stored_
or _settled_. Every storable/settled money value is computed in bigint
(cashback-split `applyPct`, FX `convertMinorUnits`, payout stroops). Float appears
only in (a) display formatting, (b) percentage/exchange-rate boundary conversions,
(c) bigint-input bounds-checks, and (d) the legacy CTX-proxy wire shape (P3-05).

---

## Summary

- **P0:** none.
- **P1:** none.
- **P2:** 1 — `sitemap.tsx` SSR loader fetch missing timeout (hangs an SSR worker on slow backend; sibling geo-redirect has one).
- **P3:** 5 — SSE stream no internal default timeout (defense-in-depth); web API client no runtime Zod (documented pure-client); `watcher.ts` second switch missing `assertNever` (silent fall-through if a new outcome variant is added, in the cursor-safety file); `purchase.store` persist-queue swallows op failure with no log; legacy CTX-proxy carries money as float on the wire.
- **Money-as-float site count:** **~60 sites** inventoried tree-wide; **0** do float math on a stored/settled value. All product money math is bigint. Only smell is the legacy-proxy `amount:number` wire shape [P3-05].
- **Overall:** the codebase is unusually disciplined on these axes. Floating promises are uniformly `void`-wrapped over self-catching async; fetches uniformly carry `AbortSignal.timeout` (one SSR-loader miss); every request body is Zod-validated; no loose equality; money math is bigint end-to-end. The findings are hardening/observability nits, not correctness defects on live money paths.
