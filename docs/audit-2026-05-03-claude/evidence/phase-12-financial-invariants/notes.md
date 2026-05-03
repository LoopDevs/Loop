# Phase 12 - Financial Invariants and Reconciliation

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/credits/\* (full suite)
- apps/backend/src/orders/{repo,repo-credit-order,fulfillment,cashback-split,transitions,transitions-sweeps}.ts
- apps/backend/src/admin/{credit-adjustments,refunds,withdrawals,payout-compensation,payouts-retry,treasury,asset-circulation,asset-drift-state,reconciliation,settlement-lag,cashback-realization,cashback-realization-daily}.ts
- apps/backend/src/scripts/check-ledger-invariant.ts
- apps/backend/src/**tests**/bigint-money-property.test.ts

## Findings filed

- A4-018 Medium — cashback-split rounding residual lands in wholesale; repo.ts comment claims margin
- A4-020 Medium — payout-compensation bypasses daily admin adjustment cap
- A4-021 Medium — payout-compensation does not verify amountMinor matches payout
- A4-022 Medium — payout-compensation does not cross-check userId/currency
- A4-023 Medium — markOrderFulfilled writes off-chain ledger on home-currency drift but skips on-chain payout
- A4-029 Low — withdrawal stroops conversion hard-codes 100_000n with no asset-code guard
- A4-033 Low — cashback/spend/interest writers don't populate reason

## No-finding-but-reviewed

- BigInt-only on every minor-unit + stroops column.
- Ledger amount-sign CHECK matches type discriminator.
- Liabilities reconciliation script (`check-ledger-invariant.ts`) replayable.
