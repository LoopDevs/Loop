/**
 * Drizzle schema — auth domain (hardening D2 split).
 * Re-exported through `../schema.ts` (the barrel), so every existing
 * `import { ... } from '../db/schema.js'` call site is unchanged.
 */
import { pgTable, uuid, text, timestamp, integer, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

/**
 * One-time passcodes for Loop-native auth (ADR 013).
 *
 * Stored as SHA-256 of the 6-digit code — the code is only ever in
 * plaintext in the operator-sent email and the user-entered body of
 * `POST /api/auth/verify-otp`. The row is marked `consumed_at` on
 * successful verification so a replay of the same code is rejected.
 *
 * `attempts` is bumped on each bad code; the handler rejects once it
 * hits a small ceiling (5) so online brute force against a specific
 * OTP is not viable. An expired OTP is never re-emitted — the user
 * hits `request-otp` again, which writes a fresh row.
 *
 * No FK to `users` because OTP issuance precedes user creation — the
 * user row is created (or resolved) inside the `verify-otp` handler
 * on first success. Linking by email is sufficient.
 */
export const otps = pgTable(
  'otps',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Lookup: "does this email have a live, unconsumed OTP with this
    // code hash?" `expires_at` keeps the index covering so the planner
    // can short-circuit.
    index('otps_email_expires').on(t.email, t.expiresAt),
  ],
);

/**
 * Per-email OTP verification attempt counter (hardening B5; ADR 013).
 *
 * The brute-force ceiling used to live only on the OTP ROW
 * (`otps.attempts` capped at OTP_MAX_ATTEMPTS). That coupled the guess
 * budget to a code's lifecycle, which forced an ugly choice
 * (`otps.incrementOtpAttempts` docstring): bump only the newest row
 * (clean UX, but an attacker rotates `request-otp` so the OLD row's
 * cap is never reached — a real bypass) OR bump every live row (closes
 * the bypass, but a mistype burns a user's sibling code too).
 *
 * This counter decouples the ceiling from OTP rows entirely: a
 * fixed-window count of FAILED verify attempts PER EMAIL. Once
 * `failed_attempts` crosses the threshold inside the window, verify is
 * locked for the email regardless of how many fresh codes exist — so
 * the rotation bypass is closed at the IDENTITY level, independent of
 * which rows get bumped. The per-row `otps.attempts` bump stays as
 * defense-in-depth (still bump-all-live-rows), but this counter is now
 * the authoritative brute-force limit, so the row bump could safely be
 * relaxed to newest-row-only in a future UX pass. A successful verify
 * clears the row; the auth-row purge sweep reaps stale ones.
 */
export const otpAttemptCounters = pgTable('otp_attempt_counters', {
  email: text('email').primaryKey(),
  /** Failed verify attempts inside the current fixed window. */
  failedAttempts: integer('failed_attempts').notNull().default(0),
  /** Start of the current counting window; reset when it lapses. */
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  /** When set and in the future, verify is locked for this email. */
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Active refresh tokens (ADR 013). One row per live refresh; revoked
 * on use (rotation) or on sign-out / security-revoke.
 *
 * `jti` matches the Loop JWT `jti` claim — stable identifier for the
 * token independent of the signed bytes. Lookup on refresh is O(1)
 * via the PK. `token_hash` stores SHA-256 of the full signed token
 * string as a defence-in-depth check: if an attacker somehow gets
 * the jti but not the full token, they can't pass verification.
 *
 * `revoked_at` is set on successful rotation (to the superseding
 * token's jti via `replaced_by_jti`) or on explicit revocation.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    jti: text('jti').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedByJti: text('replaced_by_jti'),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('refresh_tokens_user').on(t.userId),
    // Used by the periodic auth-row purge sweep (CF-26 / X-PRIV-08,
    // `auth/refresh-tokens.ts:purgeDeadRefreshTokens`, driven by
    // `auth-row-purge.ts`) that trims fully-expired rows after the
    // refresh horizon; also used to reject a token whose row is missing
    // from the table entirely.
    index('refresh_tokens_expires').on(t.expiresAt),
  ],
);

/**
 * SEC-02-stepup: single-use ledger for admin step-up tokens (ADR 028).
 *
 * The step-up JWT (`auth/admin-step-up.ts`) is otherwise stateless —
 * its 5-minute `exp` was the ONLY bound, so one minted token could be
 * replayed for UNLIMITED destructive admin writes inside the window
 * (and, defaulting to the wildcard scope, for ANY action class). This
 * table makes the token SINGLE-USE: `consumeAdminStepUpToken` inserts
 * one row per consumed `jti` with `ON CONFLICT (jti) DO NOTHING`, so
 * the FIRST presentation wins and every later replay of the same token
 * is rejected — the same atomic-consume idiom as `refresh_tokens`'
 * `tryRevokeIfLive` and `otps`' consumed-marker.
 *
 * `sub` (the admin's Loop user id) + `scope` (the action class the
 * token was minted for) are carried for forensics. No FK to `users`:
 * the row is an ephemeral single-use marker reaped by `expires_at`,
 * not a join key, and an FK would only complicate the truncate order
 * (same reasoning as `otps`). `expires_at` mirrors the token's `exp`
 * so a retention sweep can reap rows once the token can no longer
 * verify.
 */
export const adminStepUpConsumptions = pgTable(
  'admin_step_up_consumptions',
  {
    jti: text('jti').primaryKey(),
    sub: text('sub').notNull(),
    scope: text('scope').notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    // Range scan for the retention sweep that reaps rows past the
    // token's expiry — mirrors `refresh_tokens_expires` / `otps`'
    // `expires_at` indexes.
    index('admin_step_up_consumptions_expires').on(t.expiresAt),
  ],
);
