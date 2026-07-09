import { eq, sql } from 'drizzle-orm';
import { db } from './client.js';
import { users } from './schema.js';
import { env } from '../env.js';

export type User = typeof users.$inferSelect;

/**
 * Admin allowlist — CTX user IDs parsed from env once at module load.
 * Env is immutable after boot so caching is safe; re-read is a deploy.
 *
 * Fallback to an empty string handles test harnesses that mock the
 * env module with a subset of keys; the resulting empty set means
 * no admin access, which is the right failure mode.
 */
const adminCtxUserIds = new Set(
  (env.ADMIN_CTX_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
);

/**
 * CF-30: Admin allowlist for LOOP-NATIVE users — verified emails parsed
 * from `ADMIN_EMAILS` once at module load. The CTX allowlist above is
 * keyed on `ctx_user_id`, which UUID-anchored native users never carry,
 * so without this an `LOOP_AUTH_NATIVE_ENABLED=true` deployment leaves
 * `/api/admin/*` unreachable to everyone (every native session is
 * `is_admin = false`). Emails are normalized lowercase + trim to match
 * the canonical form persisted on `users.email`. Same module-load
 * caching rationale as the CTX set: env is immutable after boot, so a
 * grant/revoke is a config change (re-deploy), not a DB write.
 */
const adminEmails = new Set(
  (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0),
);

/**
 * CF-30: True when `email` is on the `ADMIN_EMAILS` allowlist. Callers
 * MUST only pass a provider/OTP-verified email — granting admin off an
 * unverified address would let anyone claim an allowlisted identity.
 * Both native entry points (`findOrCreateUserByEmail` on OTP-verify,
 * `resolveOrCreateUserForIdentity` on `email_verified` social login)
 * satisfy that. An empty allowlist (the default) always returns false.
 */
export function isAdminEmail(email: string): boolean {
  return adminEmails.has(email.toLowerCase().trim());
}

/**
 * Upsert a Loop user from a CTX identity. Called from `requireAdmin`
 * (and, later, from `requireAuth` when the identity takeover lands
 * — ADR 013). The email is best-effort — if the bearer's JWT didn't
 * carry an email claim, we store an empty string and fix it up on
 * a later request that has it.
 *
 * is_admin is derived from the `ADMIN_CTX_USER_IDS` env allowlist.
 * Recomputing every upsert means adding/removing an admin is a
 * config change, not a database write.
 */
export async function upsertUserFromCtx(args: {
  ctxUserId: string;
  email: string | undefined;
}): Promise<User> {
  const isAdmin = adminCtxUserIds.has(args.ctxUserId);
  // Atomic upsert — if the row exists, only `email` / `is_admin`
  // / `updated_at` are refreshed. The `updated_at` set keeps the
  // session-freshness signal useful without a manual bump.
  const [row] = await db
    .insert(users)
    .values({
      ctxUserId: args.ctxUserId,
      email: args.email ?? '',
      isAdmin,
    })
    .onConflictDoUpdate({
      target: users.ctxUserId,
      // Partial unique index — `targetWhere` is the conflict-arbiter
      // predicate that mirrors `users_ctx_user_id_unique`'s
      // `WHERE ctx_user_id IS NOT NULL` in schema.ts. Postgres
      // requires this on the conflict target (`ON CONFLICT (col) WHERE
      // <predicate>`) to disambiguate which partial unique index
      // arbitrates. The previous `setWhere` was incorrect — `setWhere`
      // filters which existing rows the UPDATE applies to (after the
      // conflict has already been arbitrated), not which index to
      // arbiter on. Without `targetWhere`, postgres throws
      // `there is no unique or exclusion constraint matching the
      // ON CONFLICT specification` because none of the unconditional
      // indexes match the implicit arbiter predicate.
      targetWhere: sql`${users.ctxUserId} IS NOT NULL`,
      set: {
        email: sql`COALESCE(EXCLUDED.email, ${users.email})`,
        isAdmin,
        updatedAt: sql`NOW()`,
      },
    })
    .returning();
  if (row === undefined) {
    // Should be unreachable — INSERT ... RETURNING always returns at
    // least the inserted row. Narrowed so TS is happy + so we throw
    // loudly rather than returning an undefined-shaped user.
    throw new Error('upsertUserFromCtx: no row returned');
  }
  return row;
}

/** Looks up a Loop user by their internal UUID. */
export async function getUserById(id: string): Promise<User | null> {
  const row = await db.query.users.findFirst({ where: eq(users.id, id) });
  return row ?? null;
}

/**
 * Find-or-create a Loop user by email (ADR 013 — Loop-native signup).
 * Loop-native users have no `ctx_user_id` mapping, so the partial
 * unique index on `users.ctx_user_id` does not apply; we find by
 * lower-cased email and insert a new row if nothing matches.
 *
 * **Invariant: callers MUST only pass a provider/OTP-verified email.**
 * `isAdmin` is derived from `ADMIN_EMAILS` (see `isAdminEmail` above)
 * with no further check here — granting admin off an unverified
 * address would let anyone claim an allowlisted identity. The two
 * production entry points (`verify-otp`, `email_verified` social
 * login) satisfy this by construction. The ONE deliberate exception is
 * `test-endpoints.ts`'s `/__test__/mint-loop-token` (AUDIT-2-E),
 * which calls this function with a caller-supplied, unverified email —
 * that's safe only because reaching the endpoint at all requires
 * `NODE_ENV==='test'` AND a shared secret that's never set outside
 * test infrastructure (see that file's doc comment). Do not add a
 * second unguarded caller.
 *
 * Race-safe (A2-706). The unique index
 * `users_email_loop_native_unique` on `LOWER(email) WHERE
 * ctx_user_id IS NULL` (migration 0020) means two concurrent
 * `verify-otp` calls for the same new email will collide at the
 * second INSERT — we use `ON CONFLICT DO NOTHING` to absorb the
 * collision and re-SELECT so the losing caller returns the winning
 * caller's row instead of erroring.
 */
export async function findOrCreateUserByEmail(email: string): Promise<User> {
  // A2-2002: NFKC normalize + ASCII-only check now lives in
  // `auth/normalize-email.ts`. Callers (verify-otp, social) already
  // route through it before calling here, so by the time we land at
  // this function the email is canonical. The lowercase + trim below
  // is preserved as defence-in-depth for any future caller that
  // forgets the upstream guard — both shapes converge to the same
  // canonical string.
  const normalised = email.toLowerCase().trim();
  // CF-30: the email reaching here is OTP/provider-verified (callers
  // route through verify-otp / email_verified social login), so it's
  // safe to consult the native admin allowlist.
  const isAdmin = isAdminEmail(normalised);
  const existing = await db.query.users.findFirst({
    where: eq(users.email, normalised),
  });
  if (existing !== undefined && existing !== null) {
    // CF-30: config-parity reconcile. The allowlist is the source of
    // truth (env, not DB), mirroring the CTX path's recompute-on-upsert.
    // If a grant/revoke was deployed after this row was created, bring
    // `is_admin` in line on next verified login rather than leaving it
    // stuck at the create-time value.
    if (existing.isAdmin !== isAdmin) {
      const [updated] = await db
        .update(users)
        .set({ isAdmin, updatedAt: sql`NOW()` })
        .where(eq(users.id, existing.id))
        .returning();
      return updated ?? { ...existing, isAdmin };
    }
    return existing;
  }
  // INSERT ... ON CONFLICT DO NOTHING — if a concurrent signup raced
  // us past the SELECT, the unique index trips and no row is
  // returned. We then re-SELECT to find the row the winning caller
  // inserted.
  const inserted = await db
    .insert(users)
    .values({
      email: normalised,
      // CF-30: native admin grant via the `ADMIN_EMAILS` allowlist —
      // the email is verified by the time we reach here.
      isAdmin,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0] !== undefined) return inserted[0];
  const raced = await db.query.users.findFirst({
    where: eq(users.email, normalised),
  });
  if (raced === undefined || raced === null) {
    throw new Error('findOrCreateUserByEmail: no row returned after conflict');
  }
  // CF-30: same config-parity reconcile on the raced winner.
  if (raced.isAdmin !== isAdmin) {
    const [updated] = await db
      .update(users)
      .set({ isAdmin, updatedAt: sql`NOW()` })
      .where(eq(users.id, raced.id))
      .returning();
    return updated ?? { ...raced, isAdmin };
  }
  return raced;
}
