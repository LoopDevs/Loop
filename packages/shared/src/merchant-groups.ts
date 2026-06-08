import type { Merchant } from './merchants.js';

/**
 * Merchant variant grouping (ADR 032).
 *
 * CTX models one merchant per supplier SKU, so a single brand fragments into many
 * listings (e.g. `dots.eco - Plant a Tree`, `dots.eco - Buy Land`, …). This collapses
 * those variants under one brand group for display. It is the client-side stand-in
 * for a future CTX `group` field — keep the field name (`group`) in mind so the
 * derivation can be swapped for a server-provided value without touching callers.
 */
export interface MerchantGroup {
  /** Stable, case-insensitive key for the brand group. */
  key: string;
  /** Brand display name (most common casing among members). */
  name: string;
  /** The brand's listings: the base listing (if any) plus its variants. */
  members: Merchant[];
  /** True when there is more than one member — render as a single collapsed brand tile. */
  isGroup: boolean;
}

/** Splits `"Brand - Variant"` into its brand name and optional variant label. */
export function splitMerchantName(name: string): { group: string; variant?: string | undefined } {
  const i = name.indexOf(' - ');
  if (i > 0) {
    const variant = name.slice(i + 3).trim();
    return { group: name.slice(0, i).trim(), variant: variant || undefined };
  }
  return { group: name.trim() };
}

/** The label to show for a single listing within its group (the part after `"Brand - "`). */
export function variantLabel(m: Merchant): string {
  return splitMerchantName(m.name).variant ?? m.name;
}

const normalizeKey = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Groups merchants by brand. Listings named `"Brand - Variant"` collapse under one
 * `"Brand"` group; grouping is case-insensitive (so `dots.eco` and `Dots.eco` merge).
 * A group with a single member is returned with `isGroup: false` and renders normally.
 * Input order is preserved within each group and across groups (first-seen brand order).
 */
export function groupMerchants(merchants: Merchant[]): MerchantGroup[] {
  const byKey = new Map<string, { names: Map<string, number>; members: Merchant[] }>();
  for (const m of merchants) {
    const { group } = splitMerchantName(m.name);
    const key = normalizeKey(group);
    let entry = byKey.get(key);
    if (!entry) {
      entry = { names: new Map(), members: [] };
      byKey.set(key, entry);
    }
    entry.names.set(group, (entry.names.get(group) ?? 0) + 1);
    entry.members.push(m);
  }

  const groups: MerchantGroup[] = [];
  for (const [key, entry] of byKey) {
    // Canonical display name = most common casing of the brand prefix.
    const name = [...entry.names.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    groups.push({ key, name, members: entry.members, isGroup: entry.members.length > 1 });
  }
  return groups;
}
