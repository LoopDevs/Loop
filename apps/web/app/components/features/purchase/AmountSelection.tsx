import { useState } from 'react';
import type { Merchant } from '@loop/shared';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';
import { currencySymbol } from '~/utils/money';

interface AmountSelectionProps {
  merchant: Merchant;
  onConfirm: (amount: number) => void;
  isLoading?: boolean;
  /**
   * Active cashback % for this merchant (ADR 011 / 015), as the
   * numeric(5,2) string the backend returns (e.g. `"2.50"`). Null when
   * the merchant has no active cashback config — the estimate row
   * is then omitted.
   */
  userCashbackPct?: string | null;
}

/**
 * Formats `amount × pct / 100` for the cashback-estimate row. Takes
 * the amount as a parsed-float and the pct as the server-shaped
 * numeric string; `null` on either input returns `null` so the caller
 * can skip rendering rather than show a dash.
 */
function estimateCashback(
  amount: number | null,
  userCashbackPct: string | null | undefined,
  symbol: string,
): string | null {
  if (
    amount === null ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    userCashbackPct === null ||
    userCashbackPct === undefined
  ) {
    return null;
  }
  const pct = Number(userCashbackPct);
  if (!Number.isFinite(pct) || pct <= 0) return null;
  const estimate = (amount * pct) / 100;
  // Two decimals, but drop a trailing `.00` so "$2.50 cashback"
  // renders cleanly and "$5 cashback" doesn't drag a bare zero.
  const rounded = Math.round(estimate * 100) / 100;
  const formatted = rounded.toFixed(2).replace(/\.00$/, '');
  return `${symbol}${formatted}`;
}

/** Renders fixed denomination buttons or a free-amount input based on merchant config. */
export function AmountSelection({
  merchant,
  onConfirm,
  isLoading = false,
  userCashbackPct = null,
}: AmountSelectionProps): React.JSX.Element {
  const denominations = merchant.denominations;
  // Currency symbol — £ for GBP, € for EUR, $ for USD / CAD. Shared
  // helper picks from Intl.NumberFormat so we don't maintain a
  // table. Falls back to `$` when the merchant's currency is
  // missing or unknown, matching the legacy behaviour.
  const symbol = currencySymbol(denominations?.currency ?? 'USD');
  const [customAmount, setCustomAmount] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Mirror the backend zod schema in apps/backend/src/orders/handler.ts
  // (CreateOrderBody). If these drift, the user submits, gets a 400, and sees
  // a generic error — a bad UX that pushes validation friction to the server.
  const BACKEND_MIN = 0.01;
  const BACKEND_MAX = 10_000;

  const handleConfirm = (): void => {
    const raw = selected ?? customAmount;
    const amount = parseFloat(raw);

    if (!Number.isFinite(amount) || amount <= 0) {
      setValidationError('Please enter a valid amount.');
      return;
    }

    // Reject sub-cent precision — backend's multipleOf(0.01) rejects these
    // and we'd rather catch it here than round-trip to a 400.
    //
    // The obvious check `Math.round(n * 100) !== n * 100` is broken: IEEE-754
    // drift means `0.29 * 100 === 28.999999999999996`, which would wrongly
    // flag $0.29 as sub-cent. Normalize by rounding back down before
    // comparing — `Math.round(n * 100) / 100` hits the exact IEEE-754 bit
    // pattern for a 2-decimal value, so this is true iff `n` is already a
    // valid cent amount.
    if (Math.round(amount * 100) / 100 !== amount) {
      setValidationError('Amount cannot have more than 2 decimal places.');
      return;
    }

    if (amount < BACKEND_MIN || amount > BACKEND_MAX) {
      setValidationError(
        `Amount must be between ${symbol}${BACKEND_MIN} and ${symbol}${BACKEND_MAX}.`,
      );
      return;
    }

    if (denominations?.type === 'min-max') {
      const min = denominations.min ?? BACKEND_MIN;
      const max = denominations.max ?? BACKEND_MAX;
      if (amount < min || amount > max) {
        setValidationError(`Amount must be between ${symbol}${min} and ${symbol}${max}.`);
        return;
      }
    }

    setValidationError(null);
    onConfirm(amount);
  };

  // Parse the current candidate amount for the cashback-estimate row.
  // Fixed-denomination path: use the selected chip. Custom-amount path:
  // use the raw input. Either way the estimate is purely visual —
  // the actual cashback is computed server-side at order-fulfillment
  // time.
  const candidateAmount = selected !== null ? parseFloat(selected) : parseFloat(customAmount);
  const cashbackEstimate = estimateCashback(
    Number.isFinite(candidateAmount) ? candidateAmount : null,
    userCashbackPct,
    symbol,
  );

  if (denominations?.type === 'fixed' && denominations.denominations.length > 0) {
    return (
      <div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
          Select amount ({denominations.currency})
        </p>
        <div className="grid grid-cols-3 gap-2 mb-4">
          {denominations.denominations.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                setSelected(d);
                setValidationError(null);
              }}
              className={`py-3 px-4 min-h-[44px] rounded-lg border text-sm font-semibold transition-colors ${selected === d ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-700 hover:border-blue-400'}`}
            >
              {symbol}
              {d}
            </button>
          ))}
        </div>
        {cashbackEstimate !== null && (
          <p className="mb-3 text-sm font-medium text-green-700 dark:text-green-400">
            You&rsquo;ll earn {cashbackEstimate} cashback
          </p>
        )}
        {validationError !== null && <p className="text-sm text-red-600 mb-3">{validationError}</p>}
        <Button
          className="w-full"
          onClick={handleConfirm}
          loading={isLoading}
          disabled={selected === null || isLoading}
        >
          Buy {symbol}
          {selected ?? '—'} gift card
        </Button>
      </div>
    );
  }

  const min = denominations?.min;
  const max = denominations?.max;
  const currency = denominations?.currency ?? 'USD';

  return (
    <div>
      <Input
        type="number"
        label={`Amount (${currency})`}
        // Placeholder carries the range in the merchant's currency
        // (£, €, $…). The standalone "Min X, max Y" hint below was
        // redundant with the placeholder and read as clutter on
        // GBP / EUR merchants — dropped intentionally.
        placeholder={
          min !== undefined && max !== undefined
            ? `${symbol}${min} – ${symbol}${max}`
            : 'Enter amount'
        }
        value={customAmount}
        onChange={(v) => {
          setCustomAmount(v);
          setValidationError(null);
        }}
        error={validationError ?? undefined}
        min={min}
        max={max}
        step="0.01"
      />
      {cashbackEstimate !== null && (
        <p className="mt-3 text-sm font-medium text-green-700 dark:text-green-400">
          You&rsquo;ll earn {cashbackEstimate} cashback
        </p>
      )}
      <Button
        className="w-full mt-4"
        onClick={handleConfirm}
        loading={isLoading}
        disabled={!customAmount || isLoading}
      >
        Continue
      </Button>
    </div>
  );
}
