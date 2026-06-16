/**
 * Social-provider identity linking (ADR 014).
 *
 * `resolveOrCreateUserForIdentity` is the one verb social-login
 * handlers call after verifying a provider's id_token. Three-step
 * resolution:
 *
 *   1. Existing `(provider, sub)` row → return its user_id.
 *   2. Else, existing `users.email` row → link this provider to it.
 *   3. Else, create a fresh `users` row + link.
 *
 * The middle step is deliberate: a user who signed up with OTP and
 * later picks "Continue with Google" against the same email lands
 * on the same Loop account instead of a shadow duplicate. The
 * email_verified guarantee from the provider is what makes step 2
 * safe — the social-handler enforces `email_verified = true` before
 * calling this function.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userIdentities, users, type SocialProvider } from '../db/schema.js';
import { isAdminEmail, type User } from '../db/users.js';
import { normalizeEmail } from './normalize-email.js';

export interface ResolveOrCreateArgs {
  provider: SocialProvider;
  providerSub: string;
  email: string;
}

/**
 * CF-30: config-parity reconcile for an existing user row on a verified
 * social login. The `ADMIN_EMAILS` allowlist is the source of truth
 * (env, not DB) — mirroring the CTX path's recompute-on-upsert. If a
 * grant/revoke was deployed after the row was created, bring `is_admin`
 * in line on next login instead of leaving it stuck at the create-time
 * value. Returns the (possibly updated) user. No-ops when already in
 * sync, so the common path stays a single SELECT.
 */
async function reconcileAdmin(user: User, isAdmin: boolean): Promise<User> {
  if (user.isAdmin === isAdmin) return user;
  const [updated] = await db
    .update(users)
    .set({ isAdmin, updatedAt: sql`NOW()` })
    .where(eq(users.id, user.id))
    .returning();
  return updated ?? { ...user, isAdmin };
}

/**
 * Single entry point the social-login handlers use. Returns the
 * Loop user row plus a flag saying whether we created a new user
 * (useful for welcome-email / analytics signals).
 */
export async function resolveOrCreateUserForIdentity(
  args: ResolveOrCreateArgs,
): Promise<{ user: User; created: boolean }> {
  // A2-2002: normalizeEmail does NFKC + lowercase + trim and rejects
  // non-ASCII. The social-login handlers call this with the email
  // returned by the provider's id_token, so any homograph the
  // provider would have accepted is filtered here. NonAsciiEmailError
  // bubbles up to the social-login handler which maps it to 400.
  const email = normalizeEmail(args.email);
  // CF-30: the social handler enforces `email_verified=true` before
  // calling this verb, so the email is provider-verified here and it's
  // safe to consult the native admin allowlist.
  const isAdmin = isAdminEmail(email);

  // Step 1 — known (provider, sub).
  const knownIdentity = await db.query.userIdentities.findFirst({
    where: and(
      eq(userIdentities.provider, args.provider),
      eq(userIdentities.providerSub, args.providerSub),
    ),
  });
  if (knownIdentity !== undefined && knownIdentity !== null) {
    const user = await db.query.users.findFirst({ where: eq(users.id, knownIdentity.userId) });
    if (user !== undefined && user !== null) {
      return { user: await reconcileAdmin(user, isAdmin), created: false };
    }
    // Dangling identity row (user deleted under us) — drop to
    // step 3 so we create a fresh user and re-link the identity
    // below. This is an ops-grade edge case.
  }

  // Step 2 — email already known. Link provider to the existing
  // user row.
  const existingUser = await db.query.users.findFirst({ where: eq(users.email, email) });
  if (existingUser !== undefined && existingUser !== null) {
    await db
      .insert(userIdentities)
      .values({
        userId: existingUser.id,
        provider: args.provider,
        providerSub: args.providerSub,
        emailAtLink: email,
      })
      .onConflictDoNothing({
        // Partial conflict on (provider, provider_sub) — two parallel
        // logins for the same sub both reach this branch; the later
        // insert harmlessly no-ops.
        target: [userIdentities.provider, userIdentities.providerSub],
      });
    return { user: await reconcileAdmin(existingUser, isAdmin), created: false };
  }

  // Step 3 — brand-new user. Create the users row, then the
  // user_identities row linking the provider.
  //
  // A2-570: race-safe against the `users_email_loop_native_unique`
  // partial index (A2-706). Two concurrent first-time social
  // logins for the same brand-new email could both reach step 3
  // having missed the step-2 SELECT; the second INSERT would
  // otherwise throw. `onConflictDoNothing` absorbs the unique
  // collision and the losing caller re-SELECTs the winning row,
  // then attaches its identity row to it. Same shape as
  // `findOrCreateUserByEmail` (A2-706) for OTP signup.
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(users)
      .values({
        email,
        // CF-30: native admin grant via the `ADMIN_EMAILS` allowlist —
        // the email is provider-verified by the time we reach here. The
        // raced path below re-SELECTs the winner's row, which a parallel
        // caller inserted with the same allowlist value (same env), so
        // no in-transaction reconcile is needed.
        isAdmin,
      })
      .onConflictDoNothing()
      .returning();
    let userRow: User | undefined = inserted[0];
    if (userRow === undefined) {
      // Conflict: a parallel signup created the row first. Fetch it.
      const raced = await tx.query.users.findFirst({ where: eq(users.email, email) });
      if (raced === undefined || raced === null) {
        throw new Error('resolveOrCreateUserForIdentity: insert + re-select both empty');
      }
      userRow = raced;
    }
    await tx
      .insert(userIdentities)
      .values({
        userId: userRow.id,
        provider: args.provider,
        providerSub: args.providerSub,
        emailAtLink: email,
      })
      .onConflictDoNothing({
        // Partial conflict on (provider, provider_sub) — same race
        // protection as the step-2 path; two parallel sign-ins for
        // the same sub both reach this point and the later insert
        // harmlessly no-ops.
        target: [userIdentities.provider, userIdentities.providerSub],
      });
    // `created` reports whether THIS call did the user insert. If a
    // parallel call won the race, the user already existed at the
    // time we observed it, so `created: false` is the honest answer.
    return { user: userRow, created: inserted[0] !== undefined };
  });
}

/**
 * Lists every provider linked to a user — reads for the settings /
 * account page. Empty array is a fresh Loop-OTP-only user.
 */
export async function listLinkedIdentities(userId: string): Promise<
  Array<{
    provider: SocialProvider;
    providerSub: string;
    emailAtLink: string;
    createdAt: Date;
  }>
> {
  const rows = await db
    .select({
      provider: userIdentities.provider,
      providerSub: userIdentities.providerSub,
      emailAtLink: userIdentities.emailAtLink,
      createdAt: userIdentities.createdAt,
    })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId));
  return rows.map((r) => ({
    provider: r.provider as SocialProvider,
    providerSub: r.providerSub,
    emailAtLink: r.emailAtLink,
    createdAt: r.createdAt,
  }));
}
