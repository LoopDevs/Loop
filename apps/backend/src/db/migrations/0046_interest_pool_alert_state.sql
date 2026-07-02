-- Hardening C10a — persist the interest-pool low-cover watcher's
-- per-asset alert state (ADR 031). Mirrors asset_drift_state (A3): the
-- low<->ok transition dedup previously lived in a process-memory Set
-- inside the notifiers — lost on restart, per-machine, so the machine
-- computing "recovered" usually wasn't the one that paged "low" and
-- silently dropped the close. Durable + fleet-consistent + at-least-once
-- delivery (last_paged_state moves only after the webhook confirms).
CREATE TABLE IF NOT EXISTS "interest_pool_alert_state" (
  "asset_code" text PRIMARY KEY NOT NULL,
  "state" text NOT NULL,
  "last_paged_state" text,
  "last_days_of_cover" double precision NOT NULL,
  "last_pool_stroops" bigint NOT NULL,
  "page_attempt_at" timestamp with time zone,
  "last_checked_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "interest_pool_alert_state_state_known"
    CHECK ("state" IN ('ok', 'low')),
  CONSTRAINT "interest_pool_alert_state_paged_state_known"
    CHECK ("last_paged_state" IS NULL OR "last_paged_state" IN ('ok', 'low'))
);
