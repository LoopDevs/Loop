/**
 * Onboarding — Stellar wallet explainer (ADR 015).
 *
 * Mounted after biometric setup and before the final Welcome-in so the
 * stablecoin story lands while the user is still in the "set me up"
 * mindset. Purely informational — no form, no API call. The user can
 * either continue straight through (cashback still works off-chain) or
 * tap "Link a wallet" to route to /settings/wallet where the real
 * trustline flow lives (#391/#392).
 *
 * Copy calls out two things:
 *   1. Cashback lands **instantly** in the in-app balance (no wallet
 *      required) — the user doesn't need to take any action to start
 *      earning.
 *   2. A Stellar wallet + trustline unlocks on-chain payouts as
 *      USDLOOP / GBPLOOP / EURLOOP when they want to withdraw.
 *
 * This mirrors the two-phase framing in ADR 015 — users are always
 * onboarded to the ledger; the wallet is an optional upgrade.
 */
interface ScreenCopy {
  eyebrow?: string;
  title: string;
  sub: string;
}

interface WalletIntroScreenProps {
  active: boolean;
  copy: ScreenCopy;
  /** User's home currency, used to label the matching LOOP asset chip. */
  homeCurrency: 'USD' | 'GBP' | 'EUR';
  /** Called when the user taps "Link a wallet now" — parent routes to /settings/wallet. */
  onLinkWallet: () => void;
}

const ASSET_FOR: Record<'USD' | 'GBP' | 'EUR', string> = {
  USD: 'USDLOOP',
  GBP: 'GBPLOOP',
  EUR: 'EURLOOP',
};

const SYMBOL_FOR: Record<'USD' | 'GBP' | 'EUR', string> = {
  USD: '$',
  GBP: '£',
  EUR: '€',
};

export function WalletIntroScreen({
  active,
  copy,
  homeCurrency,
  onLinkWallet,
}: WalletIntroScreenProps): React.JSX.Element {
  const asset = ASSET_FOR[homeCurrency];
  const symbol = SYMBOL_FOR[homeCurrency];

  return (
    <div className="flex-1 flex flex-col px-6">
      <div className="flex-1 flex flex-col justify-center gap-8">
        <header className="text-center">
          {copy.eyebrow !== undefined && (
            <div className="text-[11px] uppercase tracking-[0.08em] font-semibold text-gray-500 dark:text-gray-400 mb-2">
              {copy.eyebrow}
            </div>
          )}
          <h2
            className="text-[32px] font-extrabold text-gray-950 dark:text-white leading-[1.1] whitespace-pre-line"
            style={{ letterSpacing: '-0.03em' }}
          >
            {copy.title}
          </h2>
          <p className="mt-3 text-[15px] text-gray-600 dark:text-gray-300">{copy.sub}</p>
        </header>

        {/* Two framing cards — one for "today" (off-chain instant),
            one for "when you're ready" (Stellar wallet). The asset
            chip is currency-aware so a GBP user sees GBPLOOP, USD
            sees USDLOOP, etc. */}
        <div className="flex flex-col gap-3" aria-hidden={!active}>
          <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-5 py-4">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-green-100 dark:bg-green-900/30 text-green-800 dark:text-green-300 text-lg font-bold"
              >
                {symbol}
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-gray-950 dark:text-white">
                  Cashback lands instantly
                </p>
                <p className="mt-0.5 text-[13px] text-gray-600 dark:text-gray-400">
                  Every order credits your in-app balance right away — no wallet needed.
                </p>
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-5 py-4">
            <div className="flex items-center gap-3">
              <span
                aria-hidden
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-800 dark:text-blue-300 text-[11px] font-bold tracking-wide"
              >
                {asset.slice(0, 3)}
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-gray-950 dark:text-white">
                  Withdraw to your own wallet
                </p>
                <p className="mt-0.5 text-[13px] text-gray-600 dark:text-gray-400">
                  Link a Stellar address any time to pull your balance out as{' '}
                  <span className="font-mono text-[12px]">{asset}</span> — Loop&apos;s branded
                  stablecoin.
                </p>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          tabIndex={active ? 0 : -1}
          onClick={onLinkWallet}
          className="text-center text-[14px] font-medium text-blue-600 dark:text-blue-400 hover:underline"
        >
          Link a wallet now →
        </button>
      </div>
    </div>
  );
}
