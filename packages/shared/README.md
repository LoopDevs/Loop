# @loop/shared

Shared TypeScript types and small runtime utilities used by `apps/web`,
`apps/mobile`, and `apps/backend`. Kept in one place so both sides can
never drift — a rename or shape change lands atomically.

Runtime surface is deliberately small: type definitions, a tiny error
class (`ApiException`), two string helpers (`merchantSlug`,
`foldForSearch`), and the generated protobuf classes. No React, no Node
APIs — must work in both environments.

## Modules

| File               | Contents                                                                                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/api.ts`       | `ApiError`, `ApiException`, `ApiErrorCode`, `DEFAULT_CLIENT_IDS`, `Platform`, auth request/response types, `ImageProxyParams`                                                                           |
| `src/merchants.ts` | `Merchant`, `MerchantDenominations`, `MerchantListResponse`, `MerchantDetailResponse`, `MerchantAllResponse`, `MerchantListParams`, `ClusterResponse`, `LocationPoint`, `ClusterPoint`, `ClusterParams` |
| `src/orders.ts`    | `Order`, `OrderStatus`, `CreateOrderRequest`, `CreateOrderResponse`, `OrderListResponse`                                                                                                                |
| `src/search.ts`    | `foldForSearch()` — NFD normalise + strip diacritics + lowercase; shared between backend `/api/merchants?q=` and the navbar client filter                                                               |
| `src/slugs.ts`     | `merchantSlug()` — URL-safe slug from merchant name                                                                                                                                                     |
| `src/proto/`       | Generated protobuf types (run `npm run proto:generate` from root)                                                                                                                                       |

See [`AGENTS.md`](AGENTS.md) for the agent guide (rules, patterns, how
to add a new type).

## Usage

```typescript
import type { Merchant, ClusterResponse } from '@loop/shared';
import { ApiException, merchantSlug, foldForSearch } from '@loop/shared';
```

## Proto types

Generated from `apps/backend/proto/clustering.proto` via:

```bash
npm run proto:generate   # from repo root
```

Output goes to `src/proto/`. Generated files are git-ignored — regenerate after schema changes.
