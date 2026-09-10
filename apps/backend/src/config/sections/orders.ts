// config section: `orders:` — gift-card redemption secrets and the fallback cashback split.
import { z } from 'zod';
import { decode32ByteKey } from '../schema-helpers.js';

// YAML has real numbers, so this is a number with the same two-decimal bound expressed directly.
const percentOfFaceValue = z
  .number()
  .min(0)
  .max(100)
  .refine(
    (n) => Number.isInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9,
    {
      message: 'must be a 0-100 percent with at most 2 decimal places',
    },
  );

export const ordersSchema = z
  .object({
    redeem: z
      .object({
        // CF-25 / X-PRIV-03: AES-256-GCM-encrypted at rest to prevent logical DB reads from exposing spendable bearer codes.
        // NS-10: REQUIRED in production — `../../config.ts` fails closed at boot when unset in prod.
        // The length check lives on the field itself rather than in a boot guard: a wrong-length key would otherwise silently write ciphertext nobody can later decrypt.
        encryptionKey: z
          .string()
          .min(1)
          .refine((raw) => decode32ByteKey(raw) !== null, {
            message:
              'must decode to exactly 32 bytes — supply 32 random bytes as base64 or hex ' +
              '(e.g. `openssl rand -base64 32`)',
          })
          .optional(),
      })
      .prefault({}),

    // ADR 011: fallback for merchants without admin-set cashback config.
    // Boot-checked against the `userCashback + margin + wholesale = 100` invariant in `../../config.ts` to prevent silent over-granting.
    cashbackDefaults: z
      .object({
        userCashbackPct: percentOfFaceValue.default(0),
        loopMarginPct: percentOfFaceValue.default(0),
      })
      .prefault({}),
  })
  .prefault({});
