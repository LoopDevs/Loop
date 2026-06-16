import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORDERABLE_CURRENCIES, HOME_CURRENCIES, EXTENDED_ORDER_CURRENCIES } from '@loop/shared';

/**
 * CF-19 (ADR 035): the `orders.currency` (catalog-side) CHECK now admits
 * the extended supplier-currency display markets. This list lives in
 * THREE places that must stay in lock-step or an extended-market order
 * either 400s at the handler, fails the schema-parity gate, or hits a
 * raw DB CHECK violation surfaced as a 500:
 *
 *   1. `ORDERABLE_CURRENCIES` in `@loop/shared` — the handler validation set.
 *   2. The `orders_currency_known` CHECK in `db/schema.ts` (drizzle mirror).
 *   3. The `orders_currency_known` CHECK in migration 0037 (the real DDL).
 *
 * These tests pin all three to the same set so a future currency
 * addition that forgets one of the three fails here, in unit tests,
 * long before it can corrupt an order row or 500 a paid customer.
 */

const root = new URL('../../../', import.meta.url);
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
}

/**
 * Pull the currency codes out of the `… IN ('A', 'B', …)` list that
 * follows the `orders_currency_known` constraint name. Works on both the
 * raw SQL migration (`currency IN (…)`) and the drizzle mirror in
 * schema.ts (``sql`${t.currency} IN (…)` ``).
 */
function currenciesInOrdersCheck(sql: string): string[] {
  const idx = sql.indexOf('orders_currency_known');
  if (idx === -1) return [];
  const m = sql.slice(idx).match(/IN\s*\(([^)]*)\)/);
  if (m === null) return [];
  return [...m[1]!.matchAll(/'([A-Z]{3})'/g)].map((x) => x[1]!);
}

describe('ORDERABLE_CURRENCIES (CF-19 / ADR 035)', () => {
  it('is exactly the home currencies plus the extended display markets', () => {
    expect(new Set(ORDERABLE_CURRENCIES)).toEqual(
      new Set([...HOME_CURRENCIES, ...EXTENDED_ORDER_CURRENCIES]),
    );
  });

  it('extended markets are AE/IN/SA/AU/MX currencies, disjoint from home', () => {
    expect(new Set(EXTENDED_ORDER_CURRENCIES)).toEqual(
      new Set(['AED', 'INR', 'SAR', 'AUD', 'MXN']),
    );
    for (const c of EXTENDED_ORDER_CURRENCIES) {
      expect(HOME_CURRENCIES as readonly string[]).not.toContain(c);
    }
  });
});

describe('orders_currency_known CHECK mirror', () => {
  it('migration 0037 lists exactly ORDERABLE_CURRENCIES', () => {
    const sql = read('src/db/migrations/0037_orders_currency_extended_markets.sql');
    // The migration drops then re-adds the constraint; the ADD is the
    // authoritative list. Take the last IN(...) so the (commented) DROP
    // and pre-flight SELECT don't interfere.
    const adds = sql
      .split('ADD CONSTRAINT')
      .slice(1)
      .map((chunk) => currenciesInOrdersCheck('orders_currency_known' + chunk))
      .filter((list) => list.length > 0);
    expect(adds.length).toBeGreaterThan(0);
    expect(new Set(adds.at(-1)!)).toEqual(new Set(ORDERABLE_CURRENCIES));
  });

  it('schema.ts drizzle mirror lists exactly ORDERABLE_CURRENCIES', () => {
    const sql = read('src/db/schema.ts');
    expect(new Set(currenciesInOrdersCheck(sql))).toEqual(new Set(ORDERABLE_CURRENCIES));
  });
});
