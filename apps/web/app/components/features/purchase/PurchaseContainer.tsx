import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { Merchant } from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';
import { usePurchaseStore } from '~/stores/purchase.store';
import { createOrder } from '~/services/orders';
import { AmountSelection } from './AmountSelection';
import { PaymentStep } from './PaymentStep';
import { PurchaseComplete } from './PurchaseComplete';
import { RedeemFlow } from './RedeemFlow';
import { Button } from '~/components/ui/Button';
import { triggerHaptic, triggerHapticNotification } from '~/native/haptics';

interface PurchaseContainerProps {
  merchant: Merchant;
}

/**
 * Orchestrates the purchase flow: amount → payment → complete.
 * Email is sourced from the global auth session — no re-entry needed.
 */
export function PurchaseContainer({ merchant }: PurchaseContainerProps): React.JSX.Element {
  const navigate = useNavigate();
  const email = useAuthStore((s) => s.email);
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);
  const store = usePurchaseStore();
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  if (!isAuthenticated) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-6 text-center">
        <p className="text-gray-600 dark:text-gray-400 mb-4">Sign in to purchase gift cards.</p>
        <Button
          onClick={() => {
            void navigate('/auth');
          }}
        >
          Sign in
        </Button>
      </div>
    );
  }

  if (store.step === 'complete' && store.giftCardCode !== null) {
    return (
      <PurchaseComplete
        merchantName={merchant.name}
        code={store.giftCardCode}
        pin={store.giftCardPin ?? undefined}
        onDone={store.reset}
      />
    );
  }

  if (store.step === 'redeem' && store.redeemUrl !== null && store.redeemChallengeCode !== null) {
    return (
      <RedeemFlow
        merchantName={merchant.name}
        redeemUrl={store.redeemUrl}
        challengeCode={store.redeemChallengeCode}
        scripts={store.redeemScripts}
      />
    );
  }

  if (
    store.step === 'payment' &&
    store.paymentAddress !== null &&
    store.xlmAmount !== null &&
    store.orderId !== null &&
    store.expiresAt !== null
  ) {
    return (
      <PaymentStep
        merchantName={merchant.name}
        paymentAddress={store.paymentAddress}
        xlmAmount={store.xlmAmount}
        orderId={store.orderId}
        expiresAt={store.expiresAt}
      />
    );
  }

  const handlePurchase = async (amount: number): Promise<void> => {
    if (email === null) return;
    setIsCreatingOrder(true);
    setOrderError(null);
    void triggerHaptic();

    try {
      const result = await createOrder({ merchantId: merchant.id, amount });
      store.startPurchase(merchant.id, merchant.name);
      store.setAmount(amount);
      store.setOrderCreated({
        orderId: result.orderId,
        paymentAddress: result.paymentAddress,
        xlmAmount: result.xlmAmount,
        expiresAt: result.expiresAt,
      });
      void triggerHapticNotification('success');
    } catch {
      setOrderError('Failed to create order. Please try again.');
      void triggerHapticNotification('error');
    } finally {
      setIsCreatingOrder(false);
    }
  };

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <div className="mb-4 text-sm text-gray-500 dark:text-gray-400">
        Purchasing as <strong className="text-gray-700 dark:text-gray-300">{email}</strong>
      </div>

      <AmountSelection
        merchant={merchant}
        onConfirm={(amount) => {
          void handlePurchase(amount);
        }}
        isLoading={isCreatingOrder}
      />

      {orderError !== null && (
        <p className="mt-3 text-sm text-red-600 dark:text-red-400">{orderError}</p>
      )}
    </div>
  );
}
