import { randomUUID } from 'node:crypto';
import { config } from '../config/index.js';
import { db } from './client.js';
import { isUniqueViolation } from './errors.js';
import type { UserDoc } from './types.js';

export type User = UserDoc;

// ADR 037: flag is a shim for requireStaff; a staff_roles row always wins.
export function isAllowlistedAdmin(args: {
  email: string | null | undefined;
  ctxUserId: string | null | undefined;
}): boolean {
  const { emails, ctxUserIds } = config.admin;
  if (args.email !== null && args.email !== undefined && args.email !== '') {
    const needle = args.email.toLowerCase().trim();
    if (emails.some((e) => e.toLowerCase().trim() === needle)) return true;
  }
  if (args.ctxUserId !== null && args.ctxUserId !== undefined && args.ctxUserId !== '') {
    if (ctxUserIds.includes(args.ctxUserId)) return true;
  }
  return false;
}

export async function upsertUserFromCtx(args: {
  ctxUserId: string;
  email: string | undefined;
}): Promise<User> {
  const users = db.collection('users');
  const now = new Date();
  const isAdmin = isAllowlistedAdmin({ email: args.email, ctxUserId: args.ctxUserId });
  const updated = await users.updateOne(
    { ctxUserId: args.ctxUserId },
    {
      $set: {
        ...(args.email !== undefined && args.email !== '' ? { email: args.email } : {}),
        isAdmin,
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
    isAdmin,
    createdAt: now,
    updatedAt: now,
  };
  await users.insertOne(doc);
  return doc;
}

export async function getUserById(id: string): Promise<User | null> {
  return db.collection('users').findOne({ id });
}

export async function getUserCtxUserId(id: string): Promise<string | null> {
  const user = await db.collection('users').findOne({ id });
  return user?.ctxUserId ?? null;
}

// Guarded on ctxUserId: null so concurrent provisioning or legacy mappings are never clobbered.
export async function setUserCtxUserId(id: string, ctxUserId: string): Promise<boolean> {
  const updated = await db
    .collection('users')
    .updateOne({ id, ctxUserId: null }, { $set: { ctxUserId, updatedAt: new Date() } });
  return updated !== null;
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

// ADR 013: callers MUST only pass a provider/OTP-verified email.
export async function findOrCreateUserByEmail(email: string): Promise<User> {
  const users = db.collection('users');
  const normalised = email.toLowerCase().trim();
  const existing = await users.findOne({ email: normalised });
  if (existing !== null) {
    const isAdmin = isAllowlistedAdmin({ email: normalised, ctxUserId: existing.ctxUserId });
    if (isAdmin === existing.isAdmin) return existing;
    return (
      (await users.updateOne({ id: existing.id }, { $set: { isAdmin, updatedAt: new Date() } })) ??
      existing
    );
  }
  const now = new Date();
  const doc: UserDoc = {
    id: randomUUID(),
    ctxUserId: null,
    email: normalised,
    tokenVersion: 0,
    homeCurrency: 'USD',
    isAdmin: isAllowlistedAdmin({ email: normalised, ctxUserId: null }),
    createdAt: now,
    updatedAt: now,
  };
  try {
    await users.insertOne(doc);
    return doc;
  } catch (err) {
    if (isUniqueViolation(err)) {
      const raced = await users.findOne({ email: normalised });
      if (raced !== null) return raced;
    }
    throw err;
  }
}
