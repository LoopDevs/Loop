import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ORDERABLE_CURRENCIES, HOME_CURRENCIES, EXTENDED_ORDER_CURRENCIES } from '@loop/shared';

/**
 * CF-19 (ADR 035) / ADR 052: the `orders.currency` (catalog-side)
 * CHECK admits the extended supplier-currency markets. Since ADR 052
 * the order handler validates the request currency against the
 * merchant's CTX catalog entry — so this enumerated fence is the ONLY
 * gate between a currency CTX newly serves and a raw DB CHECK
 * violation surfaced to the customer as a 500. The list lives in
 * THREE places that must stay in lock-step:
 *
 *   1. `ORDERABLE_CURRENCIES` in `@loop/shared` — the canonical set.
 *   2. The `orders_currency_known` CHECK in `db/schema/orders.ts`
 *      (drizzle mirror).
 *   3. The `orders_currency_known` CHECK in the latest migration to
 *      (re)define it (the real DDL — currently 0079).
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

  it('extended markets are the ADR-035 five plus CAD (ADR 052), disjoint from home', () => {
    expect(new Set(EXTENDED_ORDER_CURRENCIES)).toEqual(
      new Set(['AED', 'INR', 'SAR', 'AUD', 'MXN', 'CAD']),
    );
    for (const c of EXTENDED_ORDER_CURRENCIES) {
      expect(HOME_CURRENCIES as readonly string[]).not.toContain(c);
    }
  });
});

describe('orders_currency_known CHECK mirror', () => {
  it('the latest migration to (re)define the constraint lists exactly ORDERABLE_CURRENCIES', () => {
    // Last-write-wins over the migration chain (the same replay model
    // check-money-invariants uses): the constraint has been redefined
    // more than once (0021 → 0037 → 0079), and only the newest ADD is
    // what a fresh database actually enforces. Scanning the whole
    // chain means a future widening migration is picked up here
    // without editing this test — forgetting the shared set or the
    // schema mirror still fails the lock-step.
    const dir = fileURLToPath(new URL('src/db/migrations/', root));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    const defining = files.filter((f) =>
      read(`src/db/migrations/${f}`).includes('ADD CONSTRAINT orders_currency_known'),
    );
    expect(defining.length).toBeGreaterThan(0);
    const sql = read(`src/db/migrations/${defining.at(-1)!}`);
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

  it('schema orders module drizzle mirror lists exactly ORDERABLE_CURRENCIES', () => {
    // D2 split: the orders table + its `orders_currency_known` CHECK
    // moved from db/schema.ts (now a barrel) into db/schema/orders.ts.
    const sql = read('src/db/schema/orders.ts');
    expect(new Set(currenciesInOrdersCheck(sql))).toEqual(new Set(ORDERABLE_CURRENCIES));
  });
});
