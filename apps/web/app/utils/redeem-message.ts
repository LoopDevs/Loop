/**
 * Strict validation of the gift-card result `postMessage` from the redemption
 * WebView (audit CF-02 / WEB-S2).
 *
 * Trust boundary: the redeem URL is a merchant page, and the `scrapeResult`
 * script that posts this message is CTX-supplied (a trusted supplier, fetched
 * over TLS and Zod-validated + size-capped at the backend). Even so, the
 * message that crosses back into our app is treated as untrusted input: we
 * accept it only when it is a well-formed `loop:giftcard` payload whose `code`
 * (and optional `pin`) are short, printable strings. Anything else — a forged
 * shape, an oversized blob, control characters — is rejected so a compromised
 * page can't drive a garbage/forged code into the order-complete state.
 */
export interface GiftCardMessage {
  code: string;
  pin?: string;
}

const MAX_FIELD_LEN = 256;
// Reject ASCII control chars (NUL..US + DEL) — a redeem code/PIN is a short
// printable token; control chars signal a malformed or hostile payload.

const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

function cleanField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_FIELD_LEN) return null;
  if (CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/**
 * Returns the validated `{ code, pin? }` for a genuine `loop:giftcard` result,
 * or `null` for anything that isn't one. Callers must treat `null` as "ignore
 * this message".
 */
export function parseGiftCardMessage(data: unknown): GiftCardMessage | null {
  if (data === null || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (obj.type !== 'loop:giftcard') return null;
  const code = cleanField(obj.code);
  if (code === null) return null;
  const pin = cleanField(obj.pin);
  return pin === null ? { code } : { code, pin };
}
