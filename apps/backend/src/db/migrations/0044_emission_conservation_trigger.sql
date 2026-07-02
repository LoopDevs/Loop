-- Hardening A1 / C10 (docs/hardening-plan-2026-07.md) — DB-level
-- emission conservation fence.
--
-- The app-layer check in credits/emissions.ts enforces that an
-- emission fits inside the UN-EMITTED portion of the user's mirror
-- liability (balance minus what prior payouts/emissions already
-- materialised on-chain, net of burns). That check lives in one
-- module — the whole lesson of the GBPLOOP unbacked-mint finding
-- (two cold audits, "do not merge as-is") is that a future writer
-- path can silently bypass an app-layer allowlist. This trigger
-- enforces the same conservation rule at the database boundary, so
-- NO writer — present or future, app or manual SQL — can insert an
-- emission row that would mint unbacked LOOP.
--
-- Accounting (mirrors emittedNetMinorFor in credits/emissions.ts):
--   minted  = Σ amount_stroops over kind IN ('order_cashback',
--             'emission', 'interest_mint'), state != 'failed',
--             compensated_at IS NULL, excluding legacy pre-ADR-036
--             withdrawal-era emissions (their at-send debit ledger
--             row is the discriminator — they already reduced the
--             mirror, counting them here would double-subtract).
--   burned  = Σ amount_stroops over kind = 'burn' (any state — the
--             user's tokens left their wallet at payment time).
--   require GREATEST(minted - burned, 0) + NEW.amount_stroops
--           <= balance_minor * 100000.
--
-- Locking: the function takes FOR UPDATE on the user_credits row —
-- the same lock every legitimate money writer already holds when it
-- inserts payout rows, so the proper path re-enters its own lock
-- (no-op) and a rogue concurrent writer serialises behind it.
--
-- TWO triggers cover the two ways a row can ENTER the counted set:
--
--   1. INSERT of a non-'failed' emission row (fresh emissions always
--      insert as 'pending'). Scoped to kind='emission' because the
--      cashback/interest flows move the mirror in the same txn and
--      preserve the invariant by construction, and a row born
--      'failed' (compensation fixtures, ops reconstructions) never
--      materialised anything — the accounting itself excludes failed
--      rows for the same reason.
--   2. UPDATE of state out of 'failed' for ANY of the three mint
--      kinds — the admin payout-retry path (resetPayoutToPending).
--      Failed rows are excluded from the accounting, so their
--      headroom may have been legitimately re-consumed (e.g. a
--      backfill emission after the original failed) — flipping the
--      old row back to pending without re-checking would mint BOTH
--      (the adversarial-review P0 on this change). Legitimate
--      retries re-enter with their matching mirror credit still in
--      place and pass; double-mint retries are rejected and surface
--      as 409 EMISSION_EXCEEDS_UNEMITTED_BALANCE on the retry
--      endpoint.
--
-- Idempotent: CREATE OR REPLACE + conditional trigger create.
-- Rollback: DROP TRIGGER pending_payouts_emission_conservation ON
-- pending_payouts; DROP FUNCTION assert_emission_conservation().

CREATE OR REPLACE FUNCTION assert_emission_conservation() RETURNS trigger AS $$
DECLARE
  mirror_currency text;
  balance_minor_val bigint;
  minted_stroops bigint;
  burned_stroops bigint;
  net_stroops bigint;
  new_amount_stroops bigint;
BEGIN
  -- Legacy pre-ADR-036 withdrawal-era emissions debited the mirror at
  -- send (their discriminator is the at-send type='withdrawal' ledger
  -- row) — they are excluded from the counted mint set, so a legacy
  -- row (re-)entering the queue contributes nothing to the check.
  -- Fresh inserts have a brand-new id with no ledger row and count in
  -- full.
  SELECT CASE
    WHEN NEW.kind = 'emission' AND EXISTS (
      SELECT 1 FROM credit_transactions ct
      WHERE ct.type = 'withdrawal'
        AND ct.reference_type = 'payout'
        AND ct.reference_id = NEW.id::text
    ) THEN 0
    ELSE NEW.amount_stroops
  END INTO new_amount_stroops;
  mirror_currency := CASE NEW.asset_code
    WHEN 'USDLOOP' THEN 'USD'
    WHEN 'GBPLOOP' THEN 'GBP'
    WHEN 'EURLOOP' THEN 'EUR'
    ELSE NULL
  END;
  IF mirror_currency IS NULL THEN
    RAISE EXCEPTION 'emission_conservation: unknown LOOP asset code % — no mirror currency to check against', NEW.asset_code
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT uc.balance_minor INTO balance_minor_val
  FROM user_credits uc
  WHERE uc.user_id = NEW.user_id AND uc.currency = mirror_currency
  FOR UPDATE;
  IF NOT FOUND THEN
    balance_minor_val := 0;
  END IF;

  SELECT
    COALESCE(SUM(pp.amount_stroops) FILTER (
      WHERE pp.kind IN ('order_cashback', 'emission', 'interest_mint')
        AND pp.state != 'failed'
        AND pp.compensated_at IS NULL
        AND (
          pp.kind != 'emission'
          OR NOT EXISTS (
            SELECT 1 FROM credit_transactions ct
            WHERE ct.type = 'withdrawal'
              AND ct.reference_type = 'payout'
              AND ct.reference_id = pp.id::text
          )
        )
    ), 0),
    COALESCE(SUM(pp.amount_stroops) FILTER (WHERE pp.kind = 'burn'), 0)
  INTO minted_stroops, burned_stroops
  FROM pending_payouts pp
  WHERE pp.user_id = NEW.user_id AND pp.asset_code = NEW.asset_code;

  net_stroops := GREATEST(minted_stroops - burned_stroops, 0);
  IF net_stroops + new_amount_stroops > balance_minor_val * 100000 THEN
    RAISE EXCEPTION 'emission_conservation: emission of % stroops for user % (%) would exceed the un-emitted liability — % stroops already materialised on-chain against a mirror balance of % minor',
      new_amount_stroops, NEW.user_id, NEW.asset_code, net_stroops, balance_minor_val
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS pending_payouts_emission_conservation ON pending_payouts;
--> statement-breakpoint
CREATE TRIGGER pending_payouts_emission_conservation
  BEFORE INSERT ON pending_payouts
  FOR EACH ROW
  WHEN (NEW.kind = 'emission' AND NEW.state != 'failed')
  EXECUTE FUNCTION assert_emission_conservation();
--> statement-breakpoint
DROP TRIGGER IF EXISTS pending_payouts_mint_reentry_conservation ON pending_payouts;
--> statement-breakpoint
CREATE TRIGGER pending_payouts_mint_reentry_conservation
  BEFORE UPDATE OF state ON pending_payouts
  FOR EACH ROW
  WHEN (OLD.state = 'failed' AND NEW.state != 'failed'
        AND NEW.kind IN ('emission', 'order_cashback', 'interest_mint'))
  EXECUTE FUNCTION assert_emission_conservation();
