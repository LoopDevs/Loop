// Social-provider identity linking — ADR 014
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
 * Tolerates parallel-login race: unique spec on (provider, providerSub)
 * makes later simultaneous inserts no-op.
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
 * Returns user row and flag for new user creation.
 */
export async function resolveOrCreateUserForIdentity(
  args: ResolveOrCreateArgs,
): Promise<{ user: User; created: boolean }> {
  // A2-2002: normalizeEmail filters homographs; NonAsciiEmailError bubbles to handler for 400.
  const email = normalizeEmail(args.email);

  // Step 1 — known (provider, sub).
  const knownIdentity = await db
    .collection('user_identities')
    .findOne({ provider: args.provider, providerSub: args.providerSub });
  if (knownIdentity !== null) {
    const user = await db.collection('users').findOne({ id: knownIdentity.userId });
    if (user !== null) return { user, created: false };
    // Dangling identity row (user deleted) — drop through to create fresh user.
  }

  // Step 2 — email already known. Link provider to existing user.
  const existingUser: UserDoc | null = await db.collection('users').findOne({ email });
  if (existingUser !== null) {
    await linkIdentity(existingUser.id, args, email);
    return { user: existingUser, created: false };
  }

  // Step 3 — brand-new user.
  const user = await findOrCreateUserByEmail(email);
  await linkIdentity(user.id, args, email);
  return { user, created: true };
}

/**
 * Lists providers linked to a user for settings page.
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
