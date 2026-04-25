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
      // Partial unique index — include the WHERE so Postgres picks
      // the right index for the upsert. (Mirrors schema.ts.)
      setWhere: sql`${users.ctxUserId} IS NOT NULL`,
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
  const existing = await db.query.users.findFirst({
    where: eq(users.email, normalised),
  });
  if (existing !== undefined && existing !== null) return existing;
  // INSERT ... ON CONFLICT DO NOTHING — if a concurrent signup raced
  // us past the SELECT, the unique index trips and no row is
  // returned. We then re-SELECT to find the row the winning caller
  // inserted.
  const inserted = await db
    .insert(users)
    .values({
      email: normalised,
      // isAdmin defaults to false in the schema. Loop-native users get
      // admin via a future migration to key allowlists on Loop UUIDs.
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
  return raced;
}
