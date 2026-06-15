/**
 * Envelope encryption for gift-card redeem secrets at rest (CF-25 /
 * X-PRIV-03).
 *
 * Gift-card `redeem_code` / `redeem_pin` ARE the gift card — spendable
 * bearer instruments. Before this slice they were stored as plaintext
 * `text` columns, protected only by Fly's volume-level at-rest
 * encryption (physical-disk theft) — a logical DB read (leaked
 * `DATABASE_URL`, a rogue `loop_readonly` SELECT, a backup
 * exfiltration) handed an attacker spendable codes. This wraps the two
 * bearer fields with an application-layer AES-256-GCM envelope so a
 * logical read sees ciphertext, and only a holder of
 * `LOOP_REDEEM_ENCRYPTION_KEY` (an env secret, not in the DB) can
 * recover the plaintext.
 *
 * `redeem_url` is left as-is — it's a redemption *landing page*, not
 * the bearer secret, and the WebView needs it to load the merchant's
 * redemption flow; the code/PIN it carries arrive separately.
 *
 * ── Self-describing envelope ──────────────────────────────────────
 *
 * `encryptRedeemField` returns a tagged string:
 *
 *     enc:v1:<base64url(iv ‖ ciphertext ‖ tag)>
 *
 *   - `enc:v1:` — version prefix, so a future scheme (key rotation, a
 *     different AEAD) can coexist and be told apart on read.
 *   - 12-byte random IV (GCM standard), 16-byte auth tag.
 *
 * `decryptRedeemField` is the inverse and is deliberately
 * backward-safe:
 *
 *   - A value WITHOUT the `enc:v1:` prefix is returned verbatim
 *     (legacy plaintext passthrough). Existing rows captured before
 *     this slice, and any row written while the key is unset, keep
 *     working — no backfill migration, no boot break.
 *   - A tampered / truncated / wrong-key ciphertext throws
 *     `RedeemDecryptError` (GCM auth-tag failure). The read handler
 *     treats that as "redemption unavailable" rather than serving a
 *     forged code.
 *
 * ── Key-unset behaviour (ships dark) ──────────────────────────────
 *
 * If `LOOP_REDEEM_ENCRYPTION_KEY` is unset, `encryptRedeemField`
 * returns the plaintext unchanged. This lets the change ship without
 * forcing a new secret — encryption activates the moment the operator
 * sets the key. `index.ts` logs a single boot warn while it's unset so
 * the dark state is visible. Once set, new writes are encrypted and
 * old plaintext rows still decrypt (passthrough); the two coexist.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../env.js';

/** Tag prefix identifying an AES-256-GCM v1 envelope. */
export const REDEEM_ENVELOPE_PREFIX = 'enc:v1:';

const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16; // GCM auth tag length
const KEY_BYTES = 32; // AES-256

/** Thrown when a stored envelope fails to decrypt (tamper / wrong key). */
export class RedeemDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RedeemDecryptError';
  }
}

/**
 * Resolves the 32-byte key from `LOOP_REDEEM_ENCRYPTION_KEY`. Accepts
 * base64 / base64url (with or without padding) or hex; both decode to
 * exactly 32 bytes. Returns null when the var is unset (encryption
 * disabled).
 *
 * Memoised per process: the key never changes mid-run, and decoding on
 * every field would be wasteful on the order read path.
 */
let cachedKey: Buffer | null | undefined;

export function resolveRedeemKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = env.LOOP_REDEEM_ENCRYPTION_KEY;
  if (raw === undefined || raw === '') {
    cachedKey = null;
    return null;
  }
  const key = decodeKey(raw);
  cachedKey = key;
  return key;
}

/** Test seam: drop the memoised key so a test can swap the env var. */
export function resetRedeemKeyCache(): void {
  cachedKey = undefined;
}

function decodeKey(raw: string): Buffer {
  // Try hex first when the string is unambiguously hex (64 hex chars);
  // otherwise treat as base64 / base64url. env.ts already validated
  // that the decoded length is 32 bytes, so this should not throw in
  // production — but guard anyway for the direct-call path.
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
    // Buffer's base64 decoder also accepts base64url.
    buf = Buffer.from(raw, 'base64');
  }
  if (buf.length !== KEY_BYTES) {
    throw new Error(
      `LOOP_REDEEM_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}); ` +
        'provide 32 bytes as base64 or hex.',
    );
  }
  return buf;
}

/**
 * True when `stored` carries the v1 envelope prefix. Used by readers
 * that want to branch (e.g. metrics) without attempting a decrypt.
 */
export function isEncryptedRedeemField(stored: string): boolean {
  return stored.startsWith(REDEEM_ENVELOPE_PREFIX);
}

/**
 * Encrypts a redeem secret for storage. Returns:
 *   - `null` when `plaintext` is null/undefined (the field is absent).
 *   - the plaintext unchanged when the key is unset (ships dark) or
 *     already enveloped (idempotent — never double-wrap).
 *   - `enc:v1:<base64url>` otherwise.
 */
export function encryptRedeemField(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  // Already enveloped — return as-is so a re-persist of an
  // already-encrypted value (e.g. an idempotent UPDATE replay) doesn't
  // nest envelopes.
  if (isEncryptedRedeemField(plaintext)) return plaintext;

  const key = resolveRedeemKey();
  if (key === null) return plaintext; // encryption disabled — plaintext passthrough

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, ciphertext, tag]).toString('base64url');
  return `${REDEEM_ENVELOPE_PREFIX}${packed}`;
}

/**
 * Decrypts a stored redeem secret. Returns:
 *   - `null` when `stored` is null/undefined.
 *   - the value unchanged when it is NOT `enc:v1:`-prefixed (legacy
 *     plaintext passthrough — existing rows + key-unset writes).
 *   - the decrypted plaintext for a valid envelope.
 *
 * Throws `RedeemDecryptError` when a `enc:v1:` value is malformed,
 * tampered, or the key is wrong/unset — fail closed rather than serve
 * a forged or unverifiable code.
 */
export function decryptRedeemField(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!isEncryptedRedeemField(stored)) return stored; // legacy plaintext

  const key = resolveRedeemKey();
  if (key === null) {
    throw new RedeemDecryptError(
      'Stored redeem field is encrypted (enc:v1:) but LOOP_REDEEM_ENCRYPTION_KEY is unset — cannot decrypt.',
    );
  }

  const packed = stored.slice(REDEEM_ENVELOPE_PREFIX.length);
  const raw = Buffer.from(packed, 'base64url');
  if (raw.length < IV_BYTES + TAG_BYTES) {
    throw new RedeemDecryptError('Malformed redeem envelope: too short for IV + tag.');
  }
  const iv = raw.subarray(0, IV_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const ciphertext = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch (err) {
    // GCM auth-tag mismatch (tamper / wrong key) lands here.
    throw new RedeemDecryptError('Failed to decrypt redeem field — auth tag mismatch.', {
      cause: err,
    });
  }
}
