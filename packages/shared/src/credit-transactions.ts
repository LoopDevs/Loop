/**
 * Credit-transaction type enum (ADR 009).
 *
 * Mirrors the CHECK constraint on `credit_transactions.type`. Also
 * encodes the sign convention for each type so consumers can validate
 * an `(type, amountMinor)` tuple without re-reading the ADR:
 *
 *   cashback / interest / refund → positive (balance goes up)
 *   spend / withdrawal           → negative (balance goes down)
 *   adjustment                   → either sign (support-mediated)
 *
 * Shared between backend (db schema CHECK literals, openapi zod,
 * admin Discord audit notifier) and web (ledger filter chips,
 * services/user.ts type declaration, admin.treasury.tsx known-types
 * list). One enum instead of five redeclarations.
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

/** Narrowing helper. Use when coercing strings from server responses. */
export function isCreditTransactionType(value: string): value is CreditTransactionType {
  return (CREDIT_TRANSACTION_TYPES as ReadonlyArray<string>).includes(value);
}

/**
 * Expected sign of the `amount_minor` column for a given transaction
 * type. `'either'` means the row can be positive or negative; the
 * database CHECK defers to the type-specific rule.
 */
export type CreditAmountSign = 'positive' | 'negative' | 'either';

const SIGN_BY_TYPE: Record<CreditTransactionType, CreditAmountSign> = {
  cashback: 'positive',
  interest: 'positive',
  refund: 'positive',
  spend: 'negative',
  withdrawal: 'negative',
  adjustment: 'either',
};

/** Expected amount-sign for a credit-transaction type. Total. */
export function expectedCreditAmountSign(type: CreditTransactionType): CreditAmountSign {
  return SIGN_BY_TYPE[type];
}
