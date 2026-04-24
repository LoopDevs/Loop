import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CURRENCY_TO_ASSET_CODE, type HomeCurrency, type LoopAssetCode } from '@loop/shared';
import {
  getAdminCashbackMonthly,
  getAdminPayoutsMonthly,
  type AdminCashbackMonthlyEntry,
  type AdminPayoutsMonthlyEntry,
} from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { monthLabel, formatMinor } from '~/components/features/cashback/MonthlyCashbackChart';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Treasury reconciliation chart (#632) — pairs
 * `/api/admin/cashback-monthly` (liability creation) with
 * `/api/admin/payouts-monthly` (liability settlement) so ops can
 * read "is outstanding LOOP liability growing or shrinking this
 * month?" at a glance. ADR 015's central treasury question.
 *
 * For each home currency:
 *   - "Minted" bar    — cashback credited to users in the month
 *   - "Settled" bar   — confirmed Stellar payouts converted back
 *                        from stroops to fiat minor (1 minor =
 *                        1e5 stroops, pinned in credits/payout-
 *                        builder.ts). Same unit as minted so the
 *                        two can be compared without a currency
 *                        conversion footnote.
 *   - "Net"           — minted - settled. Positive = liability
 *                        grew that month; negative = liability
 *                        shrank. Coloured green/red accordingly.
 *
 * Stroops → fiat-minor is bigint division (`paidStroops / 100000n`).
 * The chart caps at one month per row so the same 12-month series
 * renders as a stack and the net column stays aligned.
 */

// `credits/payout-builder.ts` pins `amountStroops = cashbackMinor * 1e5`.
// Stroops have 7 decimals, fiat minor (pence/cents) has 2 — diff is 5.
const STROOPS_PER_MINOR = 100_000n;

const ASSET_TO_CURRENCY: Record<LoopAssetCode, HomeCurrency> = (() => {
  const out = {} as Record<LoopAssetCode, HomeCurrency>;
  for (const [currency, asset] of Object.entries(CURRENCY_TO_ASSET_CODE) as Array<
    [HomeCurrency, LoopAssetCode]
  >) {
    out[asset] = currency;
  }
  return out;
})();

interface MonthRow {
  month: string;
  mintedMinor: bigint;
  settledMinor: bigint;
  netMinor: bigint;
}

export function TreasuryReconciliationChart(): React.JSX.Element {
  // A2-1160: hyphenated single-string keys match the rest of the
  // admin-side taxonomy (`admin-cashback-activity`, `admin-treasury`,
  // etc.); previously `['admin', 'cashback-monthly']` collided
  // cosmetically with `['me', 'cashback-monthly']` from
  // MonthlyCashbackChart.
  const cashbackQuery = useQuery({
    queryKey: ['admin-cashback-monthly'],
    queryFn: getAdminCashbackMonthly,
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });
  const payoutsQuery = useQuery({
    queryKey: ['admin-payouts-monthly'],
    queryFn: getAdminPayoutsMonthly,
    retry: shouldRetry,
    staleTime: 5 * 60 * 1000,
  });

  const byCurrency = useMemo(
    () => mergePerCurrency(cashbackQuery.data?.entries ?? [], payoutsQuery.data?.entries ?? []),
    [cashbackQuery.data, payoutsQuery.data],
  );

  if (cashbackQuery.isPending || payoutsQuery.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (cashbackQuery.isError || payoutsQuery.isError) {
    return (
      <p className="py-4 text-sm text-red-600 dark:text-red-400">
        Failed to load treasury reconciliation.
      </p>
    );
  }

  if (byCurrency.size === 0) {
    return (
      <p className="py-4 text-sm text-gray-500 dark:text-gray-400">
        No cashback minted or payouts confirmed in the last 12 months — reconciliation is only
        meaningful once liability flows have started.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {Array.from(byCurrency.entries()).map(([currency, rows]) => (
        <CurrencyTable key={currency} currency={currency} rows={rows} />
      ))}
    </div>
  );
}

function CurrencyTable({
  currency,
  rows,
}: {
  currency: string;
  rows: MonthRow[];
}): React.JSX.Element {
  const maxBar = useMemo(() => {
    let max = 0n;
    for (const r of rows) {
      if (r.mintedMinor > max) max = r.mintedMinor;
      if (r.settledMinor > max) max = r.settledMinor;
    }
    return max;
  }, [rows]);
  return (
    <div>
      <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">{currency}</div>
      <table className="min-w-full text-xs">
        <thead>
          <tr className="text-left text-gray-500 dark:text-gray-400">
            <th className="py-1 pr-3 font-medium">Month</th>
            <th className="py-1 pr-3 font-medium">Minted</th>
            <th className="py-1 pr-3 font-medium">Settled</th>
            <th className="py-1 pr-3 font-medium">Net (Δ liability)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${currency}-${r.month}`}
              aria-label={`${monthLabel(r.month)} minted ${formatMinor(
                r.mintedMinor.toString(),
                currency,
              )} settled ${formatMinor(r.settledMinor.toString(), currency)} net ${formatMinor(
                r.netMinor.toString(),
                currency,
              )}`}
            >
              <td className="py-1.5 pr-3 tabular-nums text-gray-500 dark:text-gray-400">
                {monthLabel(r.month)}
              </td>
              <td className="py-1.5 pr-3">
                <Bar
                  widthPct={barWidth(r.mintedMinor, maxBar)}
                  colour="bg-green-500/80 dark:bg-green-400/70"
                  label={formatMinor(r.mintedMinor.toString(), currency)}
                />
              </td>
              <td className="py-1.5 pr-3">
                <Bar
                  widthPct={barWidth(r.settledMinor, maxBar)}
                  colour="bg-blue-500/80 dark:bg-blue-400/70"
                  label={formatMinor(r.settledMinor.toString(), currency)}
                />
              </td>
              <td
                className={`py-1.5 pr-3 tabular-nums font-medium ${
                  r.netMinor > 0n
                    ? 'text-orange-700 dark:text-orange-300'
                    : r.netMinor < 0n
                      ? 'text-green-700 dark:text-green-300'
                      : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {netLabel(r.netMinor, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Bar({
  widthPct,
  colour,
  label,
}: {
  widthPct: number;
  colour: string;
  label: string;
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <span
        className={`h-3 rounded ${colour}`}
        style={{ width: `${widthPct}%`, minWidth: widthPct > 0 ? '2px' : '0px' }}
        aria-hidden="true"
      />
      <span className="tabular-nums text-gray-700 dark:text-gray-300">{label}</span>
    </span>
  );
}

function barWidth(value: bigint, max: bigint): number {
  if (max === 0n) return 0;
  // basis-points (×10000) keeps one-decimal precision after /100.
  const bp = Number((value * 10000n) / max) / 100;
  return Math.max(0, Math.min(100, bp));
}

function netLabel(net: bigint, currency: string): string {
  if (net === 0n) return '—';
  const sign = net > 0n ? '+' : '−';
  const abs = net < 0n ? -net : net;
  return `${sign}${formatMinor(abs.toString(), currency)}`;
}

export function mergePerCurrency(
  cashback: AdminCashbackMonthlyEntry[],
  payouts: AdminPayoutsMonthlyEntry[],
): Map<string, MonthRow[]> {
  // Key: `${currency}-${month}` so we can union the two series on
  // currency + month in one pass.
  const byKey = new Map<string, MonthRow & { currency: string }>();
  function touch(currency: string, month: string): MonthRow & { currency: string } {
    const k = `${currency}-${month}`;
    let row = byKey.get(k);
    if (row === undefined) {
      row = {
        currency,
        month,
        mintedMinor: 0n,
        settledMinor: 0n,
        netMinor: 0n,
      };
      byKey.set(k, row);
    }
    return row;
  }

  for (const e of cashback) {
    let v: bigint;
    try {
      v = BigInt(e.cashbackMinor);
    } catch {
      continue;
    }
    const row = touch(e.currency, e.month);
    row.mintedMinor += v;
  }

  for (const e of payouts) {
    const currency = ASSET_TO_CURRENCY[e.assetCode as LoopAssetCode];
    if (currency === undefined) continue; // unrecognised asset — skip
    let stroops: bigint;
    try {
      stroops = BigInt(e.paidStroops);
    } catch {
      continue;
    }
    const row = touch(currency, e.month);
    // bigint division truncates — the remainder is sub-cent dust
    // that shouldn't appear on a fiat reconciliation surface.
    row.settledMinor += stroops / STROOPS_PER_MINOR;
  }

  // Finalise netMinor + group by currency, sorted by month asc.
  const out = new Map<string, MonthRow[]>();
  for (const row of byKey.values()) {
    row.netMinor = row.mintedMinor - row.settledMinor;
    const list = out.get(row.currency);
    if (list === undefined) out.set(row.currency, [row]);
    else list.push(row);
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.month.localeCompare(b.month));
  }
  return out;
}
