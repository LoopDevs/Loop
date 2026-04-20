import { useEffect, useRef, useState } from 'react';
import { Button } from '~/components/ui/Button';
import { triggerHapticNotification } from '~/native/haptics';
import { copyToClipboard } from '~/native/clipboard';
import { enableScreenshotGuard } from '~/native/screenshot-guard';
import { nativeShare } from '~/native/share';
import { getImageProxyUrl } from '~/utils/image';

interface PurchaseCompleteProps {
  merchantName: string;
  code: string;
  pin?: string | undefined;
  /** Upstream-rendered barcode image URL. When present, we display it
   *  instead of rendering our own CODE128 canvas — the merchant's POS
   *  expects a specific format (CODE39, DataMatrix, QR, etc.) that we
   *  can't reliably guess client-side. */
  barcodeImageUrl?: string | undefined;
  onDone: () => void;
}

/**
 * Shows the redeemed gift card code with a barcode and optionally a PIN.
 */
export function PurchaseComplete({
  merchantName,
  code,
  pin,
  barcodeImageUrl,
  onDone,
}: PurchaseCompleteProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  // Fall back to the client-rendered canvas if CTX didn't provide a
  // barcode image URL or the image 404s / is blocked.
  const useCanvas = barcodeImageUrl === undefined || imageFailed;

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
    // Only render the client-side CODE128 canvas when we don't have
    // (or lost) the upstream image. Skipping the import cuts ~30KB of
    // JS on the happy path.
    if (!useCanvas || canvasRef.current === null) return;
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
  }, [code, useCanvas]);

  return (
    <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-6 text-center">
      <div className="text-4xl mb-3">🎉</div>
      <h2 className="text-xl font-bold text-gray-900 dark:text-white mb-1">Gift card ready!</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400 mb-6">
        Your {merchantName} gift card code:
      </p>

      {useCanvas ? (
        <canvas
          ref={canvasRef}
          className="mx-auto max-w-full mb-4"
          aria-label={`Barcode for gift card code ${code}`}
        />
      ) : (
        // Route through the image proxy so the CTX-hosted barcode
        // image is allowed by CSP (img-src 'self' + apiOrigin) and
        // gets the proxy's allowlist/SSRF guarding. If the proxy
        // rejects the host, the onError flips `imageFailed` and we
        // fall back to the client-rendered canvas.
        <img
          src={getImageProxyUrl(barcodeImageUrl ?? '', 640)}
          alt={`Barcode for gift card code ${code}`}
          onError={() => setImageFailed(true)}
          className="mx-auto max-w-full mb-4 bg-white p-2 rounded"
        />
      )}

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
