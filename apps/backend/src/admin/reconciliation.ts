/**
 * Ledger reconciliation drift check (ADR 009 integrity primitive).
 *
 * `GET /api/admin/reconciliation` joins `user_credits` against the
 * grouped sum of `credit_transactions` for each (user_id, currency)
 * pair and returns any rows where they disagree. ADR 009 declares:
 *
 *     balance_minor is a materialised sum of the corresponding
 *     credit_transactions rows; reconcilable by replay as an audit
 *     check.
 *
 * Nothing actually exercised that invariant before this endpoint.
 * Now that ADR 017 added admin-initiated writers (adjustment,
 * refund), the number of paths that mutate `user_credits` has
 * doubled — this lets ops answer "is the ledger still consistent?"
 * without reaching for a DB client.
 *
 * The query returns at most 100 drifted rows (ordered by user id)
 * so a catastrophic drift doesn't produce a multi-MB response. A
 * healthy deployment returns an empty `drift` array. The aggregate
 * `userCount` / `driftedCount` in the response let the UI render
 * "✓ 0 drift across N rows" or "⚠️ M drifted — more may exist".
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userCredits } from '../db/schema.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-reconciliation' });

/** Maximum number of drifted rows the endpoint returns. */
const DRIFT_PAGE_LIMIT = 100;

export interface ReconciliationEntry {
  userId: string;
  currency: string;
  /** Materialised balance from `user_credits.balance_minor`. */
  balanceMinor: string;
  /** Sum of the user's `credit_transactions.amount_minor` in this currency. */
  ledgerSumMinor: string;
  /** `balance - ledger_sum`. Non-zero — that's what qualifies the row as drifted. */
  deltaMinor: string;
}

export interface ReconciliationResponse {
  /** Total `user_credits` rows across all users and currencies. */
  userCount: string;
  /** Number of drifted rows returned in `drift`. Capped at `DRIFT_PAGE_LIMIT`. */
  driftedCount: string;
  /** Drifted rows, newest user first. Empty when the ledger is consistent. */
  drift: ReconciliationEntry[];
}

/**
 * Raw-SQL shape the drift query emits. Keyed with camelCase aliases
 * so we avoid a second mapping pass; postgres-js returns plain objects
 * with whatever column labels the SELECT uses.
 */
interface DriftRow extends Record<string, unknown> {
  userId: string;
  currency: string;
  balanceMinor: string;
  ledgerSumMinor: string;
  deltaMinor: string;
}

/** GET /api/admin/reconciliation */
export async function adminReconciliationHandler(c: Context): Promise<Response> {
  // Drifted rows — a LEFT JOIN so a user_credits row with zero
  // matching credit_transactions still surfaces (HAVING sees
  // COALESCE(SUM, 0), and if balance != 0 we flag it). Bigint minus
  // bigint is computed server-side; Postgres returns text via the
  // explicit ::text casts.
  const driftResult = await db.execute<DriftRow>(sql`
    SELECT
      uc.user_id::text AS "userId",
      uc.currency AS currency,
      uc.balance_minor::text AS "balanceMinor",
      COALESCE(SUM(ct.amount_minor), 0)::text AS "ledgerSumMinor",
      (uc.balance_minor - COALESCE(SUM(ct.amount_minor), 0))::text AS "deltaMinor"
    FROM user_credits uc
    LEFT JOIN credit_transactions ct
      ON ct.user_id = uc.user_id AND ct.currency = uc.currency
    GROUP BY uc.user_id, uc.currency, uc.balance_minor
    HAVING uc.balance_minor != COALESCE(SUM(ct.amount_minor), 0)
    ORDER BY uc.user_id
    LIMIT ${DRIFT_PAGE_LIMIT}
  `);

  // Drizzle's `execute` wraps the driver result; drizzle-orm/postgres-js
  // exposes the rows as the top-level array at `result.rows` on recent
  // versions and the result itself behaves as an array on older ones.
  // Normalise to a plain row array here so handler logic below doesn't
  // have to branch on version.
  const driftRows = extractRows<DriftRow>(driftResult);

  // Total user_credits count — just an aggregate, no filter. Used by
  // the UI for the "0 drift across N rows" copy.
  const [countRow] = await db.select({ count: sql<string>`COUNT(*)::text` }).from(userCredits);

  const response: ReconciliationResponse = {
    userCount: countRow?.count ?? '0',
    driftedCount: String(driftRows.length),
    drift: driftRows.map((r) => ({
      userId: r.userId,
      currency: r.currency,
      balanceMinor: r.balanceMinor,
      ledgerSumMinor: r.ledgerSumMinor,
      deltaMinor: r.deltaMinor,
    })),
  };

  if (driftRows.length > 0) {
    log.warn(
      { driftedCount: driftRows.length },
      'Ledger drift detected — some user_credits rows disagree with their credit_transactions sum',
    );
  }

  return c.json(response);
}

/**
 * Extract the row array from a drizzle `execute` result. Accepts both
 * the plain-array shape (postgres-js returns this today) and the
 * `{ rows: [] }` wrapper shape in case the driver upgrades. Narrows
 * to `T[]` so callers get the alias-shaped row directly.
 */
function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
