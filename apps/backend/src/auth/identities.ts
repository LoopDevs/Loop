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
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { userIdentities, users, type SocialProvider } from '../db/schema.js';
import type { User } from '../db/users.js';

export interface ResolveOrCreateArgs {
  provider: SocialProvider;
  providerSub: string;
  email: string;
}

/**
 * Single entry point the social-login handlers use. Returns the
 * Loop user row plus a flag saying whether we created a new user
 * (useful for welcome-email / analytics signals).
 */
export async function resolveOrCreateUserForIdentity(
  args: ResolveOrCreateArgs,
): Promise<{ user: User; created: boolean }> {
  const email = args.email.toLowerCase().trim();

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
      return { user, created: false };
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
    return { user: existingUser, created: false };
  }

  // Step 3 — brand-new user. Create the users row, then the
  // user_identities row linking the provider.
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({
        email,
        // isAdmin defaults to false; CTX-anchored admin allowlist
        // doesn't apply to social-native users.
      })
      .returning();
    if (created === undefined) {
      throw new Error('resolveOrCreateUserForIdentity: user insert returned no row');
    }
    await tx.insert(userIdentities).values({
      userId: created.id,
      provider: args.provider,
      providerSub: args.providerSub,
      emailAtLink: email,
    });
    return { user: created, created: true };
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
