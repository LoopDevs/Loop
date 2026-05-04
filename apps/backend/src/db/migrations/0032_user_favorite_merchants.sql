-- Per-user merchant favourites (Tranche 2 user-value follow-on).
--
-- A small, opt-in pin list a user maintains so the app can surface
-- their go-to merchants on the home grid and bypass the catalog
-- scroll. Read-mostly and tiny per-user (think tens, not thousands
-- of rows), so we lean on the (user_id, merchant_id) composite PK
-- for both write-side dedupe and read-side ordering.
--
-- Schema choices:
--   * `merchant_id` is `text` — matches the rest of the schema where
--     CTX merchant ids land in the catalog (`orders.merchant_id`,
--     `merchant_cashback_configs.merchant_id`). NOT a foreign-key:
--     the catalog itself isn't a Postgres table — it's the
--     in-memory `MerchantCatalogStore` (ADR 021), refreshed from
--     upstream on a 6-hour cadence. A merchant disappearing from the
--     catalog should NOT cascade-delete the user's favourite — the
--     row keeps the historical pin intact and the read-side hides
--     the entry until the merchant returns (eviction policy, ADR
--     021). The tradeoff: a permanently-removed merchant leaves a
--     dead row, mopped up by the eviction sweep below.
--   * `(user_id, merchant_id)` composite primary key — natural
--     dedupe boundary so a re-favourite is a one-row UPSERT. PK
--     gives logical-replication / CDC tools a stable row identity
--     vs. a unique index over a synthetic uuid (same reasoning as
--     `user_credits` in migration 0017).
--   * `created_at` is the ordering key — newest favourites first on
--     the home grid. No `updated_at`: the row is append-only
--     semantically (toggle is INSERT or DELETE; flipping back and
--     forth re-creates with a fresh timestamp).
--   * Index on `(user_id, created_at DESC)` — the only query shape
--     the read endpoint runs is "list this user's favourites,
--     newest first". The PK alone covers point lookups for the
--     toggle write but doesn't help the ordered read.
--
-- Idempotent: every CREATE / ADD uses IF NOT EXISTS so a partial-
-- apply rerun is safe. Rolled back via `DROP TABLE
-- user_favorite_merchants`.

CREATE TABLE IF NOT EXISTS user_favorite_merchants (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT user_favorite_merchants_pkey PRIMARY KEY (user_id, merchant_id),
  CONSTRAINT user_favorite_merchants_merchant_id_nonempty CHECK (length(merchant_id) >= 1)
);

CREATE INDEX IF NOT EXISTS user_favorite_merchants_user_created
  ON user_favorite_merchants (user_id, created_at DESC);
