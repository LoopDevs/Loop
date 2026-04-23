# Shared Package — Agent Guide

> Types and utilities shared between `apps/web` and `apps/backend`.

## Files

| File                          | Contents                                                                                                                                                                                                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                | Barrel export — re-exports everything                                                                                                                                                                                                                                 |
| `src/api.ts`                  | `ApiError`, `ApiException`, `ApiErrorCode`, auth request/response types, `DEFAULT_CLIENT_IDS`                                                                                                                                                                         |
| `src/merchants.ts`            | `Merchant`, `MerchantDenominations`, `MerchantListResponse`, `MerchantDetailResponse`, `MerchantAllResponse`, `MerchantListParams`, `ClusterResponse`, `LocationPoint`, `ClusterPoint`, `ClusterParams`                                                               |
| `src/orders.ts`               | `Order`, `OrderStatus`, `CreateOrderRequest`, `CreateOrderResponse`, `OrderListResponse`                                                                                                                                                                              |
| `src/search.ts`               | `foldForSearch()` — NFD normalise + strip diacritics + lowercase; used by backend `/api/merchants?q=` and the navbar client-side filter so both paths return the same results for the same query (PR #142)                                                            |
| `src/slugs.ts`                | `merchantSlug()` — URL-safe slug from merchant name                                                                                                                                                                                                                   |
| `src/cashback-realization.ts` | `recycledBps(earnedMinor, spentMinor)` — pure bigint→number math for the ADR 009/015 flywheel-health KPI. Shared between `/api/admin/cashback-realization`, `/api/admin/cashback-realization/daily`, and any web surface that re-aggregates daily trends client-side. |
| `src/proto/`                  | Generated protobuf types (run `npm run proto:generate` from root)                                                                                                                                                                                                     |

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
