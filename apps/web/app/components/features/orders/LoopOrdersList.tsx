import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listLoopOrders, loopOrderStateLabel, type LoopOrderView } from '~/services/orders-loop';
import { useAllMerchants } from '~/hooks/use-merchants';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

/**
 * Loop-native orders section on the account/orders page.
 *
 * Rendered at the top of the orders list when the Loop-native flow
 * is live in the deployment. Fetches `GET /api/orders/loop` and
 * shows each order as a collapsible row: merchant + amount +
 * state pill on the always-visible line, and the redemption
 * payload (code / PIN / redeem URL) inside the expanded panel
 * once the order is fulfilled.
 */
export function LoopOrdersList({ enabled }: { enabled: boolean }): React.JSX.Element | null {
  const query = useQuery({
    queryKey: ['loop-orders'],
    queryFn: () => listLoopOrders(),
    enabled,
    retry: shouldRetry,
    // 30s staleTime is enough — the user arrives at this page after
    // a purchase, not mid-polling. Inline expansion + re-click
    // triggers a refetch if they just came back from a still-in-
    // flight order.
    staleTime: 30_000,
  });

  if (!enabled) return null;
  if (query.isPending) {
    return (
      <div className="flex justify-center py-6">
        <Spinner />
      </div>
    );
  }
  if (query.isError) return null; // Silent fall-back — legacy list below still renders.

  const orders = query.data.orders;
  if (orders.length === 0) return null;

  return (
    <section className="mb-6" aria-label="Loop orders">
      <h2 className="px-1 mb-2 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        Your orders
      </h2>
      <ul className="divide-y divide-gray-100 dark:divide-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden">
        {orders.map((order) => (
          <LoopOrderRow key={order.id} order={order} />
        ))}
      </ul>
    </section>
  );
}

function LoopOrderRow({ order }: { order: LoopOrderView }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const { merchants } = useAllMerchants();
  const merchantName = merchants.find((m) => m.id === order.merchantId)?.name ?? order.merchantId;
  const amount = formatMinor(order.faceValueMinor);
  const date = new Date(order.createdAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const isFulfilled = order.state === 'fulfilled';
  const hasRedemption =
    (order.redeemCode !== null && order.redeemCode.length > 0) ||
    (order.redeemPin !== null && order.redeemPin.length > 0) ||
    (order.redeemUrl !== null && order.redeemUrl.length > 0);
  // Surface earned cashback on the row's always-visible line so the
  // user doesn't have to expand to see what they earned. Hide when
  // the backend recorded zero (e.g. a margin-only merchant or a
  // pre-ADR-011 order) rather than printing "+0.00 cashback".
  const hasEarnedCashback = isFulfilled && order.userCashbackMinor !== '0';

  return (
    <li>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 dark:text-white truncate">{merchantName}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{date}</div>
        </div>
        <div className="flex items-center gap-3 ml-4">
          <div className="text-right">
            <div className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums">
              {amount} {order.currency}
            </div>
            {hasEarnedCashback ? (
              <div className="mt-0.5 text-[11px] font-medium text-green-700 dark:text-green-400 tabular-nums">
                +{formatMinor(order.userCashbackMinor)} cashback
              </div>
            ) : null}
          </div>
          <StatePill state={order.state} />
        </div>
      </button>
      {expanded ? (
        <div className="px-4 pb-4 pt-1 text-sm space-y-3">
          <StateBanner order={order} />
          {isFulfilled && hasRedemption ? (
            <div className="rounded-lg bg-gray-50 dark:bg-gray-950/50 p-3 space-y-2">
              {order.redeemCode !== null && order.redeemCode.length > 0 ? (
                <RedemptionField label="Code" value={order.redeemCode} />
              ) : null}
              {order.redeemPin !== null && order.redeemPin.length > 0 ? (
                <RedemptionField label="PIN" value={order.redeemPin} />
              ) : null}
              {order.redeemUrl !== null && order.redeemUrl.length > 0 ? (
                <a
                  href={order.redeemUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-3 py-1.5"
                >
                  Open redemption link
                </a>
              ) : null}
            </div>
          ) : null}
          {order.userCashbackMinor !== '0' && isFulfilled ? (
            <div className="text-xs text-green-700 dark:text-green-300">
              {formatMinor(order.userCashbackMinor)} {order.currency} cashback credited.
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function StatePill({ state }: { state: LoopOrderView['state'] }): React.JSX.Element {
  const color = stateColour(state);
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${color}`}>
      {loopOrderStateLabel(state)}
    </span>
  );
}

function StateBanner({ order }: { order: LoopOrderView }): React.JSX.Element | null {
  if (order.state === 'failed') {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-700 dark:text-red-300">
        {order.failureReason ?? 'Order failed.'}
      </div>
    );
  }
  if (order.state === 'expired') {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-2 text-xs text-gray-600 dark:text-gray-400">
        Order expired before payment arrived.
      </div>
    );
  }
  return null;
}

function RedemptionField({ label, value }: { label: string; value: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = (): void => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {label}
        </div>
        <div className="text-sm font-mono text-gray-900 dark:text-white break-all">{value}</div>
      </div>
      <button
        type="button"
        onClick={onCopy}
        className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function stateColour(state: LoopOrderView['state']): string {
  switch (state) {
    case 'fulfilled':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'failed':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'expired':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
    default:
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
  }
}

function formatMinor(minor: string): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  return `${negative ? '-' : ''}${Number(whole).toLocaleString('en-US')}.${fraction}`;
}
