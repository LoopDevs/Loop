/**
 * Post-purchase "You earned X cashback" confirmation card (ADR 011 / 015).
 *
 * Shown alongside `PurchaseComplete` in both flows:
 *   - Inline purchase (PurchaseContainer) — right after the order
 *     transitions to complete.
 *   - Standalone `/orders/:id` — whenever the order is in a completed
 *     state.
 *
 * The math is the same client-side multiplication (amount × rate)
 * used at checkout in AmountSelection — we trust the rate the server
 * reports *now* as a close-enough proxy for what was pinned on the
 * order. In the rare case an admin changed a merchant's cashback
 * rate after the order was placed, the number may drift from the
 * server-authoritative `orders.user_cashback_minor`; a follow-up
 * can expose that field on the Order response and replace the
 * computation.
 *
 * Silently hides when:
 *  - the merchant has no active cashback config (null rate),
 *  - the rate parses to 0 or negative,
 *  - the amount is zero or invalid.
 * Empty card > misleading "$0 cashback".
 */
import { Link } from 'react-router';
import { useMerchantCashbackRate } from '~/hooks/use-merchants';
import { currencySymbol } from '~/utils/money';

interface EarnedCashbackCardProps {
  merchantId: string;
  /** Order amount in the merchant's own currency (decimal, e.g. 50.0). */
  amount: number;
  /** ISO currency code from the merchant (USD / GBP / EUR / CAD …). */
  currency: string;
}

export function EarnedCashbackCard({
  merchantId,
  amount,
  currency,
}: EarnedCashbackCardProps): React.JSX.Element | null {
  const { userCashbackPct } = useMerchantCashbackRate(merchantId);
  if (userCashbackPct === null) return null;

  const pct = Number(userCashbackPct);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const estimate = (amount * pct) / 100;
  const rounded = Math.round(estimate * 100) / 100;
  if (rounded <= 0) return null;

  const symbol = currencySymbol(currency);
  // Drop trailing `.00` for cleaner reads on whole-unit amounts — matches
  // the AmountSelection checkout-preview formatter.
  const formatted = rounded.toFixed(2).replace(/\.00$/, '');

  return (
    <div className="rounded-xl border border-green-200 dark:border-green-900/50 bg-green-50 dark:bg-green-900/10 px-4 py-3 flex items-center justify-between gap-3">
      <div>
        <p className="text-sm font-semibold text-green-800 dark:text-green-300">
          You earned {symbol}
          {formatted} cashback
        </p>
        <p className="text-xs text-green-700/80 dark:text-green-400/80 mt-0.5">
          Credited to your Loop balance.
        </p>
      </div>
      <Link
        to="/settings/cashback"
        className="shrink-0 text-xs font-medium text-green-700 hover:text-green-800 dark:text-green-300 dark:hover:text-green-200 underline underline-offset-2"
      >
        View →
      </Link>
    </div>
  );
}
