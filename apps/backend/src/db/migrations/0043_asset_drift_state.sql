-- Hardening A2/A3 (docs/hardening-plan-2026-07.md) — persist the
-- asset-drift watcher's per-asset state.
--
-- Why: the watcher (payments/asset-drift-watcher.ts) is the primary
-- backstop against unbacked LOOP — it compares on-chain circulation
-- against the off-chain liability mirror every tick. Its ok/over
-- transition state lived in process memory: lost on restart (every
-- deploy re-paged any ongoing incident) and duplicated per Fly
-- machine (each machine paged independently). This table makes the
-- state fleet-consistent and lets transition claims serialise via
-- SELECT ... FOR UPDATE so exactly one machine pages per flip.
--
-- It also adds the SECOND state dimension (failed_rows_state): burn /
-- interest-mint payout rows in state='failed' are deliberately counted
-- into the drift equation (the deposit-held tokens / mirror credits
-- genuinely exist), which makes the equation permanently blind to
-- them — a terminally-failed nightly mint would otherwise read as
-- drift-neutral forever while the user's mirror overstates their
-- on-chain holdings (ADR 036: chain is authoritative). Persisting the
-- failed-row sums + a none/present state keeps that masked term loud
-- until an operator retries the rows (/admin/payouts?state=failed).
--
-- No 'unknown' member in the state CHECKs on purpose: absence of the
-- row IS the unknown state (asset never successfully read).
--
-- Page delivery is at-least-once: `last_paged_*` record what ops has
-- actually been paged about (written only after a successful Discord
-- send) and `page_attempt_at` is the short send-attempt lease — a
-- page lost to a Discord outage or a SIGTERM between the state
-- commit and the send is re-attempted on later ticks.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS; rollback via
-- `DROP TABLE asset_drift_state`.

CREATE TABLE IF NOT EXISTS asset_drift_state (
  asset_code text PRIMARY KEY,
  state text NOT NULL,
  failed_rows_state text NOT NULL,
  last_drift_stroops bigint NOT NULL,
  last_threshold_stroops bigint NOT NULL,
  failed_burn_stroops bigint NOT NULL,
  failed_interest_mint_stroops bigint NOT NULL,
  last_paged_state text,
  last_paged_failed_rows_state text,
  page_attempt_at timestamptz,
  last_checked_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT asset_drift_state_state_known CHECK (state IN ('ok', 'over')),
  CONSTRAINT asset_drift_state_failed_rows_known CHECK (failed_rows_state IN ('none', 'present')),
  CONSTRAINT asset_drift_state_paged_state_known
    CHECK (last_paged_state IS NULL OR last_paged_state IN ('ok', 'over')),
  CONSTRAINT asset_drift_state_paged_failed_rows_known
    CHECK (last_paged_failed_rows_state IS NULL OR last_paged_failed_rows_state IN ('none', 'present')),
  CONSTRAINT asset_drift_state_failed_sums_non_negative
    CHECK (failed_burn_stroops >= 0 AND failed_interest_mint_stroops >= 0)
);
