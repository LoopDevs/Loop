import { Capacitor } from '@capacitor/core';

export interface WebViewOptions {
  url: string;
  /** JS to execute after page loads */
  scripts?: string[];
  /** Called when the WebView receives a postMessage */
  onMessage?: (data: unknown) => void;
  /** Called when the WebView is closed */
  onClose?: () => void;
}

/**
 * Rejects URL schemes that could execute script in the current page or read
 * local files. Only http(s) is acceptable for a remote redeem URL. If a
 * caller somehow ends up with an untrusted URL, this turns the symptom into
 * a failure instead of code execution.
 *
 * Production builds (`import.meta.env.PROD`) additionally reject plain
 * `http:` — audit A-009. Dev / test still accept http so the mocked
 * suites and local backends work.
 */
function assertSafeUrl(url: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`openWebView: invalid URL ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`openWebView: only http(s) URLs are allowed (got ${parsed.protocol})`);
  }
  // Reject URLs with embedded credentials — `https://user:pass@evil.com`
  // parses cleanly but is a classic phishing vector: the prefix lets the
  // attacker mask the true host in older WebView chrome, and CTX has no
  // legitimate reason to return a redeem URL with userinfo. Fail closed.
  if (parsed.username !== '' || parsed.password !== '') {
    throw new Error('openWebView: URLs with embedded credentials are not allowed');
  }
  const isProduction = typeof import.meta.env !== 'undefined' && import.meta.env.PROD === true;
  if (isProduction && parsed.protocol === 'http:') {
    throw new Error(
      `openWebView: http:// URLs are rejected in production (got ${url}). Redeem URLs must be https.`,
    );
  }
  return parsed;
}

/**
 * Scheme-gates a redeem URL before it is placed in an `<a href>`.
 *
 * Returns the URL unchanged if it clears the SAME allow-list as
 * `openWebView` (`assertSafeUrl`: http(s) only, no embedded
 * credentials, https-only in production), otherwise `null`.
 *
 * A `redeemUrl` is server/upstream-supplied. Dropped straight into an
 * anchor, a `javascript:` / `data:` value would execute script on
 * click — with app privileges inside the Capacitor native WebView.
 * Anchors that can't route through `openWebView` (they render as a
 * plain link the user taps) must gate the value here and fail closed:
 * a rejected URL yields `null`, and the caller renders no link at all.
 */
export function safeRedeemHref(url: string): string | null {
  try {
    assertSafeUrl(url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Scheme-gates a SEP-7 payment URI before it is placed in an `<a href>`.
 *
 * `paymentUri` is a server-supplied field on the create-order / order-read
 * API responses — Loop builds it via `buildSep7PayUri`, but it can also be
 * threaded straight through from CTX's upstream `paymentUrls` map. From the
 * client's side it is server/upstream-controlled and must not be trusted:
 * a `javascript:` / `data:` / `vbscript:` value dropped into an anchor
 * would execute on tap with app privileges inside the Capacitor native
 * WebView — the SAME XSS class `safeRedeemHref` closes for `redeemUrl`.
 *
 * A legitimate payment URI uses the SEP-7 `web+stellar:` / `stellar:`
 * scheme, which `safeRedeemHref` (http(s)-only, by design for redeem URLs)
 * deliberately rejects. So this gate allow-lists exactly those two schemes
 * — applying the same fail-closed embedded-credential guard as
 * `assertSafeUrl` — and defers every other scheme to `safeRedeemHref`,
 * reusing one sanitizer rather than forking a second. Anything outside the
 * allow-list yields `null`, and the caller renders no live link at all.
 */
export function safePaymentUriHref(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol === 'web+stellar:' || parsed.protocol === 'stellar:') {
    // Mirror assertSafeUrl's embedded-credential guard. A legitimate SEP-7
    // URI is opaque (`web+stellar:pay?...`) and carries none; the authority
    // form `web+stellar://user:pass@…` is a phishing shape we fail closed.
    if (parsed.username !== '' || parsed.password !== '') return null;
    return url;
  }
  // Not a SEP-7 scheme: fall back to the redeem-URL gate (http(s) only, no
  // embedded credentials, https-only in production). javascript: / data: /
  // vbscript: fail closed to null there.
  return safeRedeemHref(url);
}

function originOf(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Opens a URL in an in-app WebView with optional JS injection.
 * Falls back to window.open on web.
 * Returns a controller object.
 */
export async function openWebView(
  options: WebViewOptions,
): Promise<{ close: () => Promise<void> }> {
  const { url, scripts = [], onMessage, onClose } = options;
  const parsedUrl = assertSafeUrl(url);
  const allowedMessageOrigin = parsedUrl.origin;

  // Native: try @capgo/inappbrowser WebView
  if (Capacitor.isNativePlatform()) {
    try {
      const { InAppBrowser, ToolBarType } = await import('@capgo/inappbrowser');
      let currentOrigin: string | null = allowedMessageOrigin;

      // Track the WebView's current page origin across navigations. The
      // plugin's `messageFromWebview` / `browserPageLoaded` events carry no
      // browser-native MessageEvent.origin (R3-13), so this URL-change event
      // is our only origin source. BOTH the inbound message path and the
      // outbound script-injection path below gate on
      // `currentOrigin === allowedMessageOrigin`, so it must be kept fresh
      // whenever either path is active.
      if (onMessage || scripts.length > 0) {
        await InAppBrowser.addListener('urlChangeEvent', (event) => {
          currentOrigin = typeof event.url === 'string' ? originOf(event.url) : null;
        });
      }

      // Listen for messages from injected scripts. Only accept a message while
      // the WebView is still on the original redeem origin (R3-13).
      if (onMessage) {
        await InAppBrowser.addListener('messageFromWebview', (event) => {
          if (currentOrigin !== allowedMessageOrigin) return;
          // The plugin sends { detail, rawMessage } — try parsing detail or rawMessage
          const raw = event.detail ?? event.rawMessage;
          if (raw === undefined) return;
          try {
            const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
            onMessage(data);
          } catch {
            onMessage(raw);
          }
        });
      }

      // Listen for close
      if (onClose) {
        await InAppBrowser.addListener('closeEvent', () => {
          onClose();
        });
      }

      // Inject scripts after page loads — but ONLY while the WebView is still
      // on the intended redeem origin. If it has navigated away (merchant
      // redirect, an ad, an attacker-controlled page), `currentOrigin` drifts
      // and we must NOT inject: an injected script can carry a redeem
      // code/PIN and would leak it cross-origin (P2-04). Mirrors the inbound
      // `messageFromWebview` origin gate above exactly.
      if (scripts.length > 0) {
        await InAppBrowser.addListener('browserPageLoaded', () => {
          if (currentOrigin !== allowedMessageOrigin) return;
          for (const script of scripts) {
            void InAppBrowser.executeScript({ code: script });
          }
        });
      }

      // Open the WebView
      await InAppBrowser.openWebView({
        url,
        title: 'Redeem Gift Card',
        toolbarType: ToolBarType.NAVIGATION,
      });

      return {
        close: async (): Promise<void> => {
          await InAppBrowser.removeAllListeners();
          await InAppBrowser.close();
        },
      };
    } catch {
      // WebView plugin failed — fall through to web fallback
    }
  }

  // Web fallback: open in new tab. noopener,noreferrer blocks the classic
  // reverse-tabnabbing vector where the opened tab uses window.opener to
  // navigate our tab to a phishing URL.
  const win = window.open(url, '_blank', 'noopener,noreferrer');

  // A null return from window.open means a popup blocker intercepted us.
  // Previously we returned a no-op controller here and the caller's
  // "redeeming..." UI sat forever while nothing actually opened. Surface
  // the failure so callers can show a "please allow popups and retry"
  // affordance instead.
  if (win === null) {
    throw new Error('openWebView: popup blocked — allow popups for this site and retry');
  }

  // Track the poll so we can clear it when the controller's close() is called,
  // so the interval doesn't leak for the lifetime of the page.
  let poll: ReturnType<typeof setInterval> | null = null;
  if (onClose) {
    poll = setInterval(() => {
      if (win.closed) {
        if (poll !== null) clearInterval(poll);
        poll = null;
        onClose();
      }
    }, 1000);
  }

  return {
    close: async (): Promise<void> => {
      if (poll !== null) {
        clearInterval(poll);
        poll = null;
      }
      win.close();
    },
  };
}
