// Upstream CTX merchant Zod schemas + mapper — A2-1706
import type { Merchant, MerchantDenominations } from '@loop/shared';
import { z } from 'zod';

// Caps prevent compromised/buggy upstream from bloating cached merchant lists
const MAX_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_CURRENCY_LENGTH = 10;
const MAX_INFO_LENGTH = 50_000;

// A2-1706: exported for contract-test schema drift detection
export const UpstreamMerchantSchema = z
  .object({
    id: z.string().min(1).max(MAX_ID_LENGTH),
    name: z.string().min(1).max(MAX_NAME_LENGTH),
    slug: z.string().max(MAX_NAME_LENGTH).optional(),
    logoUrl: z.string().max(MAX_URL_LENGTH).optional(),
    cardImageUrl: z.string().max(MAX_URL_LENGTH).optional(),
    mapPinUrl: z.string().max(MAX_URL_LENGTH).optional(),
    enabled: z.boolean(),
    // Operator-scoped: effective status for this operator, authoritative over `enabled`
    status: z.string().max(32).optional(),
    // Operator-scoped: link row id is the bulk `PUT /merchant-links` key for ADR 052 cashback push
    link: z
      .object({
        id: z.string().optional(),
        operatorDiscountBasisPoints: z.number().optional(),
        userDiscountBasisPoints: z.number().optional(),
      })
      .passthrough()
      .optional(),
    // RFC 3339 timestamp; carried to `Merchant.updatedAt` for image cache-busting
    updated: z.string().max(64).optional(),
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

// `.safeParse` per merchant so one malformed entry doesn't poison the page
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

export function mapUpstreamMerchant(item: UpstreamMerchant): Merchant | null {
  if (!item.name) return null;
  // `status` is per-operator effective status, authoritative over `enabled`
  const effectivelyEnabled = item.status !== undefined ? item.status === 'enabled' : item.enabled;
  if (!effectivelyEnabled) return null;

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

  // Upstream `savingsPercentage` is in hundredths (400 = 4.00%); per-link override beats merchant default
  const savingsBasisPoints = item.link?.userDiscountBasisPoints ?? item.savingsPercentage;
  const savingsPercentage = savingsBasisPoints !== undefined ? savingsBasisPoints / 100 : undefined;

  const intro = item.info?.intro;
  const description = item.info?.description;
  const instructions = item.info?.instructions;
  const terms = item.info?.terms;
  const locationCount = item.locationCount ?? item.cachedLocationCount;

  return {
    id: item.id,
    name: item.name,
    // CTX brand-country slug; preferred over derived value to keep Loop URLs aligned with CTX
    ...(item.slug ? { slug: item.slug } : {}),
    ...(item.logoUrl ? { logoUrl: item.logoUrl } : {}),
    ...(item.cardImageUrl ? { cardImageUrl: item.cardImageUrl } : {}),
    ...(savingsPercentage !== undefined ? { savingsPercentage } : {}),
    ...(denominations !== undefined ? { denominations } : {}),
    ...(intro ? { intro } : {}),
    ...(description ? { description } : {}),
    ...(instructions ? { instructions } : {}),
    ...(terms ? { terms } : {}),
    enabled: effectivelyEnabled,
    ...(locationCount !== undefined ? { locationCount } : {}),
    ...(item.country ? { country: item.country } : {}),
    ...(item.updated ? { updatedAt: item.updated } : {}),
  };
}
