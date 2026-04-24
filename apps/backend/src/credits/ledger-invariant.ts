/**
 * Ledger invariant primitive (A2-1519).
 *
 * ADR 009 declares: `user_credits.balance_minor` is a materialised
 * sum of the corresponding `credit_transactions.amount_minor` rows
 * for each `(user_id, currency)` pair. The admin reconciliation
 * endpoint surfaced this as a point-in-time check, but nothing
 * exercised the invariant outside a manual operator query — and no
 * CI assertion caught a new writer path leaving the two out of sync.
 *
 * This module:
 *   - `computeLedgerDriftFromRows` — pure function over in-memory
 *     rows, testable from plain vitest with zero DB dependency.
 *     Mirrors the authoritative SQL drift shape (UNION ALL over
 *     balance-side and transaction-side anchors).
 *   - `computeLedgerDriftSql` — runs the same logic against a drizzle
 *     `db` handle; used by the admin handler and the
 *     `check-ledger-invariant` CLI (`scripts/check-ledger-invariant.ts`).
 *
 * Both return the same `DriftEntry[]` shape, so a test can exercise
 * synthetic scenarios with the pure variant and ops can run the SQL
 * variant as a deploy smoke. The SQL query in the admin handler is
 * still the on-endpoint authority; this module exists so the
 * invariant has a single definition across the code base.
 */
import { sql } from 'drizzle-orm';
import type { db as dbType } from '../db/client.js';

export interface DriftEntry {
  userId: string;
  currency: string;
  /** Materialised balance from `user_credits.balance_minor`. `"0"` when an orphan transaction exists without a balance row. */
  balanceMinor: string;
  /** Sum of `credit_transactions.amount_minor` for the (user, currency) pair. */
  ledgerSumMinor: string;
  /** `balanceMinor - ledgerSumMinor`. Non-zero by construction. */
  deltaMinor: string;
}

export interface BalanceRow {
  userId: string;
  currency: string;
  balanceMinor: bigint;
}

export interface TransactionRow {
  userId: string;
  currency: string;
  amountMinor: bigint;
}

/**
 * Pure invariant check. Groups `transactions` by (userId, currency)
 * and compares the sum against the matching `balance` row.
 *
 * Emits drift for THREE cases:
 *   1. A balance row exists whose ledger sum differs.
 *   2. A balance row exists but no transactions match → drift iff
 *      balance != 0.
 *   3. Transactions exist but no balance row → orphan; balance
 *      treated as 0, delta = -ledgerSum.
 *
 * Matches the SQL `UNION ALL` shape in `adminReconciliationHandler`.
 * Results ordered by `userId` for deterministic test output.
 */
export function computeLedgerDriftFromRows(
  balances: BalanceRow[],
  transactions: TransactionRow[],
): DriftEntry[] {
  const keyOf = (r: { userId: string; currency: string }): string => `${r.userId}\0${r.currency}`;

  const sumByKey = new Map<string, bigint>();
  for (const t of transactions) {
    const k = keyOf(t);
    sumByKey.set(k, (sumByKey.get(k) ?? 0n) + t.amountMinor);
  }

  const drift: DriftEntry[] = [];
  const seenBalances = new Set<string>();

  for (const b of balances) {
    const k = keyOf(b);
    seenBalances.add(k);
    const ledgerSum = sumByKey.get(k) ?? 0n;
    if (b.balanceMinor !== ledgerSum) {
      drift.push({
        userId: b.userId,
        currency: b.currency,
        balanceMinor: b.balanceMinor.toString(),
        ledgerSumMinor: ledgerSum.toString(),
        deltaMinor: (b.balanceMinor - ledgerSum).toString(),
      });
    }
  }

  for (const [k, ledgerSum] of sumByKey) {
    if (seenBalances.has(k)) continue;
    const [userId, currency] = k.split('\0');
    if (userId === undefined || currency === undefined) continue;
    drift.push({
      userId,
      currency,
      balanceMinor: '0',
      ledgerSumMinor: ledgerSum.toString(),
      deltaMinor: (-ledgerSum).toString(),
    });
  }

  drift.sort((a, b) => {
    if (a.userId !== b.userId) return a.userId < b.userId ? -1 : 1;
    return a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0;
  });

  return drift;
}

interface DriftSqlRow extends Record<string, unknown> {
  userId: string;
  currency: string;
  balanceMinor: string;
  ledgerSumMinor: string;
  deltaMinor: string;
}

/**
 * SQL-backed invariant check. Returns up to `limit` drifted rows,
 * ordered by `userId`. When the ledger is consistent returns `[]`.
 *
 * The query mirrors `adminReconciliationHandler`'s UNION ALL shape:
 * the balance-side anchor catches sum-disagreement and zero-sum
 * drift, the transaction-side anchor catches orphan CT rows without
 * a matching `user_credits` row.
 */
export async function computeLedgerDriftSql(
  db: typeof dbType,
  limit = 1000,
): Promise<DriftEntry[]> {
  const result = await db.execute<DriftSqlRow>(sql`
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
    LIMIT ${limit}
  `);
  return extractRows<DriftSqlRow>(result).map((r) => ({
    userId: r.userId,
    currency: r.currency,
    balanceMinor: r.balanceMinor,
    ledgerSumMinor: r.ledgerSumMinor,
    deltaMinor: r.deltaMinor,
  }));
}

function extractRows<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && 'rows' in result) {
    const rows = (result as { rows: unknown }).rows;
    if (Array.isArray(rows)) return rows as T[];
  }
  return [];
}
