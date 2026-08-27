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
 * Picks the first non-empty string value from a record across a list
 * of candidate keys. CTX has shipped the same field under several
 * names over time (e.g. `number` vs `cardNumber` vs `giftCardCode`),
 * so we accept any of them.
 */
function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = record[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Pulls the barcode image URL out of a CTX gift-card record. CTX has
 * shipped it under several names over time. Shared with the authed
 * barcode-image proxy (`./barcode-image-handler.ts`, ADR 050), which
 * resolves the URL server-side instead of forwarding it to the client.
 */
export function extractBarcodeImageUrl(upstream: Record<string, unknown>): string | undefined {
  return pickString(upstream, 'barcodeUrl', 'imageUrl', 'barcodeImageUrl', 'giftCardImageUrl');
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
  const code = pickString(upstream, 'number', 'code', 'cardNumber', 'giftCardCode');
  const pin = pickString(upstream, 'pin', 'cardPin', 'giftCardPin');
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
