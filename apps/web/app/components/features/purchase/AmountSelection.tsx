import { useState } from 'react';
import type { Merchant } from '@loop/shared';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';

interface AmountSelectionProps {
  merchant: Merchant;
  onConfirm: (amount: number) => void;
  isLoading?: boolean;
}

/** Renders fixed denomination buttons or a free-amount input based on merchant config. */
export function AmountSelection({
  merchant,
  onConfirm,
  isLoading = false,
}: AmountSelectionProps): React.JSX.Element {
  const denominations = merchant.denominations;
  const [customAmount, setCustomAmount] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleConfirm = (): void => {
    const raw = selected ?? customAmount;
    const amount = parseFloat(raw);

    if (isNaN(amount) || amount <= 0) {
      setValidationError('Please enter a valid amount.');
      return;
    }

    if (denominations?.type === 'min-max') {
      const min = denominations.min ?? 0;
      const max = denominations.max ?? Infinity;
      if (amount < min || amount > max) {
        setValidationError(`Amount must be between $${min} and $${max}.`);
        return;
      }
    }

    setValidationError(null);
    onConfirm(amount);
  };

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
              className={`py-2 px-4 rounded-lg border text-sm font-semibold transition-colors ${selected === d ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' : 'border-gray-200 dark:border-gray-700 hover:border-blue-400'}`}
            >
              ${d}
            </button>
          ))}
        </div>
        {validationError !== null && <p className="text-sm text-red-600 mb-3">{validationError}</p>}
        <Button
          className="w-full"
          onClick={handleConfirm}
          loading={isLoading}
          disabled={selected === null || isLoading}
        >
          Buy ${selected ?? '—'} gift card
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
        placeholder={min !== undefined && max !== undefined ? `$${min} – $${max}` : 'Enter amount'}
        value={customAmount}
        onChange={(v) => {
          setCustomAmount(v);
          setValidationError(null);
        }}
        hint={min !== undefined && max !== undefined ? `Min $${min}, max $${max}` : undefined}
        error={validationError ?? undefined}
        min={min}
        max={max}
        step="0.01"
      />
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
