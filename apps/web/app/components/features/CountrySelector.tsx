import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { COUNTRIES, foldForSearch } from '@loop/shared';
import {
  isLocalizablePath,
  localizedHref,
  setCountryCookie,
  stripLocale,
  useLocale,
} from '~/i18n/locale';
import { useFocusTrap } from '~/hooks/use-focus-trap';

/**
 * Country picker (ADR 034 §4). Replaces the four-region selector (ADR 033). With
 * ~23 routable countries the navbar dropdown becomes a centered modal: a search
 * field + flagged list (type "ger" → Germany). Selecting a country navigates to
 * the **same page** under the new locale (so the choice is a real, shareable
 * URL) and saves a cookie so a bare `/` redirect remembers it. When the current
 * page has no localized mount (an app/admin route), it lands on the locale home.
 */
export function CountrySelector(): React.JSX.Element {
  const { t } = useTranslation('navbar');
  const locale = useLocale();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  // A11Y-004: active-descendant index for keyboard listbox navigation. The
  // search input keeps DOM focus; arrow keys move this highlight, Enter
  // selects it, and `aria-activedescendant` tells the SR which option is
  // current without moving focus off the input.
  const [activeIndex, setActiveIndex] = useState(0);

  const current = useMemo(
    () => COUNTRIES.find((c) => c.code.toLowerCase() === locale.country) ?? COUNTRIES[0]!,
    [locale.country],
  );

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

  // A11Y-004: trap focus inside the modal, move focus to the search input on
  // open, restore it to the trigger on close, and close on Escape.
  useFocusTrap({
    active: open,
    containerRef: dialogRef,
    onClose: () => setOpen(false),
    initialFocusRef: inputRef,
  });

  // Reset the active option to the top whenever the query (and so the match
  // set) changes, and clamp it within bounds.
  useEffect(() => {
    setActiveIndex(0);
  }, [folded]);

  // Keep the highlighted option scrolled into view as the user arrows.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`#country-option-${activeIndex}`);
    // `scrollIntoView` is unimplemented in jsdom; guard so tests don't throw.
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, open]);

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
        aria-label={t('country.triggerLabel', { country: current.label })}
        className="flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-2.5 py-2 text-sm font-medium text-ink transition-colors hover:bg-gray-50"
      >
        <FlagIcon code={current.code} emoji={current.flag} />
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
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- ADR 042: onMouseDown here only stops propagation to the backdrop's close-on-outside-click handler above (standard modal pattern) — it offers no interaction of its own that needs a keyboard equivalent. Tracked: docs/readiness-backlog-2026-07-03.md B-2. */}
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={t('country.dialogLabel')}
            onMouseDown={(e) => e.stopPropagation()}
            className="w-full max-w-sm overflow-hidden rounded-xl bg-white shadow-2xl"
          >
            <div className="flex items-center gap-2 border-b border-gray-100 p-3">
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // A11Y-004: arrow-key listbox navigation driven from the
                  // search input via aria-activedescendant.
                  if (matches.length === 0) return;
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActiveIndex((i) => (i + 1) % matches.length);
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    setActiveIndex(0);
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    setActiveIndex(matches.length - 1);
                  } else if (e.key === 'Enter') {
                    e.preventDefault();
                    const c = matches[activeIndex];
                    if (c) choose(c.code);
                  }
                }}
                placeholder={t('country.search')}
                aria-label={t('country.search')}
                role="combobox"
                aria-expanded="true"
                aria-controls="country-listbox"
                aria-activedescendant={
                  matches.length > 0 ? `country-option-${activeIndex}` : undefined
                }
                className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm text-ink outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label={t('country.close')}
                className="shrink-0 rounded-md p-1.5 text-ink-muted hover:bg-gray-100"
              >
                <svg
                  aria-hidden
                  viewBox="0 0 16 16"
                  className="h-4 w-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.75"
                >
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            </div>
            <ul
              ref={listRef}
              id="country-listbox"
              role="listbox"
              aria-label={t('country.listLabel')}
              className="max-h-[50vh] overflow-y-auto py-1"
            >
              {matches.map((c, i) => {
                const selected = c.code.toLowerCase() === locale.country;
                const isActive = i === activeIndex;
                return (
                  <li key={c.code}>
                    <button
                      type="button"
                      id={`country-option-${i}`}
                      role="option"
                      aria-selected={selected}
                      tabIndex={-1}
                      onClick={() => choose(c.code)}
                      onMouseEnter={() => setActiveIndex(i)}
                      className={`flex w-full items-center gap-2.5 px-4 py-2.5 text-left text-sm transition-colors ${
                        isActive ? 'bg-gray-100' : 'hover:bg-gray-50'
                      } ${selected ? 'font-semibold text-blue-600' : 'text-ink'}`}
                    >
                      <FlagIcon code={c.code} emoji={c.flag} />
                      <span className="flex-1">{c.label}</span>
                      <span className="text-xs text-ink-muted">{c.currency}</span>
                    </button>
                  </li>
                );
              })}
              {matches.length === 0 ? (
                <li className="px-4 py-3 text-sm text-ink-muted">
                  {t('country.noResults', { query })}
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </>
  );
}

/**
 * Flat rectangular flag — a flag-icons 4x3 SVG bundled under `/public/flags`
 * (replaces the platform emoji flag, which renders as a wavy cloth flag). Falls
 * back to the emoji if the asset can't load. The `ring` keeps white-edged flags
 * legible on a white surface.
 */
function FlagIcon({ code, emoji }: { code: string; emoji: string }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span aria-hidden className="text-base leading-none">
        {emoji}
      </span>
    );
  }
  return (
    <img
      src={`/flags/${code.toLowerCase()}.svg`}
      alt=""
      aria-hidden
      width={20}
      height={15}
      onError={() => setFailed(true)}
      className="h-[15px] w-5 shrink-0 rounded-[2px] object-cover ring-1 ring-black/10"
    />
  );
}
