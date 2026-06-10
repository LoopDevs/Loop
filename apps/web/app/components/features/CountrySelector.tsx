import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { COUNTRIES, foldForSearch } from '@loop/shared';
import {
  isLocalizablePath,
  localizedHref,
  setCountryCookie,
  stripLocale,
  useLocale,
} from '~/i18n/locale';

/**
 * Country picker (ADR 034 §4). Replaces the four-region selector (ADR 033). With
 * ~23 routable countries the navbar dropdown becomes a centered modal: a search
 * field + flagged list (type "ger" → Germany). Selecting a country navigates to
 * the **same page** under the new locale (so the choice is a real, shareable
 * URL) and saves a cookie so a bare `/` redirect remembers it. When the current
 * page has no localized mount (an app/admin route), it lands on the locale home.
 */
export function CountrySelector(): React.JSX.Element {
  const locale = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const current = useMemo(
    () => COUNTRIES.find((c) => c.code.toLowerCase() === locale.country) ?? COUNTRIES[0]!,
    [locale.country],
  );

  useEffect(() => {
    if (!open) return undefined;
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const folded = foldForSearch(query);
  const matches = useMemo(
    () =>
      folded.length === 0
        ? COUNTRIES
        : COUNTRIES.filter(
            (c) => foldForSearch(c.label).includes(folded) || c.code.toLowerCase().includes(folded),
          ),
    [folded],
  );

  const choose = (code: string): void => {
    const lower = code.toLowerCase();
    setCountryCookie(lower);
    const target = { country: lower, lang: locale.lang };
    const here = `${location.pathname}${location.search}`;
    // Stay on the same page when it has a localized mount; otherwise the path
    // would 404 under the prefix, so fall back to the locale home.
    const dest = isLocalizablePath(location.pathname)
      ? localizedHref(stripLocale(here), target)
      : localizedHref('/', target);
    setOpen(false);
    setQuery('');
    void navigate(dest);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Country: ${current.label}`}
        className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-gray-50"
      >
        <span aria-hidden className="text-base leading-none">
          {current.flag}
        </span>
        <span className="hidden sm:inline">{current.code}</span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="h-3 w-3 text-ink-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M3 4.5 6 7.5 9 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          role="presentation"
          onMouseDown={() => setOpen(false)}
          className="fixed inset-0 z-[1300] flex items-start justify-center bg-black/40 px-4 pt-[12vh]"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Choose your country"
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl"
          >
            <div className="border-b border-gray-100 p-3">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search countries"
                aria-label="Search countries"
                className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-ink outline-none focus:border-blue-500"
              />
            </div>
            <ul role="listbox" aria-label="Countries" className="max-h-[50vh] overflow-y-auto py-1">
              {matches.map((c) => {
                const selected = c.code.toLowerCase() === locale.country;
                return (
                  <li key={c.code}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => choose(c.code)}
                      className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors hover:bg-gray-50 ${
                        selected ? 'font-semibold text-blue-600' : 'text-ink'
                      }`}
                    >
                      <span aria-hidden className="text-base leading-none">
                        {c.flag}
                      </span>
                      <span className="flex-1">{c.label}</span>
                      <span className="text-xs text-ink-muted">{c.currency}</span>
                    </button>
                  </li>
                );
              })}
              {matches.length === 0 ? (
                <li className="px-4 py-3 text-sm text-ink-muted">No countries match "{query}".</li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}
