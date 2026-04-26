-- A2-715: shape-pin `pending_payouts.to_address` at the DB layer.
--
-- The app-layer regex validator (`@loop/shared/STELLAR_PUBKEY_REGEX`)
-- already runs at the API boundary, but a direct INSERT bypassing
-- that — an admin DB shell, a future writer that forgets to call
-- the validator, or an admin import script — could land a malformed
-- address that the submit worker would then round-trip into Horizon
-- and fail loudly. The CHECK pins the canonical Stellar pubkey
-- shape (56-char `G…` base32) at the column itself.
--
-- Pattern matches `^G[A-Z2-7]{55}$` exactly:
--   - first char `G` (Stellar account ID identifier)
--   - 55 chars of uppercase base32 alphabet (A-Z + 2-7)
--   - total length 56
--
-- The full canonical regex includes a checksum byte that's not
-- representable in a regex; the app layer covers that. The DB
-- CHECK is the cheaper "shape" gate — anything obviously wrong
-- (lowercase, wrong length, alphabet violation) gets rejected
-- before the row lands.

ALTER TABLE pending_payouts
  ADD CONSTRAINT pending_payouts_to_address_format
    CHECK (to_address ~ '^G[A-Z2-7]{55}$');
