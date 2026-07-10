/**
 * Per-user order-create velocity limit (ADR 045, B-3).
 *
 * Bounds how many orders — and how much value — a single Loop user
 * can create in a rolling window, independent of the per-IP rate
 * limiter (`middleware/rate-limit.ts`), which an attacker can route
 * around by distributing requests across IPs but not around a
 * per-*account* cap. See ADR 045 for the full design rationale
 * (why per-currency rather than FX-converted, why the query is
 * shaped the way it is, why the fail-closed posture).
 *
 * `checkOrderVelocity` is the ONLY export callers need. It is a pure
 * read — never writes anything — so a caller placing it before a
 * money write (as `orders/loop-handler.ts` does) gets a clean
 * reject-before-any-side-effect gate for free.
 */
import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/client.js';
import { orders } from '../db/schema.js';
import { env } from '../env.js';

/**
 * Row cap used when the count dimension is disabled
 * (`LOOP_ORDER_VELOCITY_MAX_PER_WINDOW=0`) but the value dimension is
 * still active. Keeps the query bounded even in that combination —
 * see ADR 045's "bounded, indexed query" section. Not configurable:
 * it's a defensive ceiling, not a product threshold, so it isn't an
 * env var an operator would tune.
 */
const VALUE_ONLY_ROW_CAP = 200;

export type VelocityRejectionReason = 'count' | 'value';

export interface VelocityDecision {
  allowed: boolean;
  reason?: VelocityRejectionReason;
  /** Set only when `reason === 'value'` — which charge-currency bucket tripped. */
  currency?: string;
}

/**
 * Thrown when the bounded count/sum query itself fails (DB blip, pool
 * exhaustion). Callers MUST treat this as "reject the order" — never
 * fall through to "assume under budget". See ADR 045's fail-safe
 * posture: a transient DB error must not become a free pass past a
 * fraud gate.
 */
export class VelocityCheckUnavailableError extends Error {
  override readonly cause?: Error;
  constructor(cause: unknown) {
    super('Order velocity check failed — failing closed (ADR 045)');
    this.name = 'VelocityCheckUnavailableError';
    if (cause instanceof Error) this.cause = cause;
  }
}

/**
 * Evaluates whether `userId` is currently within the configured
 * order-creation velocity budget. Call this BEFORE creating a new
 * order (and before any balance debit) — it only looks at EXISTING
 * orders in the window, so the caller's prospective new order is
 * correctly excluded from the count/sum being checked against.
 *
 * Bounded, indexed query: reuses the `orders_user_created`
 * `(user_id, created_at)` index with `ORDER BY created_at DESC LIMIT
 * rowCap` — a backward index scan that stops after at most `rowCap`
 * rows regardless of how many orders the user actually has in the
 * window (S4-6 / PERF-005 lesson: never let an admin/hot-path query
 * scan unboundedly). `rowCap` is the count threshold itself when that
 * dimension is enabled (so a full count is exactly what "at the cap"
 * requires), or a fixed defensive ceiling when only the value
 * dimension is active.
 *
 * Both dimensions disabled (`MAX_PER_WINDOW=0` AND
 * `MAX_VALUE_MINOR=0`) short-circuits with no DB call at all.
 *
 * @throws {VelocityCheckUnavailableError} if the underlying query fails.
 */
export async function checkOrderVelocity(
  userId: string,
  now: Date = new Date(),
): Promise<VelocityDecision> {
  const countMax = env.LOOP_ORDER_VELOCITY_MAX_PER_WINDOW;
  const valueMax = env.LOOP_ORDER_VELOCITY_MAX_VALUE_MINOR;

  if (countMax <= 0 && valueMax <= 0n) {
    return { allowed: true };
  }

  const windowMs = env.LOOP_ORDER_VELOCITY_WINDOW_HOURS * 60 * 60 * 1000;
  const windowStart = new Date(now.getTime() - windowMs);
  const rowCap = countMax > 0 ? countMax : VALUE_ONLY_ROW_CAP;

  let rows: Array<{ chargeMinor: bigint; chargeCurrency: string }>;
  try {
    rows = await db
      .select({ chargeMinor: orders.chargeMinor, chargeCurrency: orders.chargeCurrency })
      .from(orders)
      .where(and(eq(orders.userId, userId), gte(orders.createdAt, windowStart)))
      .orderBy(desc(orders.createdAt))
      .limit(rowCap);
  } catch (err) {
    throw new VelocityCheckUnavailableError(err);
  }

  // Hitting the row cap means the true count is >= rowCap. When the
  // count dimension is enabled, rowCap === countMax, so this is
  // exactly "at or over the limit" — reject the (N+1)th order.
  if (countMax > 0 && rows.length >= countMax) {
    return { allowed: false, reason: 'count' };
  }

  if (valueMax > 0n) {
    // When countMax > 0, rows.length < rowCap here (the branch above
    // would have returned otherwise) — so this IS the complete set of
    // in-window orders, not a truncated prefix, and the sum is exact.
    // When countMax === 0 (value-only mode, an unusual config — the
    // shipped defaults enable both dimensions), rowCap falls back to
    // VALUE_ONLY_ROW_CAP and a user with >= 200 in-window orders has
    // this sum computed over only the most recent 200 — a real,
    // accepted residual, precisely documented in ADR 045's "bounded,
    // indexed query" section (not a hidden approximation).
    const totalsByCurrency = new Map<string, bigint>();
    for (const row of rows) {
      totalsByCurrency.set(
        row.chargeCurrency,
        (totalsByCurrency.get(row.chargeCurrency) ?? 0n) + row.chargeMinor,
      );
    }
    for (const [currency, total] of totalsByCurrency) {
      if (total >= valueMax) {
        return { allowed: false, reason: 'value', currency };
      }
    }
  }

  return { allowed: true };
}
