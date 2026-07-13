import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import type { Merchant, MerchantGroup } from '@loop/shared';
import {
  brandSlug,
  currencyOf,
  foldForSearch,
  groupMerchants,
  merchantInCountry,
  merchantSlug,
} from '@loop/shared';
import {
  useAllMerchants,
  useMerchantSearch,
  useMerchantsCashbackRatesMap,
} from '~/hooks/use-merchants';
import { useOrders } from '~/hooks/use-orders';
import { useAuth } from '~/hooks/use-auth';
import { useAppConfig } from '~/hooks/use-app-config';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useLocale } from '~/i18n/locale';
import { shouldRetry } from '~/hooks/query-retry';
import { getCashbackSummary } from '~/services/user';
import { getImageProxyUrl } from '~/utils/image';
import { formatCashbackPct } from '~/utils/format-cashback';
import { formatDateTime, formatMinorCurrency, formatMoney, useLocaleTag } from '~/i18n/format';
import { MerchantCardSkeleton } from '~/components/ui/Skeleton';
import { FavoritesStrip } from '~/components/features/FavoritesStrip';
import { RecentlyPurchasedStrip } from '~/components/features/RecentlyPurchasedStrip';
import { WalletCard } from '~/components/features/wallet/WalletCard';

/**
 * S4-7 §3 tail (go-live-plan §P3): the search-mode directory grid used
 * to show every catalog match with no cap. `GET /api/merchants/search`
 * bounds results server-side (default 20, max 50 — see
 * `apps/backend/src/merchants/search-handler.ts`); this passes the max
 * so the grid stays as full as it can within that documented cap. A
 * deliberate, documented UX change from "unbounded" — a query matching
 * more than 50 merchants now shows the top 50 (ranked in-country-first,
 * then by savings) instead of every match.
 */
const MOBILE_SEARCH_RESULT_LIMIT = 50;

/**
 * Mobile home — native and web narrow widths. Combines the dashboard
 * summary (savings hero, quick buy, recent activity) and the
 * directory (search + brand grid) from the Claude Design mockup
 * into one scroll, adapted to the data we actually have.
 *
 * What's real:
 * - merchants via `useAllMerchants` (localStorage-seeded so the grid
 *   paints instantly on cold start);
 * - orders via `useOrders`, auth-gated so unauth users see an
 *   empty-state hero instead of a blank "$0.00";
 * - lifetime cashback estimate = sum of `amount × savingsPercentage`
 *   on completed orders, computed client-side from the merchant
 *   catalog (no backend aggregate yet).
 *
 * What's skipped vs. the design: category pills (no merchant
 * category field yet), bell/notifications (no notifications
 * system), "streak" stat (no backend metric).
 */
export function MobileHome(): React.JSX.Element {
  const { t } = useTranslation('mobileHome');
  const [hydrated, setHydrated] = useState(false);
  const { merchants, isLoading: merchantsLoading } = useAllMerchants();
  // Bulk cashback-rate map (ADR 011 / 015). One fetch covers every
  // cell in the directory grid; each DirectoryCell then does an O(1)
  // lookup. Mirrors the desktop home grid wiring in routes/home.tsx.
  const { lookup: lookupCashback } = useMerchantsCashbackRatesMap();
  const { email, isAuthenticated } = useAuth();
  const { orders } = useOrders(1, isAuthenticated);
  const navigate = useNavigate();
  const { isNative } = useNativePlatform();
  // Phase 1 delivers cashback as instant discount at order creation —
  // no accumulating balance, no on-chain wallet to withdraw to. The
  // savings hero copy switches between "Cashback earned" (Phase 2,
  // user has a balance) and "You've saved" (Phase 1, totals are the
  // sum of discounts already realised). The numeric value is the
  // same in both phases — `o.amount × savingsPercentage` is the
  // realised saving regardless of delivery model.
  const { config } = useAppConfig();
  const phase1Only = config.phase1Only;
  const visibleMerchants = useMemo(() => (hydrated ? merchants : []), [hydrated, merchants]);
  const visibleMerchantsLoading = !hydrated || merchantsLoading;
  const { country } = useLocale();
  const locale = useLocaleTag();
  // Country-filtered view (ADR 034) for the directory + quick-buy display.
  // `visibleMerchants` stays unfiltered for the lifetime-savings calc (orders span
  // every country the user has bought in).
  const countryMerchants = useMemo(
    () => visibleMerchants.filter((m) => merchantInCountry(m, country)),
    [visibleMerchants, country],
  );

  // Greeting name — email local-part, title-cased first char. `null` for
  // unauth / no-email visitors (UX-09) — the header below swaps to a
  // non-personalized "Welcome" for that case instead of a fake name like
  // "there", which read as a real (if odd) identity under scrutiny.
  const greetingName = useMemo(() => {
    if (email === null || email === undefined || email.length === 0) return null;
    const local = email.split('@')[0] ?? '';
    if (local.length === 0) return null;
    return local.charAt(0).toUpperCase() + local.slice(1);
  }, [email]);
  const avatarInitial = greetingName?.charAt(0).toUpperCase() ?? null;

  // Authoritative cashback total — `credit_transactions.amount_minor`
  // where type='cashback' in the user's home currency. Prefer this
  // over the client-side savingsPercentage estimate below once it
  // loads, since the estimate drifts as CTX tunes savings on its
  // end (the ledger is what we actually credited). 60s stale matches
  // the cashback-balance card on /settings/cashback.
  const summaryQuery = useQuery({
    queryKey: ['me', 'cashback-summary'],
    queryFn: getCashbackSummary,
    enabled: isAuthenticated,
    retry: shouldRetry,
    staleTime: 60_000,
  });

  // Fallback: best-effort, client-side. Completed orders only;
  // multiplies purchase amount by the merchant's savingsPercentage
  // at view time. Used while the backend query is pending or has
  // errored so the hero doesn't flash "$0.00" on a cold load.
  const { fallbackCents, ordersCount } = useMemo(() => {
    const completed = orders.filter((o) => o.status === 'completed');
    const byId = new Map(visibleMerchants.map((m) => [m.id, m]));
    let total = 0;
    for (const o of completed) {
      const pct = byId.get(o.merchantId)?.savingsPercentage;
      if (pct === undefined || pct <= 0) continue;
      total += Math.round(o.amount * 100 * (pct / 100));
    }
    return { fallbackCents: total, ordersCount: completed.length };
  }, [orders, visibleMerchants]);

  // `lifetimeMinor` is already pence / cents (bigint-as-string).
  // Coerce through Number — ledger totals fit into safe-integer
  // range well before they'd print usefully in this tile (a £900T
  // lifetime would overflow, which isn't a realistic concern).
  const backendCents =
    summaryQuery.data !== undefined ? Number(summaryQuery.data.lifetimeMinor) : null;
  const cashbackCents =
    backendCents !== null && Number.isFinite(backendCents) ? backendCents : fallbackCents;

  // WEB-M1: currency for the savings hero. Prefer the ledger's home
  // currency from the cashback-summary; fall back to the routed
  // country's display currency (ADR-034) so the figure reads £/€ for a
  // GB/EU visitor even before the authed summary loads.
  const heroCurrency = summaryQuery.data?.currency ?? currencyOf(country) ?? 'USD';

  // Quick buy — top 6 by savings, only those with logos so the tile
  // row reads as populated.
  const quickBuy = useMemo(
    () =>
      countryMerchants
        .filter((m) => m.enabled !== false && m.logoUrl !== undefined)
        .slice()
        .sort((a, b) => (b.savingsPercentage ?? 0) - (a.savingsPercentage ?? 0))
        .slice(0, 6),
    [countryMerchants],
  );

  // Pending orders are hidden from Recent activity — a blank row
  // with no cashback reads as noise on the home screen. Matches the
  // same filter on /orders.
  const recent = orders.filter((o) => o.status !== 'pending').slice(0, 3);
  const merchantById = useMemo(
    () => new Map(visibleMerchants.map((m) => [m.id, m])),
    [visibleMerchants],
  );

  // Search + directory. Query folds for diacritics using the same
  // util the backend + Navbar search use, so "cafe" matches "Café"
  // here identically to everywhere else.
  const [query, setQuery] = useState('');
  // S4-7: debounce before folding/filtering so the (large, un-virtualized)
  // directory isn't re-filtered on every keystroke. The input stays bound to
  // `query` for responsive typing; filtering keys off `debouncedQuery`. Mirrors
  // Navbar's 150ms search debounce.
  const [debouncedQuery, setDebouncedQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);
  const foldedQuery = foldForSearch(debouncedQuery.trim());
  const isSearching = foldedQuery.length > 0;

  // S4-7 §3 tail: server-side search (go-live-plan §P3). Only the SEARCH
  // branch below switches to the endpoint — browsing (no query) still
  // reads `countryMerchants`/`visibleMerchants` from the full catalog
  // fetched above, unchanged. `useMerchantSearch` matches the exact
  // ordering this branch used to compute client-side (in-country first,
  // then savingsPercentage desc — ADR 034) via its `country` param, now
  // computed server-side. `MOBILE_SEARCH_RESULT_LIMIT` bounds the grid —
  // previously unbounded; see the comment on the constant below.
  const {
    merchants: searchResults,
    isLoading: searchLoading,
    isError: searchErrored,
  } = useMerchantSearch(debouncedQuery, {
    country,
    limit: MOBILE_SEARCH_RESULT_LIMIT,
    enabled: isSearching,
  });

  const grid = useMemo(() => {
    const bySavings = (a: Merchant, b: Merchant): number =>
      (b.savingsPercentage ?? 0) - (a.savingsPercentage ?? 0);
    // Browsing the directory shows the active country. Searching spans every
    // country but ranks the active country first (ADR 034) — the server
    // already applies both filters + that ordering.
    if (!isSearching) {
      return countryMerchants
        .filter((m) => m.enabled !== false)
        .slice()
        .sort(bySavings);
    }
    if (searchErrored) return [];
    return searchResults;
  }, [countryMerchants, isSearching, searchResults, searchErrored]);
  // ADR 032: collapse "Brand - Variant" SKUs into one brand cell. Grouping
  // the *filtered* list means a search for "tree" still surfaces the
  // dots.eco brand (a matching variant keeps its group).
  const groupedGrid = useMemo(() => groupMerchants(grid), [grid]);
  // Loading skeleton: while searching, only the search request's own
  // loading state matters (the catalog fetch that gates browse mode is
  // irrelevant once a query is typed). `grid.length === 0` avoids
  // re-showing skeletons under `placeholderData: keepPreviousData` once a
  // prior result set is already on screen.
  const directoryLoading =
    (isSearching ? searchLoading : visibleMerchantsLoading) && grid.length === 0;

  useEffect(() => {
    setHydrated(true);
  }, []);

  return (
    <div
      className={
        // Native: clears the safe-top padding NativeShell already
        // applies + breathing. Web mobile: clears the fixed Navbar.
        isNative ? 'pt-2' : 'pt-[5rem]'
      }
    >
      {/* Greeting header ---------------------------------------- */}
      <div className="flex items-center justify-between px-5 pt-3 pb-2">
        <div className="flex flex-col">
          <span className="text-xs font-semibold uppercase tracking-[0.06em] text-gray-500 dark:text-gray-400">
            {greetingName !== null ? t('greeting.welcomeBack') : t('greeting.welcome')}
          </span>
          <h1 className="mt-0.5 text-[24px] font-bold tracking-tight text-gray-950 dark:text-white">
            {greetingName ?? t('greeting.toLoop')}
          </h1>
        </div>
        <Link
          to="/auth"
          aria-label={t('greeting.accountAriaLabel')}
          className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-sm font-bold"
        >
          {avatarInitial !== null ? (
            avatarInitial
          ) : (
            // UX-09: no real identity to initial for an anonymous
            // visitor — a generic person glyph instead of a letter
            // avatar derived from the "there" placeholder name.
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="8" r="4" />
              <path d="M4 20c0-4 3.5-6 8-6s8 2 8 6" />
            </svg>
          )}
        </Link>
      </div>

      {/* Savings hero ------------------------------------------- */}
      <div className="px-5 pt-1">
        <SavingsHero
          cashbackCents={cashbackCents}
          ordersCount={ordersCount}
          isAuthenticated={isAuthenticated}
          phase1Only={phase1Only}
          currency={heroCurrency}
          locale={locale}
        />
      </div>

      {/* Loop balance (ADR 030 Phase C) — the on-chain LOOP balance
          is the user's authoritative spendable balance. Self-gating:
          renders nothing while signed out / loading / pre-backend. */}
      <div className="px-5 pt-3 [&>section]:mb-0">
        <WalletCard />
      </div>

      {/* Quick buy ---------------------------------------------- */}
      <SectionHeader
        title={t('section.quickBuy')}
        actionLabel={t('section.browseAll')}
        actionHref="#mobile-home-grid"
      />
      {visibleMerchantsLoading && quickBuy.length === 0 ? (
        <div className="flex gap-2.5 px-5 pb-1 overflow-x-auto">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 animate-pulse flex-shrink-0"
            />
          ))}
        </div>
      ) : (
        <div className="flex gap-2.5 px-5 pb-1 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
          {quickBuy.map((m) => (
            <Link
              key={m.id}
              to={`/gift-card/${merchantSlug(m)}`}
              className="flex-shrink-0 w-[72px] flex flex-col items-center gap-1.5"
            >
              <BrandTile merchant={m} size={64} />
              {typeof m.savingsPercentage === 'number' && m.savingsPercentage > 0 && (
                <PctPill>{`${m.savingsPercentage.toFixed(1)}%`}</PctPill>
              )}
            </Link>
          ))}
        </div>
      )}

      {/* Recent activity ---------------------------------------- */}
      {recent.length > 0 && (
        <>
          <SectionHeader
            title={t('section.recentActivity')}
            actionLabel={t('section.allOrders')}
            actionOnClick={() => void navigate('/orders')}
          />
          <div className="px-5">
            <div className="rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 px-2">
              {recent.map((order, i) => (
                <ActivityRow
                  key={order.id}
                  merchantName={order.merchantName}
                  merchantLogoUrl={merchantById.get(order.merchantId)?.logoUrl}
                  savingsPercentage={merchantById.get(order.merchantId)?.savingsPercentage}
                  amount={order.amount}
                  currency={order.currency}
                  locale={locale}
                  createdAt={order.createdAt}
                  onClick={() => void navigate(`/orders/${order.id}`)}
                  isLast={i === recent.length - 1}
                />
              ))}
            </div>
          </div>
        </>
      )}

      {/* Search ------------------------------------------------- */}
      <div className="px-5 pt-5">
        <div className="relative">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-400 dark:text-white/50 pointer-events-none"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
          <input
            type="text"
            inputMode="search"
            aria-label="Search brands"
            placeholder="Search 500+ brands"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full pl-10 pr-9 py-2.5 rounded-xl bg-gray-100 dark:bg-white/10 text-[15px] text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-white/60 outline-none border-0"
          />
          {query.length > 0 && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-gray-500 dark:text-white/70 hover:bg-black/5 dark:hover:bg-white/10"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Returning-buyer shortcuts — recently-purchased then
          favourites. Both self-gate on isAuthenticated + a non-empty
          list, so fresh accounts see the directory grid alone.
          Recently-purchased renders first because a returning buyer
          is most likely to want to repeat-purchase before they
          revisit pinned-but-unused merchants. */}
      <RecentlyPurchasedStrip variant="mobile" />
      <FavoritesStrip variant="mobile" />

      {/* Directory grid ----------------------------------------- */}
      <SectionHeader
        title={query.length > 0 ? t('section.results') : t('section.browse')}
        meta={t('section.resultsMeta', { count: groupedGrid.length })}
      />
      {/* `min-h-[70vh]` keeps the page tall enough that the search
          input's scroll position doesn't jump when the grid shrinks
          to a few results (or an empty state). Without this the
          total page height collapses, the browser force-scrolls up
          to the nearest content, and the search bar appears to hop
          back under the hero. The tab bar clearance below sits
          inside NativeShell, so this min-h is clean content. */}
      <div id="mobile-home-grid" className="px-5 pb-6 grid grid-cols-2 gap-2.5 min-h-[70vh]">
        {directoryLoading ? (
          Array.from({ length: 6 }).map((_, i) => <MerchantCardSkeleton key={i} />)
        ) : isSearching && searchErrored ? (
          // Distinct from "no results" — a failed search request
          // shouldn't read as "we searched and there's nothing".
          <div className="col-span-2 text-center py-10 text-sm text-gray-500 dark:text-gray-400">
            {t('directory.searchUnavailable')}
          </div>
        ) : groupedGrid.length > 0 ? (
          groupedGrid.map((g) =>
            g.isGroup ? (
              <DirectoryGroupCell key={`g:${g.key}`} group={g} />
            ) : (
              <DirectoryCell
                key={g.members[0]!.id}
                merchant={g.members[0]!}
                userCashbackPct={lookupCashback(g.members[0]!.id)}
              />
            ),
          )
        ) : (
          <div className="col-span-2 text-center py-10 text-sm text-gray-500 dark:text-gray-400">
            {t('directory.noMatch', { query })}
          </div>
        )}
      </div>
    </div>
  );
}

function SectionHeader({
  title,
  actionLabel,
  actionHref,
  actionOnClick,
  meta,
}: {
  title: string;
  actionLabel?: string;
  actionHref?: string;
  actionOnClick?: () => void;
  meta?: string;
}): React.JSX.Element {
  const right =
    actionLabel !== undefined ? (
      actionHref !== undefined ? (
        <a className="text-xs font-semibold text-blue-600 dark:text-blue-400" href={actionHref}>
          {actionLabel}
        </a>
      ) : (
        <button
          type="button"
          onClick={actionOnClick}
          className="text-xs font-semibold text-blue-600 dark:text-blue-400 bg-transparent border-0 p-0 cursor-pointer"
        >
          {actionLabel}
        </button>
      )
    ) : meta !== undefined ? (
      <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{meta}</span>
    ) : null;
  return (
    <div className="flex items-center justify-between px-5 pt-5 pb-2">
      <h2 className="text-[15px] font-bold tracking-tight text-gray-900 dark:text-white">
        {title}
      </h2>
      {right}
    </div>
  );
}

// Exported for unit-test access — the parent file's coverage is
// component-shape only; this lets the label-switch + amount
// formatting assertions live in a focused test file.
export function SavingsHero({
  cashbackCents,
  ordersCount,
  isAuthenticated,
  phase1Only,
  currency = 'USD',
  locale = 'en-US',
}: {
  cashbackCents: number;
  ordersCount: number;
  isAuthenticated: boolean;
  phase1Only: boolean;
  /**
   * Home/ledger currency for the hero figures (WEB-M1). Defaults to
   * `USD` so legacy call sites / tests still render `$`; the parent
   * threads the user's `cashback-summary` currency (or the routed
   * country's currency) so a GB/EU user sees £/€ on this headline.
   */
  currency?: string;
  /**
   * Active route locale for separators/grouping (CF-22). Defaults to
   * `en-US` so tests / legacy callers keep stable output; the parent
   * threads the `/:country/:lang` tag so a `/de/en` ledger groups as
   * `1.234,56 €`.
   */
  locale?: string;
}): React.JSX.Element {
  const { t } = useTranslation('mobileHome');
  // Unauth or no-orders state — show a teaser instead of "$0.00"
  // which reads as a bug. Matches the design's ink face but with a
  // friendlier copy instead of the stat strip.
  const empty = !isAuthenticated || ordersCount === 0;
  // Phase 1 = instant-discount delivery, no accumulating balance →
  // "You've saved" / "Buy a gift card to start saving."
  // Phase 2 = cashback paid to user's Loop wallet, withdraw-able →
  // "Cashback earned" / "Buy a gift card to start earning cashback."
  const heroLabel = phase1Only ? t('hero.savedLabel') : t('hero.cashbackLabel');
  const emptySubtitle = phase1Only ? t('hero.savedEmptySub') : t('hero.cashbackEmptySub');
  const avgLabel = phase1Only ? t('hero.avgSavingLabel') : t('hero.avgBackLabel');
  return (
    <div
      className="relative overflow-hidden rounded-[18px] px-6 py-5 text-white shadow-[0_8px_24px_rgba(3,7,18,0.25),0_2px_6px_rgba(3,7,18,0.15)]"
      style={{
        background: 'linear-gradient(140deg, #0F172A 0%, #030712 100%)',
      }}
    >
      <div
        className="absolute pointer-events-none"
        style={{
          top: -40,
          right: -40,
          width: 180,
          height: 180,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(59,130,246,0.35), transparent 70%)',
        }}
      />
      <div className="text-[12px] font-semibold uppercase tracking-[0.06em] opacity-60 mb-1.5">
        {heroLabel}
      </div>
      <div
        className="text-[44px] font-extrabold leading-none mb-1"
        style={{ letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}
      >
        {empty
          ? formatCashback(0, currency, locale)
          : formatCashback(cashbackCents, currency, locale)}
      </div>
      <div className="text-[13px] text-white/65 mb-4">
        {empty ? emptySubtitle : t('hero.activitySub', { count: ordersCount })}
      </div>
      <div className="grid grid-cols-2 gap-0 border-t border-white/10 pt-3.5">
        <div className="text-left">
          <div className="text-[16px] font-bold" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {ordersCount}
          </div>
          <div className="text-[11px] opacity-55 mt-0.5">{t('hero.ordersLabel')}</div>
        </div>
        <div className="text-right">
          <div className="text-[16px] font-bold" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {empty ? '—' : avgBackLabel(cashbackCents, ordersCount, currency, locale)}
          </div>
          <div className="text-[11px] opacity-55 mt-0.5">{avgLabel}</div>
        </div>
      </div>
    </div>
  );
}

// WEB-M1 / CF-22: format the hero figures in the user's home/ledger
// currency and the active route locale instead of a hardcoded `$`/en-US,
// so a GB/EU ledger reads £/€ with the right separators on the most
// prominent money figure on the home screen (ADR-034 locale model).
function formatCashback(cents: number, currency: string, locale: string): string {
  return formatMinorCurrency(cents, currency, locale);
}

function avgBackLabel(
  cashbackCents: number,
  ordersCount: number,
  currency: string,
  locale: string,
): string {
  if (ordersCount === 0) return '—';
  // Round to the nearest minor unit before formatting so the average
  // renders as exact cents (formatMinorCurrency floors otherwise).
  const avgCents = Math.round(cashbackCents / ordersCount);
  return formatMinorCurrency(avgCents, currency, locale);
}

function BrandTile({
  merchant,
  size = 64,
}: {
  merchant: Merchant;
  size?: number;
}): React.JSX.Element {
  const logo = merchant.logoUrl !== undefined ? getImageProxyUrl(merchant.logoUrl, 192) : undefined;
  return (
    <div
      className="flex items-center justify-center rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_4px_12px_rgba(0,0,0,0.06)] dark:shadow-none overflow-hidden"
      style={{ width: size, height: size, padding: size * 0.22 }}
    >
      {logo !== undefined ? (
        <img src={logo} alt={merchant.name} className="w-full h-full object-contain" />
      ) : (
        <span className="text-sm font-bold text-gray-700 dark:text-gray-200">
          {merchant.name.charAt(0)}
        </span>
      )}
    </div>
  );
}

function PctPill({
  children,
  variant = 'savings',
}: {
  children: React.ReactNode;
  /** `savings` is the upstream discount; `cashback` is Loop's ADR-011 user split. */
  variant?: 'savings' | 'cashback';
}): React.JSX.Element {
  const palette =
    variant === 'cashback'
      ? 'text-blue-700 dark:text-blue-400 bg-blue-100 dark:bg-blue-900/30'
      : 'text-green-700 dark:text-green-400 bg-green-100 dark:bg-green-900/30';
  return (
    <span
      className={`inline-flex items-center text-[10px] font-bold ${palette} px-1.5 py-0.5 rounded-full leading-none`}
    >
      {children}
    </span>
  );
}

function DirectoryCell({
  merchant,
  userCashbackPct = null,
}: {
  merchant: Merchant;
  /** Numeric(5,2) wire shape (e.g. `"2.50"`). Null → no pill. */
  userCashbackPct?: string | null;
}): React.JSX.Element {
  const { t } = useTranslation('mobileHome');
  const cashbackLabel = formatCashbackPct(userCashbackPct);
  const hasSavings =
    typeof merchant.savingsPercentage === 'number' && merchant.savingsPercentage > 0;
  return (
    <Link
      to={`/gift-card/${merchantSlug(merchant)}`}
      className="rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-3 flex flex-col gap-2 active:scale-[0.98] transition-transform"
    >
      <div className="flex items-start justify-between gap-2">
        <BrandTile merchant={merchant} size={44} />
        {/* Stack pills vertically in the top-right; savings first,
            cashback below. Two side-by-side pills clip too aggressively
            on narrow screens (iPhone SE). Either pill can independently
            be absent. */}
        {(hasSavings || cashbackLabel !== null) && (
          <div className="flex flex-col items-end gap-1">
            {hasSavings && (
              <PctPill>{`${(merchant.savingsPercentage as number).toFixed(1)}%`}</PctPill>
            )}
            {cashbackLabel !== null && (
              <PctPill variant="cashback">{`${cashbackLabel}% back`}</PctPill>
            )}
          </div>
        )}
      </div>
      <div className="text-[14px] font-semibold text-gray-900 dark:text-white truncate">
        {merchant.name}
      </div>
      <div className="text-[11px] font-medium text-gray-400 dark:text-gray-500 -mt-1">
        {t('directory.giftCards')}
      </div>
    </Link>
  );
}

/**
 * Brand cell for a multi-variant group (ADR 032) — links to the brand
 * view (`/brand/:slug`) rather than a single gift card. Mirrors
 * DirectoryCell, with an option count instead of a single savings %.
 */
function DirectoryGroupCell({ group }: { group: MerchantGroup }): React.JSX.Element {
  const { t } = useTranslation('mobileHome');
  const rep = group.members.find((m) => m.logoUrl !== undefined) ?? group.members[0]!;
  const maxSavings = group.members.reduce((acc, m) => Math.max(acc, m.savingsPercentage ?? 0), 0);
  return (
    <Link
      to={`/brand/${brandSlug(group.name)}`}
      className="rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 p-3 flex flex-col gap-2 active:scale-[0.98] transition-transform"
    >
      <div className="flex items-start justify-between gap-2">
        <BrandTile merchant={rep} size={44} />
        <div className="flex flex-col items-end gap-1">
          {maxSavings > 0 && <PctPill>{`${maxSavings.toFixed(1)}%`}</PctPill>}
          <span className="text-[10px] font-semibold text-gray-500 dark:text-gray-400 rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 tabular">
            {group.members.length}
          </span>
        </div>
      </div>
      <div className="text-[14px] font-semibold text-gray-900 dark:text-white truncate">
        {group.name}
      </div>
      <div className="text-[11px] font-medium text-gray-400 dark:text-gray-500 -mt-1">
        {t('directory.options', { count: group.members.length })}
      </div>
    </Link>
  );
}

function ActivityRow({
  merchantName,
  merchantLogoUrl,
  savingsPercentage,
  amount,
  currency,
  locale,
  createdAt,
  onClick,
  isLast,
}: {
  merchantName: string;
  merchantLogoUrl?: string | undefined;
  savingsPercentage?: number | undefined;
  amount: number;
  currency: string;
  locale: string;
  createdAt: string;
  onClick: () => void;
  isLast: boolean;
}): React.JSX.Element {
  const { t } = useTranslation('mobileHome');
  const back = savingsPercentage !== undefined ? amount * (savingsPercentage / 100) : 0;
  const when = formatWhen(createdAt, t, locale);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 py-2.5 px-2 ${
        isLast ? '' : 'border-b border-gray-100 dark:border-gray-800'
      }`}
    >
      <BrandTile
        merchant={{
          id: '',
          name: merchantName,
          enabled: true,
          logoUrl: merchantLogoUrl,
        }}
        size={40}
      />
      <div className="flex-1 min-w-0 text-left">
        <div className="text-[14px] font-semibold text-gray-900 dark:text-white truncate">
          {merchantName}
        </div>
        <div className="text-[12px] text-gray-500 dark:text-gray-400">{when}</div>
      </div>
      <div className="text-right">
        <div
          className="text-[14px] font-bold text-gray-900 dark:text-white"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          −{formatMoney(amount, currency, locale)}
        </div>
        {back > 0 && (
          <div
            className="text-[11px] font-semibold text-green-700 dark:text-green-400"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            +{formatMoney(back, currency, locale)} back
          </div>
        )}
      </div>
    </button>
  );
}

function formatWhen(iso: string, t: TFunction<'mobileHome'>, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  // Route locale, not the host default (`navigator.language` / the CI box's
  // `LANG`) — a /de/en reader sees the German time/day shape (ADR 034,
  // P2-DATE-SWEEP2). A time-only options object makes `formatDateTime`
  // (`toLocaleString`) emit exactly the time the former `toLocaleTimeString`
  // did, and a date-only object the same date `toLocaleDateString` did.
  const time = formatDateTime(iso, locale, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return t('activity.today', { time });
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return t('activity.yesterday', { time });
  return formatDateTime(iso, locale, { weekday: 'short', day: 'numeric', month: 'short' });
}
