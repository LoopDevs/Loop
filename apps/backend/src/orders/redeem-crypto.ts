// Envelope encryption for gift-card redeem secrets at rest — CF-25, X-PRIV-03
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { config } from '../config/index.js';

export const REDEEM_ENVELOPE_PREFIX = 'enc:v1:';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class RedeemDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RedeemDecryptError';
  }
}

let cachedKey: Buffer | null | undefined;

export function resolveRedeemKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = config.orders.redeem.encryptionKey;
  if (raw === undefined || raw === '') {
    cachedKey = null;
    return null;
  }
  const key = decodeKey(raw);
  cachedKey = key;
  return key;
}

export function resetRedeemKeyCache(): void {
  cachedKey = undefined;
}

function decodeKey(raw: string): Buffer {
  let buf: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, 'hex');
  } else {
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

export function isEncryptedRedeemField(stored: string): boolean {
  return stored.startsWith(REDEEM_ENVELOPE_PREFIX);
}

export function encryptRedeemField(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined) return null;
  if (isEncryptedRedeemField(plaintext)) return plaintext;

  const key = resolveRedeemKey();
  if (key === null) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, ciphertext, tag]).toString('base64url');
  return `${REDEEM_ENVELOPE_PREFIX}${packed}`;
}

export function decryptRedeemField(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!isEncryptedRedeemField(stored)) return stored;

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
    throw new RedeemDecryptError('Failed to decrypt redeem field — auth tag mismatch.', {
      cause: err,
    });
  }
}
