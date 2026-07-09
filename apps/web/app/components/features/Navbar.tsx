import { useState, useEffect, useRef, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router';
import { LocaleLink as Link } from '~/components/ui/LocaleLink';
import { useAllMerchants } from '~/hooks/use-merchants';
import {
  brandSlug,
  foldForSearch,
  groupMerchants,
  merchantInCountry,
  merchantSlug,
} from '@loop/shared';
import { useAuthStore } from '~/stores/auth.store';
import { useLocale, useLocalizedNavigate } from '~/i18n/locale';
import { useAuth } from '~/hooks/use-auth';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { useAppConfig } from '~/hooks/use-app-config';
import { getImageProxyUrl } from '~/utils/image';
import { Avatar } from '~/components/ui/Avatar';
import { LoopLogo } from '~/components/ui/LoopLogo';
import { CountrySelector } from '~/components/features/CountrySelector';

interface NavbarProps {
  // extensible for future props
}

interface SearchResult {
  id: string;
  name: string;
  logoUrl?: string | undefined;
  savingsPercentage?: number | undefined;
  /** Precomputed navigation target — `/gift-card/:slug` or, for a brand group, `/brand/:slug`. */
  to: string;
  /** For a brand group (ADR 032): number of variants. Shown instead of a savings %. */
  optionCount?: number | undefined;
}

interface SearchDropdownProps {
  results: SearchResult[];
  selectedIndex: number;
  onSelect: (r: SearchResult) => void;
}

function SearchDropdown({
  results,
  selectedIndex,
  onSelect,
}: SearchDropdownProps): React.JSX.Element {
  return (
    <div
      role="listbox"
      id="search-listbox"
      className="absolute top-full left-0 right-0 mt-2 rounded-lg shadow-lg z-[999999] bg-surface border border-line overflow-hidden"
    >
      {results.map((r, i) => (
        <button
          key={r.id}
          // Matches `aria-activedescendant` on the combobox input so the
          // screen reader announces the focused option (audit A-013).
          id={`search-option-${i}`}
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          onClick={() => onSelect(r)}
          className={`w-full px-3 py-2.5 text-left flex items-center gap-3 cursor-pointer transition-colors hover:bg-gray-50 ${
            i === selectedIndex ? 'bg-gray-50' : ''
          }`}
        >
          {r.logoUrl !== undefined ? (
            <img
              src={getImageProxyUrl(r.logoUrl, 64)}
              alt={r.name}
              className="w-8 h-8 object-contain rounded-md border border-line bg-white"
            />
          ) : (
            <div className="w-8 h-8 bg-blue-600 text-white text-xs font-bold rounded-md flex items-center justify-center">
              {r.name.substring(0, 2).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <div className="font-medium text-ink truncate">{r.name}</div>
            {r.optionCount !== undefined ? (
              <div className="text-xs text-ink-muted font-medium tabular">
                {r.optionCount} options
              </div>
            ) : (
              r.savingsPercentage !== undefined &&
              r.savingsPercentage > 0 && (
                <div className="text-xs text-green-600 font-medium tabular">
                  {r.savingsPercentage.toFixed(1)}% off
                </div>
              )
            )}
          </div>
        </button>
      ))}
    </div>
  );
}

interface SearchBarProps {
  placeholder?: string;
  onSelect: (r: SearchResult) => void;
}

const SearchBar = forwardRef<HTMLInputElement, SearchBarProps>(({ onSelect }, ref) => {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  // Portalled overlay is client-only; gate on a mount flag so SSR and
  // the first client render agree (both render no portal).
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const { merchants } = useAllMerchants();
  const { country } = useLocale();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Shared foldForSearch keeps navbar filtering in step with the
  // backend /api/merchants?q= behaviour (accent-insensitive).
  const foldedQuery = foldForSearch(debouncedQuery);
  // ADR 032: group "Brand - Variant" matches so a search for "dots" returns
  // one "dots.eco" entry (→ the brand view) rather than 14 rows. Grouping the
  // filtered set keeps a brand whose variant matches; slice(0,6) caps brands.
  // Search spans every country; the active country ranks first (ADR 034) — a UK
  // visitor searching "amazon" sees the UK entry before the US one. Stable sort
  // preserves the existing order within each tier.
  const results: SearchResult[] =
    debouncedQuery.length > 1
      ? groupMerchants(
          merchants
            .filter((m) => foldForSearch(m.name).includes(foldedQuery))
            .sort((a, b) => {
              const ra = merchantInCountry(a, country) ? 1 : 0;
              const rb = merchantInCountry(b, country) ? 1 : 0;
              return rb - ra;
            }),
        )
          .slice(0, 6)
          .map((g): SearchResult => {
            if (g.isGroup) {
              return {
                id: `g:${g.key}`,
                name: g.name,
                logoUrl: g.members.find((m) => m.logoUrl !== undefined)?.logoUrl,
                to: `/brand/${brandSlug(g.name)}`,
                optionCount: g.members.length,
              };
            }
            const m = g.members[0]!;
            return {
              id: m.id,
              name: m.name,
              logoUrl: m.logoUrl,
              savingsPercentage: m.savingsPercentage,
              to: `/gift-card/${merchantSlug(m)}`,
            };
          })
      : [];

  return (
    <>
      {/* Dim backdrop behind the dropdown, portalled to body so the
          navbar's stacking context doesn't trap it. */}
      {mounted &&
        createPortal(
          <div
            className={`fixed inset-0 bg-ink/20 z-[1050] pointer-events-none transition-opacity duration-200 ${open && results.length > 0 ? 'opacity-100' : 'opacity-0'}`}
            aria-hidden="true"
          />,
          document.body,
        )}
      <div
        className="relative"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-haspopup="listbox"
        aria-owns="search-listbox"
        aria-controls="search-listbox"
      >
        <div className="relative">
          <input
            ref={ref}
            type="text"
            value={query}
            placeholder="Search brands"
            aria-autocomplete="list"
            aria-controls="search-listbox"
            aria-activedescendant={
              selectedIndex >= 0 ? `search-option-${selectedIndex}` : undefined
            }
            className="w-full pl-9 pr-3 py-2 text-sm rounded-md border border-line bg-gray-50 text-ink placeholder:text-ink-subtle transition-[border-color,box-shadow,background-color] duration-150 focus:outline-none focus:bg-white focus:border-blue-500 focus:ring-4 focus:ring-blue-500/12"
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setSelectedIndex(-1);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 200)}
            onKeyDown={(e) => {
              if (!open || results.length === 0) return;
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setSelectedIndex((i) => Math.min(i + 1, results.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setSelectedIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === 'Enter' && selectedIndex >= 0) {
                e.preventDefault();
                const r = results[selectedIndex];
                if (r !== undefined) {
                  onSelect(r);
                  setQuery('');
                  setOpen(false);
                }
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
          />
          <svg
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-subtle"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            viewBox="0 0 24 24"
          >
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.35-4.35" />
          </svg>
        </div>
        {open && results.length > 0 && (
          <SearchDropdown
            results={results}
            selectedIndex={selectedIndex}
            onSelect={(r) => {
              onSelect(r);
              setQuery('');
              setOpen(false);
            }}
          />
        )}
      </div>
    </>
  );
});

SearchBar.displayName = 'SearchBar';

/**
 * Signed-in account control: avatar button → dropdown menu. Closes on
 * outside-click, Escape, or route change.
 */
function AccountMenu({ showCashbackNav }: { showCashbackNav: boolean }): React.JSX.Element {
  const email = useAuthStore((s) => s.email);
  const { logout } = useAuth();
  const navigate = useLocalizedNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside-click + Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent): void => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Close on navigation.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  const items: Array<{ to: string; label: string }> = [
    { to: '/orders', label: 'Orders' },
    ...(showCashbackNav
      ? [
          { to: '/settings/cashback', label: 'Cashback' },
          { to: '/settings/wallet', label: 'Wallet' },
        ]
      : []),
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center rounded-full transition-shadow focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 focus-visible:ring-offset-2"
      >
        <Avatar name={email} size="md" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-2 w-60 rounded-lg bg-surface border border-line shadow-lg overflow-hidden z-[999999]"
        >
          <div className="px-4 py-3 border-b border-line">
            <p className="text-xs text-ink-subtle">Signed in as</p>
            <p className="text-sm font-medium text-ink truncate">{email ?? 'Your account'}</p>
          </div>
          <div className="py-1">
            {items.map((it) => (
              <Link
                key={it.to}
                to={it.to}
                role="menuitem"
                className="block px-4 py-2 text-sm text-ink-muted hover:bg-gray-50 hover:text-ink transition-colors"
              >
                {it.label}
              </Link>
            ))}
          </div>
          <div className="py-1 border-t border-line">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                void (async () => {
                  await logout();
                  void navigate('/');
                })();
              }}
              className="block w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 transition-colors"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function Navbar(_props: NavbarProps = {}): React.JSX.Element {
  const location = useLocation();
  const navigate = useLocalizedNavigate();
  const { isNative } = useNativePlatform();
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);
  const { config } = useAppConfig();
  // Tranche 1 (MVP): hide cashback nav links until v1.1.
  const showCashbackNav = !config.phase1Only;

  const handleSelect = (r: SearchResult): void => {
    void navigate(r.to);
  };

  // Prefix-match for everything except "/".
  const isPathActive = (path: string): boolean => {
    if (path === '/') return location.pathname === '/';
    return location.pathname === path || location.pathname.startsWith(`${path}/`);
  };

  const navLinkClass = (path: string): string =>
    `transition-colors text-sm font-medium px-3 py-2 rounded-md ${
      isPathActive(path) ? 'text-ink bg-gray-100' : 'text-ink-muted hover:text-ink hover:bg-gray-50'
    }`;

  return (
    <nav
      data-nav="top"
      className="fixed top-0 left-0 right-0 z-[1100] bg-white border-b border-line"
      style={{
        // calc(100vw - 100%) = scrollbar width; keeps nav content aligned
        // with page content whether or not a scrollbar is present.
        paddingLeft: 'calc(100vw - 100%)',
        paddingTop: 'calc(var(--safe-top) - 0.75rem)',
        minWidth: '320px',
      }}
    >
      {/* A11Y-010 / CF-35: skip-to-content link — the first focusable element
          in the shared chrome so keyboard/SR users can jump past the logo,
          search combobox, nav links, country selector, and account menu
          straight to the route's <main id="main"> landmark. Visually hidden
          until focused. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-2 focus:z-[1200] focus:rounded-md focus:bg-blue-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to main content
      </a>
      <div className="container mx-auto px-4">
        <div className="flex items-center gap-3 py-3 sm:py-4">
          {/* Logo — web only (native shows the launcher mark). */}
          {!isNative && (
            <Link to="/" className="flex items-center flex-shrink-0 pr-1 text-ink">
              <LoopLogo className="h-6 md:h-7 w-auto mt-0.5" />
            </Link>
          )}

          {/* Search — grows on mobile, fixed beside the logo on desktop. */}
          <div className="flex-1 md:flex-none md:w-[22rem]">
            <SearchBar onSelect={handleSelect} />
          </div>

          {/* Desktop nav links. */}
          <div className="hidden md:flex items-center gap-0.5 ml-2">
            <Link to="/" className={navLinkClass('/')}>
              Directory
            </Link>
            <Link to="/map" className={navLinkClass('/map')}>
              Map
            </Link>
            {showCashbackNav && (
              <Link to="/cashback" className={navLinkClass('/cashback')}>
                Rates
              </Link>
            )}
            {isAuthenticated && (
              <Link to="/orders" className={navLinkClass('/orders')}>
                Orders
              </Link>
            )}
          </div>

          {/* Account area — pushed to the right edge. */}
          <div className="flex items-center gap-2 ml-auto">
            <CountrySelector />
            {isAuthenticated ? (
              <AccountMenu showCashbackNav={showCashbackNav} />
            ) : isNative ? null : (
              <>
                <Link
                  to="/auth"
                  className="hidden sm:inline-flex items-center text-sm font-medium px-3 py-2 rounded-md text-ink-muted hover:text-ink hover:bg-gray-50 transition-colors"
                >
                  Log in
                </Link>
                <Link
                  to="/onboarding"
                  className="inline-flex items-center text-sm font-semibold px-3.5 py-2 rounded-md bg-blue-600 text-white shadow-xs hover:bg-blue-700 active:bg-blue-800 transition-colors"
                >
                  Sign up
                </Link>
              </>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}
