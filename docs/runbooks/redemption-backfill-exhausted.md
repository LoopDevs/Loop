# Runbook · `notifyRedemptionBackfillExhausted` alert

## Symptom

Discord monitoring-channel embed titled **"🔴 Redemption Backfill Exhausted"** from
`notifyRedemptionBackfillExhausted`. A `fulfilled` order has been re-fetched
10 times by the redemption-backfill sweeper
(`apps/backend/src/orders/redemption-backfill.ts`) over ~17 hours and CTX's
`GET /gift-cards/:id` still returns no `redeemCode` / `redeemPin` / `redeemUrl`.
The user paid; their "Ready" screen has nothing to show.

## Severity

**P1** — a customer is out money with no gift card in hand. Respond within the
on-call business-hours window (`docs/oncall.md`).

## Diagnosis

1. Pivot from the alert's order tail-id into the admin shell:
   `GET /api/admin/orders/:orderId` (~1 min). Confirm `state='fulfilled'`,
   `ctx_order_id` set, all three redeem fields NULL.
2. Re-run the detail read manually against CTX with an operator bearer
   (~2 min — never paste the bearer into Discord):
   `curl -H "Authorization: Bearer $OP_BEARER" -H "X-Client-Id: loopweb" https://spend.ctx.com/gift-cards/<ctxOrderId>`.
   - Body now carries a code/url → the sweeper's cap fired during a long CTX
     delay; see Mitigation step 1.
   - Body still `{}` / empty fields → CTX-side issue (this is the 2026-05-14
     e2e signature); see Mitigation step 2.
3. Check CTX's order status (paid? fulfilled?) in the same response, and the
   monitoring channel for correlated `notifyOperatorPoolExhausted` /
   circuit-open alerts that could explain failed attempts.
4. **Confirm CTX was actually paid — do not assume it.** A `fulfilled` Loop
   order normally implies `payCtxOrder` succeeded (post-#1366 the order is
   marked `failed`, never `fulfilled`, on any payment error). That invariant
   does **not** hold for orders fulfilled before #1366 merged (2026-05-14),
   where the pay-CTX hop didn't exist and orders reached `fulfilled` purely on
   the redemption-wait timeout. Verify with BOTH (a) CTX's `status`/paid flag
   from step 2 and (b) an on-chain check that the operator account actually
   sent this order's memo —
   `GET https://horizon.stellar.org/accounts/<operator>/payments?join=transactions`,
   match `memo` + `amount`. This three-way split (Loop state ✕ CTX state ✕
   on-chain) decides the mitigation below.

## Mitigation

1. **Payload exists upstream now**: re-fetch immediately from the admin UI —
   `POST /api/admin/orders/:orderId/refetch-redemption` (ADR 037; audited,
   one-shot through the backfill machinery, no cap/backoff, support-tier) —
   or reset the order's backfill budget so the sweeper re-picks it on the
   next tick (~2 min):

   ```sql
   UPDATE orders
   SET redemption_backfill_attempts = 0,
       redemption_backfill_last_attempt_at = NULL
   WHERE id = '<orderId>'
     AND state = 'fulfilled'
     AND redeem_code IS NULL AND redeem_pin IS NULL AND redeem_url IS NULL;
   ```

2. **Payload still empty upstream — branch on the Diagnosis step 4 result:**
   - **CTX paid + on-chain payment exists** → genuine slow issuance. Open a CTX
     support ticket quoting the full `ctx_order_id` and ask why a paid order
     carries no redemption payload. Do **not** refund yet — CTX has been paid
     and may still deliver; a refund now double-spends.
   - **CTX unpaid + NO matching on-chain payment** → the order was never paid
     (pre-#1366 strand, or a regression). There is nothing to double-spend, so
     the "don't refund" rule above does **not** apply. The order was never
     truly fulfilled: mark it `failed` with a reason, and if it's a real
     customer, refund their inbound payment via the admin credit path (ADR 017).
   - **CTX unpaid but a matching on-chain payment exists** → we paid but CTX
     couldn't reconcile (memo / amount / memo-type mismatch). Open a CTX ticket,
     do **not** re-pay, and recover via the ticket before any refund.

3. Post the chosen path in `#ops-alerts` (no silent fixes).

## Resolution

- If CTX delivers the payload: confirm the sweeper persisted it (redeem
  fields non-NULL) and tell the user their card is ready.
- If CTX confirms the card can't be issued: recover the spend through the CTX
  ticket, then compensate the user via the admin credit path (ADR 017) and
  close the loop in `#ops-alerts`.

## Post-mortem

Required if more than one order exhausts in a week (suggests a CTX contract
change, not a one-off) — capture it per `docs/oncall.md`.

## Related

- [`stuck-procurement-swept.md`](./stuck-procurement-swept.md)
- [`operator-pool-exhausted.md`](./operator-pool-exhausted.md)
- [`ctx-schema-drift.md`](./ctx-schema-drift.md)
