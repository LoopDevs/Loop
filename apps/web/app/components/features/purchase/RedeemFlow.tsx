import { useState, useEffect, useRef } from 'react';
import { usePurchaseStore } from '~/stores/purchase.store';
import { Button } from '~/components/ui/Button';
import { copyToClipboard } from '~/native/clipboard';
import { triggerHaptic, triggerHapticNotification } from '~/native/haptics';
import { openWebView } from '~/native/webview';
import { Input } from '~/components/ui/Input';
import { buildChallengeBarScript } from '~/utils/redeem-challenge-bar';

interface RedeemFlowProps {
  merchantName: string;
  redeemUrl: string;
  challengeCode: string;
  scripts: { injectChallenge?: string; scrapeResult?: string } | null;
}

const REDEEM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Handles URL-based gift card redemption.
 * Opens a WebView with the redeem URL, optionally injects scripts,
 * and captures the gift card code via postMessage or manual entry.
 */
export function RedeemFlow({
  merchantName,
  redeemUrl,
  challengeCode,
  scripts,
}: RedeemFlowProps): React.JSX.Element {
  const store = usePurchaseStore();
  const [copied, setCopied] = useState(false);
  const [webViewOpen, setWebViewOpen] = useState(false);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [manualCode, setManualCode] = useState('');
  const [manualPin, setManualPin] = useState('');
  const webViewRef = useRef<{ close: () => Promise<void> } | null>(null);
  const receivedCodeRef = useRef(false);

  const handleCopy = async (): Promise<void> => {
    const ok = await copyToClipboard(challengeCode);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleOpenWebView = async (): Promise<void> => {
    void triggerHaptic();
    // Audit A-019: `openWebView` rejects when popup-blockers (web) or the
    // Capacitor Browser plugin (native) refuse to open. We used to fire
    // this as `void handleOpenWebView()` and swallow the rejection, which
    // left the user stuck on "Opening..." forever and produced an
    // unhandled promise rejection in Sentry. Now we reset `webViewOpen`,
    // surface the error in a dedicated banner, and offer the manual-entry
    // path as a fallback — so a pop-up-blocked state is recoverable
    // without a reload.
    setOpenError(null);

    // Build scripts to inject. Order matters:
    //   1. Challenge-code banner — a small top-docked bar showing the
    //      code + a Copy button, so the user doesn't have to flip
    //      back to our app to grab it. First so it's the one
    //      visible chrome change before any merchant script runs.
    //   2. Provider-supplied injectChallenge (auto-fill if possible).
    //   3. Provider-supplied scrapeResult (capture code + postMessage).
    const injectScripts: string[] = [buildChallengeBarScript(challengeCode)];
    if (scripts?.injectChallenge) {
      injectScripts.push(scripts.injectChallenge);
    }
    if (scripts?.scrapeResult) {
      injectScripts.push(scripts.scrapeResult);
    }

    setWebViewOpen(true);

    try {
      const controller = await openWebView({
        url: redeemUrl,
        scripts: injectScripts,
        onMessage: (data) => {
          // Check for gift card result from scrapeResult script
          if (
            data !== null &&
            typeof data === 'object' &&
            'type' in data &&
            (data as Record<string, unknown>).type === 'loop:giftcard'
          ) {
            const result = data as { code?: string; pin?: string };
            if (result.code) {
              receivedCodeRef.current = true;
              void triggerHapticNotification('success');
              store.setComplete(result.code, result.pin);
              void controller.close();
            }
          }
        },
        onClose: () => {
          setWebViewOpen(false);
          // If we didn't get the code via script, prompt for manual entry
          if (!receivedCodeRef.current) {
            setShowManualEntry(true);
          }
        },
      });

      webViewRef.current = controller;
    } catch (err) {
      setWebViewOpen(false);
      const message =
        err instanceof Error && err.message
          ? err.message
          : 'We could not open the redemption page.';
      setOpenError(
        `${message} If your browser blocked a pop-up, allow pop-ups for this site and try again, or enter the code manually below.`,
      );
      void triggerHapticNotification('error');
    }
  };

  // Timeout: if WebView is open too long, close and show manual entry
  useEffect(() => {
    if (!webViewOpen) return;
    const timer = setTimeout(() => {
      void webViewRef.current?.close();
    }, REDEEM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [webViewOpen]);

  const handleManualSubmit = (): void => {
    if (manualCode.trim()) {
      void triggerHapticNotification('success');
      store.setComplete(manualCode.trim(), manualPin.trim() || undefined);
    }
  };

  // Manual entry form (shown after WebView closes without auto-capture)
  if (showManualEntry) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-6">
        <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
          Enter gift card details
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
          Enter the gift card code you received from the provider.
        </p>
        <div className="space-y-3 mb-4">
          <Input
            label="Gift card code"
            value={manualCode}
            onChange={setManualCode}
            placeholder="Enter code"
            required
          />
          <Input
            label="PIN (if any)"
            value={manualPin}
            onChange={setManualPin}
            placeholder="Optional"
          />
        </div>
        <div className="flex gap-3">
          <Button
            variant="secondary"
            className="flex-1"
            onClick={() => {
              void handleOpenWebView();
              setShowManualEntry(false);
            }}
          >
            Reopen page
          </Button>
          <Button className="flex-1" onClick={handleManualSubmit} disabled={!manualCode.trim()}>
            Save
          </Button>
        </div>
      </div>
    );
  }

  // Initial state: show challenge code + open WebView button
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-6">
      <h2 className="text-lg font-bold text-gray-900 dark:text-white mb-2">
        Redeem your gift card
      </h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {scripts?.injectChallenge
          ? `Open the redemption page to claim your ${merchantName} gift card.`
          : `Copy the challenge code below, then enter it on the redemption page.`}
      </p>

      {/* Challenge code display */}
      <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4 text-center mb-4">
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1">Challenge code</p>
        <p className="font-mono text-xl font-bold text-gray-900 dark:text-white tracking-widest">
          {challengeCode}
        </p>
        <button
          type="button"
          onClick={() => {
            void handleCopy();
          }}
          className="text-xs text-blue-600 dark:text-blue-400 mt-2 min-h-[44px] px-4"
        >
          {copied ? 'Copied!' : 'Copy code'}
        </button>
      </div>

      {openError !== null && (
        <div
          className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-3 text-sm text-red-700 dark:text-red-300"
          role="alert"
        >
          {openError}
        </div>
      )}

      <Button
        className="w-full"
        onClick={() => {
          void handleOpenWebView();
        }}
        disabled={webViewOpen}
      >
        {webViewOpen ? 'Opening...' : 'Open redemption page'}
      </Button>

      {openError !== null && (
        <button
          type="button"
          onClick={() => setShowManualEntry(true)}
          className="w-full text-sm text-blue-600 dark:text-blue-400 mt-3 underline min-h-[44px]"
        >
          Enter code manually instead
        </button>
      )}
    </div>
  );
}
