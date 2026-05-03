# Phase 10 - Payments, Payouts, Stellar Rails

Status: complete
Owner: lead (Claude)

## Files reviewed

- apps/backend/src/payments/\* (watcher, watcher-bootstrap, payout-submit, payout-worker, payout-worker-pay-one, asset-drift-watcher, cursor-watchdog, fee-strategy, horizon, horizon-balances, horizon-circulation, horizon-find-outbound, horizon-trustlines, price-feed, price-feed-fx, stroops, amount-sufficient, stuck-payout-watchdog)
- apps/backend/src/credits/{withdrawals,payout-compensation,payout-asset,payout-builder,pending-payouts,pending-payouts-admin,pending-payouts-transitions,pending-payouts-user,refunds,liabilities}.ts

## Findings filed

- A4-012 Info — memo entropy at 100 bits today; defence-in-depth uniqueness recommendation
- A4-015 Info — overpayment accepted unconditionally; no upper bound

## No-finding-but-reviewed

- Payout-submit error classification covers transient/terminal split robustly.
- Memo idempotency via `findOutboundPaymentByMemo` pre-check before resubmit.
- Network passphrase + operator secret regex'd at env level.
- Asset-drift watcher pages on threshold breach.
- Stuck-payout watchdog re-picks rows past 300s submitted state.

## Cross-references

- Phase 12 owns financial-invariant findings (A4-020/021/022/023).
- A4-007 (FX-pin race) sits in Phase 09.
