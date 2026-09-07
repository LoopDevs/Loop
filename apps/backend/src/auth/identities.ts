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
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import type { SocialProvider, UserDoc, UserIdentityDoc } from '../db/types.js';
import { findOrCreateUserByEmail, type User } from '../db/users.js';
import { normalizeEmail } from './normalize-email.js';

export interface ResolveOrCreateArgs {
  provider: SocialProvider;
  providerSub: string;
  email: string;
}

/**
 * Link `(provider, sub)` to a user, tolerating the parallel-login race:
 * the unique spec on (provider, providerSub) means the later of two
 * simultaneous inserts harmlessly no-ops.
 */
async function linkIdentity(
  userId: string,
  args: ResolveOrCreateArgs,
  email: string,
): Promise<void> {
  const doc: UserIdentityDoc = {
    id: randomUUID(),
    userId,
    provider: args.provider,
    providerSub: args.providerSub,
    emailAtLink: email,
    createdAt: new Date(),
  };
  try {
    await db.collection('user_identities').insertOne(doc);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
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

  // Step 1 — known (provider, sub).
  const knownIdentity = await db
    .collection('user_identities')
    .findOne({ provider: args.provider, providerSub: args.providerSub });
  if (knownIdentity !== null) {
    const user = await db.collection('users').findOne({ id: knownIdentity.userId });
    if (user !== null) return { user, created: false };
    // Dangling identity row (user deleted under us) — drop through so
    // we create a fresh user and re-link below. Ops-grade edge case.
  }

  // Step 2 — email already known. Link provider to the existing user.
  const existingUser: UserDoc | null = await db.collection('users').findOne({ email });
  if (existingUser !== null) {
    await linkIdentity(existingUser.id, args, email);
    return { user: existingUser, created: false };
  }

  // Step 3 — brand-new user. findOrCreateUserByEmail absorbs the
  // parallel-first-login race the same way the OTP signup path does.
  const user = await findOrCreateUserByEmail(email);
  await linkIdentity(user.id, args, email);
  return { user, created: true };
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
  const rows = await db.collection('user_identities').findMany({ userId });
  return rows.map((r) => ({
    provider: r.provider,
    providerSub: r.providerSub,
    emailAtLink: r.emailAtLink,
    createdAt: r.createdAt,
  }));
}
