import { useState } from 'react';
import type { Merchant } from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';
import { usePurchaseStore } from '~/stores/purchase.store';
import { createOrder } from '~/services/orders';
import { requestOtp, verifyOtp } from '~/services/auth';
import { AmountSelection } from './AmountSelection';
import { PaymentStep } from './PaymentStep';
import { PurchaseComplete } from './PurchaseComplete';
import { RedeemFlow } from './RedeemFlow';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';
import { triggerHaptic, triggerHapticNotification } from '~/native/haptics';
import { friendlyError } from '~/utils/error-messages';

interface PurchaseContainerProps {
  merchant: Merchant;
}

type AuthStep = 'email' | 'otp';

/**
 * Orchestrates the purchase flow: inline auth → amount → payment → complete.
 * Auth is handled inline — no navigation to a separate auth page.
 */
export function PurchaseContainer({ merchant }: PurchaseContainerProps): React.JSX.Element {
  const email = useAuthStore((s) => s.email);
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);
  const store = usePurchaseStore();
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);

  // Inline auth state
  const [authStep, setAuthStep] = useState<AuthStep>('email');
  const [authEmail, setAuthEmail] = useState('');
  const [authOtp, setAuthOtp] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Completed states (redeem, complete)
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
    store.expiresAt !== null &&
    store.memo !== null
  ) {
    return (
      <PaymentStep
        merchantName={merchant.name}
        paymentAddress={store.paymentAddress}
        xlmAmount={store.xlmAmount}
        orderId={store.orderId}
        expiresAt={store.expiresAt}
        memo={store.memo}
      />
    );
  }

  // Inline auth flow (not authenticated)
  if (!isAuthenticated) {
    const handleEmailSubmit = async (): Promise<void> => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        await requestOtp(authEmail);
        setAuthStep('otp');
      } catch (err) {
        setAuthError(friendlyError(err, 'Failed to send verification code.'));
      } finally {
        setAuthLoading(false);
      }
    };

    const handleOtpSubmit = async (): Promise<void> => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        const { accessToken, refreshToken } = await verifyOtp(authEmail, authOtp);
        useAuthStore.getState().setSession(authEmail, accessToken, refreshToken ?? null);
        void triggerHapticNotification('success');
      } catch (err) {
        setAuthError(friendlyError(err, 'Invalid code. Please try again.'));
      } finally {
        setAuthLoading(false);
      }
    };

    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-1">
          Purchase {merchant.name} gift card
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          {authStep === 'email'
            ? 'Enter your email to get started.'
            : `We sent a code to ${authEmail}`}
        </p>

        {authStep === 'email' ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleEmailSubmit();
            }}
            className="space-y-3"
          >
            <Input
              type="email"
              placeholder="you@example.com"
              value={authEmail}
              onChange={setAuthEmail}
              required
              autoFocus
              label="Email address"
            />
            {authError !== null && <p className="text-red-500 text-sm">{authError}</p>}
            <Button
              type="submit"
              className="w-full"
              loading={authLoading}
              disabled={!authEmail || authLoading}
            >
              Continue
            </Button>
          </form>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleOtpSubmit();
            }}
            className="space-y-3"
          >
            <Input
              type="text"
              inputMode="numeric"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="000000"
              value={authOtp}
              onChange={setAuthOtp}
              required
              autoFocus
              label="Verification code"
            />
            {authError !== null && <p className="text-red-500 text-sm">{authError}</p>}
            <Button
              type="submit"
              className="w-full"
              loading={authLoading}
              disabled={!authOtp || authLoading}
            >
              Verify
            </Button>
            <button
              type="button"
              className="w-full text-sm text-gray-500 underline"
              onClick={() => {
                setAuthStep('email');
                setAuthOtp('');
                setAuthError(null);
              }}
            >
              Use a different email
            </button>
          </form>
        )}
      </div>
    );
  }

  // Amount selection + order creation (authenticated)
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
        expiresAt: Math.floor(Date.now() / 1000) + 30 * 60,
        memo: result.memo,
      });
      void triggerHapticNotification('success');
    } catch (err) {
      setOrderError(friendlyError(err, 'Failed to create order. Please try again.'));
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
