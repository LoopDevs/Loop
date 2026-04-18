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
function assertSafeUrl(url: string): void {
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
  assertSafeUrl(url);

  // Native: try @capgo/inappbrowser WebView
  if (Capacitor.isNativePlatform()) {
    try {
      const { InAppBrowser, ToolBarType } = await import('@capgo/inappbrowser');

      // Listen for messages from injected scripts
      if (onMessage) {
        await InAppBrowser.addListener('messageFromWebview', (event) => {
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

      // Inject scripts after page loads
      if (scripts.length > 0) {
        await InAppBrowser.addListener('browserPageLoaded', () => {
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
