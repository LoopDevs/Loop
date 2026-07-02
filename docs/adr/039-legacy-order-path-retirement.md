# ADR 039 — Legacy CTX-proxy order path retirement

**Status:** Proposed (retirement criteria; no deletion yet)
**Relates to:** ADR 010 (principal switch), ADR 013 (Loop-owned auth)

## Context

The order surface carries two parallel paths, forked on
`LOOP_AUTH_NATIVE_ENABLED`:

- **Loop-native** (`orders/loop-handler.ts`, 432 lines) — Loop is merchant of
  record; the user pays Loop's deposit address and Loop's procurement worker
  pays CTX. This is the principal-switch path (ADR 010) and the one every new
  feature builds on.
- **Legacy CTX-proxy** (`orders/handler.ts`, 183 lines) — order creation is
  forwarded to upstream CTX and the user pays CTX directly. No local ledger.

This duplication is the largest live fork in the backend (the repo-shape
review identified the ~30-file `orders/` tree as a hotspot, and the dual path
as its cause). It is _intentional_ — the two coexist while the identity +
principal takeover rolls out — not rot. But an intentional fork still carries
tax: every order-touching change reasons about both paths, the flag matrix
widens the test surface, and the legacy path accretes no new value.

This ADR records **when** the legacy path may be deleted, so the decision is a
checklist rather than a judgment call each time someone asks "can we drop
this yet?"

## Decision — retirement criteria

The legacy CTX-proxy order path (`orders/handler.ts`, its route mount, the
`orders-legacy` kill switch, and the `POST /api/orders` legacy branch) may be
deleted once **all** of the following hold:

1. **`LOOP_AUTH_NATIVE_ENABLED=true` in production** and stable for a full
   settlement cycle (no rollback in ≥30 days — one refresh-token TTL).
2. **Zero legacy orders in flight** — no `orders` rows created via the CTX-proxy
   path in a non-terminal state. (Query: legacy orders carry no
   `payment_memo` / no `ctx_settlements` row; confirm none are `pending_payment`
   / `paid` / `procuring`.)
3. **No client still pins the legacy path** — the web + mobile bundles call
   `POST /api/orders/loop` exclusively, and the deployed app versions that could
   call `POST /api/orders` are past their forced-update window.
4. **The legacy e2e contract check is green on native** — the real-upstream
   `test-e2e` suite exercises the loop-native flow end-to-end so deleting the
   legacy path removes no covered behaviour.

## What the deletion removes

- `apps/backend/src/orders/handler.ts` + its `POST /api/orders` route mount
  and OpenAPI registration.
- The `orders-legacy` kill switch (`LOOP_KILL_ORDERS_LEGACY`) and the combined
  switch's legacy branch (`LOOP_KILL_ORDERS` keeps gating loop-native).
- The `paymentMethod` legacy-only handling and any `orders` columns exclusively
  populated by the proxy path (audit before dropping — a column shared with the
  native path stays).
- The `LOOP_AUTH_NATIVE_ENABLED` fork in `orders/` — once legacy is gone, the
  flag no longer branches order behaviour (it still gates auth).

Simplifies the flag matrix (one fewer axis in every order test), collapses the
`orders/` tree, and removes the "reason about both paths" tax from every future
order change.

## Consequences / non-goals

- **Not deleting now.** This ADR is the criteria, not the action — the takeover
  is mid-roll (`LOOP_PHASE_1_ONLY` still gates the cashback surface). Deleting
  before criterion 1 would strand any user still on the CTX-proxy path.
- **Auth's dual path is separate.** ADR 013's auth fork (`LOOP_AUTH_NATIVE_ENABLED`
  gating request-otp / verify-otp / refresh) retires on its own criteria (CTX
  identity takeover complete); this ADR only covers the ORDER surface.
- When the criteria are met, the deletion is a mechanical PR: remove the files,
  the mount, the openapi registration, the kill switch, update
  `docs/architecture.md` + the env docs, and drop the now-dead flag branches
  (the `check-dead-flags` gate will confirm no orphaned env var remains).
