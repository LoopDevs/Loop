import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Merchant } from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';
import { usePurchaseStore } from '~/stores/purchase.store';
import { createOrder } from '~/services/orders';
import { createLoopOrder, type CreateLoopOrderResponse } from '~/services/orders-loop';
import { requestOtp, verifyOtp } from '~/services/auth';
import { getMyCredits } from '~/services/user';
import { useAppConfig } from '~/hooks/use-app-config';
import { useMerchantCashbackRate } from '~/hooks/use-merchants';
import { useRadioGroupKeys } from '~/hooks/use-radio-group-keys';
import { useWallet } from '~/hooks/use-wallet';
import { shouldRetry } from '~/hooks/query-retry';
import {
  useLoopOrderRestore,
  saveLoopPendingOrder,
  clearLoopPendingOrder,
} from '~/hooks/use-loop-order-restore';
import { hasPositiveBalance } from '~/components/features/cashback/LinkWalletNudge';
import { AmountSelection } from './AmountSelection';
import { EarnedCashbackCard } from './EarnedCashbackCard';
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

// A4-040: Tranche-1 payment rails. Shared so the radiogroup render and the
// roving-tabindex keyboard hook agree on order. ADR 036: 'credit' only
// joins the list during the not-yet-activated migration window (offerCredit).
const PAYMENT_RAILS = ['usdc', 'xlm'] as const;
const PAYMENT_RAILS_WITH_CREDIT = ['usdc', 'xlm', 'credit'] as const;

/**
 * Orchestrates the purchase flow: inline auth → amount → payment → complete.
 * Auth is handled inline — no navigation to a separate auth page.
 */
export function PurchaseContainer({ merchant }: PurchaseContainerProps): React.JSX.Element {
  const email = useAuthStore((s) => s.email);
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);
  const store = usePurchaseStore();
  const queryClient = useQueryClient();
  const { config } = useAppConfig();
  const [isCreatingOrder, setIsCreatingOrder] = useState(false);
  const [orderError, setOrderError] = useState<string | null>(null);
  // A4-122: in-flight guard for the Loop-native create call. The
  // disable-button + isCreatingOrder flag both depend on React
  // state propagation, which doesn't block a synchronous double-tap
  // during the same render cycle. A ref flips synchronously and
  // shuts the second invocation out at the boundary.
  const inFlightRef = useRef(false);
  // A4-122: idempotency key minted at the purchase-attempt
  // boundary and held in a ref across retries / submits. Reused
  // until a terminal state is reached (success or unrecoverable
  // error); freshens after a successful create or a manual
  // re-attempt-with-fresh-key. Without this, the previous code
  // minted a UUID per createLoopOrder() invocation, so two rapid
  // clicks sent two different keys and the backend's
  // (user_id, key) dedupe didn't coalesce them.
  const idempotencyKeyRef = useRef<string | null>(null);
  // Local state for the Loop-native flow — we deliberately don't
  // push this into the purchase store because the CTX-shaped fields
  // (paymentAddress / xlmAmount / memo / expiresAt) don't map 1:1
  // onto the Loop response. Keep the store as the legacy path's
  // contract until ADR 013 Phase C retires it.
  const [loopCreate, setLoopCreate] = useState<CreateLoopOrderResponse | null>(null);
  // A4-040: payment-rail selection for Loop-native orders. Tranche 1
  // ships with USDC + XLM only; LOOP-asset (cashback recycle) and
  // credit are gated behind `phase1Only=false` because they belong
  // to the Tranche 2 cashback flywheel. Default USDC because the
  // marketing copy + treasury docs lead with it.
  const [paymentMethod, setPaymentMethod] = useState<'usdc' | 'xlm' | 'credit'>('usdc');

  // ADR 036 OQ3 (resolved 2026-06-12): balance = tokens once
  // activated; mirror is reconciliation-only (ADR 036). A
  // wallet-activated user spends their balance as token redemption —
  // the PayWithLoopBalance button on the payment screen — so the
  // `credit` rail (inline mirror debit) must NOT be offered to them
  // (the backend rejects it with CREDIT_METHOD_RETIRED anyway). Users
  // not yet activated are the migration window: their mirror balance
  // has no emitted tokens, so `credit` stays available while they
  // still hold one. Same ['me', 'credits'] cache line as the
  // settings/cashback card.
  const { isActivated } = useWallet();
  const creditsQuery = useQuery({
    queryKey: ['me', 'credits'],
    queryFn: getMyCredits,
    enabled: isAuthenticated && config.loopOrdersEnabled && !config.phase1Only,
    retry: shouldRetry,
    staleTime: 30_000,
  });
  const offerCredit =
    !config.phase1Only && !isActivated && hasPositiveBalance(creditsQuery.data?.credits);
  // If activation lands (or the balance drains) while 'credit' is
  // selected, fall back to USDC rather than submitting a rail the
  // backend will reject.
  const effectivePaymentMethod =
    paymentMethod === 'credit' && !offerCredit ? 'usdc' : paymentMethod;
  const visibleRails = offerCredit ? PAYMENT_RAILS_WITH_CREDIT : PAYMENT_RAILS;

  // Cashback-rate preview (ADR 011 / 015). Null when the merchant
  // has no active config or the fetch fails — in both cases we just
  // don't surface the estimate, which is safer than showing $0.
  const { userCashbackPct } = useMerchantCashbackRate(merchant.id);

  // A11Y-021 / CF-35: roving-tabindex + arrow-key nav for the payment-rail
  // radiogroup. Hook must run unconditionally (Rules of Hooks) even when the
  // group only renders for loop-native orders.
  const railKeys = useRadioGroupKeys<'usdc' | 'xlm' | 'credit'>({
    options: visibleRails,
    selected: effectivePaymentMethod,
    onSelect: setPaymentMethod,
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
  // local state so it's gone regardless once that happens; `store`
  // (the legacy path's zustand store) gets reset too, which zeroes
  // `store.merchantId` and so fails the `isCurrentMerchant` guard the
  // loop-native render branch below depends on. This effect doesn't
  // try to tell "genuine navigation away" apart from "spurious
  // remount" — it can't, both look identical from here. Instead,
  // `useLoopOrderRestore` below re-hydrates `loopCreate` (and re-arms
  // `isCurrentMerchant` via `store.startPurchase`) on the very next
  // mount for this merchant whenever a live, still-payable loop-native
  // order was persisted — so a spurious remount recovers instead of
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

  // Restore-on-remount for a loop-native order (see
  // ~/hooks/use-loop-order-restore.ts for the full mechanism +
  // money-safety reasoning). Read-only — this never creates a new
  // order, so it can't double-order. Gated on auth + the loop-native
  // path being live so it never fires a doomed fetch.
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

  // Loop-native payment screen (ADR 010). Takes precedence over the
  // CTX-proxy payment screen so a user mid-flow doesn't see two at
  // once. The loopCreate gets cleared on reset so a new merchant
  // starts clean.
  if (isCurrentMerchant && loopCreate !== null) {
    return (
      <LoopPaymentStep
        create={loopCreate}
        onTerminal={(order) => {
          // The persisted restore record (if any) is only useful while
          // the order is still payable — clear it the moment we reach
          // ANY terminal state (fulfilled/failed/expired), not just the
          // error branches below, so a future remount never tries to
          // resurrect a completed order onto the purchase form.
          clearLoopPendingOrder();
          if (order.state === 'failed' || order.state === 'expired') {
            setLoopCreate(null);
            setOrderError(order.failureReason ?? `Order ${order.state}`);
          }
          // On fulfilled we leave the LoopPaymentStep visible showing
          // "Ready" — the user's redemption payload is served via the
          // existing orders API which is its own follow-up slice.
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

  // Completed states (redeem, complete)
  if (isCurrentMerchant && store.step === 'complete' && store.giftCardCode !== null) {
    return (
      <div className="flex flex-col gap-3">
        {/* Cashback-credit confirmation ties the reward back to the
            specific purchase. Falls through invisibly when the
            merchant has no active cashback config or the rate is
            zero — no "$0 cashback" noise. */}
        {store.amount !== null && (
          <EarnedCashbackCard
            merchantId={merchant.id}
            amount={store.amount}
            currency={merchant.denominations?.currency ?? 'USD'}
          />
        )}
        <PurchaseComplete
          merchantName={merchant.name}
          code={store.giftCardCode}
          pin={store.giftCardPin ?? undefined}
          barcodeImageUrl={store.barcodeImageUrl ?? undefined}
        />
      </div>
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

  // Amount selection + order creation (authenticated). Two paths:
  //   - config.loopOrdersEnabled → Loop-native (POST /api/orders/loop)
  //   - otherwise → legacy CTX proxy (POST /api/orders)
  const handlePurchase = async (amount: number): Promise<void> => {
    if (email === null) return;
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsCreatingOrder(true);
    setOrderError(null);
    void triggerHaptic();

    try {
      if (config.loopOrdersEnabled) {
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
            // A4-040: was hardcoded to 'usdc'; user now picks the rail
            // before confirming. `credit` is migration-window only —
            // hidden once the wallet activates (ADR 036 OQ3).
            paymentMethod: effectivePaymentMethod,
          },
          { idempotencyKey: idempotencyKeyRef.current },
        );
        // Q6-4 fix: the `isCurrentMerchant` guard above
        // (`store.merchantId === merchant.id`) gates the
        // `<LoopPaymentStep>` render just below, but on a
        // fresh session `store.merchantId` starts `null` — this
        // branch never called `store.startPurchase` (only the
        // legacy branch did, a few lines down), so
        // `isCurrentMerchant` stayed permanently false and the
        // payment step never rendered: the order was created
        // server-side, but the UI silently fell back to the
        // amount-selection form with no visible next step. Caught by
        // the new loop-native purchase-through-the-UI e2e
        // (tests/e2e-loop-purchase/purchase-flow.test.ts, Q6-4,
        // docs/money-auth-worklist.md) — the first test to ever drive
        // this path through a real browser on a first-touch session.
        // `loopCreate` itself is already correctly merchant-scoped
        // (local component state, reset by the mount effect's
        // `[merchant.id]` cleanup), so this call exists purely to
        // satisfy the shared guard the same way the legacy branch
        // does — it doesn't touch any of the legacy-shaped store
        // fields (`setAmount`/`setOrderCreated`) the loop-native
        // render path never reads.
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

      {config.loopOrdersEnabled && (
        <fieldset className="mb-4">
          <legend className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Pay with
          </legend>
          <div
            role="radiogroup"
            aria-label="Payment rail"
            className={`grid gap-2 ${offerCredit ? 'grid-cols-3' : 'grid-cols-2'}`}
          >
            {/* ADR 036: the credit rail only renders for the
                not-yet-activated migration window (see offerCredit). */}
            {visibleRails.map((m, i) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={effectivePaymentMethod === m}
                tabIndex={railKeys.rovingTabIndex(i)}
                onClick={() => setPaymentMethod(m)}
                onKeyDown={(e) => railKeys.onKeyDown(e, i)}
                disabled={isCreatingOrder}
                className={`py-3 px-4 min-h-[44px] rounded-lg border text-sm font-semibold transition-colors ${
                  effectivePaymentMethod === m
                    ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300'
                    : 'border-gray-200 dark:border-gray-700 hover:border-blue-400'
                }`}
              >
                {m === 'credit' ? 'Loop credit' : m.toUpperCase()}
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
