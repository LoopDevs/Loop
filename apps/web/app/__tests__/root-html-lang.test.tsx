// @vitest-environment jsdom
/**
 * FE-20 — the SSR document shell (`root.tsx#Layout`) must stamp `<html lang>`
 * from the negotiated ADR-034 route locale (`/:country/:lang`), not a hardcoded
 * `"en"`. The first server byte is what a crawler / screen reader reads, so a
 * `/de/de` visitor must not be told the page is English.
 *
 * We isolate `Layout`'s derivation: `useLocale()` is stubbed to a non-`en`
 * locale (today `SUPPORTED_LANGS === ['en']`, so the real URL→locale path can
 * never surface one — the gating is `useLocale`'s own concern, covered in
 * `i18n/__tests__/locale.test.ts`). The framework-only doc components
 * (`Meta`/`Links`/`Scripts`/`ScrollRestoration`) need a data-router context we
 * don't stand up here, so they're stubbed to nothing; and the merchant
 * cold-start prefetch in `root.tsx` module scope is stubbed so importing the
 * module never touches the network.
 *
 * Proven red: against the pre-fix `<html lang="en">` this asserts `lang="de"`
 * and fails.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as LocaleModule from '~/i18n/locale';
import type * as ReactRouter from 'react-router';

// ui.store (pulled in transitively by root.tsx) resolves the initial theme via
// window.matchMedia at module import time — jsdom doesn't implement it, so stub
// it before any import pulls the store in. Mirrors ToastContainer.test.tsx.
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

vi.mock('~/i18n/locale', async () => {
  const actual = await vi.importActual<typeof LocaleModule>('~/i18n/locale');
  return { ...actual, useLocale: () => ({ country: 'de', lang: 'de' }) };
});

vi.mock('~/services/merchants', () => ({
  fetchAllMerchants: vi.fn(async () => []),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof ReactRouter>('react-router');
  return {
    ...actual,
    Meta: () => null,
    Links: () => null,
    Scripts: () => null,
    ScrollRestoration: () => null,
  };
});

// Imported after the mocks so root.tsx binds the stubbed `useLocale`.
const { Layout } = await import('~/root');

describe('root Layout SSR <html lang> (FE-20)', () => {
  it('derives <html lang> from the negotiated locale, not a hardcoded en', () => {
    const html = renderToStaticMarkup(
      <Layout>
        <div id="child" />
      </Layout>,
    );
    expect(html).toContain('lang="de"');
    expect(html).not.toContain('lang="en"');
  });
});
