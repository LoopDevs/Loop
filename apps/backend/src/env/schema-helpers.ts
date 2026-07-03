/**
 * env.ts shared schema helpers (hardening D2 split). Zod field helpers +
 * boot-tripwire constants used across the env section modules
 * (`./sections/*`) and `parseEnv` in `../env.ts`. Extracted so the
 * section modules can import them without a cycle through `env.ts`.
 */
import { createPrivateKey } from 'node:crypto';
import { z } from 'zod';

export const STELLAR_ADDRESS_MESSAGE = 'must be a valid Stellar public key (G...)';

/**
 * Circle's canonical USDC issuer account on Stellar mainnet. Used by
 * the boot-time tripwire below — a launch-runbook typo once shipped a
 * wrong issuer address, which makes the payment watcher silently
 * ignore every legitimate USDC deposit.
 */
export const CANONICAL_MAINNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

/** Stellar mainnet (pubnet) network passphrase. */
export const MAINNET_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015';

/**
 * Parses a process.env boolean the way operators actually write them.
 *
 * `z.coerce.boolean()` is a footgun here: it uses JavaScript's truthy
 * semantics, so `"false"`, `"0"`, and `"no"` all coerce to `true`
 * (any non-empty string is truthy). An operator setting
 * `TRUST_PROXY=false` would silently enable X-Forwarded-For trust —
 * the opposite of what they wrote.
 *
 * Accept a small set of conventional strings, case-insensitive:
 * - true / 1 / yes / on → true
 * - false / 0 / no / off / "" → false
 * Anything else rejects with a clear validation error rather than
 * picking a direction silently.
 */
export const envBoolean = z.union([z.boolean(), z.string()]).transform((v, ctx) => {
  if (typeof v === 'boolean') return v;
  const s = v.trim().toLowerCase();
  if (s === 'true' || s === '1' || s === 'yes' || s === 'on') return true;
  if (s === 'false' || s === '0' || s === 'no' || s === 'off' || s === '') return false;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: `expected boolean (true/false/1/0/yes/no/on/off), got ${JSON.stringify(v)}`,
  });
  return z.NEVER;
});

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
 * length + entropy pair so every HS256 signing key (`LOOP_JWT_SIGNING_KEY`,
 * its `_PREVIOUS`, `LOOP_ADMIN_STEP_UP_SIGNING_KEY`, its `_PREVIOUS`) is
 * validated identically instead of four hand-copied `.min(32)` calls.
 */
export function signingKeySchema(varName: string): z.ZodOptional<z.ZodString> {
  return z
    .string()
    .min(32, { message: `${varName} must be at least 32 characters` })
    .refine((key) => shannonEntropyBitsPerChar(key) >= SIGNING_KEY_MIN_ENTROPY_BITS_PER_CHAR, {
      message:
        `${varName} is too low-entropy to be a real signing key ` +
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
 *    PEM-in-env-var is a classic deployment footgun: some secret
 *    stores flatten the multiline value to a single line with literal
 *    backslash-n, which `createPrivateKey` rejects. Normalising here
 *    means consumers (auth/signer.ts) always see a parseable PEM.
 * 2. `superRefine` — actually parse the key with node:crypto and
 *    require `asymmetricKeyType === 'rsa'`. A malformed PEM (or an
 *    EC/Ed25519 key pasted by mistake) fails `parseEnv()` and the
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
