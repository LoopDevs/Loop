/**
 * A2-2002: shared email-normalization primitive.
 *
 * Every entry point that writes to `users.email` previously did
 * `email.toLowerCase().trim()` inline — four callers in identities.ts,
 * native.ts (×2), and db/users.ts. Three weaknesses:
 *
 *  1. **No Unicode normalization.** `ＡＤＭＩＮ@loop.com` (fullwidth)
 *     and `admin@loop.com` (ASCII) compared as different rows — same
 *     account, two `users` rows.
 *  2. **No confusable rejection.** `admin@loop.com` (ASCII `a`)
 *     versus `аdmin@loop.com` (Cyrillic `а`, U+0430) compared as
 *     different rows even after lowercasing — a homograph attack
 *     that bypasses the partial unique index from A2-706.
 *  3. **Drift risk.** Four near-identical inline expressions across
 *     the auth surface; a future fifth caller would land without the
 *     same shape.
 *
 * The fix:
 *
 *  - **Trim** outer whitespace (covers paste-from-clipboard
 *    artifacts).
 *  - **NFKC normalize** so compatibility variants (`ﬃ` → `ffi`,
 *    fullwidth → halfwidth) collapse before comparison.
 *  - **Lowercase** for case-insensitive equality.
 *  - **Reject non-ASCII.** Returns `null` (caller maps to a 400
 *    validation error) when the post-NFKC string contains code
 *    points outside basic ASCII. IDN / SMTPUTF8 mailboxes are out
 *    of scope for Phase 1 — operators with non-ASCII addresses
 *    would need to file a support ticket. The trade-off favours
 *    not letting a homograph through.
 *
 * Order matters: trim before NFKC (NFKC of leading/trailing whitespace
 * can produce surprising results), NFKC before lowercase (some
 * compatibility forms have no lowercase), ASCII-check last (after the
 * trio above).
 */

const ASCII_RE = /^[\x20-\x7e]+$/;

export interface NormalizedEmail {
  /** Canonical lowercase ASCII email; ready for DB write or compare. */
  value: string;
}

export class NonAsciiEmailError extends Error {
  constructor(public readonly raw: string) {
    super('Email must be ASCII; non-ASCII addresses are not supported in Phase 1');
    this.name = 'NonAsciiEmailError';
  }
}

/**
 * Normalize an email for storage / comparison. Throws
 * `NonAsciiEmailError` if the post-NFKC string contains non-ASCII
 * code points — caller maps to 400 `VALIDATION_ERROR`.
 */
export function normalizeEmail(raw: string): string {
  const folded = raw.trim().normalize('NFKC').toLowerCase();
  if (!ASCII_RE.test(folded)) {
    throw new NonAsciiEmailError(raw);
  }
  return folded;
}
