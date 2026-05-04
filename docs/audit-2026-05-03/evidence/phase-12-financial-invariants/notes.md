# Phase 12 - Financial Invariants and Reconciliation

Status: in-progress

Required evidence:

- ledger invariant proofs: in progress
- credits/liabilities math review: in progress
- cashback/refund/withdrawal/interest review: finding filed for cashback payout double-credit
- rounding and currency review: in progress
- reconciliation and reporting review: in progress

Artifacts:

- [order-cashback-payout-double-credit.txt](./artifacts/order-cashback-payout-double-credit.txt)
- [ledger-writer-inventory.txt](./artifacts/ledger-writer-inventory.txt)

Observations:

- Fulfillment currently writes a positive cashback ledger row, updates `user_credits`, and queues an order-cashback pending payout for linked-wallet users.
- Payout confirmation only transitions `pending_payouts` to `confirmed`; it does not create a balancing credit-ledger debit or decrement `user_credits`.
- The credit-funded order path and admin withdrawal path both consume `user_credits`, so confirmed on-chain cashback can remain spendable off-chain.
- Positive and negative ledger writer paths were inventoried; the current reconciliation invariant compares only `user_credits` to `credit_transactions`, so it cannot detect confirmed order-cashback payouts that have not settled the off-chain balance.

Findings:

- A4-024: Order cashback can be paid on-chain while remaining spendable as off-chain credit.
