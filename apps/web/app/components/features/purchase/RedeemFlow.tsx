import { useState, useEffect, useRef } from 'react';
import { usePurchaseStore } from '~/stores/purchase.store';
import { Button } from '~/components/ui/Button';
import { copyToClipboard } from '~/native/clipboard';
import { triggerHaptic, triggerHapticNotification } from '~/native/haptics';
import { openWebView } from '~/native/webview';
import { Input } from '~/components/ui/Input';

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

    // Build scripts to inject
    const injectScripts: string[] = [];
    if (scripts?.injectChallenge) {
      injectScripts.push(scripts.injectChallenge);
    }
    if (scripts?.scrapeResult) {
      injectScripts.push(scripts.scrapeResult);
    }

    setWebViewOpen(true);

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

      <Button
        className="w-full"
        onClick={() => {
          void handleOpenWebView();
        }}
        disabled={webViewOpen}
      >
        {webViewOpen ? 'Opening...' : 'Open redemption page'}
      </Button>
    </div>
  );
}
