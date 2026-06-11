/**
 * Credit-ledger transaction types (ADR 009).
 *
 * Every row in `credit_transactions` has one of these types. The
 * list is the source of truth for:
 *
 * - the Drizzle `CHECK` constraint on `credit_transactions.type`
 *   (`apps/backend/src/db/schema.ts`),
 * - the zod enum gating admin / user query-string `?type=` filters
 *   (`apps/backend/src/openapi.ts`, `apps/backend/src/admin/user-credit-transactions.ts`),
 * - the `LEDGER_LABELS` map the web renders on `/settings/cashback`,
 *   `/auth`, and the admin `CreditTransactionsTable`.
 *
 * Drift between the three is an ADR 019 invariant violation —
 * editing this tuple requires matching the Drizzle CHECK literal
 * in `db/schema.ts`, the migration that introduced the type, and
 * the UI label map (TypeScript will catch the last one because
 * `Record<CreditTransactionType, string>` gates it).
 *
 * Sign convention:
 * - `cashback` / `interest` / `refund` → always positive.
 * - `spend` / `withdrawal` → always negative.
 * - `adjustment` → signed; ops discretion (correcting a prior bug).
 *
 * ADR 036: `withdrawal` is no longer written by any live path — the
 * ADR-024 writer was re-scoped to *emission*, which never debits the
 * mirror and writes no ledger row. The type stays in the tuple for
 * (a) historical pre-ADR-036 rows (they discriminate
 * legacy/compensable emission payouts) and (b) the future fiat-out
 * redemption rail, which WILL debit (ADR 036 §Decision 4).
 */
export const CREDIT_TRANSACTION_TYPES = [
  'cashback',
  'interest',
  'spend',
  'withdrawal',
  'refund',
  'adjustment',
] as const;
export type CreditTransactionType = (typeof CREDIT_TRANSACTION_TYPES)[number];

export function isCreditTransactionType(s: string): s is CreditTransactionType {
  return (CREDIT_TRANSACTION_TYPES as readonly string[]).includes(s);
}
