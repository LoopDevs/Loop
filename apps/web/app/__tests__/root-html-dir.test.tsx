// @vitest-environment jsdom
/**
 * FE-20-DIR — the SSR document shell (`root.tsx#Layout`) must stamp `<html dir>`
 * from the negotiated ADR-034 route locale, alongside `<html lang>` (see
 * `root-html-lang.test.tsx`). Before this, `dir` was only set by a client
 * effect, so an RTL locale's FIRST paint was LTR until hydration — text flowed
 * the wrong way on the initial server byte. Deriving `dir` in `Layout` (the
 * same place `lang` is derived) puts the correct direction in the first server
 * byte so an RTL page paints right-to-left immediately.
 *
 * `useLocale()` is stubbed to an RTL locale (`ar`) — today `SUPPORTED_LANGS`
 * is `['en']` so the real URL→locale path can never surface one, but the
 * derivation (`getLangDir`) is what we assert here; the routing gate is covered
 * in `i18n/__tests__/locale.test.ts`. Same framework/network stubs as the lang
 * test so importing `root.tsx` never needs a data-router or the network.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as LocaleModule from '~/i18n/locale';
import type * as ReactRouter from 'react-router';

// ui.store (pulled in transitively by root.tsx) resolves the initial theme via
// window.matchMedia at module import time — jsdom doesn't implement it, so stub
// it before any import pulls the store in. Mirrors root-html-lang.test.tsx.
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
  // A right-to-left language (Arabic). `getLangDir` stays the real
  // implementation so we exercise the actual ltr/rtl mapping.
  return { ...actual, useLocale: () => ({ country: 'eg', lang: 'ar' }) };
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

describe('root Layout SSR <html dir> (FE-20-DIR)', () => {
  it('derives dir="rtl" from an RTL locale on the first server byte', () => {
    const html = renderToStaticMarkup(
      <Layout>
        <div id="child" />
      </Layout>,
    );
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('lang="ar"');
  });
});
