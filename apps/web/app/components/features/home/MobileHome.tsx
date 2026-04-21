import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Merchant } from '@loop/shared';
import { foldForSearch, merchantSlug } from '@loop/shared';
import { useAllMerchants, useMerchantsCashbackRatesMap } from '~/hooks/use-merchants';
import { useOrders } from '~/hooks/use-orders';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { getImageProxyUrl } from '~/utils/image';
import { formatMoney } from '~/utils/money';
import { MerchantCardSkeleton } from '~/components/ui/Skeleton';

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
  const { merchants, isLoading: merchantsLoading } = useAllMerchants();
  // Bulk cashback-rate map (ADR 011 / 015). One fetch covers every
  // cell in the directory grid; each DirectoryCell then does an O(1)
  // lookup. Mirrors the desktop home grid wiring in routes/home.tsx.
  const { lookup: lookupCashback } = useMerchantsCashbackRatesMap();
  const { email, isAuthenticated } = useAuth();
  const { orders } = useOrders(1, isAuthenticated);
  const navigate = useNavigate();
  const { isNative } = useNativePlatform();

  // Greeting name — email local-part, title-cased first char. Falls
  // back to "there" for unauth / no-email visitors.
  const greetingName = useMemo(() => {
    if (email === null || email === undefined || email.length === 0) return 'there';
    const local = email.split('@')[0] ?? '';
    if (local.length === 0) return 'there';
    return local.charAt(0).toUpperCase() + local.slice(1);
  }, [email]);
  const avatarInitial = greetingName.charAt(0).toUpperCase();

  // Cashback aggregate — best-effort, client-side. Completed orders
  // only; multiplies purchase amount by the merchant's
  // savingsPercentage at view time (a future backend field would be
  // more accurate since savingsPercentage can drift).
  const { cashbackCents, ordersCount } = useMemo(() => {
    const completed = orders.filter((o) => o.status === 'completed');
    const byId = new Map(merchants.map((m) => [m.id, m]));
    let total = 0;
    for (const o of completed) {
      const pct = byId.get(o.merchantId)?.savingsPercentage;
      if (pct === undefined || pct <= 0) continue;
      // order.amount is a number in the display currency; store the
      // back-estimate in cents to avoid float drift when summing.
      total += Math.round(o.amount * 100 * (pct / 100));
    }
    return { cashbackCents: total, ordersCount: completed.length };
  }, [orders, merchants]);

  // Quick buy — top 6 by savings, only those with logos so the tile
  // row reads as populated.
  const quickBuy = useMemo(
    () =>
      merchants
        .filter((m) => m.enabled !== false && m.logoUrl !== undefined)
        .slice()
        .sort((a, b) => (b.savingsPercentage ?? 0) - (a.savingsPercentage ?? 0))
        .slice(0, 6),
    [merchants],
  );

  // Pending orders are hidden from Recent activity — a blank row
  // with no cashback reads as noise on the home screen. Matches the
  // same filter on /orders.
  const recent = orders.filter((o) => o.status !== 'pending').slice(0, 3);
  const merchantById = useMemo(() => new Map(merchants.map((m) => [m.id, m])), [merchants]);

  // Search + directory. Query folds for diacritics using the same
  // util the backend + Navbar search use, so "cafe" matches "Café"
  // here identically to everywhere else.
  const [query, setQuery] = useState('');
  const foldedQuery = foldForSearch(query.trim());
  const grid = useMemo(() => {
    const enabled = merchants.filter((m) => m.enabled !== false);
    const filtered =
      foldedQuery.length > 0
        ? enabled.filter((m) => foldForSearch(m.name).includes(foldedQuery))
        : enabled;
    return filtered.slice().sort((a, b) => (b.savingsPercentage ?? 0) - (a.savingsPercentage ?? 0));
  }, [merchants, foldedQuery]);

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
            Welcome back
          </span>
          <h1 className="mt-0.5 text-[24px] font-bold tracking-tight text-gray-950 dark:text-white">
            {greetingName}
          </h1>
        </div>
        <Link
          to="/auth"
          aria-label="Account"
          className="w-9 h-9 rounded-full bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 flex items-center justify-center text-sm font-bold"
        >
          {avatarInitial}
        </Link>
      </div>

      {/* Savings hero ------------------------------------------- */}
      <div className="px-5 pt-1">
        <SavingsHero
          cashbackCents={cashbackCents}
          ordersCount={ordersCount}
          isAuthenticated={isAuthenticated}
        />
      </div>

      {/* Quick buy ---------------------------------------------- */}
      <SectionHeader title="Quick buy" actionLabel="Browse all" actionHref="#mobile-home-grid" />
      {merchantsLoading && quickBuy.length === 0 ? (
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
              to={`/gift-card/${merchantSlug(m.name)}`}
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
            title="Recent activity"
            actionLabel="All orders"
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

      {/* Directory grid ----------------------------------------- */}
      <SectionHeader
        title={query.length > 0 ? 'Results' : 'Browse'}
        meta={`${grid.length} brand${grid.length === 1 ? '' : 's'}`}
      />
      {/* `min-h-[70vh]` keeps the page tall enough that the search
          input's scroll position doesn't jump when the grid shrinks
          to a few results (or an empty state). Without this the
          total page height collapses, the browser force-scrolls up
          to the nearest content, and the search bar appears to hop
          back under the hero. The tab bar clearance below sits
          inside NativeShell, so this min-h is clean content. */}
      <div id="mobile-home-grid" className="px-5 pb-6 grid grid-cols-2 gap-2.5 min-h-[70vh]">
        {merchantsLoading && grid.length === 0 ? (
          Array.from({ length: 6 }).map((_, i) => <MerchantCardSkeleton key={i} />)
        ) : grid.length > 0 ? (
          grid.map((m) => (
            <DirectoryCell key={m.id} merchant={m} userCashbackPct={lookupCashback(m.id)} />
          ))
        ) : (
          <div className="col-span-2 text-center py-10 text-sm text-gray-500 dark:text-gray-400">
            No brands match &ldquo;{query}&rdquo;
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

function SavingsHero({
  cashbackCents,
  ordersCount,
  isAuthenticated,
}: {
  cashbackCents: number;
  ordersCount: number;
  isAuthenticated: boolean;
}): React.JSX.Element {
  // Unauth or no-orders state — show a teaser instead of "$0.00"
  // which reads as a bug. Matches the design's ink face but with a
  // friendlier copy instead of the stat strip.
  const empty = !isAuthenticated || ordersCount === 0;
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
        Cashback earned
      </div>
      <div
        className="text-[44px] font-extrabold leading-none mb-1"
        style={{ letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}
      >
        {empty ? '$0.00' : formatCashback(cashbackCents)}
      </div>
      <div className="text-[13px] text-white/65 mb-4">
        {empty
          ? 'Buy a gift card to start earning cashback.'
          : `Across ${ordersCount} order${ordersCount === 1 ? '' : 's'} — keep going.`}
      </div>
      <div className="grid grid-cols-2 gap-0 border-t border-white/10 pt-3.5">
        <div className="text-left">
          <div className="text-[16px] font-bold" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {ordersCount}
          </div>
          <div className="text-[11px] opacity-55 mt-0.5">Orders</div>
        </div>
        <div className="text-right">
          <div className="text-[16px] font-bold" style={{ fontVariantNumeric: 'tabular-nums' }}>
            {empty ? '—' : avgBackLabel(cashbackCents, ordersCount)}
          </div>
          <div className="text-[11px] opacity-55 mt-0.5">Avg back</div>
        </div>
      </div>
    </div>
  );
}

function formatCashback(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars.toFixed(2)}`;
}

function avgBackLabel(cashbackCents: number, ordersCount: number): string {
  if (ordersCount === 0) return '—';
  const avgCents = cashbackCents / ordersCount;
  return `$${(avgCents / 100).toFixed(2)}`;
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

/**
 * Formats the numeric(5,2) cashback string into the compact pill
 * label. Drops a trailing `.0` so integer rates read as "5%" rather
 * than "5.0%" on the small pill. Returns `null` when the rate parses
 * to 0 / negative / unparseable — the caller hides the pill.
 */
function formatCashbackPct(pct: string | null | undefined): string | null {
  if (pct === null || pct === undefined) return null;
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return null;
  const rounded = Math.round(n * 10) / 10;
  return rounded.toFixed(1).replace(/\.0$/, '');
}

function DirectoryCell({
  merchant,
  userCashbackPct = null,
}: {
  merchant: Merchant;
  /** Numeric(5,2) wire shape (e.g. `"2.50"`). Null → no pill. */
  userCashbackPct?: string | null;
}): React.JSX.Element {
  const cashbackLabel = formatCashbackPct(userCashbackPct);
  const hasSavings =
    typeof merchant.savingsPercentage === 'number' && merchant.savingsPercentage > 0;
  return (
    <Link
      to={`/gift-card/${merchantSlug(merchant.name)}`}
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
        Gift cards
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
  createdAt,
  onClick,
  isLast,
}: {
  merchantName: string;
  merchantLogoUrl?: string | undefined;
  savingsPercentage?: number | undefined;
  amount: number;
  currency: string;
  createdAt: string;
  onClick: () => void;
  isLast: boolean;
}): React.JSX.Element {
  const back = savingsPercentage !== undefined ? amount * (savingsPercentage / 100) : 0;
  const when = formatWhen(createdAt);
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
          −{formatMoney(amount, currency)}
        </div>
        {back > 0 && (
          <div
            className="text-[11px] font-semibold text-green-700 dark:text-green-400"
            style={{ fontVariantNumeric: 'tabular-nums' }}
          >
            +{formatMoney(back, currency)} back
          </div>
        )}
      </div>
    </button>
  );
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return `Today · ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `Yesterday · ${time}`;
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
