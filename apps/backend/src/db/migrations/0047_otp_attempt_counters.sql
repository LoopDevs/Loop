-- Hardening B5 — per-email OTP verification attempt counter (ADR 013).
-- Decouples the brute-force ceiling from the OTP row lifecycle: a
-- fixed-window count of failed verify attempts per email. Once the
-- threshold is crossed inside the window, verify is locked for the
-- email regardless of how many fresh codes an attacker rotates in — so
-- the per-row `attempts` bump can go back to newest-row-only for good
-- UX (the email counter is now the authoritative limit).
CREATE TABLE IF NOT EXISTS "otp_attempt_counters" (
  "email" text PRIMARY KEY NOT NULL,
  "failed_attempts" integer DEFAULT 0 NOT NULL,
  "window_started_at" timestamp with time zone NOT NULL,
  "locked_until" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
