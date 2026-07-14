import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ORDER_STATES,
  ORDER_PAYMENT_METHODS,
  PAYOUT_STATES,
  CREDIT_TRANSACTION_TYPES,
} from '@loop/shared';

/**
 * COR-14 (ADR 019): single-source parity for the money/order enums.
 *
 * ADR 019 makes the TS tuples in `@loop/shared` the single source of
 * truth for a stack that must move together: the tuple, the Drizzle
 * CHECK mirror in `db/schema/*.ts`, the hand-written migration DDL, and
 * the live DB. Five money/order enums are pinned to a DB CHECK this
 * way; only ONE — `orders_currency_known` / `ORDERABLE_CURRENCIES` —
 * actually had a gate that reads the CHECK source and asserts it equals
 * the tuple (`orders-currency-check.test.ts`).
 *
 * The other four only had *pin* tests (`order-state.test.ts`,
 * `payout-state.test.ts`, `orders-schema.test.ts`, `wire-enums.test.ts`),
 * which assert the tuple against a HARD-CODED literal array and never
 * read the CHECK at all. That misses the drift ADR 019 exists to catch:
 * a migration adds/removes a CHECK literal (or the tuple + its pin get
 * edited together) while the DB CHECK is left behind, and a row valid in
 * TS violates the DB CHECK (or vice versa) with nothing failing in CI.
 *
 * This test closes that gap for the remaining four, mirroring the
 * currency gate: parse the CHECK literals from the authoritative sources
 * and assert set-equality with the tuple. It FAILS if a literal is added
 * to one side but not the other.
 *
 * Sources parsed (both, per enum):
 *  - the Drizzle mirror in `db/schema/*.ts` — what the ORM believes; the
 *    check-migration-parity gate separately pins this mirror to the live
 *    DB, so tuple==mirror + mirror==DB gives tuple==DB.
 *  - the hand-written migration chain — what production actually runs. A
 *    CHECK can be re-defined by a later DROP+ADD migration (e.g.
 *    `orders_payment_method_known` gained `loop_asset` in 0008), so we
 *    take the LAST migration in chain order that defines the literal set,
 *    never the initial one.
 */

const root = new URL('../../../', import.meta.url);
function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, root)), 'utf8');
}

/**
 * Pull the string literals out of the `… IN ('a', 'b', …)` list that
 * follows the named CHECK constraint. Anchors on the LAST occurrence of
 * the constraint name so a DROP-then-ADD within one migration file
 * yields the ADD's (authoritative) list, and the first `IN (…)` after
 * that name is the constraint's own value list. Works on both the raw
 * SQL migrations (`… IN (…)`) and the Drizzle `sql\`${t.col} IN (…)\``
 * mirror in schema.ts.
 */
function checkLiterals(source: string, constraintName: string): string[] {
  const idx = source.lastIndexOf(constraintName);
  if (idx === -1) return [];
  const m = source.slice(idx).match(/IN\s*\(([^)]*)\)/i);
  if (m === null) return [];
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const MIGRATIONS_DIR = 'src/db/migrations';

/**
 * The literal set of a CHECK constraint as the migration CHAIN would
 * leave it: scan every `*.sql` in order and keep the last file that
 * defines the constraint's `IN (…)` list. (None of these four enums is
 * ever dropped-without-readd, so "last non-empty" is the effective set.)
 */
function authoritativeMigrationLiterals(constraint: string): string[] {
  const dir = fileURLToPath(new URL(`${MIGRATIONS_DIR}/`, root));
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  let last: string[] = [];
  for (const f of files) {
    const lits = checkLiterals(read(`${MIGRATIONS_DIR}/${f}`), constraint);
    if (lits.length > 0) last = lits;
  }
  return last;
}

const ENUMS = [
  {
    name: 'ORDER_STATES → orders_state_known (ADR 010)',
    tuple: ORDER_STATES,
    constraint: 'orders_state_known',
    schemaFile: 'src/db/schema/orders.ts',
  },
  {
    name: 'ORDER_PAYMENT_METHODS → orders_payment_method_known (ADR 010/015)',
    tuple: ORDER_PAYMENT_METHODS,
    constraint: 'orders_payment_method_known',
    schemaFile: 'src/db/schema/orders.ts',
  },
  {
    name: 'PAYOUT_STATES → pending_payouts_state_known (ADR 015/016)',
    tuple: PAYOUT_STATES,
    constraint: 'pending_payouts_state_known',
    schemaFile: 'src/db/schema/payments.ts',
  },
  {
    name: 'CREDIT_TRANSACTION_TYPES → credit_transactions_type_known (ADR 009)',
    tuple: CREDIT_TRANSACTION_TYPES,
    constraint: 'credit_transactions_type_known',
    schemaFile: 'src/db/schema/credits.ts',
  },
] as const;

describe.each(ENUMS)(
  '$name single-source parity (COR-14 / ADR 019)',
  ({ tuple, constraint, schemaFile }) => {
    it('the Drizzle schema mirror CHECK lists exactly the TS tuple', () => {
      const literals = checkLiterals(read(schemaFile), constraint);
      // Guard against a silently-empty parse (renamed constraint, changed
      // DSL) masquerading as a pass.
      expect(literals.length).toBeGreaterThan(0);
      expect(new Set(literals)).toEqual(new Set(tuple));
    });

    it('the authoritative migration CHECK lists exactly the TS tuple', () => {
      const literals = authoritativeMigrationLiterals(constraint);
      expect(literals.length).toBeGreaterThan(0);
      expect(new Set(literals)).toEqual(new Set(tuple));
    });
  },
);
