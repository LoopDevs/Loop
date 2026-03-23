import { useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/Button';
import { triggerHapticNotification } from '~/native/haptics';
import { copyToClipboard } from '~/native/clipboard';
import { enableScreenshotGuard } from '~/native/screenshot-guard';
import { nativeShare } from '~/native/share';

interface PurchaseCompleteProps {
  merchantName: string;
  code: string;
  pin?: string | undefined;
  onDone: () => void;
}

/**
 * Shows the redeemed gift card code with a barcode and optionally a PIN.
 */
export function PurchaseComplete({
  merchantName,
  code,
  pin,
  onDone,
}: PurchaseCompleteProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = async (text: string): Promise<void> => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleShare = async (): Promise<void> => {
    await nativeShare({
      title: `${merchantName} Gift Card`,
      text: `Gift card code: ${code}${pin ? `\nPIN: ${pin}` : ''}`,
    });
  };

  useEffect(() => {
    void triggerHapticNotification('success');
  }, []);

  // Blur screen when app is backgrounded to protect gift card code
  useEffect(() => {
    return enableScreenshotGuard();
  }, []);

  useEffect(() => {
    if (canvasRef.current === null) return;
    void (async () => {
      try {
        const JsBarcode = (await import('jsbarcode')).default;
        JsBarcode(canvasRef.current, code, {
          format: 'CODE128',
          displayValue: true,
          fontSize: 14,
          margin: 10,
        });
      } catch {
        // Barcode generation failed — code is still shown as text
      }
    })();
  }, [code]);

  return (
    <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-6 text-center">
      <div className="text-4xl mb-3">🎉</div>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Gift card ready!</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        Your {merchantName} gift card code:
      </p>

      <canvas
        ref={canvasRef}
        className="mx-auto max-w-full mb-4"
        aria-label={`Barcode for gift card code ${code}`}
      />

      <div className="bg-white dark:bg-gray-900 rounded-lg p-3 font-mono text-lg font-bold tracking-widest text-gray-900 dark:text-white mb-2">
        {code}
      </div>

      <div className="text-center mb-2">
        <button
          type="button"
          onClick={() => {
            void handleCopy(code);
          }}
          className="text-xs text-blue-600 dark:text-blue-400 mt-1"
        >
          {copied ? 'Copied!' : 'Copy code'}
        </button>
      </div>

      {pin !== undefined && (
        <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
          PIN: <strong className="font-mono">{pin}</strong>
        </p>
      )}

      <p className="text-xs text-gray-500 mb-6">
        Save this code — you'll need it to redeem your gift card.
      </p>

      <div className="flex gap-3">
        <Button
          onClick={() => {
            void handleShare();
          }}
          variant="secondary"
          className="flex-1"
        >
          Share
        </Button>
        <Button onClick={onDone} variant="secondary" className="flex-1">
          Done
        </Button>
      </div>
    </div>
  );
}
