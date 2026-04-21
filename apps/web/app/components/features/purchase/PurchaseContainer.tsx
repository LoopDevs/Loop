import { useEffect, useState } from 'react';
import type { Merchant } from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';
import { usePurchaseStore } from '~/stores/purchase.store';
import { createOrder } from '~/services/orders';
import { createLoopOrder, type CreateLoopOrderResponse } from '~/services/orders-loop';
import { requestOtp, verifyOtp } from '~/services/auth';
import { useAppConfig } from '~/hooks/use-app-config';
import { useMerchantCashbackRate } from '~/hooks/use-merchants';
import { AmountSelection } from './AmountSelection';
import { LoopPaymentStep } from './LoopPaymentStep';
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
  const { config } = useAppConfig();
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  // Local state for the Loop-native flow — we deliberately don't
  // push this into the purchase store because the CTX-shaped fields
  // (paymentAddress / xlmAmount / memo / expiresAt) don't map 1:1
  // onto the Loop response. Keep the store as the legacy path's
  // contract until ADR 013 Phase C retires it.
  const [loopCreate, setLoopCreate] = useState<CreateLoopOrderResponse | null>(null);

  // Cashback-rate preview (ADR 011 / 015). Null when the merchant
  // has no active config or the fetch fails — in both cases we just
  // don't surface the estimate, which is safer than showing $0.
  const { userCashbackPct } = useMerchantCashbackRate(merchant.id);

  // Inline auth state
  const [authStep, setAuthStep] = useState<AuthStep>('email');
  const [authEmail, setAuthEmail] = useState('');
  const [authOtp, setAuthOtp] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  // Store state only applies to THIS merchant. Without this guard, opening
  // merchant B while merchant A has a pending payment shows B's page with
  // A's payment card (wrong address, wrong amount).
  const isCurrentMerchant = store.merchantId === merchant.id;

  // Navigating to a different merchant (or off the page entirely) cancels
  // any in-progress purchase rather than carrying it over — the user
  // explicitly left the flow, so the state shouldn't follow them.
  useEffect(() => {
    if (store.merchantId !== null && store.merchantId !== merchant.id) {
      store.reset();
      setLoopCreate(null);
    }
    return () => {
      store.reset();
      setLoopCreate(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [merchant.id]);

  // Loop-native payment screen (ADR 010). Takes precedence over the
  // CTX-proxy payment screen so a user mid-flow doesn't see two at
  // once. The loopCreate gets cleared on reset so a new merchant
  // starts clean.
  if (isCurrentMerchant && loopCreate !== null) {
    return (
      <LoopPaymentStep
        create={loopCreate}
        onTerminal={(order) => {
          if (order.state === 'failed' || order.state === 'expired') {
            setLoopCreate(null);
            setOrderError(order.failureReason ?? `Order ${order.state}`);
          }
          // On fulfilled we leave the LoopPaymentStep visible showing
          // "Ready" — the user's redemption payload is served via the
          // existing orders API which is its own follow-up slice.
        }}
      />
    );
  }

  // Completed states (redeem, complete)
  if (isCurrentMerchant && store.step === 'complete' && store.giftCardCode !== null) {
    return (
      <PurchaseComplete
        merchantName={merchant.name}
        code={store.giftCardCode}
        pin={store.giftCardPin ?? undefined}
        barcodeImageUrl={store.barcodeImageUrl ?? undefined}
      />
    );
  }

  if (
    isCurrentMerchant &&
    store.step === 'redeem' &&
    store.redeemUrl !== null &&
    store.redeemChallengeCode !== null
  ) {
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
    isCurrentMerchant &&
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

  // Error state — previously fell through to amount selection, which meant
  // users hitting "order failed/expired" or polling-result errors from
  // PaymentStep silently landed back at amount selection with no message.
  if (isCurrentMerchant && store.step === 'error' && store.error !== null) {
    return (
      <div className="rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/30 p-6">
        <h3 className="text-lg font-semibold text-red-900 dark:text-red-200 mb-2">
          Purchase failed
        </h3>
        <p className="text-sm text-red-700 dark:text-red-300 mb-4">{store.error}</p>
        <Button variant="secondary" onClick={store.reset}>
          Start over
        </Button>
      </div>
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

  // Amount selection + order creation (authenticated). Two paths:
  //   - config.loopOrdersEnabled → Loop-native (POST /api/orders/loop)
  //   - otherwise → legacy CTX proxy (POST /api/orders)
  const handlePurchase = async (amount: number): Promise<void> => {
    if (email === null) return;
    setIsCreatingOrder(true);
    setOrderError(null);
    void triggerHaptic();

    try {
      if (config.loopOrdersEnabled) {
        const result = await createLoopOrder({
          merchantId: merchant.id,
          amountMinor: Math.round(amount * 100),
          currency: merchant.denominations?.currency ?? 'USD',
          paymentMethod: 'usdc',
        });
        setLoopCreate(result);
        void triggerHapticNotification('success');
        return;
      }
      const result = await createOrder({ merchantId: merchant.id, amount });
      store.startPurchase(merchant.id, merchant.name);
      store.setAmount(amount);
      store.setOrderCreated({
        orderId: result.orderId,
        paymentAddress: result.paymentAddress,
        xlmAmount: result.xlmAmount,
        // Server-authoritative: the backend sends unix seconds. Recomputing
        // from Date.now() here would drift under any clock skew between the
        // client and the server and break the payment countdown.
        expiresAt: result.expiresAt,
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
      <div className="mb-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{merchant.name}</h3>
        {merchant.savingsPercentage !== undefined && merchant.savingsPercentage > 0 && (
          <span className="inline-block mt-1 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-xs font-semibold px-2 py-0.5 rounded-full">
            Save {merchant.savingsPercentage.toFixed(1)}%
          </span>
        )}
      </div>

      <AmountSelection
        merchant={merchant}
        userCashbackPct={userCashbackPct}
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
