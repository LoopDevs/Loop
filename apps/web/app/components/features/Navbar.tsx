import { useState, useEffect, forwardRef } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation, useNavigate } from 'react-router';
import { useAllMerchants } from '~/hooks/use-merchants';
import { foldForSearch, merchantSlug } from '@loop/shared';
import { useUiStore } from '~/stores/ui.store';
import { useAuthStore } from '~/stores/auth.store';
import { useNativePlatform } from '~/hooks/use-native-platform';
import { getImageProxyUrl } from '~/utils/image';

interface NavbarProps {
  // extensible for future props
}

interface SearchResult {
  id: string;
  name: string;
  logoUrl?: string | undefined;
  savingsPercentage?: number | undefined;
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
      className="absolute top-full left-0 right-0 mt-1 rounded-lg shadow-lg z-[999999] bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800"
    >
      {results.map((r, i) => (
        <button
          key={r.id}
          // Matches the `aria-activedescendant="search-option-${i}"` on the
          // combobox input so the screen reader announces the focused
          // option (audit A-013). Without this id the ARIA pointer was
          // dangling and AT keyboard focus was broken.
          id={`search-option-${i}`}
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          onClick={() => onSelect(r)}
          className={`w-full px-4 py-3 text-left last:border-b-0 flex items-center gap-3 cursor-pointer border-b border-gray-100 dark:border-gray-900 hover:bg-gray-100 dark:hover:bg-gray-900 ${
            i === selectedIndex ? 'bg-gray-100 dark:bg-gray-900' : ''
          }`}
        >
          {r.logoUrl !== undefined ? (
            <img
              src={getImageProxyUrl(r.logoUrl, 64)}
              alt={r.name}
              className="w-8 h-8 object-contain rounded"
            />
          ) : (
            <div className="w-8 h-8 bg-blue-500 text-white text-xs font-bold rounded flex items-center justify-center">
              {r.name.substring(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <div className="font-medium text-gray-900 dark:text-gray-100">{r.name}</div>
            {r.savingsPercentage !== undefined && r.savingsPercentage > 0 && (
              <div className="text-xs text-green-400 font-medium">
                {r.savingsPercentage.toFixed(1)}% savings
              </div>
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
  // the first client render agree (both render no portal). The effect
  // flips it true after hydration completes — past that point React
  // has reconciled and we can safely render tree-external content.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  // Full catalog via /api/merchants/all (audit A-002). Paginated /api/merchants
  // silently truncated search to the first 100 merchants once the catalog grew
  // past that.
  const { merchants } = useAllMerchants();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Use the shared foldForSearch so navbar filtering matches backend
  // /api/merchants?q= behaviour — a query of "cafe" finds merchants
  // named "Café". Without this, users typing the un-accented form
  // missed the merchant in the client-side navbar search even though
  // the same query via the API would have found it.
  const foldedQuery = foldForSearch(debouncedQuery);
  const results: SearchResult[] =
    debouncedQuery.length > 1
      ? merchants
          .filter((m) => foldForSearch(m.name).includes(foldedQuery))
          .slice(0, 6)
          .map((m) => ({
            id: m.id,
            name: m.name,
            logoUrl: m.logoUrl,
            savingsPercentage: m.savingsPercentage,
          }))
      : [];

  return (
    <>
      {/* Dim backdrop behind the search dropdown. Portalled to
          document.body because the navbar creates its own stacking
          context (via its own z-index), which would otherwise trap
          the overlay inside the navbar's paint area. Always mounted
          so `transition-opacity` can animate in both directions —
          conditional-render would snap the fade-out. pointer-events
          stay off so the dim layer never swallows clicks. */}
      {mounted &&
        createPortal(
          <div
            className={`fixed inset-0 bg-black/40 z-[1050] pointer-events-none transition-opacity duration-200 ${open ? 'opacity-100' : 'opacity-0'}`}
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
      >
        <div className="relative">
          <input
            ref={ref}
            type="text"
            value={query}
            placeholder="Search"
            aria-autocomplete="list"
            aria-controls="search-listbox"
            aria-activedescendant={
              selectedIndex >= 0 ? `search-option-${selectedIndex}` : undefined
            }
            className="w-full px-3 py-1.5 pl-8 text-sm rounded-lg border focus:outline-none focus:ring-2 bg-black/5 dark:bg-black/30 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-white/70 border-black/10 dark:border-white/20 focus:ring-gray-950/30 dark:focus:ring-white/60"
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
            className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 dark:text-white/70"
            fill="none"
            stroke="currentColor"
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

export function Navbar(_props: NavbarProps = {}): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const { toggleTheme } = useUiStore();
  const { isNative } = useNativePlatform();
  const isAuthenticated = useAuthStore((s) => s.accessToken !== null);

  const handleSelect = (r: SearchResult): void => {
    void navigate(`/gift-card/${merchantSlug(r.name)}`);
  };

  const navLinkClass = (path: string): string =>
    `transition-colors text-sm px-3 py-2 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 ${
      location.pathname === path
        ? 'text-gray-950 dark:text-white'
        : 'text-gray-600 hover:text-gray-900 dark:text-white/60 dark:hover:text-white/80'
    }`;

  return (
    <nav
      data-nav="top"
      // Theme-aware backdrop: translucent white in light theme,
      // translucent ink in dark. `backdrop-blur` keeps the frosted
      // effect in both. Border follows the theme on its alpha side.
      className="fixed top-0 left-0 right-0 z-[1100] bg-white/70 dark:bg-gray-950/50 backdrop-blur-md border-b border-black/10 dark:border-white/10"
      style={{
        // calc(100vw - 100%) evaluates to the vertical scrollbar's
        // width (0 when absent). Adding it as left padding nudges the
        // nav's inner container right by exactly that amount, so the
        // logo / links stay horizontally aligned with the page content
        // whether or not a scrollbar is present — no layout shift
        // when short vs long pages are compared side-by-side.
        paddingLeft: 'calc(100vw - 100%)',
        // Push content into the status-bar area slightly — at
        // `var(--safe-top)` the search input ends up ~40px from the
        // viewport top, which reads as "too much space" on narrow
        // phones. Subtracting 0.75rem pulls it up into the lower
        // portion of the status bar so the input visually sits
        // alongside the clock / battery rather than below them. On
        // web env() is 0 so this becomes slightly negative / clamped
        // to 0 by the browser — no visible effect.
        paddingTop: 'calc(var(--safe-top) - 0.75rem)',
        minWidth: '320px',
      }}
    >
      <div className="container mx-auto">
        <div className="flex items-center gap-4 px-4 sm:px-6 py-1.5 sm:py-3">
          {/* Logo — web only. Native users already see the Loop mark on
              their launcher icon / splash so we don't want to retread
              the brand inside the app chrome. */}
          {!isNative && (
            <div className="flex items-center flex-shrink-0 pr-2">
              <Link to="/">
                {/* Both logos shipped; Tailwind's dark: variant hides
                    the wrong one so SSR/hydration match (inline theme
                    script sets html.dark before React paints). */}
                <img src="/loop-logo.svg" alt="Loop" className="h-6 md:h-7 mt-1.5 dark:hidden" />
                <img
                  src="/loop-logo-white.svg"
                  alt="Loop"
                  className="h-6 md:h-7 mt-1.5 hidden dark:block"
                />
              </Link>
            </div>
          )}

          {/* SearchBar — fills remaining width on mobile, fixed-size
              sitting right next to the logo on desktop. Previously it
              was centred via `flex-1 + max-w-md mx-auto`, which left a
              lot of empty space between the logo and the search. */}
          <div className="flex-1 md:flex-none md:w-[28rem]">
            <SearchBar onSelect={handleSelect} />
          </div>

          {/* Mobile-only Sign up pill — entry point into the
              six-screen onboarding flow at `/onboarding`. Hidden on
              desktop (the desktop nav doesn't need a standalone CTA,
              and we gate this on unauthed so returning users don't
              see the prompt). */}
          {!isAuthenticated && !isNative && (
            <Link
              to="/onboarding"
              className="md:hidden flex-shrink-0 text-sm font-semibold px-3.5 py-1.5 rounded-full transition-colors bg-gray-950 text-white hover:bg-gray-800 dark:bg-white dark:text-gray-950 dark:hover:bg-white/90"
            >
              Sign up
            </Link>
          )}

          {/* Desktop nav links + theme toggle — pushed to the right
              edge via `ml-auto` now that the search is left-anchored. */}
          <div className="hidden md:flex items-center gap-1 ml-auto">
            <Link to="/" className={navLinkClass('/')}>
              Directory
            </Link>
            <Link to="/map" className={navLinkClass('/map')}>
              Map
            </Link>
            <Link to="/orders" className={navLinkClass('/orders')}>
              Orders
            </Link>
            {isAuthenticated ? (
              <Link to="/settings/cashback" className={navLinkClass('/settings/cashback')}>
                Cashback
              </Link>
            ) : null}
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="p-2 rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/10 text-gray-600 hover:text-gray-900 dark:text-white/70 dark:hover:text-white"
            >
              <ThemeIcons />
            </button>
          </div>
        </div>
      </div>
    </nav>
  );
}

/**
 * Render both sun + moon icons and let CSS hide the wrong one via the
 * `dark:` variant. The `html.dark` class is set synchronously by the
 * inline theme script in `root.tsx` before React hydrates, so the
 * server-rendered DOM and the client DOM are identical at hydration
 * time — no mismatch warning. Previously the JS-gated conditional
 * (`theme === 'dark' ? Sun : Moon`) produced different DOM between
 * SSR (store default) and client (localStorage-restored theme).
 */
function ThemeIcons(): React.JSX.Element {
  return (
    <>
      {/* Moon — shown in light mode (so the user can see "tap to go dark"). */}
      <svg
        className="w-5 h-5 dark:hidden"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z"
        />
      </svg>
      {/* Sun — shown in dark mode. */}
      <svg
        className="w-5 h-5 hidden dark:block"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        strokeWidth={1.5}
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z"
        />
      </svg>
    </>
  );
}
