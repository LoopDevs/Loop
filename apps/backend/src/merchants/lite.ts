import type { Merchant } from '@loop/shared';

// S4-7 `fields=lite` projection — browse/search don't render these fields
export function toLiteMerchant(m: Merchant): Merchant {
  const copy = { ...m };
  delete copy.description;
  delete copy.instructions;
  delete copy.terms;
  return copy;
}
