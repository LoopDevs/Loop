import { useEffect, useRef, useState } from 'react';
import { triggerHapticNotification } from '~/native/haptics';
import { copyToClipboard } from '~/native/clipboard';
import { nativeShare } from '~/native/share';
import { getImageProxyUrl } from '~/utils/image';
import { composeGiftCardShareImage } from '~/utils/share-image';

interface PurchaseCompleteProps {
  merchantName: string;
  code: string;
  pin?: string | undefined;
  /**
   * Upstream-rendered barcode image URL. When present, we display it
   * instead of rendering our own CODE128 canvas — the merchant's POS
   * expects a specific format (CODE39, DataMatrix, QR, etc.) that we
   * can't reliably guess client-side.
   */
  barcodeImageUrl?: string | undefined;
}

/**
 * Post-purchase gift-card presentation. Rendered both inline in
 * the purchase flow and on the standalone /orders/:id page when
 * the order has a `giftCardCode`. Designed to feel like the
 * redeemable card itself rather than a green success banner — a
 * clean white card with the barcode centred, the code + PIN
 * prominent and monospaced, and a single row of secondary
 * actions (Copy, Share, Done).
 */
export function PurchaseComplete({
  merchantName,
  code,
  pin,
  barcodeImageUrl,
}: PurchaseCompleteProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [copied, setCopied] = useState<'code' | 'pin' | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  // Fall back to the client-rendered canvas if CTX didn't provide
  // a barcode image URL or the image 404s / is blocked.
  const useCanvas = barcodeImageUrl === undefined || imageFailed;

  const handleCopy = async (text: string, which: 'code' | 'pin'): Promise<void> => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopied(which);
      setTimeout(() => setCopied(null), 2000);
    }
  };

  const handleShare = async (): Promise<void> => {
    // Compose a proper "gift card" share image — merchant header,
    // barcode, code, PIN — so the share preview reads like a card
    // rather than a bare barcode. Falls back cleanly if the
    // barcode source can't be loaded.
    const composed = await composeGiftCardShareImage({
      merchantName,
      code,
      pin,
      barcodeCanvas: useCanvas ? (canvasRef.current ?? undefined) : undefined,
      barcodeImageUrl:
        !useCanvas && barcodeImageUrl !== undefined
          ? getImageProxyUrl(barcodeImageUrl, 640, 80, { mode: 'private' })
          : undefined,
    });
    const safeName = merchantName.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    await nativeShare({
      title: `${merchantName} Gift Card`,
      text: `Gift card code: ${code}${pin !== undefined ? `\nPIN: ${pin}` : ''}`,
      // `imageUrl` is a data:image/png URL when compose succeeded;
      // undefined if the composite failed (share falls through to
      // text-only via the plugin).
      imageUrl: composed ?? undefined,
      imageFilename: `${safeName}-gift-card.png`,
    });
  };

  useEffect(() => {
    void triggerHapticNotification('success');
  }, []);

  useEffect(() => {
    // Only render the client-side CODE128 canvas when we don't have
    // (or lost) the upstream image. Skipping the import cuts ~30KB
    // of JS on the happy path.
    if (!useCanvas || canvasRef.current === null) return;
    void (async () => {
      try {
        const JsBarcode = (await import('jsbarcode')).default;
        JsBarcode(canvasRef.current, code, {
          format: 'CODE128',
          displayValue: false,
          margin: 8,
          // Darker bars read cleaner on the white card face than
          // the default #000 which looks harsh against our ink
          // background. Actual CODE128 scanners tolerate any
          // near-black hex.
          lineColor: '#030712',
          height: 72,
        });
      } catch {
        // Barcode generation failed — code is still shown as text
      }
    })();
  }, [code, useCanvas]);

  return (
    <div className="flex flex-col gap-3">
      {/* Gift-card-shaped face: white body, ink header band with the
          merchant name + "Gift card" label, rounded corners + soft
          shadow. Mimics a physical card sitting on the page. */}
      <div className="rounded-2xl overflow-hidden bg-white border border-gray-200 shadow-sm">
        <div className="bg-gray-950 text-white px-5 py-4 flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-white/60">
              Gift card
            </div>
            <div className="text-[15px] font-semibold truncate">{merchantName}</div>
          </div>
          {/* Checkmark chip — the "ready" confirmation, replacing
              the green success panel / emoji that lived here
              before. Subtle green on ink reads as "paid, ready to
              redeem" without shouting. */}
          <div className="flex-shrink-0 flex items-center gap-1.5 bg-green-500/15 text-green-400 text-[11px] font-semibold px-2 py-1 rounded-full">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M5 13l4 4L19 7"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Ready
          </div>
        </div>

        <div className="px-5 pt-5 pb-4">
          {/* Barcode pane — always white so scanners read it in
              both themes. Centred, fixed height so the canvas and
              CTX image render at the same size. */}
          <div className="flex items-center justify-center bg-white rounded-lg h-[92px]">
            {useCanvas ? (
              <canvas
                ref={canvasRef}
                className="max-w-full"
                aria-label={`Barcode for gift card code ${code}`}
              />
            ) : (
              <img
                src={getImageProxyUrl(barcodeImageUrl ?? '', 640, 80, { mode: 'private' })}
                alt={`Barcode for gift card code ${code}`}
                onError={() => setImageFailed(true)}
                className="max-h-full max-w-full"
              />
            )}
          </div>
        </div>
      </div>

      {/* Code + PIN fields — pill inputs with inline copy buttons,
          mirroring the in-app pattern from the onboarding OTP
          screen. Monospaced + tracked so the characters are easy
          to read off-device. */}
      <CodeField
        label="Code"
        value={code}
        copied={copied === 'code'}
        onCopy={() => void handleCopy(code, 'code')}
      />
      {pin !== undefined && (
        <CodeField
          label="PIN"
          value={pin}
          copied={copied === 'pin'}
          onCopy={() => void handleCopy(pin, 'pin')}
        />
      )}

      <p className="text-xs text-gray-500 dark:text-gray-400 px-1">
        Save this — you&apos;ll need it to redeem your gift card.
      </p>

      <button
        type="button"
        onClick={() => void handleShare()}
        className="h-11 rounded-xl bg-gray-950 dark:bg-white text-white dark:text-gray-950 text-[15px] font-semibold flex items-center justify-center gap-2 active:scale-[0.98] transition-transform mt-2"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
        Share
      </button>
    </div>
  );
}

function CodeField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl px-3 py-2.5">
      <div className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-[0.08em] text-gray-500 dark:text-gray-400 w-10">
        {label}
      </div>
      <div
        className="flex-1 min-w-0 text-[15px] font-semibold text-gray-900 dark:text-white truncate"
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          letterSpacing: '0.06em',
        }}
      >
        {value}
      </div>
      <button
        type="button"
        onClick={onCopy}
        aria-label={`Copy ${label.toLowerCase()}`}
        className="flex-shrink-0 h-8 px-2.5 rounded-lg text-[12px] font-semibold text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}
