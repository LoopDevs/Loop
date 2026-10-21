// Social-provider identity linking — ADR 014
import { randomUUID } from 'node:crypto';
import { db } from '../db/client.js';
import { isUniqueViolation } from '../db/errors.js';
import type { SocialProvider, UserIdentityDoc } from '../db/types.js';
import type { User } from '../db/users.js';
import { signInCtxUserByEmail, signInCtxUserById } from './ctx-login.js';
import { normalizeEmail } from './normalize-email.js';

export interface ResolveOrCreateArgs {
  provider: SocialProvider;
  providerSub: string;
  email: string;
  country?: string | undefined;
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
export async function signInUserForIdentity(
  args: ResolveOrCreateArgs,
): Promise<{ user: User; created: boolean }> {
  // A2-2002: normalizeEmail filters homographs; NonAsciiEmailError bubbles to handler for 400.
  const email = normalizeEmail(args.email);

  // Step 1 — known (provider, sub).
  const knownIdentity = await db
    .collection('user_identities')
    .findOne({ provider: args.provider, providerSub: args.providerSub });
  if (knownIdentity !== null) {
    return { user: await signInCtxUserById(knownIdentity.userId), created: false };
  }

  // Step 2 — the CTX customer for the email, created when CTX allows it.
  const { user, created } = await signInCtxUserByEmail(email, args.country);
  await linkIdentity(user.id, args, email);
  return { user, created };
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
