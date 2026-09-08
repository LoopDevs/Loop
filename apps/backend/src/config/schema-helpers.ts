/**
 * Shared zod helpers for the `config.yaml` schema sections
 * (`./sections/*`) and the composed schema in `../config.ts`.
 * Extracted so the section modules can import them without a cycle
 * back through `config.ts`.
 *
 * Note what is NOT here any more: the old `env.ts` needed an
 * `envBoolean` helper because `process.env` values are always strings
 * and `z.coerce.boolean()` turns `"false"` into `true`. YAML has real
 * booleans, real numbers, and real lists, so those coercion helpers —
 * and the whole class of bug they existed to prevent — are gone. Plain
 * `z.boolean()` / `z.number()` / `z.array()` are correct here.
 */
import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

/**
 * Recursively drops keys whose value is `null`, in place of the parsed
 * YAML document, before the schema sees it.
 *
 * YAML spells "this key exists but has no value" as `null`:
 *
 *   email:
 *     replyTo:          # ← null, not ""
 *
 * That is exactly what an operator means by "leave this unset", and it
 * is how `config-reference.yaml` documents every optional key — the key
 * stays visible with its explanatory comment, with no value filled in.
 * Stripping nulls here lets every section schema use ordinary
 * `.optional()` / `.default()` instead of threading `.nullish()`
 * through ~60 fields, and keeps `null` from ever reaching a consumer
 * that expects `string | undefined`.
 *
 * Arrays are walked but not filtered: a `null` *element* is a mistake
 * worth surfacing as a validation error, not silently removing.
 */
export function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) continue;
    out[key] = stripNulls(v);
  }
  return out;
}

/**
 * Shannon entropy in bits per character. A uniformly random alphanumeric
 * secret (e.g. `openssl rand -base64 32`) lands well above 4 bits/char;
 * a degenerate value (all one character, a short repeating pattern, or a
 * low-cardinality string like `"aaaaaaaa...bbbbbbbb..."`) lands well below.
 */
function shannonEntropyBitsPerChar(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** CF2-17 (2026-06-30 cold audit): minimum entropy every signing key must clear. */
const SIGNING_KEY_MIN_ENTROPY_BITS_PER_CHAR = 3.0;

/**
 * CF2-17: length alone doesn't rule out a low-entropy secret — a 32-char
 * string of one repeated character (or a short repeating cycle) passes a
 * bare `.min(32)` check but is trivially guessable. Centralizes the
 * length + entropy pair so every HS256 signing key
 * (`auth.native.jwt.hs256.current` / `.previous`) is validated
 * identically instead of hand-copied `.min(32)` calls.
 *
 * `path` is the dotted config path, used verbatim in the error message
 * so an operator can find the offending line in `config.yaml`.
 */
export function signingKeySchema(path: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .min(32, { message: `${path} must be at least 32 characters` })
    .refine((key) => shannonEntropyBitsPerChar(key) >= SIGNING_KEY_MIN_ENTROPY_BITS_PER_CHAR, {
      message:
        `${path} is too low-entropy to be a real signing key ` +
        `(looks like a repeated/patterned value, not a random secret) — ` +
        `generate one with \`openssl rand -base64 32\` or similar`,
    })
    .optional();
}

/**
 * Validates an RSA private key in PEM (PKCS8) form at boot (ADR 030
 * Phase A). Two-step:
 *
 * 1. `transform` — normalise escaped `\n` sequences to real newlines.
 *    A multi-line PEM is natural in YAML (use a `|` block scalar), but
 *    a key copied out of a secret store may still arrive flattened to a
 *    single line with literal backslash-n, which `createPrivateKey`
 *    rejects. Normalising here means consumers (auth/signer.ts) always
 *    see a parseable PEM.
 * 2. `superRefine` — actually parse the key with node:crypto and
 *    require `asymmetricKeyType === 'rsa'`. A malformed PEM (or an
 *    EC/Ed25519 key pasted by mistake) fails `loadConfig()` and the
 *    boot, rather than surfacing as a 500 on the first token mint.
 */
export const rsaPrivateKeyPem = z
  .string()
  .transform((v) => v.replace(/\\n/g, '\n'))
  .superRefine((pem, ctx) => {
    try {
      const key = createPrivateKey(pem);
      if (key.asymmetricKeyType !== 'rsa') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `must be an RSA private key, got ${key.asymmetricKeyType ?? 'unknown'}`,
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'must be a PEM-encoded (PKCS8) RSA private key — generate with ' +
          '`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048`',
      });
    }
  });

/**
 * Decodes a 32-byte symmetric key supplied as base64 / base64url / hex.
 * Returns `null` when the value doesn't decode to exactly 32 bytes.
 * Shared by the schema (which rejects a wrong-length key at boot) and
 * by the redeem-crypto consumer.
 */
export function decode32ByteKey(raw: string): Buffer | null {
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  return bytes.length === 32 ? bytes : null;
}
