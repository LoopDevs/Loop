// @vitest-environment jsdom
/**
 * FE-08 — the SSR document shell (`root.tsx#Layout`) emits the
 * `<meta http-equiv="Content-Security-Policy">`. On the SSR web path a
 * per-request nonce exists (minted in `entry.server.tsx`, threaded via
 * `NonceContext`), and the HTTP CSP header is nonce-strict. The meta CSP
 * must AGREE with that header: its `script-src` must carry
 * `'nonce-<value>'` and must NOT advertise `'unsafe-inline'`. Before the
 * fix the meta was built without the nonce, so `script-src` still listed
 * `'unsafe-inline'` — masked today only by the browser's header∩meta
 * intersection, but a latent inline-script XSS weakening if the header is
 * ever dropped.
 *
 * The mobile static export (Capacitor webview, `ssr: false`) has no SSR
 * round-trip and thus no nonce: there `useNonce()` returns null and the
 * meta CSP is the ONLY policy, so it must stay on `'unsafe-inline'` — that
 * path is deliberately preserved (there is no per-request nonce mechanism
 * to switch to).
 *
 * Same isolation approach as `root-html-lang.test.tsx`: `useLocale`,
 * `fetchAllMerchants`, and the framework-only doc components
 * (`Meta`/`Links`/`Scripts`/`ScrollRestoration`) are stubbed; the CSP meta
 * and the inline theme-init `<script>` are Layout's own output and render
 * for real.
 *
 * Proven red: against the pre-fix meta (built without the nonce) the
 * script-src carries `'unsafe-inline'` and no nonce, so both the
 * nonce-present assertions fail.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type * as LocaleModule from '~/i18n/locale';
import type * as ReactRouter from 'react-router';
import { NonceContext } from '~/utils/nonce-context';

// ui.store (pulled in transitively by root.tsx) resolves the initial theme
// via window.matchMedia at module import time — jsdom doesn't implement it,
// so stub it before any import pulls the store in. Mirrors
// root-html-lang.test.tsx / ToastContainer.test.tsx.
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
  return { ...actual, useLocale: () => ({ country: 'us', lang: 'en' }) };
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

// Imported after the mocks so root.tsx binds the stubbed modules.
const { Layout } = await import('~/root');

const TEST_NONCE = 'TESTNONCE123';

/**
 * Renders Layout under a given NonceContext value and returns the decoded
 * `script-src` directive from the emitted meta CSP. Parsing via the DOM
 * (jsdom) rather than string-matching the raw markup means we assert on the
 * decoded attribute value — robust to React's HTML-entity escaping of the
 * single quotes in the CSP.
 */
function renderScriptSrc(nonce: string | null): {
  metaContent: string;
  scriptSrc: string;
  html: string;
} {
  const html = renderToStaticMarkup(
    <NonceContext value={nonce}>
      <Layout>
        <div id="child" />
      </Layout>
    </NonceContext>,
  );
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = doc.querySelector('meta[http-equiv="Content-Security-Policy"]');
  expect(meta, 'meta CSP tag must be present').not.toBeNull();
  const metaContent = meta?.getAttribute('content') ?? '';
  const scriptSrc =
    metaContent
      .split(';')
      .map((d) => d.trim())
      .find((d) => d.startsWith('script-src')) ?? '';
  expect(scriptSrc, 'meta CSP must contain a script-src directive').not.toBe('');
  return { metaContent, scriptSrc, html };
}

describe('root Layout SSR meta CSP nonce (FE-08)', () => {
  it('SSR web path: meta script-src carries the nonce and drops unsafe-inline', () => {
    const { scriptSrc, html } = renderScriptSrc(TEST_NONCE);
    // Agrees with the strict HTTP CSP header from the same builder.
    expect(scriptSrc).toContain(`'nonce-${TEST_NONCE}'`);
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    // Watch item (coordinator): the inline theme-init <script> must itself
    // carry the nonce, else the now-tightened meta would block it.
    expect(html).toContain(`nonce="${TEST_NONCE}"`);
  });

  it('mobile static path (nonce === null): meta script-src keeps unsafe-inline, no nonce', () => {
    const { scriptSrc } = renderScriptSrc(null);
    // No per-request nonce mechanism in the Capacitor webview — the meta
    // is the only CSP there and must stay on unsafe-inline (unchanged).
    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain('nonce-');
  });

  it('style-src still allows unsafe-inline on both paths (Tailwind inlines styles)', () => {
    // Guards against a lazy "meta has no unsafe-inline anywhere" fix that
    // would break Tailwind's build-time inline styles.
    for (const nonce of [TEST_NONCE, null]) {
      const { metaContent } = renderScriptSrc(nonce);
      const styleSrc = metaContent
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith('style-src'));
      expect(styleSrc).toContain("'unsafe-inline'");
    }
  });
});
