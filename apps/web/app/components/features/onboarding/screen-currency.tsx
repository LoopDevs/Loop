/**
 * Onboarding screen — home-currency picker (ADR 015).
 *
 * Mounted between OTP verify and the biometric-setup step. The user
 * taps one of USD / GBP / EUR; the CTA at the container level POSTs
 * to `/api/users/me/home-currency` (locked to zero-orders by the
 * backend, but onboarding is necessarily pre-any-order so the
 * endpoint's 409 branch is unreachable here).
 */
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { currencyOf } from '@loop/shared';
import { useRadioGroupKeys } from '~/hooks/use-radio-group-keys';

interface ScreenCopy {
  eyebrow?: string;
  title: string;
  sub: string;
}

export type HomeCurrency = 'USD' | 'GBP' | 'EUR';

/**
 * Home currency for a routed country's first guess (ADR 034). Maps the country's
 * display currency to a supported home currency; CAD → USD, since there is no
 * CADLOOP asset yet, so Canadian cashback settles in USDLOOP for now.
 */
export function homeCurrencyForCountry(country: string): HomeCurrency {
  const currency = currencyOf(country);
  if (currency === 'GBP') return 'GBP';
  if (currency === 'EUR') return 'EUR';
  return 'USD';
}

interface CurrencyOption {
  code: HomeCurrency;
  symbol: string;
  label: string;
  /** Subhead copy rendered beneath the label — one-liner regional hint. */
  hint: string;
}

function buildOptions(t: TFunction<'onboarding'>): readonly CurrencyOption[] {
  return [
    {
      code: 'USD',
      symbol: '$',
      label: t('currency.options.usd.label'),
      hint: t('currency.options.usd.hint'),
    },
    {
      code: 'GBP',
      symbol: '£',
      label: t('currency.options.gbp.label'),
      hint: t('currency.options.gbp.hint'),
    },
    {
      code: 'EUR',
      symbol: '€',
      label: t('currency.options.eur.label'),
      hint: t('currency.options.eur.hint'),
    },
  ];
}

interface CurrencyPickerScreenProps {
  active: boolean;
  copy: ScreenCopy;
  selected: HomeCurrency | null;
  onSelect: (code: HomeCurrency) => void;
  /** Error text from the submit call (network / 4xx). Rendered inline below the picker. */
  error?: string | null;
}

export function CurrencyPickerScreen({
  active,
  copy,
  selected,
  onSelect,
  error,
}: CurrencyPickerScreenProps): React.JSX.Element {
  const { t } = useTranslation('onboarding');
  const OPTIONS = buildOptions(t);
  // A11Y-007 / CF-35: proper WAI-ARIA radiogroup keyboard behaviour — a
  // single roving tab stop + Arrow/Home/End navigation. The previous
  // `tabIndex={active?0:-1}` on every radio made all three simultaneous tab
  // stops with no arrow keys.
  const { rovingTabIndex, onKeyDown } = useRadioGroupKeys({
    options: OPTIONS.map((o) => o.code),
    selected,
    onSelect,
  });
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

        <div role="radiogroup" aria-label={t('currency.ariaLabel')} className="flex flex-col gap-3">
          {OPTIONS.map((opt, i) => {
            const isSelected = selected === opt.code;
            return (
              <button
                key={opt.code}
                type="button"
                role="radio"
                aria-checked={isSelected}
                tabIndex={active ? rovingTabIndex(i) : -1}
                onClick={() => onSelect(opt.code)}
                onKeyDown={(e) => onKeyDown(e, i)}
                className={[
                  'w-full rounded-2xl px-5 py-4 border text-left flex items-center gap-4 cursor-pointer active:scale-[0.98] transition-transform',
                  isSelected
                    ? 'border-blue-600 bg-blue-50 ring-1 ring-blue-600'
                    : 'border-line bg-white hover:border-line-strong',
                ].join(' ')}
              >
                <span
                  className="flex-shrink-0 w-10 h-10 rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center text-[20px] font-bold text-gray-950 dark:text-white"
                  aria-hidden
                >
                  {opt.symbol}
                </span>
                <span className="flex-1 flex flex-col gap-0.5">
                  <span className="text-[16px] font-semibold text-gray-950 dark:text-white">
                    {opt.label}
                    <span className="ml-2 text-gray-500 dark:text-gray-400 font-normal">
                      {opt.code}
                    </span>
                  </span>
                  <span className="text-[13px] text-gray-500 dark:text-gray-400">{opt.hint}</span>
                </span>
                {/* A11Y-007: selected state was color-only — add a checkmark
                    glyph so the choice doesn't rely on hue alone. */}
                <span
                  aria-hidden
                  className={[
                    'flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center',
                    isSelected
                      ? 'border-blue-600 bg-blue-600 text-white'
                      : 'border-line-strong bg-transparent',
                  ].join(' ')}
                >
                  {isSelected ? (
                    <svg
                      viewBox="0 0 12 12"
                      className="h-3 w-3"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M2.5 6.5 5 9l4.5-5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>

        {error !== undefined && error !== null ? (
          <div role="alert" className="text-center text-[13px] text-red-600 dark:text-red-400 px-4">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Best-effort locale → currency guess for the picker's default
 * selection. Falls back to USD when the locale doesn't map to a
 * supported currency — the user can always change their mind
 * before the container's CTA fires.
 */
export function guessHomeCurrency(locale: string | undefined): HomeCurrency {
  if (typeof locale !== 'string' || locale.length === 0) return 'USD';
  const region = localeRegion(locale);
  if (region === null) return 'USD';
  if (EUROZONE_REGIONS.has(region)) return 'EUR';
  if (region === 'GB') return 'GBP';
  return 'USD';
}

function localeRegion(locale: string): string | null {
  // Normalise underscore-separated POSIX locales ("en_GB") to the
  // hyphenated BCP-47 form Intl expects.
  const normalised = locale.replace(/_/g, '-');
  const parts = normalised.split('-');
  for (const p of parts) {
    if (p.length === 2 && p === p.toUpperCase()) return p;
  }
  // Fall back to parsing the first segment's language code — not
  // perfect (no region signal), but better than guessing USD
  // when the user has `de` or `fr` set without a country.
  const lang = parts[0]?.toLowerCase();
  if (lang === 'de' || lang === 'fr' || lang === 'es' || lang === 'it' || lang === 'pt') {
    return 'EU'; // synthetic — routes to EUR
  }
  if (lang === 'en') {
    // Bare `en` defaults to US since that's the majority of
    // English-speaking visitors; `en-GB` / `en-IE` etc. are picked
    // up by the region branch above.
    return 'US';
  }
  return null;
}

const EUROZONE_REGIONS = new Set([
  'EU', // synthetic from language-only locales
  'AT',
  'BE',
  'CY',
  'DE',
  'EE',
  'ES',
  'FI',
  'FR',
  'GR',
  'IE',
  'IT',
  'LT',
  'LU',
  'LV',
  'MT',
  'NL',
  'PT',
  'SI',
  'SK',
  'HR',
]);
