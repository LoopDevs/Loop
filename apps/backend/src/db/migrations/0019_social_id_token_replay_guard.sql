-- A2-566: social-login ID tokens were accepted with only signature /
-- issuer / audience / exp validation. A valid id_token is replayable
-- within its provider TTL (Google: 1h, Apple: 10min) — an attacker
-- who intercepts one can mint a Loop session as the token's subject
-- for the remainder of that window.
--
-- One-shot consumption closes the replay window: every id_token that
-- successfully verifies is recorded here by a cryptographic digest.
-- The next attempt with the same token hits the unique constraint
-- and the handler rejects with 401.
--
-- Why sha256(token) rather than `jti`:
--   - Not every provider sets jti — Apple historically didn't.
--   - sha256 of the raw token is stable, provider-agnostic, and
--     the column doesn't carry any identifying claim content.
-- The digest alone is enough to detect replays; we never need to
-- correlate back to a user (auth already recorded the session).
--
-- TTL: rows are swept daily by the cleanup worker (follow-up). Safe
-- to cap at 48h — the largest provider TTL is Google at 1h, so
-- anything older than 48h is already expiry-rejected and the row is
-- pure disk weight.

CREATE TABLE IF NOT EXISTS social_id_token_uses (
  token_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Sweep index — cheap `DELETE WHERE expires_at < NOW()` when the
-- cleanup worker runs. Without it, the sweep would seq-scan the
-- whole table which grows linearly with signin volume.
CREATE INDEX IF NOT EXISTS social_id_token_uses_expires_at_idx
  ON social_id_token_uses (expires_at);
