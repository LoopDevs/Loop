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
 * The caller's prior `hasSufficientCredit` fast-path check is a UX
 * nicety, not a guard — a concurrent admin adjustment or a
 * just-captured spend between the check and the insert can leave
 * the balance insufficient. In that case the txn aborts and nothing
 * is written; callers translate this to a 400.
 */
export class InsufficientCreditError extends Error {
  constructor() {
    super('Loop credit balance is below the order amount');
    this.name = 'InsufficientCreditError';
  }
}
