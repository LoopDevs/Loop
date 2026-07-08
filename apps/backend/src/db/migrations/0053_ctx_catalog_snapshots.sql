-- R3-3: durable last-good CTX catalog snapshots.
--
-- Merchant and location catalogs are served from in-memory stores. A
-- restart during a CTX outage used to cold-start those stores empty,
-- causing public catalog endpoints to return successful but empty
-- responses. Persist the last successful full sweep so boot can
-- warm-start before attempting the next upstream refresh.

CREATE TABLE IF NOT EXISTS ctx_catalog_snapshots (
  name text PRIMARY KEY,
  payload jsonb NOT NULL,
  item_count integer NOT NULL,
  loaded_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ctx_catalog_snapshots_name_known CHECK (name IN ('merchants', 'locations')),
  CONSTRAINT ctx_catalog_snapshots_payload_array CHECK (jsonb_typeof(payload) = 'array'),
  CONSTRAINT ctx_catalog_snapshots_item_count_non_negative CHECK (item_count >= 0)
);
