// Barcode-gift-card field extraction — ADR 005 §2, ADR 050
import type { Logger } from 'pino';

// Strict string check: missing, empty, or non-string values read as absent to prevent malformed upstream data from landing on the order.
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function extractBarcodeImageUrl(upstream: Record<string, unknown>): string | undefined {
  return readString(upstream, 'barcodeUrl');
}

export function applyBarcodeFields(args: {
  upstream: Record<string, unknown>;
  orderId: string;
  order: Record<string, unknown>;
  log: Logger;
}): void {
  const { upstream, orderId, order, log } = args;
  const code = readString(upstream, 'number');
  const pin = readString(upstream, 'pin');
  const imageUrl = extractBarcodeImageUrl(upstream);

  if (code !== undefined) order.giftCardCode = code;
  if (pin !== undefined) order.giftCardPin = pin;
  if (imageUrl !== undefined) order.barcodeImageUrl = imageUrl;

  log.info(
    {
      orderId,
      extracted: {
        hasCode: code !== undefined,
        hasPin: pin !== undefined,
        hasImageUrl: imageUrl !== undefined,
      },
    },
    'Barcode gift card extracted from /gift-cards/:id response',
  );
}
