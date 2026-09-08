/**
 * config section: `admin:` — who may reach `/api/admin/*`, and the
 * step-up signing key that gates the destructive writes inside it.
 *
 * See `./server.ts` for what a section module is.
 *
 * ── Why the allowlist is config and not a database write ───────────
 *
 * ADR 037 puts durable role management in the `staff_roles`
 * collection, granted and revoked through the admin UI. But that only
 * works once *an* admin exists to do the granting, and Loop has no
 * seeding step and no console: an empty database with an empty
 * allowlist has no way to reach the surface that would let you fix it.
 *
 * So `emails` (and `ctxUserIds`, its legacy CTX-anchored counterpart)
 * is the bootstrap: a Loop user whose verified email appears here is
 * flagged admin at upsert, on every login, forever. Granting one is a
 * config edit plus a redeploy — deliberately heavier than the
 * self-serve path, because it is the only path that cannot be locked
 * out of itself. Everything after the first admin should go through
 * `PUT /api/admin/staff/:userId/role`.
 *
 * Both lists are matched against an already-verified identity — a
 * provider/OTP-verified email, or the `ctxUserId` on the user row —
 * never against a client-supplied claim.
 */
import { z } from 'zod';

export const adminSchema = z
  .object({
    // Verified email addresses granted admin on the Loop-native auth
    // path (ADR 013). Compared case-insensitively against the
    // NFKC-normalised email already verified by OTP or a social
    // provider, so an entry only ever matches someone who proved they
    // control that mailbox.
    //
    // This was `ADMIN_EMAILS`, a comma-separated string every consumer
    // had to split and trim itself.
    emails: z.array(z.string().email()).default([]),

    // CTX user ids granted admin on the legacy CTX-proxy auth path,
    // keyed on `ctxUserId` (which Loop-native users don't carry).
    // Retires with the proxy path; use `emails` for anything new.
    //
    // This was `ADMIN_CTX_USER_IDS`.
    ctxUserIds: z.array(z.string().min(1)).default([]),

    // ADR 028 / A4-063 — admin step-up. The destructive admin writes
    // want more than a bearer token: the caller re-presents an OTP,
    // gets a 5-minute single-use token scoped to one action class, and
    // sends it as `X-Admin-Step-Up`.
    //
    // Deliberately a DIFFERENT key from `auth.native.jwt` so that a
    // leak of the bearer signing key does not also let the holder mint
    // step-ups. Unset → the gated endpoints fail closed with 503
    // rather than silently skipping the check, so the surface ships
    // disabled until an operator generates a key.
    stepUp: z
      .object({
        // Min 32 chars of real entropy. `openssl rand -base64 32`
        signingKey: z.string().min(32).optional(),
        // Keep the old key here for the 5-minute step-up TTL after
        // rotating; both verify, only `signingKey` signs.
        previousSigningKey: z.string().min(32).optional(),
      })
      .prefault({}),

    // NS-03: how long applied admin writes stay readable in the audit
    // tail. `admin_idempotency_keys` doubles as the durable record of
    // every admin mutation, so retention is decoupled from the 24h
    // replay window (`IDEMPOTENCY_TTL_HOURS`) and defaults to
    // financial-records grade — 7 years.
    auditRetentionDays: z.number().int().positive().default(2557),
  })
  .prefault({});
