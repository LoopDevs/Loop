// A2-803 / D1 (orders slice): single source of truth for `POST /api/orders/loop` body shape
import { z } from 'zod';

// `amountMinor` accepts number OR digit-string so BigInt face values survive JSON (JS numbers lose integer precision past 2^53)
export const LoopCreateOrderBody = z.object({
  merchantId: z.string().min(1),
  amountMinor: z
    .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
    .transform((v) => BigInt(v))
    .refine((v) => v > 0n, { message: 'amountMinor must be positive' }),
  currency: z
    .string()
    .length(3)
    .transform((v) => v.toUpperCase()),
  cryptoCurrency: z
    .string()
    .min(1)
    .max(32)
    .transform((v) => v.toUpperCase()),
});
