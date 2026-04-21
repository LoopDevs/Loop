/**
 * Renders a gift-card share image into an offscreen canvas and
 * returns a PNG data URL. Called from the PurchaseComplete share
 * handler so the user's share sheet preview shows one polished
 * image — merchant name, the barcode, and the code — rather than
 * just text or a bare barcode.
 *
 * Stand-alone so it has no React / JSX overhead; runs once when
 * the user taps Share. Everything inside is plain canvas 2D API
 * so there are no new dependencies.
 */

interface ShareImageInput {
  merchantName: string;
  code: string;
  pin?: string | undefined;
  /**
   * Source for the barcode. Can be:
   * - an existing `HTMLCanvasElement` (typical when our CODE128
   *   canvas rendered it client-side); we grab its contents via
   *   `drawImage` directly.
   * - a URL pointing to a CTX-rendered barcode image.
   */
  barcodeCanvas?: HTMLCanvasElement | undefined;
  barcodeImageUrl?: string | undefined;
}

const WIDTH = 800;
const HEIGHT = 420;

/**
 * Returns a PNG data URL (`data:image/png;base64,...`) sized 800×420
 * with the gift-card face composed. Resolves with `null` when a
 * dependency (canvas, image load, remote fetch) fails — callers
 * should fall back to text-only share in that case.
 */
export async function composeGiftCardShareImage(input: ShareImageInput): Promise<string | null> {
  if (typeof document === 'undefined') return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return null;

    // Ink header band. Keeps the merchant identity anchoring the
    // top third of the card so the recipient sees what store this
    // is for before any code.
    ctx.fillStyle = '#030712';
    ctx.fillRect(0, 0, WIDTH, 110);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
    ctx.font = '600 14px "Inter", ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText('GIFT CARD', 32, 28);

    ctx.fillStyle = '#ffffff';
    ctx.font = '700 28px "Inter", ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(truncate(input.merchantName, 32), 32, 56);

    // White body — barcode zone.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 110, WIDTH, HEIGHT - 110);

    // Paint the barcode. Prefer a live canvas (no network, always
    // renders) and fall back to the remote URL if only that's
    // available. Worst case: we skip the barcode and still emit
    // code + PIN below.
    const barcodeTop = 140;
    const barcodeBoxHeight = 140;
    if (input.barcodeCanvas !== undefined) {
      drawImageContain(ctx, input.barcodeCanvas, 32, barcodeTop, WIDTH - 64, barcodeBoxHeight);
    } else if (input.barcodeImageUrl !== undefined) {
      const image = await loadImage(input.barcodeImageUrl);
      if (image !== null) {
        drawImageContain(ctx, image, 32, barcodeTop, WIDTH - 64, barcodeBoxHeight);
      }
    }

    // Code + PIN — monospaced, big, tracked. Recipient-friendly
    // even when the OS downscales the share preview.
    ctx.fillStyle = '#030712';
    ctx.font = '600 12px "Inter", ui-sans-serif, system-ui, sans-serif';
    ctx.fillText('CODE', 32, 300);
    ctx.font = '700 22px "JetBrains Mono", ui-monospace, SFMono-Regular, monospace';
    ctx.fillText(truncate(input.code, 40), 32, 320);

    if (input.pin !== undefined && input.pin.length > 0) {
      ctx.fillStyle = '#030712';
      ctx.font = '600 12px "Inter", ui-sans-serif, system-ui, sans-serif';
      ctx.fillText('PIN', 32, 366);
      ctx.font = '700 22px "JetBrains Mono", ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(truncate(input.pin, 40), 32, 386);
    }

    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Paint `source` onto `ctx` at `(x, y)` within a `maxWidth × maxHeight`
 * box, preserving aspect ratio (contain fit) and centering on both
 * axes. Keeps barcode scanlines crisp by never stretching.
 */
function drawImageContain(
  ctx: CanvasRenderingContext2D,
  source: CanvasImageSource,
  x: number,
  y: number,
  maxWidth: number,
  maxHeight: number,
): void {
  const width = getImageWidth(source);
  const height = getImageHeight(source);
  if (width === 0 || height === 0) return;
  const scale = Math.min(maxWidth / width, maxHeight / height);
  const drawWidth = width * scale;
  const drawHeight = height * scale;
  const dx = x + (maxWidth - drawWidth) / 2;
  const dy = y + (maxHeight - drawHeight) / 2;
  ctx.drawImage(source, dx, dy, drawWidth, drawHeight);
}

function getImageWidth(source: CanvasImageSource): number {
  if (source instanceof HTMLCanvasElement) return source.width;
  if (source instanceof HTMLImageElement) return source.naturalWidth;
  if (source instanceof SVGImageElement) return source.width.baseVal.value;
  return 0;
}
function getImageHeight(source: CanvasImageSource): number {
  if (source instanceof HTMLCanvasElement) return source.height;
  if (source instanceof HTMLImageElement) return source.naturalHeight;
  if (source instanceof SVGImageElement) return source.height.baseVal.value;
  return 0;
}

function loadImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    // `crossOrigin` is required so the resulting canvas isn't
    // tainted and `toDataURL` can serialise it. Our image proxy
    // (`/api/image?url=...`) returns the right CORS headers; the
    // URL comes from `getImageProxyUrl` so it always hits the
    // proxy, never the raw CTX origin.
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}
