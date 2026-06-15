import { describe, it, expect, beforeEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

// The crypto util reads the key from `env.LOOP_REDEEM_ENCRYPTION_KEY`.
// Mock the env module with a mutable object so each test can toggle the
// key on/off, then `resetRedeemKeyCache()` to drop the memoised buffer.
const envState: { LOOP_REDEEM_ENCRYPTION_KEY: string | undefined } = {
  LOOP_REDEEM_ENCRYPTION_KEY: undefined,
};
vi.mock('../../env.js', () => ({
  get env() {
    return envState;
  },
}));

import {
  encryptRedeemField,
  decryptRedeemField,
  isEncryptedRedeemField,
  resolveRedeemKey,
  resetRedeemKeyCache,
  RedeemDecryptError,
  REDEEM_ENVELOPE_PREFIX,
} from '../redeem-crypto.js';

// A deterministic 32-byte key in base64 + the same key in hex.
const KEY_BYTES = randomBytes(32);
const KEY_B64 = KEY_BYTES.toString('base64');
const KEY_HEX = KEY_BYTES.toString('hex');

function setKey(value: string | undefined): void {
  envState.LOOP_REDEEM_ENCRYPTION_KEY = value;
  resetRedeemKeyCache();
}

beforeEach(() => {
  setKey(undefined);
});

describe('encryptRedeemField / decryptRedeemField — round trip', () => {
  it('round-trips a value through the AES-256-GCM envelope', () => {
    setKey(KEY_B64);
    const plaintext = 'GIFT-CARD-CODE-1234-5678';
    const stored = encryptRedeemField(plaintext);
    expect(stored).not.toBeNull();
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain(plaintext); // ciphertext, not plaintext
    expect(decryptRedeemField(stored)).toBe(plaintext);
  });

  it('produces a different ciphertext each call (random IV) but both decrypt', () => {
    setKey(KEY_B64);
    const plaintext = 'PIN-0000';
    const a = encryptRedeemField(plaintext);
    const b = encryptRedeemField(plaintext);
    expect(a).not.toBe(b); // distinct IVs → distinct envelopes
    expect(decryptRedeemField(a)).toBe(plaintext);
    expect(decryptRedeemField(b)).toBe(plaintext);
  });

  it('handles unicode + empty-string payloads', () => {
    setKey(KEY_B64);
    for (const plaintext of ['', 'café-£-😀-code']) {
      const stored = encryptRedeemField(plaintext);
      expect(decryptRedeemField(stored)).toBe(plaintext);
    }
  });

  it('accepts a hex-encoded key as well as base64', () => {
    setKey(KEY_HEX);
    const stored = encryptRedeemField('hex-keyed-code');
    expect(stored).toMatch(/^enc:v1:/);
    expect(decryptRedeemField(stored)).toBe('hex-keyed-code');
  });

  it('decrypts ciphertext written under the equivalent base64 key (hex/b64 are the same key)', () => {
    setKey(KEY_B64);
    const stored = encryptRedeemField('cross-encoding-code');
    setKey(KEY_HEX); // same 32 bytes, different encoding
    expect(decryptRedeemField(stored)).toBe('cross-encoding-code');
  });
});

describe('null / undefined handling', () => {
  it('encrypt returns null for null/undefined', () => {
    setKey(KEY_B64);
    expect(encryptRedeemField(null)).toBeNull();
    expect(encryptRedeemField(undefined)).toBeNull();
  });

  it('decrypt returns null for null/undefined', () => {
    setKey(KEY_B64);
    expect(decryptRedeemField(null)).toBeNull();
    expect(decryptRedeemField(undefined)).toBeNull();
  });

  it('encrypt never double-wraps an already-enveloped value', () => {
    setKey(KEY_B64);
    const once = encryptRedeemField('code');
    const twice = encryptRedeemField(once);
    expect(twice).toBe(once); // idempotent — no nested envelope
    expect(decryptRedeemField(twice)).toBe('code');
  });
});

describe('legacy plaintext passthrough', () => {
  it('decrypt returns a non-enveloped value verbatim (existing rows)', () => {
    setKey(KEY_B64);
    // A row captured before this slice has no `enc:v1:` prefix.
    expect(decryptRedeemField('LEGACY-PLAINTEXT-CODE')).toBe('LEGACY-PLAINTEXT-CODE');
  });

  it('a legacy value that coincidentally looks code-like is not treated as an envelope', () => {
    setKey(KEY_B64);
    expect(isEncryptedRedeemField('enc:v2:something')).toBe(false);
    expect(decryptRedeemField('enc:v2:something')).toBe('enc:v2:something');
  });
});

describe('key-unset behaviour (ships dark)', () => {
  it('encrypt returns plaintext unchanged when the key is unset', () => {
    setKey(undefined);
    expect(resolveRedeemKey()).toBeNull();
    expect(encryptRedeemField('CODE-WHEN-KEY-OFF')).toBe('CODE-WHEN-KEY-OFF');
  });

  it('decrypt passes legacy plaintext through when the key is unset', () => {
    setKey(undefined);
    expect(decryptRedeemField('CODE-WHEN-KEY-OFF')).toBe('CODE-WHEN-KEY-OFF');
  });

  it('decrypt throws when an enveloped value is read but the key is unset', () => {
    setKey(KEY_B64);
    const stored = encryptRedeemField('CODE');
    setKey(undefined); // key removed / rotated away
    expect(() => decryptRedeemField(stored)).toThrow(RedeemDecryptError);
  });

  it('treats an empty-string key the same as unset', () => {
    setKey('');
    expect(resolveRedeemKey()).toBeNull();
    expect(encryptRedeemField('CODE')).toBe('CODE');
  });
});

describe('tamper / auth-tag rejection', () => {
  it('rejects a flipped ciphertext byte (GCM auth-tag mismatch)', () => {
    setKey(KEY_B64);
    const stored = encryptRedeemField('TAMPER-ME')!;
    const packed = stored.slice(REDEEM_ENVELOPE_PREFIX.length);
    const raw = Buffer.from(packed, 'base64url');
    // Flip a byte in the ciphertext region (after the 12-byte IV).
    raw[13] = raw[13]! ^ 0xff;
    const tampered = `${REDEEM_ENVELOPE_PREFIX}${raw.toString('base64url')}`;
    expect(() => decryptRedeemField(tampered)).toThrow(RedeemDecryptError);
  });

  it('rejects a flipped auth-tag byte', () => {
    setKey(KEY_B64);
    const stored = encryptRedeemField('TAG-TAMPER')!;
    const packed = stored.slice(REDEEM_ENVELOPE_PREFIX.length);
    const raw = Buffer.from(packed, 'base64url');
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x01; // last byte = tail of the 16-byte tag
    const tampered = `${REDEEM_ENVELOPE_PREFIX}${raw.toString('base64url')}`;
    expect(() => decryptRedeemField(tampered)).toThrow(RedeemDecryptError);
  });

  it('rejects a value decrypted under the wrong key', () => {
    setKey(KEY_B64);
    const stored = encryptRedeemField('WRONG-KEY')!;
    setKey(randomBytes(32).toString('base64')); // a different key
    expect(() => decryptRedeemField(stored)).toThrow(RedeemDecryptError);
  });

  it('rejects a truncated envelope (shorter than IV + tag)', () => {
    setKey(KEY_B64);
    const tooShort = `${REDEEM_ENVELOPE_PREFIX}${Buffer.alloc(10).toString('base64url')}`;
    expect(() => decryptRedeemField(tooShort)).toThrow(RedeemDecryptError);
  });
});

describe('key decoding guards', () => {
  it('throws when the key does not decode to 32 bytes', () => {
    setKey(Buffer.alloc(16).toString('base64')); // 16 bytes — too short
    expect(() => resolveRedeemKey()).toThrow(/32 bytes/);
  });
});
