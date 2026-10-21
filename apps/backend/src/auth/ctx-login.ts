import type { Context } from 'hono';
import { cacheCtxUser, type CtxUser, type User } from '../db/users.js';
import { CtxUserCreationDisabledError, loadOrCreateCtxCustomer } from '../ctx/user-provisioning.js';
import {
  CtxUserRolesError,
  enableCtxUser,
  fetchCtxUser,
  updateCtxCountry,
} from '../ctx/user-roles.js';
import { logger } from '../logger.js';

const log = logger.child({ area: 'ctx-login' });

export class CtxUserNotEnabledError extends Error {
  constructor(readonly userId: string) {
    super(`CTX user ${userId} is not enabled`);
    this.name = 'CtxUserNotEnabledError';
  }
}

export class CtxSignInUnavailableError extends Error {
  constructor(cause: unknown) {
    super('CTX user could not be loaded', { cause });
    this.name = 'CtxSignInUnavailableError';
  }
}

async function loadFromCtx(load: () => Promise<CtxUser>): Promise<CtxUser> {
  try {
    return await load();
  } catch (err) {
    if (err instanceof CtxUserCreationDisabledError || err instanceof CtxUserNotEnabledError) {
      throw err;
    }
    throw new CtxSignInUnavailableError(err);
  }
}

function requireEnabled(user: User): User {
  if (user.status !== 'enabled') throw new CtxUserNotEnabledError(user.id);
  return user;
}

export async function registerCtxUserForOtp(email: string): Promise<void> {
  const ctxUser = await loadFromCtx(() => loadOrCreateCtxCustomer(email));
  if (ctxUser.status === 'disabled' || ctxUser.status === 'suspended') {
    throw new CtxUserNotEnabledError(ctxUser.id);
  }
}

async function applyCountryIfUnset(
  ctxUser: CtxUser,
  country: string | undefined,
): Promise<CtxUser> {
  if (country === undefined || ctxUser.country !== null) return ctxUser;
  try {
    return await updateCtxCountry(ctxUser.id, country);
  } catch (err) {
    if (err instanceof CtxUserRolesError && err.status === 400) return ctxUser;
    throw err;
  }
}

export async function signInCtxUserByEmail(
  email: string,
  country?: string,
): Promise<{ user: User; created: boolean }> {
  const ctxUser = await loadFromCtx(async () => {
    const loaded = await loadOrCreateCtxCustomer(email, { country, emailVerified: true });
    const verified = loaded.status === 'email_unverified' ? await enableCtxUser(loaded.id) : loaded;
    return applyCountryIfUnset(verified, country);
  });
  const { user, created } = await cacheCtxUser(ctxUser);
  return { user: requireEnabled(user), created };
}

export async function signInCtxUserById(id: string): Promise<User> {
  const ctxUser = await loadFromCtx(async () => {
    try {
      return await fetchCtxUser(id);
    } catch (err) {
      if (err instanceof CtxUserRolesError && err.status === 404) {
        throw new CtxUserNotEnabledError(id);
      }
      throw err;
    }
  });
  return requireEnabled((await cacheCtxUser(ctxUser)).user);
}

export function ctxSignInErrorResponse(c: Context, err: unknown): Response | null {
  if (err instanceof CtxUserCreationDisabledError) {
    return c.json(
      { code: 'SIGNUP_DISABLED', message: 'New accounts cannot be created right now' },
      403,
    );
  }
  if (err instanceof CtxUserNotEnabledError) {
    log.info({ userId: err.userId }, 'Sign-in refused: CTX user is not enabled');
    return c.json({ code: 'USER_DEACTIVATED', message: 'This account is not active' }, 403);
  }
  if (err instanceof CtxSignInUnavailableError) {
    log.error({ err }, 'Sign-in failed: CTX user could not be loaded');
    return c.json(
      {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Sign-in is temporarily unavailable — please retry shortly',
      },
      503,
    );
  }
  return null;
}
