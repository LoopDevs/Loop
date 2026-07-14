import { useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiException, CURRENCY_TO_ASSET_CODE, isHomeCurrency } from '@loop/shared';
import type { CreateLoopOrderResponse, LoopOrderView } from '~/services/orders-loop';
import { redeemLoopOrder, loopBalanceCoversCharge, balanceToStroops } from '~/services/wallet';
import { useWallet, WALLET_QUERY_KEY } from '~/hooks/use-wallet';
import { useOnline } from '~/hooks/use-online';
import { fmtLoopBalance } from '~/components/features/wallet/WalletCard';
import { triggerHaptic, triggerHapticNotification } from '~/native/haptics';
import { friendlyError } from '~/utils/error-messages';
import { useLocaleTag } from '~/i18n/format';

export interface PayWithLoopBalanceProps {
  /** The create-order payload — carries orderId + charge amount/currency. */
  create: CreateLoopOrderResponse;
  /** Latest polled order view from the parent's loop-order query. */
  order: LoopOrderView | undefined;
}

/**
 * One-tap "Pay with Loop balance" (ADR 030 Phase C, plan §C3).
 *
 * Offered above the crypto deposit instructions while the order sits
 * in `pending_payment` and the user's on-chain LOOP balance for the
 * order's currency covers the charge. Tapping POSTs
 * `redeem`; everything downstream is the EXISTING pipeline
 * — the parent's `['loop-order', id]` poll (which we invalidate for
 * an immediate refetch) follows the watcher through paid → procuring
 * → fulfilled exactly as a wallet-app payment would. No signing UI,
 * no wallet jargon: it reads like spending a gift-card balance.
 *
 * Visibility ladder:
 *  - no wallet / not activated / zero matching balance → render null
 *    (the crypto path is the whole story);
 *  - non-zero balance that doesn't cover the charge → disabled button
 *    with the shortfall spelled out;
 *  - covers → enabled one-tap button.
 *
 * The cover check is advisory — the server re-checks (400
 * `INSUFFICIENT_BALANCE`) and the deposit watcher stays authoritative.
 */
export function PayWithLoopBalance({
  create,
  order,
}: PayWithLoopBalanceProps): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const { wallet, isActivated, balanceFor } = useWallet();
  const locale = useLocaleTag();
  // Gate the tap on connectivity. Offline, the POST can only fail or hang;
  // an enabled button just invites a re-tap and a confused "did it go
  // through?" moment. Disabling it (with a spoken-aloud reason below) is the
  // honest affordance — the submit/idempotency path is untouched.
  const online = useOnline();
  // Ties the button to whichever hint is showing so AT reads the reason it's
  // disabled (offline / short balance) instead of an unexplained dead control.
  const hintId = useId();
  const [isPaying, setIsPaying] = useState(false);
  // A4-122 pattern: the disabled flag depends on React state
  // propagation, which a synchronous double-tap can outrun. The ref
  // flips synchronously and shuts the second invocation out. (The
  // endpoint is idempotent on order id anyway — this is belt and
  // braces against a duplicate request, not a duplicate spend.)
  const inFlightRef = useRef(false);
  // Set after a successful POST so the section collapses to a quiet
  // confirmation until the order poll catches up and hides us.
  const [paidFromBalance, setPaidFromBalance] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Only the on-chain create variants carry a charge the balance can
  // settle; `credit` already pays from the off-chain ledger.
  if (create.payment.method === 'credit') return null;

  // Only offer while there's still something to pay. Once the watcher
  // (or our POST) flips the order past pending_payment, the existing
  // state labels take over.
  if (order !== undefined && order.state !== 'pending_payment') return null;

  const { amountMinor, currency } = create.payment;
  const assetCode =
    create.payment.method === 'loop_asset'
      ? create.payment.assetCode
      : isHomeCurrency(currency)
        ? CURRENCY_TO_ASSET_CODE[currency]
        : null;
  if (assetCode === null) return null;

  if (wallet === undefined || !isActivated) return null;
  const balance = balanceFor(assetCode);
  const covers = loopBalanceCoversCharge(balance, amountMinor);
  const balanceStroops = balanceToStroops(balance);
  // Zero (or unparseable) balance → nothing to advertise; hide entirely.
  if (!covers && (balanceStroops === null || balanceStroops <= 0n)) return null;

  const chargeLabel = fmtLoopBalance(minorToDecimal(amountMinor), assetCode, locale);

  if (paidFromBalance) {
    return (
      <div className="rounded-xl border border-green-200 dark:border-green-900/40 bg-green-50/50 dark:bg-green-900/10 p-4 text-center text-sm text-green-700 dark:text-green-300">
        Paid {chargeLabel} from your Loop balance — confirming…
      </div>
    );
  }

  const handlePay = async (): Promise<void> => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsPaying(true);
    setError(null);
    void triggerHaptic();
    try {
      await redeemLoopOrder(create.orderId);
      setPaidFromBalance(true);
      void triggerHapticNotification('success');
      // Same polling state as the crypto path: the parent's
      // ['loop-order', id] query keeps running; invalidating it pulls
      // the post-payment state immediately instead of waiting out the
      // 3s tick. The wallet balance just changed too.
      void queryClient.invalidateQueries({ queryKey: ['loop-order', create.orderId] });
      void queryClient.invalidateQueries({ queryKey: WALLET_QUERY_KEY });
    } catch (err) {
      void triggerHapticNotification('error');
      if (err instanceof ApiException && err.code === 'INSUFFICIENT_BALANCE') {
        // Stale local read — refresh the balance so the button's
        // cover check corrects itself on the next render.
        setError('Your Loop balance doesn’t cover this order — you can pay from a wallet below.');
        void queryClient.invalidateQueries({ queryKey: WALLET_QUERY_KEY });
      } else if (err instanceof ApiException && err.status === 503) {
        setError(
          'Paying with your balance isn’t available right now — you can still pay from a wallet below.',
        );
      } else {
        setError(friendlyError(err, 'Something went wrong — you can pay from a wallet below.'));
      }
    } finally {
      inFlightRef.current = false;
      setIsPaying(false);
    }
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={!covers || isPaying || !online}
        aria-describedby={hintId}
        onClick={() => {
          void handlePay();
        }}
        className="block w-full rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 dark:disabled:bg-gray-700 disabled:cursor-not-allowed px-4 py-3 text-center text-sm font-semibold text-white"
      >
        {isPaying ? 'Paying…' : `Pay with Loop balance — ${chargeLabel}`}
      </button>
      {!online ? (
        <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400 text-center">
          You’re offline — reconnect to pay from your Loop balance.
        </p>
      ) : !covers ? (
        <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400 text-center">
          Not enough Loop balance — you have {fmtLoopBalance(balance, assetCode, locale)}.
        </p>
      ) : (
        <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400 text-center">
          Instant — uses the cashback you’ve earned.
        </p>
      )}
      {error !== null ? (
        <div
          role="alert"
          className="rounded-lg border border-amber-200 dark:border-amber-900/40 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-300"
        >
          {error}
        </div>
      ) : null}
      <div className="relative flex items-center justify-center pt-1">
        <span className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-gray-200 dark:bg-gray-800" />
        <span className="relative bg-gray-50 dark:bg-gray-950 px-3 text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400">
          or pay from a wallet
        </span>
      </div>
    </div>
  );
}

/**
 * Minor units (`"1050"`) → decimal string (`"10.50"`) so the charge
 * can reuse `fmtLoopBalance`'s localised fiat formatting.
 */
function minorToDecimal(amountMinor: string): string {
  const negative = amountMinor.startsWith('-');
  const digits = (negative ? amountMinor.slice(1) : amountMinor).padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
