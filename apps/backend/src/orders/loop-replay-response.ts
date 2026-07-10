/**
 * A2-2003 idempotent-replay shaper for `POST /api/orders/loop`.
 *
 * Lifted out of `apps/backend/src/orders/loop-handler.ts`. Pure
 * response-builder: takes a stored `Order` row + the request
 * context and re-emits the original `OrderPaymentResponse` shape
 * the client got when the order was first created.
 *
 * Two callers in the parent handler:
 *
 *   1. Lookup-first short-circuit — a repeat POST with the same
 *      `(user_id, idempotency_key)` pair short-circuits before we
 *      hit `createOrder` at all.
 *   2. `IdempotentOrderConflictError` recovery — when a concurrent
 *      caller raced us through the lookup, the unique-index
 *      violation in the insert path lands the existing row in our
 *      hands and we replay through this function.
 *
 * Discord notifications (`notifyCashbackRecycled` /
 * `notifyFirstCashbackRecycled`) are deliberately NOT re-fired
 * here — those are tied to user intent at first creation; firing
 * them again on every retry would dilute the signal and risk
 * per-attempt double-pings on a flaky client.
 *
 * Stays close to `loop-handler.ts` (sibling file) rather than a
 * shared helper module: the only consumer is `loopCreateOrderHandler`
 * and the response shape is pinned to that endpoint.
 */
import type { Context } from 'hono';
import { type Order } from './repo.js';
import type { OrderPaymentResponse } from './loop-handler.js';
import { deriveLoopPaymentInstructions } from './loop-payment-instructions.js';

/**
 * A2-2003: build the create-order response from an already-persisted
 * row. Two callers:
 *   - lookup-first short-circuit before we even hit `createOrder`
 *     (a repeat post within TTL),
 *   - `IdempotentOrderConflictError` recovery when a concurrent
 *     caller raced us through that lookup.
 *
 * Q6-4b: the payment-instruction derivation (oracle/FX re-quote + SEP-7
 * build) now lives in `deriveLoopPaymentInstructions` so `GET
 * /api/orders/loop/:id` can reuse the exact same server-authoritative
 * math. This function is a thin HTTP wrapper: map the derived error
 * cases to their original status codes so replay stays byte-for-byte
 * compatible, otherwise emit the `{ orderId, payment }` response.
 *
 * Discord notifications (`notifyCashbackRecycled` / `notifyFirstCashbackRecycled`)
 * are deliberately NOT re-fired here — those are tied to user intent
 * at first creation; firing them again on every retry would dilute
 * the signal and risk per-attempt double-pings on a flaky client.
 */
export async function replayOrderResponse(c: Context, order: Order): Promise<Response> {
  const derived = await deriveLoopPaymentInstructions(order);
  if (!derived.ok) {
    return c.json({ code: derived.code, message: derived.message }, derived.status);
  }
  return c.json<OrderPaymentResponse>({ orderId: order.id, payment: derived.payment });
}
