/**
 * Order-repo error types.
 *
 * Lives in its own module so both `./repo.ts` (the entry point) and
 * `./repo-credit-order.ts` (the credit-funded txn lifted out for
 * focus) can throw / catch the same `InsufficientCreditError`
 * instance without a circular import. Re-exported from `./repo.ts`
 * so existing import sites keep resolving.
 */

/**
 * Raised by the credit-funded order ladder when the user's live
 * balance (re-read FOR UPDATE inside the same txn that would
 * debit it) is below the charge amount.
 *
 * This in-txn re-read is the authoritative balance guard — there is
 * no separate handler pre-check ahead of it. A concurrent admin
 * adjustment or a just-captured spend can leave the balance
 * insufficient at debit time; when it does the txn aborts and nothing
 * is written, and callers translate this to a 400.
 */
export class InsufficientCreditError extends Error {
  constructor() {
    super('Loop credit balance is below the order amount');
    this.name = 'InsufficientCreditError';
  }
}
