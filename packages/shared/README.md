# @loop/shared

Shared TypeScript types used by `apps/web`, `apps/mobile`, and `apps/backend`.

No runtime code — types only (except generated protobuf classes).

## Modules

| File               | Contents                                                                    |
| ------------------ | --------------------------------------------------------------------------- |
| `src/merchants.ts` | `Merchant`, `MerchantListResponse`, `ClusterResponse`, `ClusterParams`      |
| `src/api.ts`       | `ApiError`, `ApiException`, auth request/response types, `ImageProxyParams` |
| `src/orders.ts`    | `Order`, `OrderStatus`, `CreateOrderRequest`, `CreateOrderResponse`         |
| `src/proto/`       | Generated protobuf types (run `npm run proto:generate` from root)           |

## Usage

```typescript
import type { Merchant, ClusterResponse } from '@loop/shared';
```

## Proto types

Generated from `apps/backend/proto/clustering.proto` via:

```bash
npm run proto:generate   # from repo root
```

Output goes to `src/proto/`. Generated files are git-ignored — regenerate after schema changes.
