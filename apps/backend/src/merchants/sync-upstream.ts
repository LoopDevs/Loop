/**
 * Upstream CTX merchant Zod schemas + the mapper that converts a
 * parsed upstream record to our internal `Merchant` shape.
 *
 * Lifted out of `apps/backend/src/merchants/sync.ts` so the parsing
 * + mapping logic has a focused home, separate from the refresh
 * loop / pagination / store-replacement plumbing in the parent
 * file.
 *
 * `UpstreamMerchantSchema` and `UpstreamListResponseSchema` are
 * re-exported from `sync.ts` so the existing import path used by
 * the CTX contract test (`apps/backend/src/__tests__/ctx-contract.test.ts`)
 * keeps working without changes.
 */
import type { Merchant, MerchantDenominations } from '@loop/shared';
import { z } from 'zod';
import { env } from '../env.js';

// Size caps stop a compromised or buggy upstream from bloating every merchant
// list response (which we cache and serve to every client). Generous relative
// to real merchant data but tight enough to catch "CTX returns a 1MB string".
const MAX_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_CURRENCY_LENGTH = 10;
const MAX_INFO_LENGTH = 50_000;

/**
 * Zod schema for upstream CTX merchants. Required fields (id, name, enabled)
 * are validated strictly; everything else is optional because CTX sometimes
 * omits them. `.passthrough()` preserves unknown fields without rejection.
 *
 * A2-1706: exported (and re-exported from `sync.ts`) so the contract-test
 * suite can parse recorded CTX fixtures through it at PR-time and detect
 * schema drift.
 */
export const UpstreamMerchantSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    name: z.string().min(1).max(MAX_NAME_LENGTH),
    slug: z.string().max(MAX_NAME_LENGTH).optional(),
    logoUrl: z.string().max(MAX_URL_LENGTH).optional(),
    cardImageUrl: z.string().max(MAX_URL_LENGTH).optional(),
    mapPinUrl: z.string().max(MAX_URL_LENGTH).optional(),
    enabled: z.boolean(),
    country: z.string().max(MAX_CURRENCY_LENGTH).optional(),
    currency: z.string().max(MAX_CURRENCY_LENGTH).optional(),
    savingsPercentage: z.number().optional(),
    userDiscount: z.number().optional(),
    denominationsType: z.enum(['fixed', 'min-max']).optional(),
    denominations: z.array(z.string().max(32)).optional(),
    denominationValues: z.array(z.string().max(32)).optional(),
    locationCount: z.number().optional(),
    cachedLocationCount: z.number().optional(),
    redeemType: z.string().max(64).optional(),
    redeemLocation: z.string().max(64).optional(),
    info: z
      .object({
        description: z.string().max(MAX_INFO_LENGTH).optional(),
        instructions: z.string().max(MAX_INFO_LENGTH).optional(),
        intro: z.string().max(MAX_INFO_LENGTH).optional(),
        terms: z.string().max(MAX_INFO_LENGTH).optional(),
      })
      .optional(),
  })
  .passthrough();

export type UpstreamMerchant = z.infer<typeof UpstreamMerchantSchema>;

// Wrap individual merchants in .safeParse so one malformed entry does not
// poison the whole page — we skip it and keep going.
export const UpstreamListResponseSchema = z
  .object({
    pagination: z.object({
      page: z.number().int().nonnegative(),
      pages: z.number().int().nonnegative(),
      perPage: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
    }),
    result: z.array(z.unknown()),
  })
  .passthrough();

/**
 * Maps an upstream CTX merchant to our Merchant type.
 * The upstream returns all fields flat (no nested `data` JSON blob).
 */
export function mapUpstreamMerchant(item: UpstreamMerchant): Merchant | null {
  if (!item.name) return null;
  // NOTE: CTX currently returns all 117 merchants with enabled: true.
  // This filter only matters if CTX starts returning disabled merchants.
  if (!item.enabled && !env.INCLUDE_DISABLED_MERCHANTS) return null;

  // Parse denominations from the flat upstream fields
  let denominations: MerchantDenominations | undefined;
  const currency = item.currency ?? 'USD';

  if (item.denominationsType === 'fixed' && item.denominations?.length) {
    denominations = {
      type: 'fixed',
      denominations: item.denominations,
      currency,
    };
  } else if (item.denominationsType === 'min-max' && item.denominations?.length) {
    // Upstream sends min-max as denominations array: ["5", "200"] = [$5, $200]
    const values = item.denominations
      .map(Number)
      .filter((n) => !isNaN(n))
      .sort((a, b) => a - b);
    denominations = {
      type: 'min-max',
      denominations: item.denominations,
      currency,
      ...(values[0] !== undefined ? { min: values[0] } : {}),
      ...(values[values.length - 1] !== undefined ? { max: values[values.length - 1] } : {}),
    };
  }

  // savingsPercentage from upstream is in hundredths (e.g. 400 = 4.00%).
  // Convert to percentage for display (4.0).
  const savingsPercentage =
    item.savingsPercentage !== undefined ? item.savingsPercentage / 100 : undefined;

  const description = item.info?.description;
  const instructions = item.info?.instructions;
  const terms = item.info?.terms;
  const locationCount = item.locationCount ?? item.cachedLocationCount;

  return {
    id: item.id,
    name: item.name,
    ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
    ...(item.cardImageUrl ? { cardImageUrl: item.cardImageUrl } : {}),
    ...(savingsPercentage !== undefined ? { savingsPercentage } : {}),
    ...(denominations !== undefined ? { denominations } : {}),
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
    ...(terms ? { terms } : {}),
    // Reflect the actual upstream flag — hardcoding true was a bug that
    // only didn't bite because CTX currently returns all merchants enabled.
    // With INCLUDE_DISABLED_MERCHANTS=true (dev), this lets the UI see the
    // real state instead of a falsified `enabled: true` on every record.
    enabled: item.enabled,
    ...(locationCount !== undefined ? { locationCount } : {}),
  };
}
