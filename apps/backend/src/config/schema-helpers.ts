// shared zod helpers for config.yaml — CF2-17
import { z } from 'zod';

// YAML null means "unset"; stripping here lets sections use .optional()/.default() instead of .nullish()
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

// CF2-17 (2026-06-30 cold audit): minimum entropy every signing key must clear.
const SIGNING_KEY_MIN_ENTROPY_BITS_PER_CHAR = 3.0;

// CF2-17: length alone doesn't rule out low-entropy secrets (e.g. repeated chars)
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

export function decode32ByteKey(raw: string): Buffer | null {
  const bytes = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, 'hex')
    : Buffer.from(raw, 'base64');
  return bytes.length === 32 ? bytes : null;
}
