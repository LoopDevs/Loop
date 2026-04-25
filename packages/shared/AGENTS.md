# Shared Package — Agent Guide

> Types and utilities shared between `apps/web` and `apps/backend`.

## Files

| File                                   | Contents                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                         | Barrel export — re-exports everything                                                                                                                                                       |
| `src/api.ts`                           | `ApiError`, `ApiException`, `ApiErrorCode`, auth request/response types, `DEFAULT_CLIENT_IDS`                                                                                               |
| `src/assert-never.ts`                  | Exhaustiveness helper (A2-1532 enables `@typescript-eslint/switch-exhaustiveness-check`)                                                                                                    |
| `src/merchants.ts`                     | Merchant / `ClusterResponse` / `ClusterParams` etc.                                                                                                                                         |
| `src/orders.ts`                        | Order / `OrderStatus` / `CreateOrder*` / `OrderListResponse`                                                                                                                                |
| `src/loop-orders.ts`                   | Loop-native order shapes (ADR 010 / 015)                                                                                                                                                    |
| `src/order-state.ts`                   | `ORDER_STATES` + `OrderState` canonical union (ADR 010)                                                                                                                                     |
| `src/payout-state.ts`                  | `PAYOUT_STATES` + `PayoutState` canonical union (ADR 015/016)                                                                                                                               |
| `src/loop-asset.ts`                    | `LOOP_ASSET_CODES`, `HOME_CURRENCIES`, `HomeCurrency`, `loopAssetForCurrency()` (ADR 015)                                                                                                   |
| `src/stellar.ts`                       | `STELLAR_PUBKEY_REGEX` — the ED25519 public-key regex used by every `setStellarAddress` validator (web + backend + openapi). Sole export.                                                   |
| `src/credit-transaction-type.ts`       | `CREDIT_TRANSACTION_TYPES` canonical union (ADR 009 / 017)                                                                                                                                  |
| `src/money-format.ts`                  | `formatMinorCurrency(bigint\|string\|number, currency)` + `pctBigint()` — A2-1520 bigint-safe formatters                                                                                    |
| `src/cashback-realization.ts`          | `recycledBps(earned, spent)` — pure bigint→number math for the flywheel-health KPI                                                                                                          |
| `src/users-me.ts`                      | A2-1505 `/api/users/me*` response shapes (13 types)                                                                                                                                         |
| `src/search.ts`                        | `foldForSearch()` — backend `?q=` + navbar client-side filter                                                                                                                               |
| `src/slugs.ts`                         | `merchantSlug()` — URL-safe slug from merchant name                                                                                                                                         |
| `src/admin-assets.ts`                  | A2-1506 admin asset-observability shapes (circulation + drift state)                                                                                                                        |
| `src/admin-cashback-realization.ts`    | A2-1506 flywheel KPI shapes (flat + daily)                                                                                                                                                  |
| `src/admin-operator-mixes.ts`          | A2-1506 ADR-022 mix-axis matrix: merchant/user/operator × operator/merchant                                                                                                                 |
| `src/admin-operator-stats.ts`          | A2-1506 operator volume / p50-p99 latency                                                                                                                                                   |
| `src/admin-settlement-lag.ts`          | A2-1506 cashback → Stellar confirm latency percentiles                                                                                                                                      |
| `src/admin-supplier-spend.ts`          | A2-1506 CTX-as-supplier economics (flat + daily activity)                                                                                                                                   |
| `src/admin-treasury.ts`                | A2-1506 treasury snapshot + credit-flow daily (includes `LoopLiability`, `TreasuryHolding`, `TreasuryOrderFlow`, `TreasurySnapshot`, `TreasuryCreditFlowDay`, `TreasuryCreditFlowResponse`) |
| `src/public-cashback-preview.ts`       | ADR 020 pre-signup calculator shape                                                                                                                                                         |
| `src/public-cashback-stats.ts`         | ADR 020 public aggregate cashback stats                                                                                                                                                     |
| `src/public-merchant.ts`               | ADR 020 single-merchant detail                                                                                                                                                              |
| `src/public-top-cashback-merchants.ts` | ADR 020 top-cashback-merchants list                                                                                                                                                         |
| `src/proto/`                           | Generated protobuf types (`npm run proto:generate`)                                                                                                                                         |

## Rules

- **All code used by both web and backend MUST live here.** Never duplicate.
- **No runtime dependencies** except `@bufbuild/protobuf` (for proto types).
- **No React, no Node APIs** — this package must work in both environments.
- When adding a new type, export it from `src/index.ts`.
- When changing a type, check both `apps/web` and `apps/backend` for breakage.

## Proto types

Generated from `apps/backend/proto/clustering.proto` via `npm run proto:generate`.
Output: `src/proto/clustering_pb.ts`. Imported dynamically (with JSON fallback) by both web and backend clustering code.

The `package.json` exports map includes `"./src/proto/*"` to allow deep imports.
