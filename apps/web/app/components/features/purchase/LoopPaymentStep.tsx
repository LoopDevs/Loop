import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  getLoopOrder,
  isLoopOrderTerminal,
  loopOrderStateLabel,
  type CreateLoopOrderResponse,
  type LoopOrderView,
} from '~/services/orders-loop';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';

export interface LoopPaymentStepProps {
  /** Result of `createLoopOrder` — the memo + deposit address we display to the user. */
  create: CreateLoopOrderResponse;
  /** Called when the order reaches a terminal state (fulfilled / failed / expired). */
  onTerminal?: ((order: LoopOrderView) => void) | undefined;
}

/**
 * Pay-and-wait step for a Loop-native order (ADR 010).
 *
 * For XLM / USDC: shows the deposit address + memo with copy buttons
 * and a live state label ("Waiting for payment" → "Payment received" →
 * "Buying your gift card" → "Ready"). Polls `getLoopOrder` every 3s
 * until the order hits a terminal state.
 *
 * For `credit`: there's nothing for the user to send — the watcher
 * will flip it to paid on the next tick. We still poll so the UI
 * follows the state through to fulfilled.
 */
export function LoopPaymentStep({ create, onTerminal }: LoopPaymentStepProps): React.JSX.Element {
  const [notifiedTerminal, setNotifiedTerminal] = useState(false);

  const orderQuery = useQuery({
    queryKey: ['loop-order', create.orderId],
    queryFn: () => getLoopOrder(create.orderId),
    retry: shouldRetry,
    // 3s poll while the order is in-flight. The backend rate-limit is
    // 120/min — a single-tab poll at 3s is well inside that.
    refetchInterval: (query) => {
      const order = query.state.data as LoopOrderView | undefined;
      if (order === undefined) return 3000;
      return isLoopOrderTerminal(order.state) ? false : 3000;
    },
  });

  // Fire onTerminal exactly once when the order crosses into a
  // terminal state — useful for the parent container to advance to
  // a confirmation screen or show an error toast.
  useEffect(() => {
    if (notifiedTerminal) return;
    const order = orderQuery.data;
    if (order === undefined) return;
    if (!isLoopOrderTerminal(order.state)) return;
    setNotifiedTerminal(true);
    onTerminal?.(order);
  }, [orderQuery.data, notifiedTerminal, onTerminal]);

  const stateLabel =
    orderQuery.data !== undefined ? loopOrderStateLabel(orderQuery.data.state) : 'Creating order…';

  return (
    <section className="max-w-md mx-auto px-5 py-8 flex flex-col gap-5">
      <header className="text-center">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
          Order {create.orderId.slice(0, 8)}
        </div>
        <h2 className="text-2xl font-semibold text-gray-900 dark:text-white">{stateLabel}</h2>
      </header>

      {orderQuery.data?.state === 'fulfilled' ? (
        <RedemptionBody order={orderQuery.data} />
      ) : create.payment.method === 'credit' ? (
        <CreditPaymentBody order={orderQuery.data} />
      ) : (
        // A2-1504: the stellar-funded payload now includes `loop_asset`
        // (ADR 015 recycled-cashback rail). Rendering is identical to
        // xlm/usdc — stellarAddress + memo + amount — and
        // StellarPaymentBody shows the asset label in the "Send X in Y"
        // line. assetCode is only on the loop_asset variant; the render
        // asserts its presence via a method-narrowing check inside.
        <StellarPaymentBody
          address={create.payment.stellarAddress}
          memo={create.payment.memo}
          method={create.payment.method}
          amountMinor={create.payment.amountMinor}
          currency={create.payment.currency}
          assetLabel={
            create.payment.method === 'loop_asset'
              ? create.payment.assetCode
              : create.payment.method.toUpperCase()
          }
          order={orderQuery.data}
        />
      )}

      {orderQuery.data?.state === 'failed' && (
        <div className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-3 text-sm text-red-700 dark:text-red-300">
          {orderQuery.data.failureReason ?? 'Order failed.'}
        </div>
      )}
    </section>
  );
}

/**
 * Displayed once the order reaches `fulfilled`. Shows whichever of
 * code / PIN / redeem URL CTX returned — merchant types vary in
 * which fields they use. Copy buttons on the static values; a
 * launch button on the URL.
 *
 * All-null redemption (CTX detail fetch failed at procurement time)
 * is surfaced as a "Check your email" fallback — the operator can
 * backfill later, and the user's order history retains the entry.
 */
function RedemptionBody({ order }: { order: LoopOrderView }): React.JSX.Element {
  const hasCode = order.redeemCode !== null && order.redeemCode.length > 0;
  const hasPin = order.redeemPin !== null && order.redeemPin.length > 0;
  const hasUrl = order.redeemUrl !== null && order.redeemUrl.length > 0;

  if (!hasCode && !hasPin && !hasUrl) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 text-center">
        <p className="text-sm text-gray-700 dark:text-gray-300">
          Your gift card is ready. Redemption details are still coming through — check back in a
          moment, or look at your email.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-green-200 dark:border-green-900/40 bg-green-50/50 dark:bg-green-900/10 p-4 space-y-3">
      {hasCode ? <Row label="Gift card code" value={order.redeemCode!} copyable mono /> : null}
      {hasPin ? <Row label="PIN" value={order.redeemPin!} copyable mono /> : null}
      {hasUrl ? (
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Redeem online
          </div>
          <a
            href={order.redeemUrl!}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center justify-center w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-2"
          >
            Open redemption link
          </a>
        </div>
      ) : null}
      {order.userCashbackMinor !== '0' ? (
        <p className="text-xs text-green-700 dark:text-green-300 text-center pt-2 border-t border-green-200 dark:border-green-900/40">
          {formatMinor(order.userCashbackMinor)} {order.currency} cashback credited.
        </p>
      ) : null}
    </div>
  );
}

function CreditPaymentBody({ order }: { order: LoopOrderView | undefined }): React.JSX.Element {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 text-center">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Paying with your Loop credit balance — no action needed.
      </p>
      {order === undefined || !isLoopOrderTerminal(order.state) ? (
        <div className="mt-4 flex justify-center">
          <Spinner />
        </div>
      ) : null}
    </div>
  );
}

interface StellarPaymentBodyProps {
  address: string;
  memo: string;
  /** Payment rail: native XLM, USDC trustline, or a LOOP-branded stablecoin. */
  method: 'xlm' | 'usdc' | 'loop_asset';
  amountMinor: string;
  currency: string;
  /**
   * User-facing label for the rail. `XLM` / `USDC` for native methods,
   * the `USDLOOP`/`GBPLOOP`/`EURLOOP` asset code for `loop_asset` so
   * the user sees the exact asset their wallet needs to send.
   */
  assetLabel: string;
  order: LoopOrderView | undefined;
}

function StellarPaymentBody({
  address,
  memo,
  amountMinor,
  currency,
  assetLabel,
  order,
}: StellarPaymentBodyProps): React.JSX.Element {
  const showSpinner = order === undefined || order.state === 'pending_payment';
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
        <Row label="Send" value={`${formatMinor(amountMinor)} ${currency} in ${assetLabel}`} />
        <Row label="To address" value={address} copyable />
        <Row label="Memo (required)" value={memo} copyable mono />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
        Send from any Stellar wallet. Your order updates automatically once the payment confirms.
      </p>
      {showSpinner ? (
        <div className="flex justify-center">
          <Spinner />
        </div>
      ) : null}
    </div>
  );
}

function Row({
  label,
  value,
  copyable,
  mono,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  mono?: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = (): void => {
    void navigator.clipboard.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{label}</div>
      <div className="flex items-center justify-between gap-2">
        <div
          className={`text-sm text-gray-900 dark:text-white break-all ${mono === true ? 'font-mono' : ''}`}
        >
          {value}
        </div>
        {copyable === true ? (
          <button
            type="button"
            onClick={onCopy}
            className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:underline shrink-0"
            aria-label={`Copy ${label.toLowerCase()}`}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** BigInt-safe minor-unit → major-unit with two decimal places. */
function formatMinor(minor: string): string {
  const negative = minor.startsWith('-');
  const digits = negative ? minor.slice(1) : minor;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  return `${negative ? '-' : ''}${Number(whole).toLocaleString('en-US')}.${fraction}`;
}
