/**
 * `/admin/orders` — Loop-native orders drill-down (ADR 011 / 015).
 *
 * Fourth admin tab, alongside Cashback / Treasury / Payouts. Renders
 * a table of recent orders with the full cashback-split breakdown
 * and CTX procurement metadata so ops can triage stuck orders
 * (state=paid with no ctxOrderId is a procurement stall) and audit
 * how cashback is being split per merchant.
 *
 * Filters: state enum + userId (optional) + Load more cursor on
 * createdAt. Keeps the table compact by using monospace for ids;
 * a future slice can expand to a per-order detail drawer.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.orders';
import { useAuth } from '~/hooks/use-auth';
import { listAdminOrders, type AdminOrderState, type AdminOrderView } from '~/services/admin';
import { shouldRetry } from '~/hooks/query-retry';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { CsvDownloadButton } from '~/components/features/admin/CsvDownloadButton';
import { OrdersSparkline } from '~/components/features/admin/OrdersSparkline';
import { Spinner } from '~/components/ui/Spinner';
import { Button } from '~/components/ui/Button';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Orders — Loop' }];
}

const STATES: ReadonlyArray<AdminOrderState | 'all'> = [
  'all',
  'pending_payment',
  'paid',
  'procuring',
  'fulfilled',
  'failed',
  'expired',
];

const STATE_CLASSES: Record<AdminOrderState, string> = {
  pending_payment: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  paid: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  procuring: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  fulfilled: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  expired: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

const PAGE_SIZE = 50;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Bigint-minor → localized currency (e.g. `"5000"` GBP → `"£50.00"`).
 * Local copy — the shared helper in #390 covers this but isn't merged
 * yet, so inlining keeps this PR unblocked. Follow-up slice will
 * replace with `formatMinorAmount` from `@loop/shared`.
 */
function formatMinor(minor: string, currency: string): string {
  try {
    const major = Number(BigInt(minor)) / 100;
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(major);
  } catch {
    return '—';
  }
}

export default function AdminOrdersRoute(): React.JSX.Element {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const merchantIdFilter = searchParams.get('merchantId') ?? undefined;
  const chargeCurrencyRaw = searchParams.get('chargeCurrency');
  // Only honour USD/GBP/EUR — anything else silently drops instead of
  // letting the backend 400 on a typo that would blank the table.
  const chargeCurrencyFilter =
    chargeCurrencyRaw !== null && ['USD', 'GBP', 'EUR'].includes(chargeCurrencyRaw)
      ? chargeCurrencyRaw
      : undefined;
  const ctxOperatorIdRaw = searchParams.get('ctxOperatorId');
  // Operator ids are free-form opaque strings (ADR 013). Mirror the
  // backend shape check here so a pasted id with whitespace silently
  // surfaces an unfiltered list instead of a 400 the user can't debug
  // from the URL.
  const ctxOperatorIdFilter =
    ctxOperatorIdRaw !== null &&
    ctxOperatorIdRaw.length > 0 &&
    ctxOperatorIdRaw.length <= 128 &&
    /^[A-Za-z0-9._-]+$/.test(ctxOperatorIdRaw)
      ? ctxOperatorIdRaw
      : undefined;
  const [stateFilter, setStateFilter] = useState<AdminOrderState | 'all'>('all');
  // Cursor list — each Load more pushes the last row's `createdAt`
  // so pages stay stable across refetches (offset pagination would
  // skip / duplicate rows as new orders land).
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined]);

  if (!isAuthenticated) {
    return (
      <main className="max-w-3xl mx-auto px-6 py-12">
        <AdminNav />
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-4">
          Admin · Orders
        </h1>
        <p className="text-gray-700 dark:text-gray-300 mb-6">Sign in to continue.</p>
        <Button onClick={() => void navigate('/auth')}>Sign in</Button>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Admin · Orders</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
            Loop-native orders across every user, newest first. Filter by state to triage stuck
            rows; each row shows the ADR-015 cashback split + CTX procurement metadata.
          </p>
        </div>
        <CsvDownloadButton
          path="/api/admin/orders.csv"
          filename={`loop-orders-${new Date().toISOString().slice(0, 10)}.csv`}
        />
      </header>

      <OrdersSparkline />

      {/* Filters — intentionally rendered above the table so the
          state change is visible to screen readers right before the
          list redraws. Changing the filter resets the cursor list
          so the user sees page 1 of the new result set. */}
      <div className="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setStateFilter(s);
              setCursors([undefined]);
            }}
            aria-pressed={stateFilter === s}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              stateFilter === s
                ? 'border-blue-600 bg-blue-600 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-50 dark:border-gray-800 dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-gray-800'
            }`}
          >
            {s === 'all' ? 'All' : s.replace('_', ' ')}
          </button>
        ))}
      </div>

      {/* Active merchant filter — sourced from `?merchantId=` so the
          drill-down from /admin/cashback is linkable + bookmarkable.
          The "clear" button strips the param (and resets the cursor
          so page 1 of the unfiltered list renders). */}
      {merchantIdFilter !== undefined ? (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <span>
            Filtered to merchant <code className="font-mono text-xs">{merchantIdFilter}</code>
          </span>
          <button
            type="button"
            onClick={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('merchantId');
                return next;
              });
              setCursors([undefined]);
            }}
            className="text-xs font-medium underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      {/* Active charge-currency filter — sourced from `?chargeCurrency=`
          so the drill-down from /admin/treasury supplier-spend rows is
          linkable. Same dismiss-banner pattern as the merchant filter
          above so the two behave consistently. */}
      {chargeCurrencyFilter !== undefined ? (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <span>
            Charged in <code className="font-mono text-xs">{chargeCurrencyFilter}</code>
          </span>
          <button
            type="button"
            onClick={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('chargeCurrency');
                return next;
              });
              setCursors([undefined]);
            }}
            className="text-xs font-medium underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      {/* Active ctx-operator filter — sourced from `?ctxOperatorId=`.
          Drill-in target from the treasury operator-pool list + the
          row-level operator pill below. ADR-013 framing: an operator
          id is which CTX service account carried this order, so the
          per-operator slice is the natural "which operator is flaky"
          question ops reaches for during an incident. */}
      {ctxOperatorIdFilter !== undefined ? (
        <div
          role="status"
          className="flex items-center justify-between gap-2 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200"
        >
          <span>
            Filtered to CTX operator{' '}
            <code className="font-mono text-xs">{ctxOperatorIdFilter}</code>
          </span>
          <button
            type="button"
            onClick={() => {
              setSearchParams((prev) => {
                const next = new URLSearchParams(prev);
                next.delete('ctxOperatorId');
                return next;
              });
              setCursors([undefined]);
            }}
            className="text-xs font-medium underline hover:no-underline"
          >
            Clear
          </button>
        </div>
      ) : null}

      <section className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        {cursors.map((cursor, idx) => (
          <OrdersPage
            key={cursor ?? 'head'}
            state={stateFilter}
            merchantId={merchantIdFilter}
            chargeCurrency={chargeCurrencyFilter}
            ctxOperatorId={ctxOperatorIdFilter}
            cursor={cursor}
            isLastPage={idx === cursors.length - 1}
            onLoadMore={(nextCursor) => {
              setCursors((prev) => [...prev, nextCursor]);
            }}
          />
        ))}
      </section>
    </main>
  );
}

function OrdersPage({
  state,
  merchantId,
  chargeCurrency,
  ctxOperatorId,
  cursor,
  isLastPage,
  onLoadMore,
}: {
  state: AdminOrderState | 'all';
  merchantId: string | undefined;
  chargeCurrency: string | undefined;
  ctxOperatorId: string | undefined;
  cursor: string | undefined;
  isLastPage: boolean;
  onLoadMore: (nextCursor: string) => void;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: [
      'admin-orders',
      state,
      merchantId ?? null,
      chargeCurrency ?? null,
      ctxOperatorId ?? null,
      cursor ?? null,
      PAGE_SIZE,
    ],
    queryFn: () =>
      listAdminOrders({
        limit: PAGE_SIZE,
        ...(state !== 'all' ? { state } : {}),
        ...(merchantId !== undefined ? { merchantId } : {}),
        ...(chargeCurrency !== undefined ? { chargeCurrency } : {}),
        ...(ctxOperatorId !== undefined ? { ctxOperatorId } : {}),
        ...(cursor !== undefined ? { before: cursor } : {}),
      }),
    retry: shouldRetry,
    staleTime: 0,
  });

  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }

  if (query.isError) {
    const denied =
      query.error instanceof ApiException &&
      (query.error.status === 401 || query.error.status === 404);
    return (
      <div className="px-5 py-6 text-sm text-red-600 dark:text-red-400">
        {denied ? 'This page is only available to Loop admins.' : "Couldn't load orders."}
      </div>
    );
  }

  const rows = query.data.orders;
  if (rows.length === 0 && cursor === undefined) {
    return (
      <div className="px-5 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No orders match this filter.
      </div>
    );
  }

  const hasMore = rows.length === PAGE_SIZE;
  const last = rows[rows.length - 1];
  return (
    <>
      {/* Header row once per mount — only on the first page. */}
      {cursor === undefined && <OrdersTableHeader />}
      <ul role="list">
        {rows.map((row) => (
          <OrderRow key={row.id} row={row} />
        ))}
      </ul>
      {isLastPage && hasMore && last !== undefined ? (
        <div className="px-5 py-4 flex justify-center border-t border-gray-200 dark:border-gray-800">
          <Button
            variant="secondary"
            onClick={() => {
              onLoadMore(last.createdAt);
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}

function OrdersTableHeader(): React.JSX.Element {
  return (
    <div className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,1fr)] gap-3 px-5 py-2 bg-gray-50 dark:bg-gray-900/40 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
      <div>Order</div>
      <div>Split</div>
      <div>CTX</div>
      <div>User</div>
      <div className="text-right">State</div>
    </div>
  );
}

function OrderRow({ row }: { row: AdminOrderView }): React.JSX.Element {
  const stateClass = STATE_CLASSES[row.state] ?? STATE_CLASSES.pending_payment;
  return (
    <li className="grid grid-cols-[minmax(0,1.5fr)_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_minmax(0,1fr)] gap-3 px-5 py-3 items-start border-b border-gray-100 dark:border-gray-900 last:border-0 text-sm">
      <div className="min-w-0">
        <p className="font-mono text-xs text-gray-900 dark:text-white truncate" title={row.id}>
          <Link
            to={`/admin/orders/${row.id}`}
            className="text-blue-600 hover:underline dark:text-blue-400"
          >
            {row.id.slice(0, 8)}
          </Link>
        </p>
        <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
          {formatMinor(row.chargeMinor, row.chargeCurrency)}
        </p>
        <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">
          {formatDate(row.createdAt)}
        </p>
      </div>
      <div className="min-w-0 text-xs text-gray-700 dark:text-gray-300 space-y-0.5">
        <p>
          <span className="text-gray-500">Wholesale</span>{' '}
          <span className="font-mono">{row.wholesalePct}%</span>{' '}
          <span className="text-gray-400">
            ({formatMinor(row.wholesaleMinor, row.chargeCurrency)})
          </span>
        </p>
        <p>
          <span className="text-gray-500">Cashback</span>{' '}
          <span className="font-mono">{row.userCashbackPct}%</span>{' '}
          <span className="text-gray-400">
            ({formatMinor(row.userCashbackMinor, row.chargeCurrency)})
          </span>
        </p>
        <p>
          <span className="text-gray-500">Margin</span>{' '}
          <span className="font-mono">{row.loopMarginPct}%</span>{' '}
          <span className="text-gray-400">
            ({formatMinor(row.loopMarginMinor, row.chargeCurrency)})
          </span>
        </p>
      </div>
      <div className="min-w-0 text-xs text-gray-700 dark:text-gray-300 space-y-0.5">
        <p className="font-mono truncate" title={row.ctxOrderId ?? ''}>
          {row.ctxOrderId !== null ? row.ctxOrderId.slice(0, 12) : '—'}
        </p>
        <p
          className="text-[11px] text-gray-500 dark:text-gray-400 truncate"
          title={row.ctxOperatorId ?? ''}
        >
          {row.ctxOperatorId !== null ? (
            <Link
              to={`/admin/orders?ctxOperatorId=${encodeURIComponent(row.ctxOperatorId)}`}
              className="text-blue-600 hover:underline dark:text-blue-400"
              aria-label={`Show all orders carried by operator ${row.ctxOperatorId}`}
            >
              op {row.ctxOperatorId.slice(0, 10)}
            </Link>
          ) : (
            'no operator'
          )}
        </p>
      </div>
      <div className="min-w-0">
        <p
          className="font-mono text-xs text-gray-700 dark:text-gray-300 truncate"
          title={row.userId}
        >
          {row.userId.slice(0, 8)}
        </p>
        <p className="text-[11px] text-gray-500 dark:text-gray-400">{row.paymentMethod}</p>
      </div>
      <div className="text-right">
        <span
          className={`inline-block rounded-full px-2.5 py-0.5 text-[11px] font-medium ${stateClass}`}
        >
          {row.state.replace('_', ' ')}
        </span>
        {row.failureReason !== null && (
          <p
            className="mt-1 text-[11px] text-red-600 dark:text-red-400 truncate"
            title={row.failureReason}
          >
            {row.failureReason}
          </p>
        )}
      </div>
    </li>
  );
}
