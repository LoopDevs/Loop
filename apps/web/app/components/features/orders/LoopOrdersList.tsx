import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { assertNever } from '@loop/shared';
import { listLoopOrders, loopOrderStateLabel, type LoopOrderView } from '~/services/orders-loop';
import { useAllMerchants } from '~/hooks/use-merchants';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { formatDateTime, formatMinorCurrency, useLocaleTag } from '~/i18n/format';
import { safeRedeemHref } from '~/native/webview';
import { copySensitive } from '~/native/clipboard';

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
  const { t } = useTranslation('orders');
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
        {t('loopList.heading')}
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
  const { t } = useTranslation('orders');
  // A4-026: unpaid rows auto-expand so the user sees the awaiting-
  // payment banner without knowing to click the row. The payment
  // instructions themselves live on the merchant page's pay screen
  // (rebuilt server-side from the detail read — ADR 052); the list
  // read deliberately carries no payment payload.
  const [expanded, setExpanded] = useState(order.state === 'unpaid');
  const { merchants } = useAllMerchants();
  const locale = useLocaleTag();
  const merchantName = merchants.find((m) => m.id === order.merchantId)?.name ?? order.merchantId;
  // WUM-04 (2026-06-30 cold audit): canonical symbol-prefixed formatter,
  // matching the cashback teaser two lines below instead of the old
  // bare-number-plus-code-suffix local formatMinor.
  const amount = formatMinorCurrency(order.faceValueMinor, order.currency, locale);
  // Route-locale timestamp via the shared `formatDateTime` seam — not a local
  // `toLocaleDateString` copy — so a `/de/en` reader sees the German month/order,
  // not the host default (ADR 034 / P2-DATE). Options unchanged.
  const date = formatDateTime(order.createdAt, locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const isFulfilled = order.state === 'fulfilled';
  // P2-03: scheme-gate the upstream redeemUrl before it reaches an
  // `<a href>`. `safeRedeemHref` returns null for anything that isn't a
  // safe http(s) URL — a `javascript:`/`data:` value is neutralized to
  // "no link" rather than a clickable XSS payload in the native WebView.
  const redeemHref =
    order.redeemUrl !== null && order.redeemUrl.length > 0 ? safeRedeemHref(order.redeemUrl) : null;
  const hasRedemption =
    (order.redeemCode !== null && order.redeemCode.length > 0) ||
    (order.redeemPin !== null && order.redeemPin.length > 0) ||
    redeemHref !== null;
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
        className="flex items-center justify-between w-full px-4 py-3 text-start hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
        aria-expanded={expanded}
      >
        <div className="flex-1 min-w-0">
          <div className="font-medium text-gray-900 dark:text-white truncate">{merchantName}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{date}</div>
        </div>
        <div className="flex items-center gap-3 ms-4">
          <div className="text-end">
            <div className="text-sm font-semibold text-gray-900 dark:text-white tabular-nums">
              {amount}
            </div>
            {hasEarnedCashback ? (
              <div className="mt-0.5 text-[11px] font-medium text-green-700 dark:text-green-400 tabular-nums">
                {/* WEB-M2: render the currency symbol/code so £1.25 isn't
                    ambiguous with $1.25 on the always-visible row. */}
                {t('loopList.earnedCashback', {
                  amount: formatMinorCurrency(order.userCashbackMinor, order.currency, locale),
                })}
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
                <RedemptionField
                  label={t('loopList.fields.code')}
                  value={order.redeemCode}
                  sensitive
                />
              ) : null}
              {order.redeemPin !== null && order.redeemPin.length > 0 ? (
                <RedemptionField
                  label={t('loopList.fields.pin')}
                  value={order.redeemPin}
                  sensitive
                />
              ) : null}
              {redeemHref !== null ? (
                <a
                  href={redeemHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium px-3 py-1.5"
                >
                  {t('loopList.openRedemptionLink')}
                </a>
              ) : null}
            </div>
          ) : null}
          {order.userCashbackMinor !== '0' && isFulfilled ? (
            <div className="text-xs text-green-700 dark:text-green-300">
              {t('loopList.cashbackCredited', {
                amount: formatMinorCurrency(order.userCashbackMinor, order.currency, locale),
              })}
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
  const { t } = useTranslation('orders');
  const locale = useLocaleTag();
  if (order.state === 'rejected' || order.state === 'refunded') {
    return (
      <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-2 text-xs text-red-700 dark:text-red-300">
        {order.failureReason ?? t('loopList.failedFallback')}
      </div>
    );
  }
  if (order.state === 'expired') {
    return (
      <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 p-2 text-xs text-gray-600 dark:text-gray-400">
        {t('loopList.expired')}
      </div>
    );
  }
  // ADR 052: the list read carries no payment payload — the pay screen
  // is rebuilt server-side on the merchant page (detail read). This
  // banner just tells the user the order is still awaiting payment and
  // what CTX is expecting.
  if (order.state === 'unpaid') {
    return (
      <div className="rounded-lg border border-yellow-200 dark:border-yellow-900/40 bg-yellow-50 dark:bg-yellow-900/20 p-3 text-xs text-yellow-900 dark:text-yellow-100">
        <p className="font-medium">
          {t('loopList.pendingPayment', {
            amount: formatMinorCurrency(order.chargeMinor, order.chargeCurrency, locale),
            asset: order.paymentCryptoCurrency ?? '',
          })}
        </p>
      </div>
    );
  }
  return null;
}

function RedemptionField({
  label,
  value,
  sensitive = false,
}: {
  label: string;
  value: string;
  /**
   * When true the value is a redemption secret (gift-card code / PIN):
   * copy via `copySensitive` so the clipboard auto-clears after a short
   * delay (FE-05). Non-sensitive fields (payment address / memo) copy
   * plainly and are left on the clipboard.
   */
  sensitive?: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('orders');
  const [copied, setCopied] = useState(false);
  const onCopy = (): void => {
    if (sensitive) {
      void copySensitive(value);
    } else {
      void navigator.clipboard.writeText(value);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
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
          aria-label={t('loopList.copyAriaLabel', { label: label.toLowerCase() })}
        >
          {copied ? t('loopList.copied') : t('loopList.copy')}
        </button>
      </div>
      {/* WUM-10 (2026-06-30 cold audit) / CF-35 rollout: confirm copy to
          assistive tech, mirroring LoopPaymentStep's Row exactly — this
          function is that component's structural sibling for the orders
          list (address/memo recovery panel + redeem code/PIN). */}
      <span aria-live="polite" className="sr-only">
        {copied ? t('loopList.copiedAnnouncement', { label }) : ''}
      </span>
    </div>
  );
}

function stateColour(state: LoopOrderView['state']): string {
  // A2-1531 fix: the prior `default:` silently routed new OrderState
  // variants to yellow. Exhaustive switch + assertNever forces every
  // new state to land here explicitly at compile time; runtime hit
  // (wire-side variant the client doesn't know) throws loudly rather
  // than faking a neutral pill.
  switch (state) {
    case 'fulfilled':
      return 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300';
    case 'rejected':
    case 'refunded':
      return 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300';
    case 'expired':
      return 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300';
    case 'unpaid':
    case 'paid':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300';
    default:
      return assertNever(state, 'OrderState');
  }
}
