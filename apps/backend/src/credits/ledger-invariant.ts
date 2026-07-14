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
  /**
   * `balanceMinor - ledgerSumMinor`. Non-zero for a materialised
   * (`user_credits`-backed) drift row. For an ORPHAN row (`orphan: true`)
   * it may be `"0"`: `credit_transactions` rows exist for a (user,
   * currency) that has NO `user_credits` row, and those rows net to zero
   * (e.g. `+100` and `-100`). That is still an ADR-009 violation — a
   * materialised balance row must exist for any (user, currency) that has
   * ledger activity — but `SUM(amount_minor)` collapses the offsetting
   * rows to `0`, so the delta alone can't distinguish it from a clean
   * ledger. `orphan` is the non-collapsing signal that qualifies such a
   * zero-sum row as drift (DAT-06).
   */
  deltaMinor: string;
  /**
   * DAT-06: `true` iff this is an ORPHAN — `credit_transactions` rows
   * exist with no matching `user_credits` row. Present (and `true`) only
   * on orphan rows; omitted for materialised-balance drift rows. Read it
   * as "a balance row is missing, not merely wrong": it stays `true`
   * regardless of whether the orphaned rows net to zero, so a zero-sum
   * orphan is detected instead of reading as clean, and it disambiguates
   * an orphan from a genuine `balance_minor = 0` mismatch (both carry
   * `balanceMinor: "0"`).
   */
  orphan?: boolean;
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
 *   3. Transactions exist but no balance row → orphan (`orphan: true`);
 *      balance treated as 0, delta = -ledgerSum. DAT-06: an orphan is
 *      emitted for EVERY (user, currency) with orphaned rows — including
 *      one whose rows net to zero (delta `"0"`) — because the missing
 *      balance row is the violation, not the net magnitude. The `orphan`
 *      flag carries that signal so a zero-sum orphan isn't collapsed to a
 *      row indistinguishable from clean.
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
      // DAT-06: flag the orphan explicitly. `-ledgerSum` is `"0"` for a
      // zero-sum orphan (offsetting rows), so this flag — not the delta —
      // is what keeps it from reading as clean.
      orphan: true,
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
  orphan: boolean;
}

/**
 * SQL-backed invariant check. Returns up to `limit` drifted rows,
 * ordered by `userId`. When the ledger is consistent returns `[]`.
 *
 * The query mirrors `adminReconciliationHandler`'s UNION ALL shape:
 * the balance-side anchor catches sum-disagreement and zero-sum
 * drift, the transaction-side anchor catches orphan CT rows without
 * a matching `user_credits` row. DAT-06: each anchor tags its rows
 * with an `orphan` boolean (transaction-side `TRUE`, balance-side
 * `FALSE`) so a zero-sum orphan — whose `SUM(amount_minor)` collapses
 * to 0 and would otherwise read as a clean `0 = 0` row — is still
 * qualified as drift, matching `computeLedgerDriftFromRows`.
 */
export async function computeLedgerDriftSql(
  // `execute` is the only method used — accepting the narrow shape
  // lets callers pass either the pooled client or a transaction
  // handle (the C1 watcher runs inside its single-flight txn).
  db: Pick<typeof dbType, 'execute'>,
  limit = 1000,
): Promise<DriftEntry[]> {
  const result = await db.execute<DriftSqlRow>(sql`
    SELECT "userId", currency, "balanceMinor", "ledgerSumMinor", "deltaMinor", "orphan"
    FROM (
      SELECT
        uc.user_id::text AS "userId",
        uc.currency AS currency,
        uc.balance_minor::text AS "balanceMinor",
        COALESCE(SUM(ct.amount_minor), 0)::text AS "ledgerSumMinor",
        (uc.balance_minor - COALESCE(SUM(ct.amount_minor), 0))::text AS "deltaMinor",
        FALSE AS "orphan"
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
        (-SUM(ct.amount_minor))::text AS "deltaMinor",
        -- DAT-06: orphan rows are drift regardless of their net sum. No
        -- HAVING on the sum here (a zero-sum orphan must NOT be filtered
        -- out); the flag carries the signal the collapsed sum can't.
        TRUE AS "orphan"
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
    // Only present on orphan rows, mirroring `computeLedgerDriftFromRows`.
    // postgres returns a JS boolean for the `TRUE`/`FALSE` literal; guard
    // for the `'t'`/`'f'` string form too in case a driver marshals it raw.
    ...(r.orphan === true || (r.orphan as unknown) === 't' ? { orphan: true } : {}),
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
