/**
 * config section: `orders:` — gift-card redemption secrets and the
 * fallback cashback split.
 *
 * See `./server.ts` for what a section module is.
 */
import { z } from 'zod';
import { decode32ByteKey } from '../schema-helpers.js';

/**
 * A percent of face value, 0-100, with at most two decimal places.
 *
 * These were percent-shaped *strings* under env (`"8.00"`, guarded by a
 * regex) because `process.env` has no numbers and a bare
 * `z.coerce.number()` would have accepted `"eight"` as NaN. YAML has
 * real numbers, so this is a number with the same two-decimal bound
 * expressed directly.
 */
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
        // Gift-card redeem-secret envelope key (CF-25 / X-PRIV-03).
        // When set, `orders.redeem_code` / `redeem_pin` are
        // AES-256-GCM-encrypted at rest (orders/redeem-crypto.ts) so a
        // logical DB read (leaked connection string, rogue read-only
        // query, backup exfiltration) sees ciphertext, not spendable
        // bearer codes. `redeem_url` stays plaintext — it's the
        // redemption landing page, not the secret.
        //
        // 32 bytes, supplied as base64 / base64url or hex. NS-10:
        // REQUIRED in production — `../../config.ts` fails closed at
        // boot when it's unset in prod, with an explicit
        // `unsafe.allowPlaintextRedeemSecrets` rollback opt-out. Absent
        // in dev/test → encryption is disabled and codes are stored
        // plaintext; index.ts logs a single boot warn while unset.
        //
        // Decrypt is backward-safe: old plaintext rows and key-unset
        // writes pass through untouched, so setting the key activates
        // encryption for new writes;
        // `scripts/backfill-redeem-encryption.ts` encrypts any
        // pre-existing plaintext rows as a deploy step. NOT a JWT/HMAC
        // secret — keep it separate from `auth.native.jwt`.
        //
        // The length check lives on the field itself rather than in a
        // boot guard: a wrong-length key would otherwise silently write
        // ciphertext nobody can later decrypt (the read path throws on
        // every order).
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

    // Defaults for the cashback split when a merchant has no admin-set
    // cashback config (ADR 011), applied as a fallback so newly-synced
    // merchants aren't accidentally zero-cashback before ops gets to
    // them. Percent of face value, at most two decimal places; the sum
    // is boot-checked against the `userCashback + margin + wholesale =
    // 100` invariant in `../../config.ts` so a misconfigured deployment
    // can't silently over-grant cashback at order-creation time.
    //
    // The old env names carried an `_OF_CTX` suffix tracing back to the
    // ADR wording ("of CTX's discount to Loop"); they are applied
    // directly to face value today because the per-merchant CTX-discount
    // rate isn't in the catalog's hot data. Default 0/0 — zero cashback,
    // zero margin — until ops explicitly opts in.
    cashbackDefaults: z
      .object({
        userCashbackPct: percentOfFaceValue.default(0),
        loopMarginPct: percentOfFaceValue.default(0),
      })
      .prefault({}),
  })
  .prefault({});
