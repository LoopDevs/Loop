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
 * Opens a URL in an in-app WebView with optional JS injection.
 * Falls back to window.open on web.
 * Returns a controller object.
 */
export async function openWebView(
  options: WebViewOptions,
): Promise<{ close: () => Promise<void> }> {
  const { url, scripts = [], onMessage, onClose } = options;

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

  // Web fallback: open in new tab
  const win = window.open(url, '_blank');
  if (onClose) {
    // Poll to detect when the tab is closed
    const poll = setInterval(() => {
      if (win?.closed) {
        clearInterval(poll);
        onClose();
      }
    }, 1000);
  }

  return {
    close: async (): Promise<void> => {
      win?.close();
    },
  };
}
