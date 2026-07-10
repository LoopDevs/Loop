import type { Merchant } from '@loop/shared';

/**
 * Strips the long-form `description` / `instructions` / `terms` fields
 * from a merchant record — the S4-7 `fields=lite` projection
 * (`GET /api/merchants/all?fields=lite`). Shared with
 * `GET /api/merchants/search`, which reuses the same projection for
 * the same reason: neither the browse directory nor the search
 * dropdown/grid renders these fields (only the detail page does, via
 * `/by-slug` + `/:id`), so there's no reason to ship them.
 */
export function toLiteMerchant(m: Merchant): Merchant {
  const copy = { ...m };
  delete copy.description;
  delete copy.instructions;
  delete copy.terms;
  return copy;
}
