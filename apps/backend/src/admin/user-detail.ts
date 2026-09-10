// admin user-detail + by-email lookups
import type { Context } from 'hono';
import { UUID_RE } from '../uuid.js';
import { db } from '../db/client.js';
import type { UserDoc } from '../db/types.js';
import { logger } from '../logger.js';

const log = logger.child({ handler: 'admin-user-detail' });

// pre-filters obvious garbage to avoid a lookup; real validation is at signup
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMAIL_MAX_LENGTH = 254;

export interface AdminUserView {
  id: string;
  email: string;
  isAdmin: boolean;
  homeCurrency: string;
  ctxUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: UserDoc): AdminUserView {
  return {
    id: row.id,
    email: row.email,
    isAdmin: row.isAdmin,
    homeCurrency: row.homeCurrency,
    ctxUserId: row.ctxUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function adminGetUserHandler(c: Context): Promise<Response> {
  const userId = c.req.param('userId');
  if (userId === undefined || userId.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId is required' }, 400);
  }
  if (!UUID_RE.test(userId)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'userId must be a uuid' }, 400);
  }
  try {
    const row = await db.collection('users').findOne({ id: userId });
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'User not found' }, 404);
    }
    return c.json<AdminUserView>(toView(row));
  } catch (err) {
    log.error({ err, userId }, 'Admin user-detail lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to fetch user' }, 500);
  }
}

export async function adminUserByEmailHandler(c: Context): Promise<Response> {
  const raw = c.req.query('email');
  if (raw === undefined || raw.length === 0) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email is required' }, 400);
  }
  if (raw.length > EMAIL_MAX_LENGTH) {
    return c.json(
      { code: 'VALIDATION_ERROR', message: `email must be at most ${EMAIL_MAX_LENGTH} chars` },
      400,
    );
  }
  if (!EMAIL_SHAPE.test(raw)) {
    return c.json({ code: 'VALIDATION_ERROR', message: 'email must look like an email' }, 400);
  }

  try {
    const row = await db.collection('users').findOne({ email: raw.toLowerCase().trim() });
    if (row === null) {
      return c.json({ code: 'NOT_FOUND', message: 'No user with that email' }, 404);
    }
    return c.json<AdminUserView>(toView(row));
  } catch (err) {
    log.error({ err }, 'Admin user-by-email lookup failed');
    return c.json({ code: 'INTERNAL_ERROR', message: 'Failed to look up user' }, 500);
  }
}
