import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { ApiException } from '@loop/shared';
import type { Route } from './+types/admin.orders.$orderId';
import { shouldRetry } from '~/hooks/query-retry';
import {
  getAdminOrder,
  getAdminPayoutByOrder,
  type AdminOrderState,
  type AdminOrderView,
  type AdminPayoutView,
} from '~/services/admin';
import { AdminNav } from '~/components/features/admin/AdminNav';
import { RequireAdmin } from '~/components/features/admin/RequireAdmin';
import { CopyButton } from '~/components/features/admin/CopyButton';
import { Spinner } from '~/components/ui/Spinner';
import { ADMIN_LOCALE } from '~/utils/locale';

export function meta(): Route.MetaDescriptors {
  return [{ title: 'Admin · Order — Loop' }];
}

const STATE_CLASSES: Record<AdminOrderState, string> = {
  pending_payment: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  paid: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  procuring: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300',
  fulfilled: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
  expired: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

/**
 * Formats a minor-unit (pence/cent) bigint-string as localised
 * currency. Falls back to em-dash on bad input.
 */
export function fmtMinor(minor: string, currency: string): string {
  try {
    const major = Number(BigInt(minor)) / 100;
    if (!Number.isFinite(major)) return '—';
    return new Intl.NumberFormat(ADMIN_LOCALE, { style: 'currency', currency }).format(major);
  } catch {
    return '—';
  }
}

function TimelineRow({ label, iso }: { label: string; iso: string | null }): React.JSX.Element {
  return (
    <div className="flex items-baseline gap-3 py-1.5 text-sm">
      <span className="w-24 shrink-0 text-gray-500 dark:text-gray-400">{label}</span>
      {iso !== null ? (
        <span title={iso} className="text-gray-900 dark:text-white tabular-nums">
          {new Date(iso).toLocaleString(ADMIN_LOCALE, { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      ) : (
        <span className="text-gray-400 dark:text-gray-600">—</span>
      )}
    </div>
  );
}

/**
 * `/admin/orders/:orderId` — drill-down view for a Loop-native
 * order (ADR 011/015). Ops needs to quote a specific order in a
 * ticket or correlate a stuck row with a payout; this is the
 * permalink target. Shows state, the full cashback split, CTX
 * procurement metadata, state timeline, and any failure transcript.
 */
// A2-1101: see RequireAdmin.tsx for the shell-gate rationale.
export default function AdminOrderDetailRoute(): React.JSX.Element {
  return (
    <RequireAdmin>
      <AdminOrderDetailRouteInner />
    </RequireAdmin>
  );
}

function AdminOrderDetailRouteInner(): React.JSX.Element {
  const { orderId } = useParams<{ orderId: string }>();

  const query = useQuery({
    queryKey: ['admin-order', orderId ?? null],
    queryFn: () => getAdminOrder(orderId ?? ''),
    enabled: orderId !== undefined && orderId.length > 0,
    retry: shouldRetry,
    staleTime: 10_000,
  });

  const notFound = query.error instanceof ApiException && query.error.status === 404;

  return (
    <main className="max-w-3xl mx-auto px-6 py-12 space-y-6">
      <AdminNav />
      <nav aria-label="Back to orders list">
        <Link
          to="/admin/orders"
          className="text-sm text-gray-600 hover:underline dark:text-gray-400"
        >
          ← All orders
        </Link>
      </nav>

      {query.isPending ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : notFound ? (
        <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Order not found</h1>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            No order with id <code className="font-mono text-xs">{orderId}</code>.
          </p>
        </section>
      ) : query.isError ? (
        <p className="text-red-600 dark:text-red-400 py-6">
          Failed to load order. You may not be an admin.
        </p>
      ) : (
        <>
          <Detail row={query.data} />
          {orderId !== undefined ? <OrderPayoutSection orderId={orderId} /> : null}
        </>
      )}
    </main>
  );
}

/**
 * Shows the on-chain payout emitted for this order, if any. Hides
 * itself silently on 404 with a gentle "no payout yet" line —
 * payout-builder skips under several expected conditions (no linked
 * wallet, cashback=0, Loop-margin-only merchants), none of which
 * warrant a red banner.
 */
function OrderPayoutSection({ orderId }: { orderId: string }): React.JSX.Element {
  const query = useQuery({
    queryKey: ['admin-order-payout', orderId],
    queryFn: () => getAdminPayoutByOrder(orderId),
    retry: shouldRetry,
    staleTime: 30_000,
  });

  if (query.isPending) {
    return (
      <section className="flex justify-center py-4">
        <Spinner />
      </section>
    );
  }

  const notFound = query.error instanceof ApiException && query.error.status === 404;
  if (query.isError && notFound) {
    return (
      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          On-chain payout
        </h2>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
          No payout row for this order yet. If the user hasn&rsquo;t linked a Stellar wallet, or the
          cashback share rounds to zero, the payout builder skips the emission.
        </p>
      </section>
    );
  }

  if (query.isError) {
    return (
      <section className="rounded-xl border border-red-200 bg-red-50 px-6 py-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
        Failed to load on-chain payout.
      </section>
    );
  }

  const payout: AdminPayoutView = query.data;
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900">
      <header className="flex items-start justify-between gap-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          On-chain payout
        </h2>
        <Link
          to={`/admin/payouts/${payout.id}`}
          className="text-xs font-medium text-blue-600 hover:underline dark:text-blue-400"
        >
          See full payout →
        </Link>
      </header>
      <dl className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3 text-sm">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">State</dt>
          <dd className="text-gray-900 dark:text-white">{payout.state}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Asset</dt>
          <dd className="text-gray-900 dark:text-white font-mono text-xs">{payout.assetCode}</dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Attempts</dt>
          <dd className="text-gray-900 dark:text-white tabular-nums">{payout.attempts}</dd>
        </div>
      </dl>
    </section>
  );
}

function Detail({ row }: { row: AdminOrderView }): React.JSX.Element {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-900 space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
            {fmtMinor(row.faceValueMinor, row.currency)}
          </h1>
          <p className="mt-1 text-xs font-mono text-gray-500 dark:text-gray-400 break-all inline-flex items-center gap-1">
            {row.id}
            <CopyButton text={row.id} label="Copy order id" />
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${STATE_CLASSES[row.state]}`}
        >
          {row.state.replace('_', ' ')}
        </span>
      </header>

      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 text-sm">
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Merchant</dt>
          <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all inline-flex items-center gap-1">
            {row.merchantId}
            <CopyButton text={row.merchantId} label="Copy merchant id" />
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">User</dt>
          <dd>
            <Link
              to={`/admin/users/${row.userId}`}
              className="text-blue-600 hover:underline dark:text-blue-400 font-mono text-xs break-all"
            >
              {row.userId}
            </Link>
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">Charge</dt>
          <dd className="text-gray-900 dark:text-white inline-flex items-center gap-2 flex-wrap">
            <span>{fmtMinor(row.chargeMinor, row.chargeCurrency)}</span>
            <span className="text-gray-500 dark:text-gray-400">via</span>
            {row.paymentMethod === 'loop_asset' ? (
              // Cross-surface consistency: same green "Recycled" pill
              // treatment as /admin/stuck-orders, /admin/orders (list),
              // and the user-facing LoopOrdersList row. Makes a
              // flywheel-closing order immediately legible regardless
              // of which admin surface an operator comes in through.
              <span
                className="inline-flex items-center gap-1 rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800 dark:bg-green-900/30 dark:text-green-300"
                aria-label="Paid with recycled cashback"
                title="The user paid for this order with LOOP-asset cashback they earned on earlier orders."
              >
                <span aria-hidden="true">♻️</span>
                {row.paymentMethod}
              </span>
            ) : (
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                {row.paymentMethod}
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">CTX operator</dt>
          <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all">
            {row.ctxOperatorId ?? '—'}
          </dd>
        </div>
        <div>
          <dt className="text-gray-500 dark:text-gray-400">CTX order</dt>
          <dd className="font-mono text-xs text-gray-700 dark:text-gray-300 break-all inline-flex items-center gap-1">
            {row.ctxOrderId ?? '—'}
            {row.ctxOrderId !== null && row.ctxOrderId !== undefined ? (
              <CopyButton text={row.ctxOrderId} label="Copy CTX order id" />
            ) : null}
          </dd>
        </div>
      </dl>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Cashback split (ADR 011)
        </h2>
        <dl className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Wholesale (ours)</dt>
            <dd className="tabular-nums text-gray-900 dark:text-white">
              {fmtMinor(row.wholesaleMinor, row.chargeCurrency)}{' '}
              <span className="text-xs text-gray-500 dark:text-gray-400">
                ({row.wholesalePct}%)
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Cashback (theirs)</dt>
            <dd className="tabular-nums text-gray-900 dark:text-white">
              {fmtMinor(row.userCashbackMinor, row.chargeCurrency)}{' '}
              <span className="text-xs text-gray-500 dark:text-gray-400">
                ({row.userCashbackPct}%)
              </span>
            </dd>
          </div>
          <div>
            <dt className="text-gray-500 dark:text-gray-400">Loop margin</dt>
            <dd className="tabular-nums font-medium text-gray-900 dark:text-white">
              {fmtMinor(row.loopMarginMinor, row.chargeCurrency)}{' '}
              <span className="text-xs text-gray-500 dark:text-gray-400">
                ({row.loopMarginPct}%)
              </span>
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Timeline
        </h2>
        <div className="mt-2 divide-y divide-gray-100 dark:divide-gray-900">
          <TimelineRow label="Created" iso={row.createdAt} />
          <TimelineRow label="Paid" iso={row.paidAt} />
          <TimelineRow label="Procured" iso={row.procuredAt} />
          <TimelineRow label="Fulfilled" iso={row.fulfilledAt} />
          <TimelineRow label="Failed" iso={row.failedAt} />
        </div>
      </section>

      {row.failureReason !== null ? (
        <section>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
            Failure reason
          </h2>
          <pre className="mt-2 rounded-lg bg-red-50 dark:bg-red-900/20 px-3 py-2 text-xs text-red-800 dark:text-red-300 whitespace-pre-wrap break-words">
            {row.failureReason}
          </pre>
        </section>
      ) : null}
    </section>
  );
}
