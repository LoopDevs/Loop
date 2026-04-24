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
 * `rowCount` / `driftedCount` in the response let the UI render
 * "✓ 0 drift across N rows" or "⚠️ M drifted — more may exist".
 *
 * A2-907: `rowCount` counts `user_credits` rows — a user with
 * balances in two currencies contributes two rows. The field was
 * previously labelled `userCount`, which implied distinct users and
 * would double-count anyone multi-currency. No UI consumes the
 * field today, so the rename is clean.
 */
import type { Context } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userCredits } from '../db/schema.js';
import { logger } from '../logger.js';
import { computeLedgerDriftSql } from '../credits/ledger-invariant.js';

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
  /**
   * Total `user_credits` rows across all users and currencies. A
   * multi-currency user contributes one row per currency — this is
   * NOT a distinct-user count (A2-907).
   */
  rowCount: string;
  /** Number of drifted rows returned in `drift`. Capped at `DRIFT_PAGE_LIMIT`. */
  driftedCount: string;
  /** Drifted rows, newest user first. Empty when the ledger is consistent. */
  drift: ReconciliationEntry[];
}

/** GET /api/admin/reconciliation */
export async function adminReconciliationHandler(c: Context): Promise<Response> {
  try {
    // A2-1519: the drift SQL lives in `credits/ledger-invariant.ts`
    // so the `check-ledger-invariant` CLI and this handler share one
    // definition. The historical SQL (dual balance-side + orphan-side
    // UNION ALL) is preserved verbatim in that module — see the
    // `computeLedgerDriftSql` source for the per-branch rationale.
    const driftRows = await computeLedgerDriftSql(db, DRIFT_PAGE_LIMIT);

    // Total user_credits count — just an aggregate, no filter. Used by
    // the UI for the "0 drift across N rows" copy.
    const [countRow] = await db.select({ count: sql<string>`COUNT(*)::text` }).from(userCredits);

    const response: ReconciliationResponse = {
      rowCount: countRow?.count ?? '0',
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
