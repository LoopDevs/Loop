-- MNY-06-hotfloat: a sub-minor stroop carry accumulator on the hot float,
-- so the vault-withdraw replenish path stops silently LEAKING dust.
--
-- `treasury/hot-float.ts`'s `runHotFloatReplenishTick` converts the
-- batched `vault.withdraw` proceeds (`amount_out_stroops`, 7-decimal
-- underlying-asset stroops, 100_000 stroops per FIAT minor) into the
-- float's `balance_minor` with a TRUNCATING integer division
-- (`amount_out_stroops / 100_000`). That discards
-- `amount_out_stroops % 100_000` stroops of REAL, already-landed
-- on-chain USDC on every tick. A single drop is sub-cent, but the float
-- replenishes continuously and each dropped remainder is gone for good,
-- so the discarded fractions ACCUMULATE into a growing, unaccounted gap
-- between what the bookkeeping records and what the vault actually paid
-- out — money slowly lost from the operator's working capital, exactly
-- the drift the R3-1 float reconciliation would eventually surface as
-- unexplained.
--
-- The fix mirrors the sanctioned interest-mint carry accumulator
-- (`interest_mint_snapshots.carry_after_stroops`, migration 0041): keep
-- the dropped remainder in `carry_stroops` and flush it into
-- `balance_minor` the moment carry + a tick's remainder reaches a whole
-- minor unit. Conservation invariant the replenish writer maintains:
--
--     balance_minor * 100_000 + carry_stroops == Σ amount_out_stroops
--
-- i.e. no stroop credited to the float is ever dropped.
--
-- `carry_stroops` is by construction a sub-minor remainder, so it is
-- bounded to [0, 100_000) — the same `>= 0 AND < 100000` shape as
-- `interest_mint_snapshots_carry_bounded`. NOT NULL DEFAULT 0 is
-- backfill-safe: every existing `vault_hot_float` row acquires
-- carry_stroops = 0 (an empty carry, which is the correct opening state
-- — no historical remainder was ever persisted to reclaim), and 0
-- trivially satisfies both bounds.
--
-- Both the column and the CHECK are drizzle-representable and are
-- declared in `db/schema/vaults.ts`, so schema <-> migration parity
-- holds without an allowlist entry (`check:migration-parity`).
--
-- Idempotent ADD COLUMN IF NOT EXISTS / DROP CONSTRAINT IF EXISTS keeps
-- a partial-apply rerun safe (matches the discipline in 0057 / 0068).

ALTER TABLE vault_hot_float
  ADD COLUMN IF NOT EXISTS carry_stroops bigint NOT NULL DEFAULT 0;

ALTER TABLE vault_hot_float
  DROP CONSTRAINT IF EXISTS vault_hot_float_carry_bounded;

ALTER TABLE vault_hot_float
  ADD CONSTRAINT vault_hot_float_carry_bounded
  CHECK (carry_stroops >= 0 AND carry_stroops < 100000);
