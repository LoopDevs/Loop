/**
 * Barcode-gift-card field extraction (ADR 005 §2 — barcode merchants).
 *
 * Lifted out of `./get-handler.ts`. CTX populates the barcode card
 * material (`number`, `pin`, `barcodeUrl`) on the SAME `/gift-cards/{id}`
 * response (via passthrough) once `fulfilmentStatus` flips to
 * `completed`. The web client's PurchaseComplete component renders
 * the code + jsbarcode canvas whenever `giftCardCode` is present, so
 * extracting these fields here is what completes the barcode-merchant
 * purchase flow end-to-end.
 *
 * Those three names are the whole contract. An unrecognised spelling
 * reads as absent rather than being absorbed by a fallback list, so a
 * CTX rename surfaces as a visibly empty extraction in the log below
 * instead of quietly working until it doesn't.
 *
 * The function mutates the supplied `order` object in place and logs
 * which fields were populated — that log line is the only signal we
 * have at this layer for "did the upstream actually return something
 * usable" without a paired client poll.
 *
 * No-op for non-barcode redeem types or non-completed orders — the
 * caller is responsible for gating on `status === 'completed' &&
 * redeemType === 'barcode'`.
 */
import type { Logger } from 'pino';

/**
 * Reads one string field off a CTX gift-card record. Missing, empty
 * and non-string all read as absent, so a malformed upstream value
 * never lands on the order as card material.
 */
function readString(record: Record<string, unknown>, key: string): string | undefined {
  const v = record[key];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/**
 * Pulls the barcode image URL out of a CTX gift-card record. Shared
 * with the authed barcode-image proxy (`./barcode-image-handler.ts`,
 * ADR 050), which resolves the URL server-side instead of forwarding
 * it to the client.
 */
export function extractBarcodeImageUrl(upstream: Record<string, unknown>): string | undefined {
  return readString(upstream, 'barcodeUrl');
}

/**
 * Extracts barcode card material from the validated CTX response and
 * adds the `giftCardCode`, `giftCardPin`, `barcodeImageUrl` fields to
 * the in-flight `order` shape. Logs the extraction outcome on
 * `log.info` for ops visibility.
 */
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
