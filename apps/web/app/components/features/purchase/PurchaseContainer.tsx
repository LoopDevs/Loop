import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';
import { usePurchaseStore } from '~/stores/purchase.store';
import {
  createLoopOrder,
  isLoopOrderFailure,
  type CreateLoopOrderResponse,
} from '~/services/orders-loop';
import { requestOtp, verifyOtp } from '~/services/auth';
import { useAppConfig } from '~/hooks/use-app-config';
import { useMerchantCashbackRate } from '~/hooks/use-merchants';
import { useRadioGroupKeys } from '~/hooks/use-radio-group-keys';
import {
  useLoopOrderRestore,
  saveLoopPendingOrder,
  clearLoopPendingOrder,
} from '~/hooks/use-loop-order-restore';
import { AmountSelection } from './AmountSelection';
import { LoopPaymentStep } from './LoopPaymentStep';
import { Button } from '~/components/ui/Button';
import { Input } from '~/components/ui/Input';
import { triggerHaptic, triggerHapticNotification } from '~/native/haptics';
import { friendlyError } from '~/utils/error-messages';

interface PurchaseContainerProps {
  merchant: Merchant;
}

type AuthStep = 'email' | 'otp';

/**
 * Orchestrates the purchase flow: inline auth → amount (+ payment
 * currency) → ctx payment → complete. Auth is handled inline — no
 * navigation to a separate auth page.
 *
 * ADR 052: single flow. ctx is the payment processor — every order is
 * `POST /api/orders/loop` with a chain-qualified `cryptoCurrency` the
 * user picks from `config.ctxPaymentCurrencies` (selector hidden when
 * the deployment offers exactly one). The legacy CTX-proxy path and
 * the loop-balance/credit rails are gone.
 */
export function PurchaseContainer({ merchant }: PurchaseContainerProps): React.JSX.Element {
  const email = useAuthStore((s) => s.email);
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);
  const store = usePurchaseStore();
  const queryClient = useQueryClient();
  const { config } = useAppConfig();
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  // A4-122: in-flight guard for the create call. The disable-button +
  // isCreatingOrder flag both depend on React state propagation, which
  // doesn't block a synchronous double-tap during the same render
  // cycle. A ref flips synchronously and shuts the second invocation
  // out at the boundary.
  const inFlightRef = useRef(false);
  // A4-122: idempotency key minted at the purchase-attempt
  // boundary and held in a ref across retries / submits. Reused
  // until a terminal state is reached (success or unrecoverable
  // error); freshens after a successful create. Without this, two
  // rapid clicks would send two different keys and the backend's
  // (user_id, key) dedupe wouldn't coalesce them.
  const idempotencyKeyRef = useRef<string | null>(null);
  // The create response (CTX's payment instructions) lives in local
  // state — the pay screen renders from it directly, and
  // `useLoopOrderRestore` rebuilds it server-side after a remount.
  const [loopCreate, setLoopCreate] = useState<CreateLoopOrderResponse | null>(null);
  // ADR 052: chain-qualified CTX payment currency. Defaults to the
  // first allowlisted entry ('XLM' in the default deployment); a
  // selector renders only when the operator offers more than one.
  const paymentCurrencies =
    config.ctxPaymentCurrencies.length > 0 ? config.ctxPaymentCurrencies : ['XLM'];
  const [cryptoCurrency, setCryptoCurrency] = useState<string>('XLM');
  const effectiveCryptoCurrency = paymentCurrencies.includes(cryptoCurrency)
    ? cryptoCurrency
    : (paymentCurrencies[0] ?? 'XLM');

  // Cashback-rate preview (ADR 011 / 015). Null when the merchant
  // has no active config or the fetch fails — in both cases we just
  // don't surface the estimate, which is safer than showing $0.
  const { userCashbackPct } = useMerchantCashbackRate(merchant.id);

  // A11Y-021 / CF-35: roving-tabindex + arrow-key nav for the
  // payment-currency radiogroup. Hook must run unconditionally (Rules
  // of Hooks) even when the group only renders for multi-currency
  // deployments.
  const currencyKeys = useRadioGroupKeys<string>({
    options: paymentCurrencies,
    selected: effectiveCryptoCurrency,
    onSelect: setCryptoCurrency,
  });

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
  //
  // This cleanup ALSO fires on a spurious remount of the SAME merchant
  // (a re-render that tears down and recreates this component without
  // the user ever navigating away — e.g. a parent re-key, an error
  // boundary reset, a slow-connection late fetch). `loopCreate` is
  // local state so it's gone regardless once that happens; the store
  // gets reset too, which zeroes `store.merchantId` and so fails the
  // `isCurrentMerchant` guard the render branch below depends on. This
  // effect doesn't try to tell "genuine navigation away" apart from
  // "spurious remount" — it can't, both look identical from here.
  // Instead, `useLoopOrderRestore` below re-hydrates `loopCreate` (and
  // re-arms `isCurrentMerchant` via `store.startPurchase`) on the very
  // next mount for this merchant whenever a live, still-payable order
  // was persisted — so a spurious remount recovers instead of
  // stranding the user at the amount-selection form despite a real,
  // payable order existing server-side.
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

  // Restore-on-remount for an in-progress order (see
  // ~/hooks/use-loop-order-restore.ts for the full mechanism +
  // money-safety reasoning). Read-only — this never creates a new
  // order, so it can't double-order. Gated on auth + the orders path
  // being live so it never fires a doomed fetch.
  const { restored: restoredLoopOrder } = useLoopOrderRestore({
    merchantId: merchant.id,
    enabled: isAuthenticated && config.loopOrdersEnabled,
  });
  useEffect(() => {
    if (restoredLoopOrder === null) return;
    // Don't clobber a payment screen the user is already looking at, or
    // an order create that's currently in flight (e.g. the restore GET
    // resolved late, after the user had already tapped "Buy" again).
    if (loopCreate !== null || isCreatingOrder) return;
    store.startPurchase(merchant.id, merchant.name);
    setLoopCreate(restoredLoopOrder.create);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredLoopOrder]);

  // The ctx payment screen (ADR 052). `loopCreate` gets cleared on
  // reset so a new merchant starts clean.
  if (isCurrentMerchant && loopCreate !== null) {
    return (
      <LoopPaymentStep
        create={loopCreate}
        onTerminal={(order) => {
          // The persisted restore record (if any) is only useful while
          // the order is still payable — clear it the moment we reach
          // ANY terminal state (fulfilled / rejected / refunded /
          // expired), not just the error branches below, so a future
          // remount never tries to resurrect a completed order onto
          // the purchase form.
          clearLoopPendingOrder();
          if (isLoopOrderFailure(order.state)) {
            setLoopCreate(null);
            setOrderError(order.failureReason ?? `Order ${order.state}`);
          }
          // On fulfilled we leave the LoopPaymentStep visible showing
          // the redemption payload ("Ready").
        }}
        onOrderNotFound={() => {
          // A restored (or, more rarely, freshly-created) order id came
          // back 404/403 — nothing left to show. Clear the persisted
          // record and fall back to the normal amount-selection flow
          // rather than leaving the screen stuck on "Creating order…".
          clearLoopPendingOrder();
          setLoopCreate(null);
          setOrderError('This order could not be found. Please start again.');
        }}
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
              label="Email address"
            />
            {authError !== null && (
              <p role="alert" className="text-red-500 text-sm">
                {authError}
              </p>
            )}
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
              // eslint-disable-next-line jsx-a11y/no-autofocus -- ADR 042: deliberate UX — this is the sole input on a step that just became active after an explicit user action (submit email / advance a wizard step), not an unexpected focus jump. eslint-plugin-jsx-a11y blanket-disallows autoFocus; WCAG does not. Tracked: docs/readiness-backlog-2026-07-03.md B-2.
              autoFocus
              label="Verification code"
            />
            {authError !== null && (
              <p role="alert" className="text-red-500 text-sm">
                {authError}
              </p>
            )}
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

  // Amount selection + order creation (authenticated).
  const handlePurchase = async (amount: number): Promise<void> => {
    if (email === null) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsCreatingOrder(true);
    setOrderError(null);
    void triggerHaptic();

    try {
      // A4-122: stable idempotency key across retries until success.
      // The first attempt mints, subsequent retries (e.g. network
      // flap) reuse so the backend dedup collapses them to one row.
      if (idempotencyKeyRef.current === null) {
        idempotencyKeyRef.current = crypto.randomUUID();
      }
      const result = await createLoopOrder(
        {
          merchantId: merchant.id,
          amountMinor: Math.round(amount * 100),
          currency: merchant.denominations?.currency ?? 'USD',
          cryptoCurrency: effectiveCryptoCurrency,
        },
        { idempotencyKey: idempotencyKeyRef.current },
      );
      // Q6-4 fix: the `isCurrentMerchant` guard above
      // (`store.merchantId === merchant.id`) gates the
      // `<LoopPaymentStep>` render, but on a fresh session
      // `store.merchantId` starts `null` — without this call
      // `isCurrentMerchant` stays permanently false and the payment
      // step never renders: the order was created server-side, but the
      // UI silently fell back to the amount-selection form with no
      // visible next step. Caught by the loop-native
      // purchase-through-the-UI e2e
      // (tests/e2e-loop-purchase/purchase-flow.test.ts, Q6-4).
      store.startPurchase(merchant.id, merchant.name);
      setLoopCreate(result);
      // Persist a POINTER (merchant + order id only — no payment
      // fields) so a remount (see the `[merchant.id]` effect above) or
      // a tab refresh can restore this payment screen instead of
      // stranding the user at the amount-selection form with a live,
      // payable order sitting unnoticed server-side. On restore the
      // screen is rebuilt ENTIRELY from GET /api/orders/loop/:id, so
      // nothing payment-directing is ever trusted from client storage.
      // See ~/hooks/use-loop-order-restore.ts.
      saveLoopPendingOrder({ merchantId: merchant.id, orderId: result.orderId });
      // Successful create — reset the key so a follow-up "place
      // another order for this merchant" flow doesn't dedupe onto
      // the just-created row.
      idempotencyKeyRef.current = null;
      // A2-1159: new row exists server-side; mark the cache stale so
      // /account/orders (LoopOrdersList) refetches on next mount
      // instead of sitting on its 30s staleTime.
      void queryClient.invalidateQueries({ queryKey: ['loop-orders'] });
      void triggerHapticNotification('success');
    } catch (err) {
      setOrderError(friendlyError(err, 'Failed to create order. Please try again.'));
      void triggerHapticNotification('error');
    } finally {
      setIsCreatingOrder(false);
      inFlightRef.current = false;
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

      {/* ADR 052: payment-currency picker. Hidden when the deployment
          offers a single currency — nothing to choose. */}
      {paymentCurrencies.length > 1 && (
        <fieldset className="mb-4">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Pay with
          </legend>
          <div role="radiogroup" aria-label="Payment currency" className="flex flex-wrap gap-2">
            {paymentCurrencies.map((c, i) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={effectiveCryptoCurrency === c}
                tabIndex={currencyKeys.rovingTabIndex(i)}
                onClick={() => setCryptoCurrency(c)}
                onKeyDown={(e) => currencyKeys.onKeyDown(e, i)}
                disabled={isCreatingOrder}
                className={`py-3 px-4 min-h-[44px] rounded-lg border text-sm font-semibold transition-colors ${
                  effectiveCryptoCurrency === c
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'border-gray-200 dark:border-gray-700 hover:border-blue-400'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </fieldset>
      )}

      <AmountSelection
        merchant={merchant}
        userCashbackPct={userCashbackPct}
        onConfirm={(amount) => {
          void handlePurchase(amount);
        }}
        isLoading={isCreatingOrder}
      />

      {orderError !== null && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {orderError}
        </p>
      )}
    </div>
  );
}
