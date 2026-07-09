import { Capacitor } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';

/**
 * Hosts Loop is willing to open the app for. Exact hostname match only —
 * no subdomain wildcard, no suffix match — so `evilloopfinance.io` or
 * `loopfinance.io.evil.com` never qualifies. Kept in sync with the
 * associated-domains / App Links hosts wired in
 * `apps/mobile/scripts/apply-native-overlays.sh` (M-3) and the
 * `.well-known/apple-app-site-association` / `assetlinks.json`
 * verification files served by the backend.
 */
const ALLOWED_DEEP_LINK_HOSTS = ['loopfinance.io', 'www.loopfinance.io', 'beta.loopfinance.io'];

/**
 * Resolves an incoming `appUrlOpen` URL (from a universal link / App
 * Link tap, or Apple Sign-In's HTTPS-callback bridge — CF-27 / C2-2) to
 * an in-app navigation target, or `null` if the URL should be ignored.
 *
 * Pure function — no Capacitor dependency — so it's unit-testable
 * without mocking the native layer. Exported separately from
 * `registerDeepLinks` for exactly that reason.
 *
 * SECURITY (non-negotiable): this is the only thing standing between an
 * arbitrary string handed to us by the OS (which in turn got it from
 * whatever app/website/QR code produced the link) and a `navigate()`
 * call inside the app.
 *
 * - Parse with `new URL()` — a malformed string (or a `javascript:`
 *   payload with no authority) throws and is rejected below, never
 *   passed through as a literal string.
 * - `protocol` MUST be exactly `https:` — rules out `javascript:`,
 *   `data:`, `file:`, and any custom scheme (`loopfinance://...`) some
 *   other app could register.
 * - `hostname` MUST be an exact match against `ALLOWED_DEEP_LINK_HOSTS`
 *   — rules out lookalike domains and open-redirect-style abuse via a
 *   trusted-looking query string on an untrusted host.
 * - The return value is `pathname + search + hash` ONLY — never the raw
 *   input string and never `origin` — so nothing derived from this
 *   function can smuggle a scheme/host change into `navigate()`. React
 *   Router's `navigate()` treats a path-only string as in-app by
 *   construction; there is no origin left to leak.
 */
export function resolveDeepLinkTarget(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_DEEP_LINK_HOSTS.includes(parsed.hostname)) return null;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/**
 * Registers the `appUrlOpen` listener (universal links / App Links,
 * M-3) and returns a disposer that removes it. Mirrors
 * `registerBackButton`'s dynamic-import + disposer shape exactly — see
 * that file's doc comment for why the disposer must be called on
 * unmount (stacked listeners on NativeShell re-mount).
 *
 * `onNavigate` receives the resolved in-app path (never the raw URL —
 * see `resolveDeepLinkTarget`). Untrusted / unresolvable URLs are
 * silently ignored: there is no user-visible error state for "the OS
 * handed us a link we don't recognise," it just doesn't navigate.
 */
export function registerDeepLinks(onNavigate: (path: string) => void): () => void {
  if (!Capacitor.isNativePlatform()) return () => {};

  let handle: PluginListenerHandle | null = null;
  let disposed = false;

  void (async () => {
    const { App } = await import('@capacitor/app');
    const listener = await App.addListener('appUrlOpen', ({ url }) => {
      const target = resolveDeepLinkTarget(url);
      if (target !== null) {
        onNavigate(target);
      }
    });
    if (disposed) {
      // Caller already disposed — tear down immediately so we don't
      // leak a listener past the component's lifetime.
      void listener.remove();
      return;
    }
    handle = listener;
  })();

  return () => {
    disposed = true;
    void handle?.remove();
  };
}
