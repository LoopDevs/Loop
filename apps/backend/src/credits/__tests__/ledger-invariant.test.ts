import { describe, it, expect } from 'vitest';
import {
  computeLedgerDriftFromRows,
  type BalanceRow,
  type TransactionRow,
} from '../ledger-invariant.js';

describe('computeLedgerDriftFromRows', () => {
  it('returns empty when balances match transaction sums', () => {
    const balances: BalanceRow[] = [
      { userId: 'u1', currency: 'GBP', balanceMinor: 500n },
      { userId: 'u2', currency: 'USD', balanceMinor: 0n },
    ];
    const transactions: TransactionRow[] = [
      { userId: 'u1', currency: 'GBP', amountMinor: 300n },
      { userId: 'u1', currency: 'GBP', amountMinor: 200n },
    ];
    expect(computeLedgerDriftFromRows(balances, transactions)).toEqual([]);
  });

  it('surfaces a user whose balance is larger than the ledger sum', () => {
    const drift = computeLedgerDriftFromRows(
      [{ userId: 'u1', currency: 'GBP', balanceMinor: 600n }],
      [{ userId: 'u1', currency: 'GBP', amountMinor: 500n }],
    );
    expect(drift).toEqual([
      {
        userId: 'u1',
        currency: 'GBP',
        balanceMinor: '600',
        ledgerSumMinor: '500',
        deltaMinor: '100',
      },
    ]);
  });

  it('surfaces a user whose balance is smaller than the ledger sum', () => {
    const drift = computeLedgerDriftFromRows(
      [{ userId: 'u1', currency: 'GBP', balanceMinor: 400n }],
      [{ userId: 'u1', currency: 'GBP', amountMinor: 500n }],
    );
    expect(drift[0]?.deltaMinor).toBe('-100');
  });

  it('surfaces a balance row with no matching transactions as drift when non-zero', () => {
    const drift = computeLedgerDriftFromRows(
      [{ userId: 'u1', currency: 'GBP', balanceMinor: 100n }],
      [],
    );
    expect(drift).toEqual([
      {
        userId: 'u1',
        currency: 'GBP',
        balanceMinor: '100',
        ledgerSumMinor: '0',
        deltaMinor: '100',
      },
    ]);
  });

  it('does not surface a zero-balance row with no transactions', () => {
    const drift = computeLedgerDriftFromRows(
      [{ userId: 'u1', currency: 'GBP', balanceMinor: 0n }],
      [],
    );
    expect(drift).toEqual([]);
  });

  it('surfaces orphan transactions with no balance row (balance=0)', () => {
    const drift = computeLedgerDriftFromRows(
      [],
      [
        { userId: 'u1', currency: 'GBP', amountMinor: 300n },
        { userId: 'u1', currency: 'GBP', amountMinor: 200n },
      ],
    );
    expect(drift).toEqual([
      {
        userId: 'u1',
        currency: 'GBP',
        balanceMinor: '0',
        ledgerSumMinor: '500',
        deltaMinor: '-500',
      },
    ]);
  });

  it('scopes the sum per (user, currency) — multi-currency drift is reported per row', () => {
    const balances: BalanceRow[] = [
      { userId: 'u1', currency: 'GBP', balanceMinor: 500n },
      { userId: 'u1', currency: 'USD', balanceMinor: 999n }, // drifted
    ];
    const transactions: TransactionRow[] = [
      { userId: 'u1', currency: 'GBP', amountMinor: 500n },
      { userId: 'u1', currency: 'USD', amountMinor: 200n },
    ];
    const drift = computeLedgerDriftFromRows(balances, transactions);
    expect(drift).toEqual([
      {
        userId: 'u1',
        currency: 'USD',
        balanceMinor: '999',
        ledgerSumMinor: '200',
        deltaMinor: '799',
      },
    ]);
  });

  it('orders drifted rows deterministically by userId then currency', () => {
    const balances: BalanceRow[] = [
      { userId: 'b', currency: 'USD', balanceMinor: 1n },
      { userId: 'a', currency: 'USD', balanceMinor: 1n },
      { userId: 'a', currency: 'GBP', balanceMinor: 1n },
    ];
    const drift = computeLedgerDriftFromRows(balances, []);
    expect(drift.map((d) => [d.userId, d.currency])).toEqual([
      ['a', 'GBP'],
      ['a', 'USD'],
      ['b', 'USD'],
    ]);
  });

  it('handles large bigint sums past 2^53 without precision loss', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1
    const drift = computeLedgerDriftFromRows(
      [{ userId: 'u1', currency: 'USD', balanceMinor: huge }],
      [{ userId: 'u1', currency: 'USD', amountMinor: huge - 1n }],
    );
    expect(drift[0]?.deltaMinor).toBe('1');
  });

  it('treats negative ledger totals correctly (e.g. debit-only scenario)', () => {
    const drift = computeLedgerDriftFromRows(
      [{ userId: 'u1', currency: 'GBP', balanceMinor: -500n }],
      [{ userId: 'u1', currency: 'GBP', amountMinor: -500n }],
    );
    expect(drift).toEqual([]);
  });
});
