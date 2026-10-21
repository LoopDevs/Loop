import type { CashbackDestination } from '@loop/shared';
import { db } from './client.js';
import { isUniqueViolation } from './errors.js';
import type { CtxUserStatus, UserDoc } from './types.js';

export type User = UserDoc;

export async function getUserById(id: string): Promise<User | null> {
  return db.collection('users').findOne({ id });
}

export interface CtxUser {
  id: string;
  email: string;
  status: CtxUserStatus;
  isAdmin: boolean;
  stableCurrency: string;
  cashbackDestination: CashbackDestination;
  country: string | null;
}

// ADR 037: every CTX user response overwrites the mirror; a staff_roles row still wins in requireStaff.
export async function cacheCtxUser(ctxUser: CtxUser): Promise<{ user: User; created: boolean }> {
  const users = db.collection('users');
  const fields = {
    email: ctxUser.email,
    status: ctxUser.status,
    isAdmin: ctxUser.isAdmin,
    stableCurrency: ctxUser.stableCurrency,
    cashbackDestination: ctxUser.cashbackDestination,
    ...(ctxUser.country !== null ? { country: ctxUser.country } : {}),
  };
  const overwrite = (): Promise<User | null> =>
    users.updateOne({ id: ctxUser.id }, { $set: { ...fields, updatedAt: new Date() } });
  const updated = await overwrite();
  if (updated !== null) return { user: updated, created: false };
  const now = new Date();
  const doc: UserDoc = {
    id: ctxUser.id,
    ...fields,
    tokenVersion: 0,
    createdAt: now,
    updatedAt: now,
  };
  try {
    await users.insertOne(doc);
    return { user: doc, created: true };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await overwrite();
    if (raced === null) throw err;
    return { user: raced, created: false };
  }
}

// NS-09: caller fails closed if user row is missing.
export async function getUserTokenVersion(id: string): Promise<number | null> {
  const user = await db.collection('users').findOne({ id });
  return user?.tokenVersion ?? null;
}

// NS-09: invalidates all access tokens minted before this bump.
export async function bumpUserTokenVersion(id: string): Promise<void> {
  await db
    .collection('users')
    .updateOne({ id }, { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } });
}
