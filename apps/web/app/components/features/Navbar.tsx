import { useRef, useState, useEffect, forwardRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { useMerchants } from '~/hooks/use-merchants';
import { toSlug } from '~/hooks/slug';
import { useUiStore } from '~/stores/ui.store';
import { getImageProxyUrl } from '~/utils/image';

interface NavbarProps {
  alwaysDark?: boolean;
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
      className="absolute top-full left-0 right-0 mt-1 bg-gray-950 border border-gray-800 rounded-lg shadow-lg max-h-64 overflow-y-auto z-[999999]"
    >
      {results.map((r, i) => (
        <button
          key={r.id}
          type="button"
          role="option"
          aria-selected={i === selectedIndex}
          onClick={() => onSelect(r)}
          className={`w-full px-4 py-3 text-left border-b border-gray-900 last:border-b-0 flex items-center gap-3 hover:bg-gray-900 cursor-pointer ${i === selectedIndex ? 'bg-gray-900' : ''}`}
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
            <div className="font-medium text-gray-100">{r.name}</div>
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
  const { merchants } = useMerchants({ limit: 1000 });

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const results: SearchResult[] =
    debouncedQuery.length > 1
      ? merchants
          .filter((m) => m.name.toLowerCase().includes(debouncedQuery.toLowerCase()))
          .slice(0, 8)
          .map((m) => ({
            id: m.id,
            name: m.name,
            logoUrl: m.logoUrl,
            savingsPercentage: m.savingsPercentage,
          }))
      : [];

  return (
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
          placeholder="Search for gift cards"
          aria-autocomplete="list"
          aria-controls="search-listbox"
          aria-activedescendant={selectedIndex >= 0 ? `search-option-${selectedIndex}` : undefined}
          className="w-full px-3 py-2 pl-8 text-sm bg-white/10 text-white placeholder-white/70 rounded-lg border border-white/20 focus:outline-none focus:ring-2 focus:ring-white/30"
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
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-white/70"
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
  );
});

SearchBar.displayName = 'SearchBar';

export function Navbar({ alwaysDark: _alwaysDark = false }: NavbarProps): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  const mobileSearchRef = useRef<HTMLInputElement>(null);
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const { theme, toggleTheme } = useUiStore();

  useEffect(() => {
    setShowMobileSearch(false);
  }, [location.pathname]);

  const handleSelect = (r: SearchResult): void => {
    void navigate(`/gift-card/${toSlug(r.name)}`);
    setShowMobileSearch(false);
  };

  const navLinkClass = (path: string): string =>
    `transition-colors text-sm px-3 py-2 rounded-lg hover:bg-white/10 ${location.pathname === path ? 'text-white' : 'text-white/60 hover:text-white/80'}`;

  return (
    <nav
      className="fixed top-0 left-0 right-0 z-[1100]"
      style={{
        backgroundColor: 'rgb(3 7 18 / 80%)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(255,255,255,0.1)',
      }}
    >
      <div className="container mx-auto">
        <div className="flex items-center justify-between px-4 sm:px-6 py-2 sm:py-3">
          <div className="flex items-center w-auto md:w-48">
            <Link to="/">
              <img src="/loop-logo.svg" alt="Loop" className="h-8 md:h-10" />
            </Link>
          </div>

          <div className="hidden md:block flex-1">
            <div className="max-w-md mx-auto">
              <SearchBar onSelect={handleSelect} />
            </div>
          </div>

          <div className="hidden md:flex items-center gap-1 w-48 justify-end">
            <Link to="/" className={navLinkClass('/')}>
              Directory
            </Link>
            <Link to="/map" className={navLinkClass('/map')}>
              Map
            </Link>
            <Link to="/orders" className={navLinkClass('/orders')}>
              Orders
            </Link>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
              className="p-2 rounded-lg hover:bg-white/10 text-white/70 hover:text-white transition-colors"
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>

          <div className="flex items-center gap-1 md:hidden">
            <Link
              to="/"
              className="transition-colors text-xs px-1.5 py-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white/80"
            >
              Directory
            </Link>
            <Link
              to="/map"
              className="transition-colors text-xs px-1.5 py-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white/80"
            >
              Map
            </Link>
            <Link
              to="/orders"
              className="transition-colors text-xs px-1.5 py-1 rounded-lg hover:bg-white/10 text-white/60 hover:text-white/80"
            >
              Orders
            </Link>
            <button
              type="button"
              onClick={() => {
                setShowMobileSearch((v) => !v);
                if (!showMobileSearch) setTimeout(() => mobileSearchRef.current?.focus(), 100);
              }}
              aria-label="Toggle search"
              className="text-white hover:text-gray-300 p-1.5 rounded-lg hover:bg-white/10"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.35-4.35" />
              </svg>
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="p-1.5 rounded-lg hover:bg-white/10 text-white/70 hover:text-white"
            >
              {theme === 'dark' ? '☀️' : '🌙'}
            </button>
          </div>
        </div>

        {showMobileSearch && (
          <div className="md:hidden px-4 sm:px-6 pb-2">
            <SearchBar ref={mobileSearchRef} onSelect={handleSelect} />
          </div>
        )}
      </div>
    </nav>
  );
}
