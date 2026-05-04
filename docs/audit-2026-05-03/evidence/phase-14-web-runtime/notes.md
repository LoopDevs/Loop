# Phase 14 - Web Runtime and UX State

Status: in-progress

Required evidence:

- route/service/hook/store inventory
- query key and retry review
- SSR/static export review
- purchase/auth/admin/wallet journey review
- accessibility/loading/error state review

Findings:

- A4-026: Loop-native pending payment instructions are not recoverable after refresh/app restart.
- A4-041: Loop-native client idempotency key is not stable across rapid duplicate submits.

Evidence captured:

- `artifacts/loop-native-payment-recovery-gap.txt` traces the Loop-native create response, component-local state, legacy pending-order persistence, read-side Loop order fields, and orders-list rendering path.
- `artifacts/loop-order-client-idempotency-gap.txt` traces service-generated idempotency keys, purchase submit/loading state, backend dedupe scope, and credit-funded order side effects.
- `artifacts/web-vitest-full-run.txt` records the full web Vitest run, web file/test inventory by area, and static boundary scan results.

Observations:

- `apps/web/app/services/api-client.ts` coalesces refresh attempts, applies timeout/abort handling, and retries authenticated requests once after refresh.
- Direct `fetch` use outside `api-client` is currently limited to public/non-auth config, clusters, and sitemap surfaces.
- Capacitor plugin imports found during this pass are confined to `apps/web/app/native/**`; no direct component/service imports were found outside the native bridge layer.
- Route loader usage found during this pass is limited to `routes/sitemap.tsx` plus the not-found SSR throw route, matching the documented API-client architecture exception pattern.
- Legacy CTX purchase payment state is persisted through `purchase.store.ts` and `native/purchase-storage.ts`; Loop-native create response state is held only in `PurchaseContainer` component state.
- Loop-native order idempotency currently protects only repeated requests that reuse the same key. The primary web caller does not hold a stable key per purchase attempt.
- Full web Vitest run passed 123 files / 959 tests with non-fatal jsdom canvas warnings.
- Web source inventory remains component-heavy; static scans still show direct fetch and Capacitor access following the intended service/native boundaries.
