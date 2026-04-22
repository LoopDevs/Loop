/**
 * Stellar ED25519 public key validation (ADR 015).
 *
 * The canonical form is 56 uppercase base32 chars starting with `G`.
 * Used at every boundary that accepts a user-supplied Stellar address
 * — the backend `PUT /api/users/me/stellar-address` body, the web
 * wallet-linking form, order-creation guards.
 *
 * Pure string validation — does not verify the checksum inside the
 * strkey (ADR 015 defers that to the `@stellar/stellar-sdk` call site,
 * which both ends reach via a different path). The regex catches
 * every *format* error a user can type; a valid-looking-but-wrong
 * checksum will fail at the SDK boundary with a clearer error.
 */

export const STELLAR_PUBKEY_REGEX = /^G[A-Z2-7]{55}$/;

/**
 * Returns true when `value` is a syntactically valid Stellar ED25519
 * public key (G... 56 chars, uppercase base32). Does *not* verify the
 * strkey checksum — see the file comment.
 */
export function isValidStellarAddress(value: string): boolean {
  return STELLAR_PUBKEY_REGEX.test(value);
}
