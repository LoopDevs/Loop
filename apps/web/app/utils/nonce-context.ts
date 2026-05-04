/**
 * Per-request CSP nonce context (A4-057).
 *
 * The SSR entry (`entry.server.tsx`) generates a fresh random nonce
 * on every request and passes it through this context to `root.tsx`,
 * which threads it to every inline `<script>` (the theme-init guard,
 * `<Scripts />`, `<ScrollRestoration />`). The same nonce lands on
 * the HTTP `Content-Security-Policy` header as `'nonce-<value>'` on
 * `script-src`, replacing `'unsafe-inline'`.
 *
 * Mobile static export (Capacitor webview) doesn't go through SSR
 * and has no access to a per-request nonce — that path stays on the
 * meta-tag CSP that retains `'unsafe-inline'`. Defence in depth: the
 * web SSR path is now strict-CSP (only the nonced inline scripts
 * Loop ships are allowed); mobile is unchanged from the prior
 * posture.
 *
 * The default export is a React Context with `null` as its initial
 * value. `null` means "no SSR nonce" — components that consume the
 * nonce should fall through to no-nonce behaviour (matches the
 * mobile static-export path).
 */
import { createContext, useContext } from 'react';

export const NonceContext = createContext<string | null>(null);

/** Reads the active nonce. Returns null off the SSR path (mobile static). */
export function useNonce(): string | null {
  return useContext(NonceContext);
}
