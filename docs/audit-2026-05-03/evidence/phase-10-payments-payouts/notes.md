# Phase 10 - Payments, Payouts, and Stellar Rails

Status: in-progress

Required evidence:

- Horizon client and watcher review: in progress
- payout submit and worker review: in progress
- asset/floor/trustline review: in progress
- memo idempotency and duplicate payout review: finding filed
- Stellar env and secret boundary review: in progress

Artifacts:

- [payments-payouts-files.txt](./artifacts/payments-payouts-files.txt)
- [payout-idempotency-account-mismatch.txt](./artifacts/payout-idempotency-account-mismatch.txt)
- [payment-watcher-idle-stale-alert.txt](./artifacts/payment-watcher-idle-stale-alert.txt)
- [xlm-price-rounding-underpayment.txt](./artifacts/xlm-price-rounding-underpayment.txt)
- [payment-asset-method-mismatch.txt](./artifacts/payment-asset-method-mismatch.txt)
- [stuck-payout-submitted-cutoff-mismatch.txt](./artifacts/stuck-payout-submitted-cutoff-mismatch.txt)

Observations:

- Payment watcher, payout worker, Horizon read helpers, payout submit, pending-payout transitions, withdrawal admin flow, and payout retry/compensation flows are under active review.
- `payOne` uses `row.assetIssuer` as the Horizon account for duplicate-payout detection, while `submitPayout` signs and submits from `Keypair.fromSecret(args.secret).publicKey()`.
- Env validation exposes independent LOOP issuer public keys and an independent operator secret, but no public operator account or equality invariant check.
- ADR 016 says the idempotency check queries payments from the operator account; current code queries the issuer account unless the hidden issuer==operator invariant happens to be true.
- `runPaymentWatcherTick` writes the cursor only when a record exists or an empty page has `nextCursor`; the cursor watchdog treats an unchanged cursor row `updated_at` as stuck after 10 minutes. Unit tests currently assert no cursor write on a normal empty page.
- XLM price-feed conversion rounds one-XLM fiat price to whole cents/pence/euro-cents before calculating required stroops, which can accept underpayment for fractional-cent XLM prices.
- The payment watcher matches USDC, XLM, and configured LOOP assets independently, then amount validation chooses the formula from the order's stored payment method. The actual non-LOOP asset that matched is not passed into `isAmountSufficient`, allowing cross-asset settlement.
- Stuck payout triage filters submitted rows by `created_at < cutoff` but reports submitted-row age from `submitted_at`, so old-created but freshly submitted rows can be reported as stuck.

Findings:

- A4-018: Payout idempotency pre-check can scan the issuer account instead of the sending operator account.
- A4-019: Payment-watcher stuck alert can fire during healthy no-payment periods.
- A4-020: XLM payment validation can accept underpayment due to whole-cent oracle rounding.
- A4-021: Payment watcher accepts mismatched assets for the order's selected payment method.
- A4-022: Submitted payouts can be flagged stuck immediately after a delayed submit.
