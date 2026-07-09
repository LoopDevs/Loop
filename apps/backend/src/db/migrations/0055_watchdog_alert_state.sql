-- S4-8 follow-up (money-review 2026-07-09) — persist the fire-once
-- watchdog alert state (cursor-age watchdog + stuck-payout watchdog).
-- Mirrors interest_pool_alert_state (ADR-038 D2): the fired-state
-- previously lived in a per-process boolean; with the S4-8
-- advisory-lock single-flight, a machine whose boolean latched true
-- during a past incident could win the lock during a FUTURE, distinct
-- incident and silently skip paging — worst case zero pages for a
-- live money incident. alert_active is written true only after the
-- Discord send confirms delivery (at-least-once), and reset false on
-- a healthy tick (re-arm), all under the watchdog's fleet-wide
-- transaction-scoped advisory lock.
CREATE TABLE IF NOT EXISTS "watchdog_alert_state" (
  "watchdog_name" text PRIMARY KEY NOT NULL,
  "alert_active" boolean NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
