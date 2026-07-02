import { describe, expect, it } from 'vitest';

import { CREDIT_TRANSACTION_TYPES, isCreditTransactionType } from './credit-transaction-type.js';

describe('CREDIT_TRANSACTION_TYPES', () => {
  it('pins the ADR 009 ledger row types exactly', () => {
    // Mirrors the CHECK on credit_transactions.type in db/schema.ts —
    // `withdrawal` stays for historical rows + the future fiat-out rail
    // (ADR 036) even though no live path writes it.
    expect(CREDIT_TRANSACTION_TYPES).toEqual([
      'cashback',
      'interest',
      'spend',
      'withdrawal',
      'refund',
      'adjustment',
    ]);
  });

  it('isCreditTransactionType narrows members and rejects non-members', () => {
    for (const t of CREDIT_TRANSACTION_TYPES) expect(isCreditTransactionType(t)).toBe(true);
    expect(isCreditTransactionType('emission')).toBe(false);
    expect(isCreditTransactionType('Cashback')).toBe(false);
    expect(isCreditTransactionType('')).toBe(false);
  });
});
