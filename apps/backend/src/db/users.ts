import { randomUUID } from 'node:crypto';
import { db } from './client.js';
import { isUniqueViolation } from './errors.js';
import type { UserDoc } from './types.js';

export type User = UserDoc;

/**
 * Upsert a Loop user from a CTX identity. Called from `requireAuth` on
 * the legacy CTX-proxy path. The email is best-effort — if the bearer's
 * JWT didn't carry an email claim, we store an empty string and fix it
 * up on a later request that has it.
 */
export async function upsertUserFromCtx(args: {
  ctxUserId: string;
  email: string | undefined;
}): Promise<User> {
  const users = db.collection('users');
  const now = new Date();
  const updated = await users.updateOne(
    { ctxUserId: args.ctxUserId },
    {
      $set: {
        // Only refresh the email when the token actually carried one.
        ...(args.email !== undefined && args.email !== '' ? { email: args.email } : {}),
        updatedAt: now,
      },
    },
  );
  if (updated !== null) return updated;
  const doc: UserDoc = {
    id: randomUUID(),
    ctxUserId: args.ctxUserId,
    email: args.email ?? '',
    tokenVersion: 0,
    homeCurrency: 'USD',
    createdAt: now,
    updatedAt: now,
  };
  await users.insertOne(doc);
  return doc;
}

/** Looks up a Loop user by their internal UUID. */
export async function getUserById(id: string): Promise<User | null> {
  return db.collection('users').findOne({ id });
}

/**
 * Read of a user's CTX customer mapping. Used by the procurement path
 * to decide whether to act-as the customer on CTX calls.
 */
export async function getUserCtxUserId(id: string): Promise<string | null> {
  const user = await db.collection('users').findOne({ id });
  return user?.ctxUserId ?? null;
}

/**
 * Records the CTX customer id minted by async provisioning
 * (`ctx/user-provisioning.ts`). Guarded on `ctxUserId: null` so a
 * concurrent provision (or a legacy CTX-proxy mapping) is never
 * clobbered — first write wins, later writers see `false`.
 */
export async function setUserCtxUserId(id: string, ctxUserId: string): Promise<boolean> {
  const updated = await db
    .collection('users')
    .updateOne({ id, ctxUserId: null }, { $set: { ctxUserId, updatedAt: new Date() } });
  return updated !== null;
}

/**
 * NS-09: reads a user's CURRENT access-token-revocation counter.
 * `requireAuth` calls this on every authenticated request and rejects
 * a token whose `tv` claim differs from this value (or that carries no
 * `tv` at all). Returns `null` when no such user row exists — the
 * caller fails closed (a token pointing at a deleted user is invalid).
 */
export async function getUserTokenVersion(id: string): Promise<number | null> {
  const user = await db.collection('users').findOne({ id });
  return user?.tokenVersion ?? null;
}

/**
 * NS-09: atomically bumps a user's access-token-revocation counter.
 * Every access token minted before this bump (its `tv` claim now
 * stale) is rejected on its next `requireAuth` check. Called on logout;
 * the bulk sign-out / refresh-reuse paths bump it inside
 * `revokeAllRefreshTokensForUser` (auth/refresh-tokens.ts).
 */
export async function bumpUserTokenVersion(id: string): Promise<void> {
  await db
    .collection('users')
    .updateOne({ id }, { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } });
}

/**
 * Find-or-create a Loop user by email (ADR 013 — Loop-native signup).
 *
 * **Invariant: callers MUST only pass a provider/OTP-verified email.**
 * The two production entry points (`verify-otp`, `email_verified`
 * social login) satisfy this by construction; the one deliberate
 * exception is `test-endpoints.ts`'s `/__test__/mint-loop-token`,
 * which is double-gated on NODE_ENV=test + a shared secret.
 *
 * The email reaching here is already NFKC-normalised by
 * `auth/normalize-email.ts`; the lowercase + trim below is
 * defence-in-depth for any future caller that forgets the guard.
 */
export async function findOrCreateUserByEmail(email: string): Promise<User> {
  const users = db.collection('users');
  const normalised = email.toLowerCase().trim();
  const existing = await users.findOne({ email: normalised });
  if (existing !== null) return existing;
  const now = new Date();
  const doc: UserDoc = {
    id: randomUUID(),
    ctxUserId: null,
    email: normalised,
    tokenVersion: 0,
    homeCurrency: 'USD',
    createdAt: now,
    updatedAt: now,
  };
  try {
    await users.insertOne(doc);
    return doc;
  } catch (err) {
    // A concurrent signup raced us past the findOne — return the
    // winner's row.
    if (isUniqueViolation(err)) {
      const raced = await users.findOne({ email: normalised });
      if (raced !== null) return raced;
    }
    throw err;
  }
}
