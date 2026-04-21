-- ADR 015: opt-in Stellar address for cashback payouts. Nullable —
-- a user who hasn't linked an address still earns cashback off-chain
-- via the credit ledger; when set, the outbound payout worker emits
-- a Stellar Payment of the matching LOOP asset to this address on
-- each fulfillment.
ALTER TABLE "users"
  ADD COLUMN "stellar_address" text;
