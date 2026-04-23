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
  try {
    // A2-900: build the drift set from BOTH directions so the endpoint
    // catches orphans on either side.
    //
    //   (1) user_credits rows whose ledger sum disagrees with
    //       balance_minor. Covers the LEFT-JOIN shape (balance row
    //       exists, ledger sum may be zero) where the prior single
    //       query was anchored.
    //
    //   (2) credit_transactions keyed on (user_id, currency) for which
    //       NO user_credits row exists at all. Prior LEFT JOIN anchored
    //       on user_credits would miss these entirely — a dangling
    //       ledger entry (deleted balance row, failed migration) stays
    //       invisible to ops. Surface them here with balance=0, ledger
    //       sum computed, delta = -ledger_sum.
    //
    // UNION ALL is safe: the two halves partition on "has matching
    // user_credits row" so no row appears twice. Results merged,
    // ordered by user id, capped at DRIFT_PAGE_LIMIT.
    const driftResult = await db.execute<DriftRow>(sql`
    SELECT "userId", currency, "balanceMinor", "ledgerSumMinor", "deltaMinor"
    FROM (
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
      UNION ALL
      SELECT
        ct.user_id::text AS "userId",
        ct.currency AS currency,
        '0' AS "balanceMinor",
        SUM(ct.amount_minor)::text AS "ledgerSumMinor",
        (-SUM(ct.amount_minor))::text AS "deltaMinor"
      FROM credit_transactions ct
      LEFT JOIN user_credits uc
        ON uc.user_id = ct.user_id AND uc.currency = ct.currency
      WHERE uc.user_id IS NULL
      GROUP BY ct.user_id, ct.currency
    ) drift
    ORDER BY "userId"
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
  } catch (err) {
    // A2-507: keep the handler-scoped logger binding so ops can
    // correlate a failed /admin/reconciliation load to this log line
    // via the request-id. The generic onError would lose the
    // `handler: 'admin-reconciliation'` tag.
    log.error({ err }, 'admin reconciliation query failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to compute reconciliation' }, 500);
  }
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
