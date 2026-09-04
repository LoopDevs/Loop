import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import {
  getLoopOrder,
  isLoopOrderFailure,
  isLoopOrderTerminal,
  loopOrderStateLabel,
  type CreateLoopOrderResponse,
  type LoopOrderPaymentInstructions,
  type LoopOrderView,
} from '~/services/orders-loop';
import { shouldRetry } from '~/hooks/query-retry';
import { Spinner } from '~/components/ui/Spinner';
import { safeRedeemHref, safePaymentUriHref } from '~/native/webview';
import { formatMinorCurrency, useLocaleTag } from '~/i18n/format';
import { copySensitive } from '~/native/clipboard';

export interface LoopPaymentStepProps {
  /** Result of `createLoopOrder` — CTX's payment instructions we display to the user. */
  create: CreateLoopOrderResponse;
  /** Called when the order reaches a terminal state (fulfilled / rejected / refunded / expired). */
  onTerminal?: ((order: LoopOrderView) => void) | undefined;
  /**
   * Called once if `GET /api/orders/loop/:id` settles into a
   * non-retryable 404/403 — the order doesn't exist, or doesn't belong
   * to the caller (e.g. a different account restored a stale persisted
   * order id from the same device). Without this, the poll would keep
   * re-firing the same failing request every 3s and the screen would
   * sit on "Creating order…" forever. Distinct from `onTerminal`
   * because there's no `LoopOrderView` to hand back — nothing was ever
   * fetched.
   */
  onOrderNotFound?: (() => void) | undefined;
}

/**
 * Pay-and-wait step for a Loop-native order (ADR 052 — ctx is the
 * payment processor).
 *
 * While `unpaid`: renders CTX's payment instructions — the fiat charge,
 * the crypto amount + currency, the deposit address (copyable + QR),
 * an "Open in wallet" deep-link when CTX supplied a payment URI for
 * the chosen currency, and a countdown to the CTX payment-window
 * expiry. Polls `getLoopOrder` every 3s; `paid` collapses to a
 * "payment received, card on the way" spinner, `fulfilled` shows the
 * redemption payload, and rejected/refunded/expired render the
 * failure body.
 */
export function LoopPaymentStep({
  create,
  onTerminal,
  onOrderNotFound,
}: LoopPaymentStepProps): React.JSX.Element {
  const [notifiedTerminal, setNotifiedTerminal] = useState(false);
  const [notifiedNotFound, setNotifiedNotFound] = useState(false);
  // A11Y-001 / CF-35: move focus to the redemption block once the order
  // reaches `fulfilled` so an SR user lands on the gift card code/PIN
  // instead of the change being announced silently somewhere off-screen.
  const redemptionRef = useRef<HTMLDivElement>(null);

  const orderQuery = useQuery({
    queryKey: ['loop-order', create.orderId],
    queryFn: () => getLoopOrder(create.orderId),
    retry: shouldRetry,
    // 3s poll while the order is in-flight. The backend rate-limit is
    // 120/min — a single-tab poll at 3s is well inside that.
    refetchInterval: (query) => {
      const order = query.state.data as LoopOrderView | undefined;
      if (order === undefined) {
        // A non-retryable 404/403 means this order id doesn't exist for
        // this caller — stop hammering the same doomed request every
        // 3s. Any other error (5xx, network, timeout) keeps polling;
        // `shouldRetry` already backs off TanStack's own inline retry
        // for those, but this interval poll is what recovers once a
        // transient blip clears.
        const err = query.state.error;
        if (err instanceof ApiException && (err.status === 404 || err.status === 403)) {
          return false;
        }
        return 3000;
      }
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

  // Fire onOrderNotFound exactly once if the GET settles into a
  // non-retryable 404/403 — see the prop doc for why this needs its own
  // signal (no LoopOrderView was ever fetched, so onTerminal can't fire).
  useEffect(() => {
    if (notifiedNotFound) return;
    const err = orderQuery.error;
    if (!(err instanceof ApiException) || (err.status !== 404 && err.status !== 403)) return;
    setNotifiedNotFound(true);
    onOrderNotFound?.();
  }, [orderQuery.error, notifiedNotFound, onOrderNotFound]);

  // Poll data wins once present (it tracks CTX); until then the create
  // response's snapshot drives the screen so the user isn't staring at
  // a spinner while the first poll is in flight.
  const state = orderQuery.data?.state ?? create.state;
  const stateLabel = loopOrderStateLabel(state);
  const isFulfilled = orderQuery.data?.state === 'fulfilled';
  const isFailure = isLoopOrderFailure(state);

  useEffect(() => {
    if (isFulfilled) redemptionRef.current?.focus();
  }, [isFulfilled]);

  return (
    <section className="max-w-md mx-auto px-5 py-8 flex flex-col gap-5">
      <header className="text-center">
        <div className="text-xs font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-1">
          Order {create.orderId.slice(0, 8)}
        </div>
        {/* A11Y-001 / CF-35: the state label updates via a 3s poll — wrap it
            in a polite live region so "Waiting for payment" → "Payment
            received" → "Ready" is announced to SR users. */}
        <h2 aria-live="polite" className="text-2xl font-semibold text-gray-900 dark:text-white">
          {stateLabel}
        </h2>
      </header>

      {isFulfilled ? (
        <div ref={redemptionRef} tabIndex={-1} role="status">
          <RedemptionBody order={orderQuery.data!} />
        </div>
      ) : isFailure ? (
        <FailureBody state={state} failureReason={orderQuery.data?.failureReason ?? null} />
      ) : state === 'paid' ? (
        <PaidBody />
      ) : (
        <CtxPaymentBody payment={create.payment} />
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
  const locale = useLocaleTag();
  const hasCode = order.redeemCode !== null && order.redeemCode.length > 0;
  const hasPin = order.redeemPin !== null && order.redeemPin.length > 0;
  // P2-03: scheme-gate the upstream redeemUrl before it reaches an
  // `<a href>`. `safeRedeemHref` returns null for anything that isn't a
  // safe http(s) URL — a `javascript:`/`data:` value is neutralized to
  // "no link" rather than a clickable XSS payload in the native WebView.
  const redeemHref =
    order.redeemUrl !== null && order.redeemUrl.length > 0 ? safeRedeemHref(order.redeemUrl) : null;
  const hasUrl = redeemHref !== null;

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
      {hasCode ? (
        <Row label="Gift card code" value={order.redeemCode!} copyable mono sensitive />
      ) : null}
      {hasPin ? <Row label="PIN" value={order.redeemPin!} copyable mono sensitive /> : null}
      {redeemHref !== null ? (
        <div>
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">
            Redeem online
          </div>
          <a
            href={redeemHref}
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
          {formatMinorCurrency(order.userCashbackMinor, order.currency, locale)} cashback applied as
          a discount.
        </p>
      ) : null}
    </div>
  );
}

/** `paid` — CTX confirmed the payment; the card is on its way. */
function PaidBody(): React.JSX.Element {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 text-center">
      <p className="text-sm text-gray-700 dark:text-gray-300">
        Thanks — your gift card is on the way.
      </p>
      <div className="mt-4 flex justify-center">
        <Spinner />
      </div>
    </div>
  );
}

/** Terminal failure states: rejected / refunded / expired. */
function FailureBody({
  state,
  failureReason,
}: {
  state: LoopOrderView['state'];
  failureReason: string | null;
}): React.JSX.Element {
  return (
    <div
      role="alert"
      className="rounded-lg border border-red-200 dark:border-red-900/40 bg-red-50 dark:bg-red-900/20 p-4 text-sm text-red-700 dark:text-red-300"
    >
      {failureReason ?? `Order ${state}.`}
    </div>
  );
}

/**
 * `unpaid` — CTX's payment instructions (ADR 052). The customer pays
 * CTX directly: fiat charge, crypto amount + currency, deposit address
 * with copy + QR, an "Open in wallet" deep-link when CTX supplied a
 * payment URI for the chosen currency, and a countdown to the
 * payment-window expiry (hidden when CTX didn't report one).
 */
function CtxPaymentBody({ payment }: { payment: LoopOrderPaymentInstructions }): React.JSX.Element {
  const locale = useLocaleTag();
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);

  // PAYMENTURI-UNGATED (XSS): `paymentUrls` values are upstream-supplied
  // (see safePaymentUriHref). A `javascript:`/`data:` scheme dropped into
  // this anchor would execute on tap inside the native WebView. Gate it
  // to the wallet-scheme allow-list; a rejected URI yields null and we
  // render no live link — the address copy path below still lets the
  // user pay.
  const rawUri = payment.paymentUrls[payment.cryptoCurrency];
  const paymentHref = rawUri !== undefined ? safePaymentUriHref(rawUri) : null;

  // QR encodes the wallet URI when CTX supplied one (wallets prefill
  // amount + destination from it) and falls back to the bare address.
  const qrContent = paymentHref ?? payment.address;

  useEffect(() => {
    if (qrContent === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const QRCode = await import('qrcode');
        const url = await QRCode.toDataURL(qrContent, { width: 200, margin: 1 });
        if (!cancelled) setQrDataUrl(url);
      } catch {
        // QR code generation failed — address still shown as text
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [qrContent]);

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-4 space-y-3">
        <Row
          label="You pay"
          value={formatMinorCurrency(payment.amountMinor, payment.currency, locale)}
        />
        {payment.cryptoAmount !== null ? (
          <Row label="Send" value={`${payment.cryptoAmount} ${payment.cryptoCurrency}`} mono />
        ) : (
          <Row label="Pay in" value={payment.cryptoCurrency} mono />
        )}
        {payment.address !== null ? (
          <Row label="To address" value={payment.address} copyable mono />
        ) : null}
      </div>

      {qrDataUrl !== null ? (
        <div className="flex justify-center">
          <img src={qrDataUrl} alt="Payment QR code" className="rounded-lg" />
        </div>
      ) : null}

      {paymentHref !== null ? (
        <a
          href={paymentHref}
          className="block w-full rounded-lg bg-gray-900 hover:bg-gray-800 dark:bg-white dark:text-gray-900 dark:hover:bg-gray-200 px-4 py-3 text-center text-sm font-semibold text-white"
        >
          Open in wallet
        </a>
      ) : null}

      <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
        Send exactly this amount from any {payment.cryptoCurrency} wallet. Your order updates
        automatically once the payment confirms.
      </p>

      <ExpiryCountdown expiresAt={payment.expiresAt} />

      <div className="flex justify-center">
        <Spinner />
      </div>
    </div>
  );
}

/**
 * Countdown to CTX's payment-window expiry. Renders nothing when the
 * server didn't report one (`expiresAt: null`) — a missing window is
 * "no deadline to show", never a fabricated local one.
 *
 * WCAG 2.2.1 (Timing Adjustable) / A11Y-002: announced politely on a
 * coarse cadence so SR users hear time running low without a
 * per-second barrage.
 */
function ExpiryCountdown({ expiresAt }: { expiresAt: string | null }): React.JSX.Element | null {
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    if (expiresAt === null) return;
    const expiryMs = Date.parse(expiresAt);
    if (Number.isNaN(expiryMs)) return;
    const tick = (): void => {
      setSecondsLeft(Math.max(0, Math.floor((expiryMs - Date.now()) / 1000)));
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  if (expiresAt === null || secondsLeft === null) return null;

  const expired = secondsLeft <= 0;
  const mins = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const timeLeft = `${mins}:${secs.toString().padStart(2, '0')}`;

  const announcement = expired
    ? 'Payment window expired.'
    : secondsLeft <= 60
      ? `Less than a minute left to pay: ${timeLeft} remaining.`
      : secondsLeft % 60 === 0
        ? `${mins} minutes left to pay.`
        : '';

  return (
    <div className="text-center">
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>
      <p
        className={`text-sm font-medium ${expired ? 'text-red-500' : 'text-gray-500 dark:text-gray-400'}`}
      >
        {expired ? 'Payment window expired' : `Time remaining: ${timeLeft}`}
      </p>
    </div>
  );
}

function Row({
  label,
  value,
  copyable,
  mono,
  sensitive = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
  mono?: boolean;
  /**
   * When true the value is a redemption secret (gift-card code / PIN):
   * copy via `copySensitive` so the clipboard auto-clears after a short
   * delay (FE-05). Non-sensitive rows (payment address / amounts)
   * copy plainly and are deliberately left on the clipboard so the user
   * can paste them into their wallet.
   */
  sensitive?: boolean;
}): React.JSX.Element {
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
      {/* UX-001 / CF-35: confirm copy to assistive tech — these values
          (address / code / PIN) are the ones most worth confirming. */}
      {copyable === true ? (
        <span aria-live="polite" className="sr-only">
          {copied ? `${label} copied to clipboard.` : ''}
        </span>
      ) : null}
    </div>
  );
}
