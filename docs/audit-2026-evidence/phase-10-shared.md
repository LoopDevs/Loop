# Phase 10 — Shared package (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Audit branch:** `main`
**Date captured:** 2026-04-23

---

## 1. Package-level facts

- `packages/shared/package.json` — one runtime dep `@bufbuild/protobuf@2.11.0`, no other deps. Exports map covers `.` and `./src/proto/*`. `main: ./src/index.ts`. Private (monorepo-only).
- `packages/shared/src/` — 16 TS source files + `proto/clustering_pb.ts`. 845 total lines of source.
- **No Node-only APIs.** `grep "process\.|require(|fs\.|path\.|os\.|Buffer|react|__dirname|__filename"` across `packages/shared/src` returns zero matches.
- **No React APIs.** Ditto.
- **No internal relative imports between shared files.** `grep "^import.*from '\./"` in `packages/shared/src` (excluding `proto/`) returns zero matches. G5-66 circular-import check trivially passes (`madge` unavailable; structural check shows zero edges in the internal graph). Only external import is `@bufbuild/protobuf/codegenv2` from the generated `proto/clustering_pb.ts`.
- Proto regeneration reproducibility confirmed in Phase 4 — not re-verified here.

---

## 2. Per-file disposition

| File                               | Lines | Exports                                                                                                                                                                                                                  | Disposition                         |
| ---------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| `index.ts`                         | 15    | barrel `export * from` for every non-proto file                                                                                                                                                                          | audited-clean                       |
| `api.ts`                           | 130   | `ApiError`, `ApiException`, `Platform`, `DEFAULT_CLIENT_IDS`, `ApiErrorCode`, `ApiErrorCodeValue`, `RequestOtpRequest`, `VerifyOtpRequest`, `VerifyOtpResponse`, `RefreshRequest`, `RefreshResponse`, `ImageProxyParams` | audited-findings-4 (A2-800..A2-803) |
| `cashback-realization.ts`          | 34    | `recycledBps(earnedMinor: bigint, spentMinor: bigint): number`                                                                                                                                                           | audited-findings-1 (A2-810)         |
| `credit-transaction-type.ts`       | 37    | `CREDIT_TRANSACTION_TYPES`, `CreditTransactionType`, `isCreditTransactionType`                                                                                                                                           | audited-findings-1 (A2-811)         |
| `loop-asset.ts`                    | 89    | `HOME_CURRENCIES`, `HomeCurrency`, `LOOP_ASSET_CODES`, `LoopAssetCode`, `CURRENCY_TO_ASSET_CODE`, `loopAssetForCurrency`, `isLoopAssetCode`, `isHomeCurrency`                                                            | audited-findings-2 (A2-812..A2-813) |
| `merchants.ts`                     | 120   | `Merchant`, `MerchantDenominations`, `MerchantListResponse`, `MerchantDetailResponse`, `MerchantAllResponse`, `MerchantListParams`, `LocationPoint`, `ClusterPoint`, `ClusterResponse`, `ClusterParams`                  | audited-findings-1 (A2-814)         |
| `money-format.ts`                  | 78    | `formatMinorCurrency`, `pctBigint`                                                                                                                                                                                       | audited-findings-1 (A2-815)         |
| `order-state.ts`                   | 55    | `ORDER_STATES`, `OrderState`, `isOrderState`, `TERMINAL_ORDER_STATES`, `TerminalOrderState`, `isTerminalOrderState`, `ORDER_PAYMENT_METHODS`, `OrderPaymentMethod`, `isOrderPaymentMethod`                               | audited-findings-2 (A2-816..A2-817) |
| `orders.ts`                        | 86    | `OrderStatus`, `Order`, `CreateOrderRequest`, `CreateOrderResponse`, `OrderListResponse`                                                                                                                                 | audited-findings-1 (A2-818)         |
| `payout-state.ts`                  | 23    | `PAYOUT_STATES`, `PayoutState`, `isPayoutState`                                                                                                                                                                          | audited-findings-1 (A2-819)         |
| `public-cashback-stats.ts`         | 34    | `PerCurrencyCashback`, `PublicCashbackStats`                                                                                                                                                                             | audited-clean                       |
| `public-merchant.ts`               | 33    | `PublicMerchantDetail`                                                                                                                                                                                                   | audited-clean                       |
| `public-top-cashback-merchants.ts` | 37    | `TopCashbackMerchant`, `PublicTopCashbackMerchantsResponse`                                                                                                                                                              | audited-clean                       |
| `search.ts`                        | 19    | `foldForSearch`                                                                                                                                                                                                          | audited-clean                       |
| `slugs.ts`                         | 14    | `merchantSlug`                                                                                                                                                                                                           | audited-clean                       |
| `stellar.ts`                       | 41    | `STELLAR_PUBKEY_REGEX`, `isStellarPublicKey`                                                                                                                                                                             | audited-findings-2 (A2-820..A2-821) |
| `proto/clustering_pb.ts`           | 165   | protoc-gen-es generated; `Coordinates`, `Geometry`, `LocationProperties`, `ClusterProperties`, `LocationPoint`, `ClusterPoint`, `Bounds`, `ProtobufClusterResponse`                                                      | generated                           |

---

## 3. Symbol × consumer matrix (§5.5)

**Legend** — B = imported by `apps/backend`, W = imported by `apps/web`, — = no consumer. "local-dup" = consumer re-implements or re-declares the same shape without importing.

### 3.1 `api.ts`

| Symbol               | B   | W   | Notes                                                                                                                             |
| -------------------- | --- | --- | --------------------------------------------------------------------------------------------------------------------------------- |
| `ApiError`           | —   | W   | `apps/web/app/services/{api-client,clusters}.ts` only                                                                             |
| `ApiException`       | —   | W   | 40+ web call sites (services, routes, components, tests); backend never imports — it returns `{code, message}` JSON, web wraps it |
| `Platform`           | —   | —   | **Never imported.** `apps/web/app/native/platform.ts:3` re-declares `Platform = 'ios'\|'android'\|'web'` locally — A2-800         |
| `DEFAULT_CLIENT_IDS` | B   | W   | backend `env.ts`, web `services/api-client.ts`                                                                                    |
| `ApiErrorCode`       | —   | —   | **Zero consumers in `apps/`** — A2-801                                                                                            |
| `ApiErrorCodeValue`  | —   | —   | **Zero consumers in `apps/`** — A2-801                                                                                            |
| `RequestOtpRequest`  | —   | W   | `apps/web/app/services/auth.ts` only                                                                                              |
| `VerifyOtpRequest`   | —   | W   | `apps/web/app/services/auth.ts` only                                                                                              |
| `VerifyOtpResponse`  | —   | W   | `apps/web/app/services/auth.ts` only                                                                                              |
| `RefreshRequest`     | —   | W   | `apps/web/app/services/api-client.ts` only                                                                                        |
| `RefreshResponse`    | —   | —   | **Zero consumers in `apps/`.** Backend's `openapi.ts:87` has a same-named zod const but does NOT import this type — A2-802        |
| `ImageProxyParams`   | —   | W   | `apps/web/app/utils/image.ts` only                                                                                                |

**Note on auth/image request+response types:** Backend never imports the request/response types from shared — it Zod-validates at the handler with its own local schemas, and the openapi registration redeclares its own const of the same name. The web is the sole compile-time consumer. They still pass the ADR 019 three-part test because the JSON wire format crosses the boundary even if the TS symbol doesn't (same argument the PR 80 close-out used for `CreateOrderRequest`). Flagged as A2-803 for visibility: the backend could compile a `CreateOrderRequest`-shaped response that disagrees with the shared type and only web tests would catch it.

### 3.2 `cashback-realization.ts`

| Symbol        | B   | W   | Notes                                                                                                                                                                                                                                                                                                                          |
| ------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `recycledBps` | B   | —   | Backend `admin/cashback-realization.ts`, `admin/cashback-realization-daily.ts`, `admin/cashback-realization-daily-csv.ts`. **Web re-implements inline** in `apps/web/app/components/features/admin/RealizationSparkline.tsx:22-48` (`toDailyBps`) — A2-810. The file header claims the web uses the shared helper; it doesn't. |

### 3.3 `credit-transaction-type.ts`

| Symbol                     | B   | W   | Notes                                                                                                                                                                                                                          |
| -------------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CREDIT_TRANSACTION_TYPES` | B   | —   | backend `admin/user-credit-transactions.ts`                                                                                                                                                                                    |
| `CreditTransactionType`    | —   | —   | **Shared export unused.** `apps/web/app/services/admin.ts:1853` declares its own union `type CreditTransactionType = 'cashback' \| 'interest' \| …` and `CreditTransactionsTable.tsx` imports from `~/services/admin` — A2-811 |
| `isCreditTransactionType`  | —   | —   | unused                                                                                                                                                                                                                         |

### 3.4 `loop-asset.ts`

| Symbol                   | B   | W   | Notes                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOME_CURRENCIES`        | B   | —   | backend `users/handler.ts`, `orders/loop-handler.ts`, `orders/transitions.ts`, `admin/credit-adjustments.ts`, `admin/asset-circulation.ts`, `db/schema.ts` (re-export)                                                                                                                                                                                                                       |
| `HomeCurrency`           | B   | W   | backend widely; web `admin.users.$userId.tsx`, `TreasuryReconciliationChart.tsx`                                                                                                                                                                                                                                                                                                             |
| `LOOP_ASSET_CODES`       | B   | W   | backend `admin/asset-circulation.ts`; web `admin._index.tsx`, `admin.treasury.tsx`, `admin.assets.$assetCode.tsx`, `admin.assets.tsx`                                                                                                                                                                                                                                                        |
| `LoopAssetCode`          | B   | W   | backend many; web many (admin components + services/admin.ts)                                                                                                                                                                                                                                                                                                                                |
| `CURRENCY_TO_ASSET_CODE` | B   | W   | backend `credits/payout-asset.ts`; web `TreasuryReconciliationChart.tsx`                                                                                                                                                                                                                                                                                                                     |
| `loopAssetForCurrency`   | —   | W   | `settings.wallet.tsx` only. Backend `credits/payout-asset.ts:52` re-implements via `CURRENCY_TO_ASSET_CODE[homeCurrency]` directly — minor (A2-812 notes)                                                                                                                                                                                                                                    |
| `isLoopAssetCode`        | —   | W   | `admin.payouts.tsx` only. Backend `admin/asset-circulation.ts:56` reimplements as `isLoopAsset()` — A2-812                                                                                                                                                                                                                                                                                   |
| `isHomeCurrency`         | —   | —   | **Shared export never imported.** Six re-implementations exist: `apps/backend/src/orders/loop-handler.ts:359`, `apps/backend/src/orders/transitions.ts:226`, `apps/backend/src/admin/supplier-spend-activity.ts:66`, `apps/backend/src/admin/treasury-credit-flow.ts:64`, `apps/backend/src/admin/treasury-credit-flow-csv.ts:72`, `apps/web/app/routes/admin.users.$userId.tsx:26` — A2-813 |

### 3.5 `merchants.ts`

| Symbol                   | B   | W   | Notes                                                                                                                                         |
| ------------------------ | --- | --- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Merchant`               | B   | W   | backend `merchants/sync.ts`, tests; web 5 components                                                                                          |
| `MerchantDenominations`  | B   | —   | backend `merchants/sync.ts` only; web reads via `Merchant.denominations`                                                                      |
| `MerchantListResponse`   | —   | W   | web `services/merchants.ts`, `hooks/use-merchants.ts`. Backend `openapi.ts:147` redeclares a same-name zod const without importing            |
| `MerchantDetailResponse` | —   | W   | web `services/merchants.ts`. Same pattern                                                                                                     |
| `MerchantAllResponse`    | —   | W   | web `services/merchants.ts`, `hooks/use-merchants.ts`. Same pattern                                                                           |
| `MerchantListParams`     | —   | W   | web `services/merchants.ts` only                                                                                                              |
| `LocationPoint`          | —   | —   | **Re-implemented identically** in `apps/backend/src/clustering/algorithm.ts:10-21` — A2-814                                                   |
| `ClusterPoint`           | —   | —   | **Re-implemented identically** in `apps/backend/src/clustering/algorithm.ts:24-35` — A2-814                                                   |
| `ClusterResponse`        | —   | W   | web `services/clusters.ts`, `ClusterMap.tsx`. Backend `openapi.ts:1450` redeclares zod const; backend handler doesn't import the shared type. |
| `ClusterParams`          | —   | W   | web `services/clusters.ts`, `ClusterMap.tsx`                                                                                                  |

### 3.6 `money-format.ts`

| Symbol                | B   | W   | Notes                                                                                                                                                                                                |
| --------------------- | --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `formatMinorCurrency` | —   | W   | 7 web files; **backend never imports** — no formatMinorCurrency / Intl.NumberFormat call in backend source. ADR 019 three-part test fails condition 1 (does not cross web↔backend boundary) — A2-815 |
| `pctBigint`           | —   | W   | 8 web files; backend never imports. Same ADR 019 failure — A2-815                                                                                                                                    |

### 3.7 `order-state.ts`

| Symbol                  | B   | W   | Notes                                                                                                                                                                                                                                                           |
| ----------------------- | --- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORDER_STATES`          | B   | —   | backend `db/schema.ts` (re-export), `admin/user-payment-method-share.ts`, `admin/merchant-payment-method-share.ts`, `admin/payment-method-share.ts`, `users/payment-method-share.ts`. **`apps/backend/src/admin/orders.ts:26-33` re-declares locally** — A2-816 |
| `OrderState`            | B   | W   | backend 6 files; web `services/orders-loop.ts`, `services/admin.ts` inline unions — those union literals drift-risk covered by A2-816                                                                                                                           |
| `isOrderState`          | —   | —   | unused                                                                                                                                                                                                                                                          |
| `TERMINAL_ORDER_STATES` | —   | —   | unused. Module header says "web polling loops use this to stop refetching" but no polling-loop consumer imports it — A2-817                                                                                                                                     |
| `TerminalOrderState`    | —   | —   | unused                                                                                                                                                                                                                                                          |
| `isTerminalOrderState`  | —   | —   | unused                                                                                                                                                                                                                                                          |
| `ORDER_PAYMENT_METHODS` | B   | —   | backend 6 files; web `services/admin.ts` comment only                                                                                                                                                                                                           |
| `OrderPaymentMethod`    | B   | —   | backend 6 files; web `orders-loop.ts` + `admin.ts` declare own local unions                                                                                                                                                                                     |
| `isOrderPaymentMethod`  | —   | —   | unused; backend files validate via manual `.includes()` check                                                                                                                                                                                                   |

### 3.8 `orders.ts`

| Symbol                | B   | W   | Notes                                                                                                                                                                                                                                             |
| --------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OrderStatus`         | —   | W   | web via `Order['status']` implicit use only (`routes/orders.$id.tsx`). Coexists confusingly with `OrderState` (ADR 010 vocabulary: `pending_payment/paid/procuring/fulfilled`). `OrderStatus` is the **CTX-proxy legacy XLM** vocabulary — A2-818 |
| `Order`               | —   | W   | web `services/orders.ts`, `hooks/use-orders.ts`, `routes/orders.$id.tsx`, `routes/orders.tsx`. Backend uses `typeof orders.$inferSelect` (drizzle-derived, different shape)                                                                       |
| `CreateOrderRequest`  | —   | W   | web `services/orders.ts`. Backend `orders/handler.ts` has own local zod `CreateOrderBody`                                                                                                                                                         |
| `CreateOrderResponse` | —   | W   | web `services/orders.ts`                                                                                                                                                                                                                          |
| `OrderListResponse`   | —   | W   | web `services/orders.ts`, `hooks/use-orders.ts`                                                                                                                                                                                                   |

### 3.9 `payout-state.ts`

| Symbol          | B   | W   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | --- | --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PAYOUT_STATES` | B   | —   | backend `db/schema.ts` (re-export), `users/handler.ts`, `admin/treasury.ts`, `admin/payouts.ts` (via re-export). **Duplicated locally** in `apps/backend/src/admin/payouts-by-asset.ts:23-24`, `apps/web/app/routes/admin.treasury.tsx:68`, `apps/web/app/routes/admin.assets.$assetCode.tsx:61-62`. Test mocks hardcode the tuple in `users/__tests__/handler.test.ts:137`, `__tests__/pending-payouts-summary.test.ts:41`, `admin/__tests__/treasury.test.ts:45`, `admin/__tests__/payouts.test.ts:5` — A2-819 |
| `PayoutState`   | B   | —   | backend `admin/treasury.ts`. `apps/web/app/services/admin.ts:151` declares own inline union `type PayoutState = 'pending' \| 'submitted' \| 'confirmed' \| 'failed'` rather than importing — covered by A2-819                                                                                                                                                                                                                                                                                                   |
| `isPayoutState` | —   | —   | unused                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### 3.10 `public-cashback-stats.ts`

| Symbol                | B   | W   | Notes                                                                                       |
| --------------------- | --- | --- | ------------------------------------------------------------------------------------------- |
| `PerCurrencyCashback` | B   | W   | backend `public/cashback-stats.ts`; web `services/public-stats.ts`, `CashbackStatsBand.tsx` |
| `PublicCashbackStats` | B   | W   | backend `public/cashback-stats.ts`; web `services/public-stats.ts`                          |

Clean.

### 3.11 `public-merchant.ts`

| Symbol                 | B   | W   | Notes                                                        |
| ---------------------- | --- | --- | ------------------------------------------------------------ |
| `PublicMerchantDetail` | B   | W   | backend `public/merchant.ts`; web `services/public-stats.ts` |

Clean.

### 3.12 `public-top-cashback-merchants.ts`

| Symbol                               | B   | W   | Notes                                                                                                                                       |
| ------------------------------------ | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `TopCashbackMerchant`                | B   | W   | backend `public/top-cashback-merchants.ts`; web consumers go through `~/services/public-stats` re-export → `cashback.tsx`, `calculator.tsx` |
| `PublicTopCashbackMerchantsResponse` | B   | W   | backend `public/top-cashback-merchants.ts`; web `services/public-stats.ts`, `routes/sitemap.tsx`                                            |

Clean.

### 3.13 `search.ts`

| Symbol          | B   | W   | Notes                                                                                                                           |
| --------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------- |
| `foldForSearch` | B   | W   | backend `merchants/handler.ts`; web `Navbar.tsx`, `MobileHome.tsx`, `routes/admin.merchants.tsx`. Canonical shared-use example. |

Clean.

### 3.14 `slugs.ts`

| Symbol         | B   | W   | Notes                                                                                                                       |
| -------------- | --- | --- | --------------------------------------------------------------------------------------------------------------------------- |
| `merchantSlug` | B   | W   | backend `merchants/sync.ts`, `public/merchant.ts`, `public/cashback-preview.ts`; web 8 files. Canonical shared-use example. |

Clean.

### 3.15 `stellar.ts`

| Symbol                 | B   | W   | Notes                                                                                                                                                                                |
| ---------------------- | --- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STELLAR_PUBKEY_REGEX` | B   | W   | backend `env.ts` (5 regex uses), `openapi.ts:275`, `users/handler.ts:196`; web `routes/settings.wallet.tsx:126`. Canonical shared-use example.                                       |
| `isStellarPublicKey`   | —   | —   | **Zero consumers.** Additionally, the return-type predicate is `s is string` (stellar.ts:39) — a no-op narrowing that doesn't add type information past `s: string` — A2-820, A2-821 |

---

## 4. ADR 019 three-part-test results

Test: (1) crosses web ↔ backend boundary, (2) pure TypeScript / regex / arithmetic, (3) drift would be a bug, not a type error.

| Module                             | (1) Crosses | (2) Pure | (3) Drift = bug | Verdict                                                                           |
| ---------------------------------- | ----------- | -------- | --------------- | --------------------------------------------------------------------------------- |
| `api.ts`                           | partial     | ✅       | ✅              | Belongs; but several symbols are unused or single-consumer (see A2-800..A2-803)   |
| `cashback-realization.ts`          | ✅ (intent) | ✅       | ✅              | Belongs; web consumer promised but not yet wired (A2-810)                         |
| `credit-transaction-type.ts`       | ✅          | ✅       | ✅              | Belongs; web consumer still has a parallel union (A2-811)                         |
| `loop-asset.ts`                    | ✅          | ✅       | ✅              | Belongs; narrowing helpers under-adopted (A2-812, A2-813)                         |
| `merchants.ts`                     | partial     | ✅       | ✅              | Belongs; `LocationPoint`/`ClusterPoint` duplicated in backend (A2-814)            |
| `money-format.ts`                  | ❌          | ✅       | ✅              | **Fails (1) — web-only.** Should live in `apps/web/app/utils/` (A2-815)           |
| `order-state.ts`                   | ✅          | ✅       | ✅              | Belongs; `ORDER_STATES` duplicated (A2-816); terminal-state triad unused (A2-817) |
| `orders.ts`                        | partial     | ✅       | ✅              | Belongs but confused: `OrderStatus` is CTX-proxy legacy vocabulary (A2-818)       |
| `payout-state.ts`                  | ✅          | ✅       | ✅              | Belongs; multiple local dups (A2-819)                                             |
| `public-cashback-stats.ts`         | ✅          | ✅       | ✅              | Belongs; clean                                                                    |
| `public-merchant.ts`               | ✅          | ✅       | ✅              | Belongs; clean                                                                    |
| `public-top-cashback-merchants.ts` | ✅          | ✅       | ✅              | Belongs; clean                                                                    |
| `search.ts`                        | ✅          | ✅       | ✅              | Belongs; clean                                                                    |
| `slugs.ts`                         | ✅          | ✅       | ✅              | Belongs; clean                                                                    |
| `stellar.ts`                       | ✅          | ✅       | ✅              | Belongs; `isStellarPublicKey` unused + buggy predicate (A2-820, A2-821)           |

---

## 5. Public API change log (G5-67, last 30 days)

```
8684d29 2026-04-23 +cashback-realization.js (recycledBps)                  PR #734
1a337f3 2026-04-23 +public-merchant.js (PublicMerchantDetail)              PR #647
7d3570a 2026-04-22 +money-format.js (formatMinorCurrency, pctBigint)       PR #606
a8e5544 2026-04-22 +public-top-cashback-merchants.js                       PR #571
86e43b7 2026-04-22 +public-cashback-stats.js (+PerCurrencyCashback)        PR #569
92d1ad2 2026-04-22 +credit-transaction-type.js                             PR #561
dbdd2e3 2026-04-22 +order-state.js, +payout-state.js                       PR #559
221bdea 2026-04-22 +loop-asset.js                                          PR #556
a9e5e8a 2026-04-22 +stellar.js                                             PR #555
324e0f1 2026-04-18 +search.js (foldForSearch)                              PR #142
ace070e 2026-04-20 api.ts: −ApiErrorCode.FORBIDDEN                         PR #282  (intentional dead-code removal; ApiErrorCode itself is unused)
10e0c2c 2026-04-19 api.ts: ApiError.requestId, ApiException.requestId +   PR #256  (additive)
```

**Verdict:** every change is additive or a documented dead-code removal. No unintentional breaks. FORBIDDEN removal is the only removal; PR #282 confirmed zero emit-or-consume sites. Additions correlate 1:1 with shared-extraction ADR 019 sweep PRs (#555..#571, #606, #647, #734) documented in the ADR's "Sweep-style PRs" open-issues section.

---

## 6. Findings

Severity rubric per audit plan §3.4. Every finding fixed regardless of severity.

### A2-800 — `Platform` type duplicated instead of consumed from shared

- **Severity:** Low
- **Files:** `packages/shared/src/api.ts:37`, `apps/web/app/native/platform.ts:3`
- **Evidence:** Shared exports `type Platform = 'web' | 'ios' | 'android'`. `apps/web/app/native/platform.ts:3` re-declares `export type Platform = 'ios' | 'android' | 'web'`. No consumer imports shared `Platform`. `getPlatform()` returns web's local type, which `services/auth.ts` then assigns into `body.platform: Platform` where the second `Platform` comes from shared — so the two types coincide only because the literal unions happen to match today. ADR 019 drift-risk criterion: a web-side change to add `'electron'` compiles but desyncs the backend contract.
- **Remediation:** delete web's local `Platform` export; `native/platform.ts` imports from `@loop/shared`.

### A2-801 — `ApiErrorCode` and `ApiErrorCodeValue` have zero consumers

- **Severity:** Low
- **Files:** `packages/shared/src/api.ts:63-82`
- **Evidence:** `grep -n "ApiErrorCode\|ApiErrorCodeValue" apps/**/*.ts` → no matches. The file-header claim is "so the frontend can `switch` on `ApiErrorCodeValue`", but the frontend compares `err.code` to string literals everywhere. Listed as a dead public-API export. Note A2-801 is the ADR 019 inverse: an export that ADR 019 argues for in principle but which no consumer has adopted.
- **Remediation:** either delete both exports (no consumers), or migrate web's `err.code === 'NOT_FOUND'` sites to `err.code === ApiErrorCode.NOT_FOUND`.

### A2-802 — `RefreshResponse` in shared has zero consumers

- **Severity:** Low
- **Files:** `packages/shared/src/api.ts:116-120`
- **Evidence:** `grep -n "RefreshResponse" apps/**/*.ts` matches only `apps/backend/src/openapi.ts:87,88,1625` which is a local `RefreshResponse = registry.register(...)` zod const, not an import of the shared type. No web or backend file imports it.
- **Remediation:** either wire web's `services/api-client.ts` refresh path to type-check against `RefreshResponse`, or delete the shared export as dead.

### A2-803 — Auth / image request+response types are web-only consumers of backend-emitted shapes

- **Severity:** Low (Info if treated as observation only)
- **Files:** `packages/shared/src/api.ts:87-130`, `packages/shared/src/orders.ts`, `packages/shared/src/merchants.ts`
- **Evidence:** `RequestOtpRequest`, `VerifyOtpRequest`, `VerifyOtpResponse`, `RefreshRequest`, `ImageProxyParams`, `CreateOrderRequest`, `CreateOrderResponse`, `OrderListResponse`, `MerchantListResponse`, `MerchantDetailResponse`, `MerchantAllResponse`, `MerchantListParams`, `ClusterResponse`, `ClusterParams` are consumed only by `apps/web`. The backend validates request bodies with local zod schemas and registers local-same-name consts in `openapi.ts`. The shared type is not the compile-time source of truth for the backend — only for the web. A backend-side shape change that preserves zod-validity but drifts from the shared type would not fail backend compilation; web fetches would silently decode into the old shape.
- **Remediation:** document per-module how "backend emits this shape" is enforced (one of: backend imports the shared type into `openapi.ts` registry via `z.infer`, or a contract test validates backend response bodies against the shared type). The public-\* triad (A2 findings §3.10-§3.12) already does this — extend the pattern to merchants / orders / clusters.

### A2-810 — Web `RealizationSparkline` re-implements `recycledBps` inline instead of importing

- **Severity:** Medium
- **Files:** `packages/shared/src/cashback-realization.ts:27-34`, `packages/shared/AGENTS.md:15`, `apps/web/app/components/features/admin/RealizationSparkline.tsx:22-48`
- **Evidence:** The shared module header (`cashback-realization.ts:21-25`) and the `packages/shared/AGENTS.md` Files entry both claim the web `RealizationSparkline` imports `recycledBps` from shared. It does not. `toDailyBps(rows)` at `RealizationSparkline.tsx:22-48` aggregates per-day earned/spent and re-inlines the same clamp-to-[0, 10000] integer math. Today's copy is behaviourally identical, but a change to the shared helper (e.g. a rounding tweak for ADR 009/015 reconciliation) would desync the headline card and the sparkline — the exact reason the helper was extracted per PR #734.
- **Remediation:** refactor `toDailyBps` to compute `earned`/`spent` per day and call `recycledBps(earned, spent)` per day from `@loop/shared`. Remove the inline `(clampedSpent * 10_000n) / earned` arithmetic.

### A2-811 — `CreditTransactionType` union re-declared in `services/admin.ts`

- **Severity:** Low
- **Files:** `packages/shared/src/credit-transaction-type.ts:33`, `apps/web/app/services/admin.ts:1853-1864`
- **Evidence:** Shared exports `CreditTransactionType` backed by `CREDIT_TRANSACTION_TYPES as const`. `apps/web/app/services/admin.ts:1853` declares its own inline `type CreditTransactionType = 'cashback' | 'interest' | 'spend' | 'withdrawal' | 'refund' | 'adjustment'` and `CreditTransactionsTable.tsx:6` imports `CreditTransactionType` from `~/services/admin`. PR #561 description acknowledges "Web unions / LEDGER_LABELS keys stay local per ADR 019 phased-adoption rule — they migrate when touched for another reason."
- **Remediation:** migrate `services/admin.ts` + `CreditTransactionsTable.tsx` to import from `@loop/shared`. ADR 019 phased-adoption accepts this drift temporarily, but adopting on the next touch would discharge it.

### A2-812 — Backend `isLoopAsset` / direct map access reimplements shared `isLoopAssetCode` / `loopAssetForCurrency`

- **Severity:** Low
- **Files:** `packages/shared/src/loop-asset.ts:69-80`, `apps/backend/src/admin/asset-circulation.ts:56`, `apps/backend/src/credits/payout-asset.ts:52-54`
- **Evidence:** `admin/asset-circulation.ts:56` declares `function isLoopAsset(v: string): v is LoopAssetCode { return (LOOP_ASSET_CODES as ReadonlyArray<string>).includes(v); }` — byte-identical to `isLoopAssetCode`. `credits/payout-asset.ts:52` reads `CURRENCY_TO_ASSET_CODE[homeCurrency]` directly instead of calling `loopAssetForCurrency()`. The module header on `loop-asset.ts` says "payoutAssetFor stays backend-local because it reads from env.ts", which is fine, but nothing stops it from calling `loopAssetForCurrency()` inside.
- **Remediation:** replace local `isLoopAsset` with `isLoopAssetCode`; replace the direct map access with `loopAssetForCurrency`.

### A2-813 — `isHomeCurrency` re-implemented in six files instead of imported from shared

- **Severity:** Medium
- **Files:** `packages/shared/src/loop-asset.ts:87-89`, `apps/backend/src/orders/loop-handler.ts:359`, `apps/backend/src/orders/transitions.ts:226`, `apps/backend/src/admin/supplier-spend-activity.ts:66`, `apps/backend/src/admin/treasury-credit-flow.ts:64`, `apps/backend/src/admin/treasury-credit-flow-csv.ts:72`, `apps/web/app/routes/admin.users.$userId.tsx:26`
- **Evidence:** Shared exports `isHomeCurrency`. Six files re-implement it as an identical local function `function isHomeCurrency(s: string): s is HomeCurrency { return (HOME_CURRENCIES as ReadonlyArray<string>).includes(s); }`. Zero importers of the shared version. This is the exact drift shape ADR 019 warns against — adding a fourth currency to `HOME_CURRENCIES` leaves six guards pinned on the old three-value tuple.
- **Remediation:** delete the six local copies; import `isHomeCurrency` from `@loop/shared`. Add an ESLint rule (or lint-docs script) that flags `function isHomeCurrency(` outside `packages/shared/src/`.

### A2-814 — Backend clustering re-declares `LocationPoint` / `ClusterPoint` instead of importing from shared

- **Severity:** Medium
- **Files:** `packages/shared/src/merchants.ts:65-96`, `apps/backend/src/clustering/algorithm.ts:10-35`
- **Evidence:** Shared `LocationPoint`/`ClusterPoint` interfaces are declared with matching field shapes. `apps/backend/src/clustering/algorithm.ts:10-35` re-declares both locally with identical shapes; nothing in the backend imports the shared types. The clustering handler returns JSON via `c.json(...)` against the openapi-level `ClusterResponse` zod schema, and the web then parses into the shared `ClusterResponse`. The two sides agree today because the shapes were literally copy-pasted; an edit to `mapPinUrl: string` in one won't propagate.
- **Remediation:** backend `algorithm.ts` imports `LocationPoint` / `ClusterPoint` from `@loop/shared`; delete local declarations.

### A2-815 — `formatMinorCurrency` and `pctBigint` are web-only — fail ADR 019 three-part test

- **Severity:** Medium
- **Files:** `packages/shared/src/money-format.ts:1-78`
- **Evidence:** `grep -n "formatMinorCurrency\|pctBigint\|Intl\.NumberFormat" apps/backend/src` → zero matches. Every consumer is in `apps/web` (`FlywheelChip.tsx`, `CashbackSummaryChip.tsx`, `AdminUserFlywheelChip.tsx`, `MerchantsFlywheelShareCard.tsx`, `MerchantCashbackPaidCard.tsx`, `MerchantTopEarnersCard.tsx`, `FleetFlywheelHeadline.tsx`, `UsersRecyclingActivityCard.tsx`, `MerchantFlywheelChip.tsx`). The module header (`money-format.ts:1-23`) claims cross-consumer consolidation but all listed consumers are web components. ADR 019 three-part test fails condition 1 ("crosses the web ↔ backend boundary"). These belong in `apps/web/app/utils/money-format.ts`, not `@loop/shared`. The extraction PR #606 body lists four web components as the trigger — the ADR-019 trigger was ~4 web-web duplicates, not a boundary crossing.
- **Remediation:** move `money-format.ts` to `apps/web/app/utils/money-format.ts`. Update the 9 consumer imports. Remove `export * from './money-format.js'` from `packages/shared/src/index.ts`.

### A2-816 — `ORDER_STATES` re-declared in `apps/backend/src/admin/orders.ts`

- **Severity:** Medium
- **Files:** `packages/shared/src/order-state.ts:15-23`, `apps/backend/src/admin/orders.ts:26-34`
- **Evidence:** `apps/backend/src/admin/orders.ts:26-34` declares `const ORDER_STATES = ['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'] as const; type OrderState = …`. The file imports `ORDER_PAYMENT_METHODS` from `@loop/shared` on line 18 but declines to import the co-located `ORDER_STATES`. If an admin-only state lands first (say, `refunded`) and is added only in admin/orders.ts, the Drizzle CHECK constraint accepts it but all other call sites reject it.
- **Remediation:** import `ORDER_STATES, type OrderState` from `@loop/shared`; delete the local declaration.

### A2-817 — `TERMINAL_ORDER_STATES` / `TerminalOrderState` / `isTerminalOrderState` have zero consumers

- **Severity:** Low
- **Files:** `packages/shared/src/order-state.ts:33-38`
- **Evidence:** Module docstring says "Terminal states — the web polling loops use this to stop refetching." `grep -n "TERMINAL_ORDER_STATES\|isTerminalOrderState\|TerminalOrderState" apps/**/*.ts` → zero matches. The web's `orders-loop.ts` polling loops appear to check terminality differently (via `LoopOrderState` local inline union and `isLoopOrderTerminal`).
- **Remediation:** either adopt these in the polling loops (likely the intent) or delete the triad.

### A2-818 — `OrderStatus` (shared) vs `OrderState` (shared) confusion — two order vocabularies coexist

- **Severity:** Medium
- **Files:** `packages/shared/src/orders.ts:2`, `packages/shared/src/order-state.ts:15-23`
- **Evidence:** `orders.ts:2` exports `type OrderStatus = 'pending' | 'completed' | 'failed' | 'expired'` — the CTX-proxy / Phase-1 XLM vocabulary used on `routes/orders.$id.tsx` via `Order['status']`. `order-state.ts:15-23` exports `ORDER_STATES = ['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired']` — the ADR 010 Loop vocabulary. A reader encountering both in the same `@loop/shared` barrel has no structural signal that these are two state machines (CTX-proxy legacy vs Loop-native). The `orders.ts` docstring does not mention the coexistence; the `order-state.ts` docstring cites ADR 010 but does not flag that `OrderStatus` is the legacy alternative. Post-Phase-1 the legacy path is expected to retire — until then it's ambient confusion.
- **Remediation:** (a) add header comments on both files cross-referencing the other and explaining the legacy/native split, or (b) rename `OrderStatus` to `CtxOrderStatus` to make the legacy scope explicit at every call site.

### A2-819 — `PAYOUT_STATES` / `PayoutState` duplicated in 3 sources + 4 test mocks

- **Severity:** Medium
- **Files:** `packages/shared/src/payout-state.ts:18-19`, `apps/backend/src/admin/payouts-by-asset.ts:23-24`, `apps/web/app/routes/admin.treasury.tsx:68`, `apps/web/app/routes/admin.assets.$assetCode.tsx:61-62`, `apps/web/app/services/admin.ts:151`, `apps/backend/src/users/__tests__/handler.test.ts:137`, `apps/backend/src/users/__tests__/pending-payouts-summary.test.ts:41`, `apps/backend/src/admin/__tests__/treasury.test.ts:45`, `apps/backend/src/admin/__tests__/payouts.test.ts:5`
- **Evidence:** Three source files and four test mocks declare the tuple `['pending', 'submitted', 'confirmed', 'failed']` inline. `services/admin.ts:151` declares an inline type union. Test mocks hardcode the string list to avoid pulling schema.ts; the mock shape matches today but is unverified on extension. PR #559 body explicitly acknowledges these web-side local copies stay under ADR 019 phased adoption.
- **Remediation:** migrate the three source sites to `import { PAYOUT_STATES, type PayoutState } from '@loop/shared'`. Replace test-mock tuple literals with `PAYOUT_STATES`. Phased-adoption rationale does not apply to identical re-declarations in admin routes that are already being touched regularly.

### A2-820 — `isStellarPublicKey` has zero consumers

- **Severity:** Low
- **Files:** `packages/shared/src/stellar.ts:39-41`
- **Evidence:** `grep -n "isStellarPublicKey" apps/**/*.{ts,tsx}` → zero matches. Every caller uses `STELLAR_PUBKEY_REGEX.test(...)` directly (env.ts 5×, openapi.ts, users/handler.ts, settings.wallet.tsx). The predicate wrapper is dead.
- **Remediation:** either migrate the ~8 `.test()` call sites to use the wrapper (gains the type-narrowing once A2-821 is fixed), or delete `isStellarPublicKey`.

### A2-821 — `isStellarPublicKey` return type `s is string` is a no-op predicate

- **Severity:** Low
- **Files:** `packages/shared/src/stellar.ts:39-41`
- **Evidence:** `export function isStellarPublicKey(s: string): s is string { … }`. The return type `s is string` narrows from `string` to `string` — it adds zero type information. No branded type, no `StellarPublicKey` nominal type, so the predicate cannot be used to narrow. Compare `isHomeCurrency(s: string): s is HomeCurrency` which narrows to a subtype. The docstring says "Returns a type predicate so callers can narrow after the guard runs" — no narrowing takes place.
- **Remediation:** introduce a branded type `export type StellarPublicKey = string & { readonly __brand: unique symbol }` and change the predicate to `s is StellarPublicKey`. Or drop the no-op predicate and return `boolean`.

---

## 7. Exit

Phase 10 complete. 16 findings raised (0 Critical, 0 High, 7 Medium, 9 Low, 0 Info). G5-66 circular import check: no internal relative imports — trivially passes. G5-67 public-API 30-day change log: all additive or one documented dead-code removal. Zero ADR 019 rule-breakers among the "stays shared" set; two web-only modules (A2-815) and the unused-export cluster (A2-801, A2-802, A2-817, A2-820) are the main hygiene load. Ready to hand off to Phase 11 (cross-app integration) which will exercise the JSON-wire contracts that back A2-803.
