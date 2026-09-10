// Order-repo error types — shared to avoid circular import between repo.ts and repo-credit-order.ts

// In-txn FOR UPDATE re-read is the authoritative balance guard; no separate handler pre-check.
export class InsufficientCreditError extends Error {
  constructor() {
    super('Loop credit balance is below the order amount');
    this.name = 'InsufficientCreditError';
  }
}
