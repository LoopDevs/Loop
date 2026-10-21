import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import type * as ProvisioningModule from '../../ctx/user-provisioning.js';
import type * as UserRolesModule from '../../ctx/user-roles.js';
import type { CtxUser } from '../../db/users.js';
import type { CtxUserStatus, UserDoc } from '../../db/types.js';

const loadOrCreateMock = vi.fn();
const fetchCtxUserMock = vi.fn();
const enableCtxUserMock = vi.fn();
const updateCtxCountryMock = vi.fn();
const cacheCtxUserMock = vi.fn();

vi.mock('../../ctx/user-provisioning.js', async (importActual) => ({
  ...(await importActual<typeof ProvisioningModule>()),
  loadOrCreateCtxCustomer: (email: string, options?: unknown) => loadOrCreateMock(email, options),
}));
vi.mock('../../ctx/user-roles.js', async (importActual) => ({
  ...(await importActual<typeof UserRolesModule>()),
  fetchCtxUser: (id: string) => fetchCtxUserMock(id),
  enableCtxUser: (id: string) => enableCtxUserMock(id),
  updateCtxCountry: (id: string, country: string) => updateCtxCountryMock(id, country),
}));
vi.mock('../../db/users.js', () => ({
  cacheCtxUser: (ctxUser: CtxUser) => cacheCtxUserMock(ctxUser),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  CtxSignInUnavailableError,
  CtxUserNotEnabledError,
  ctxSignInErrorResponse,
  registerCtxUserForOtp,
  signInCtxUserByEmail,
  signInCtxUserById,
} from '../ctx-login.js';
import { CtxUserCreationDisabledError } from '../../ctx/user-provisioning.js';
import { CtxUserRolesError } from '../../ctx/user-roles.js';

function ctxUser(status: CtxUserStatus = 'enabled', country: string | null = 'GB'): CtxUser {
  return {
    id: 'ctx-1',
    email: 'a@b.com',
    status,
    isAdmin: false,
    stableCurrency: 'XLM.USDC',
    cashbackDestination: 'account',
    country,
  };
}

function cachedRow(user: CtxUser): UserDoc {
  const now = new Date();
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    tokenVersion: 0,
    stableCurrency: user.stableCurrency,
    cashbackDestination: user.cashbackDestination,
    isAdmin: user.isAdmin,
    createdAt: now,
    updatedAt: now,
  };
}

function makeCtx(): Context {
  return {
    json: (b: unknown, status?: number) =>
      new Response(JSON.stringify(b), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  loadOrCreateMock.mockReset();
  fetchCtxUserMock.mockReset();
  enableCtxUserMock.mockReset();
  updateCtxCountryMock.mockReset();
  cacheCtxUserMock.mockReset();
  cacheCtxUserMock.mockImplementation(async (user: CtxUser) => ({
    user: cachedRow(user),
    created: true,
  }));
});

describe('registerCtxUserForOtp', () => {
  it.each(['enabled', 'email_unverified'] as const)(
    'accepts a %s CTX customer without touching the cache',
    async (status) => {
      loadOrCreateMock.mockResolvedValue(ctxUser(status));
      await expect(registerCtxUserForOtp('a@b.com')).resolves.toBeUndefined();
      expect(loadOrCreateMock).toHaveBeenCalledWith('a@b.com', undefined);
      expect(cacheCtxUserMock).not.toHaveBeenCalled();
    },
  );

  it.each(['suspended', 'disabled'] as const)('refuses a %s CTX customer', async (status) => {
    loadOrCreateMock.mockResolvedValue(ctxUser(status));
    await expect(registerCtxUserForOtp('a@b.com')).rejects.toBeInstanceOf(CtxUserNotEnabledError);
  });

  it('propagates CTX refusing to create the customer', async () => {
    loadOrCreateMock.mockRejectedValue(new CtxUserCreationDisabledError());
    await expect(registerCtxUserForOtp('a@b.com')).rejects.toBeInstanceOf(
      CtxUserCreationDisabledError,
    );
  });

  it('wraps any other CTX failure as CtxSignInUnavailableError', async () => {
    loadOrCreateMock.mockRejectedValue(new CtxUserRolesError('CTX user lookup returned 502', 502));
    await expect(registerCtxUserForOtp('a@b.com')).rejects.toBeInstanceOf(
      CtxSignInUnavailableError,
    );
  });
});

describe('signInCtxUserByEmail', () => {
  it('loads or creates the verified CTX customer, caches it and returns the enabled user', async () => {
    loadOrCreateMock.mockResolvedValue(ctxUser());
    const out = await signInCtxUserByEmail('a@b.com', 'GB');
    expect(loadOrCreateMock).toHaveBeenCalledWith('a@b.com', {
      country: 'GB',
      emailVerified: true,
    });
    expect(enableCtxUserMock).not.toHaveBeenCalled();
    expect(updateCtxCountryMock).not.toHaveBeenCalled();
    expect(cacheCtxUserMock).toHaveBeenCalledWith(ctxUser());
    expect(out.user.id).toBe('ctx-1');
    expect(out.created).toBe(true);
  });

  it('enables an email_unverified CTX customer and caches the enabled user', async () => {
    loadOrCreateMock.mockResolvedValue(ctxUser('email_unverified'));
    enableCtxUserMock.mockResolvedValue(ctxUser('enabled'));
    const out = await signInCtxUserByEmail('a@b.com');
    expect(enableCtxUserMock).toHaveBeenCalledWith('ctx-1');
    expect(cacheCtxUserMock).toHaveBeenCalledWith(ctxUser('enabled'));
    expect(out.user.status).toBe('enabled');
  });

  it('sets the chosen country when the CTX customer has none', async () => {
    loadOrCreateMock.mockResolvedValue(ctxUser('enabled', null));
    updateCtxCountryMock.mockResolvedValue(ctxUser('enabled', 'PT'));
    await signInCtxUserByEmail('a@b.com', 'PT');
    expect(updateCtxCountryMock).toHaveBeenCalledWith('ctx-1', 'PT');
    expect(cacheCtxUserMock).toHaveBeenCalledWith(ctxUser('enabled', 'PT'));
  });

  it('keeps the CTX customer country-less when CTX rejects the chosen country', async () => {
    loadOrCreateMock.mockResolvedValue(ctxUser('enabled', null));
    updateCtxCountryMock.mockRejectedValue(new CtxUserRolesError('unsupported', 400));
    const out = await signInCtxUserByEmail('a@b.com', 'ZZ');
    expect(out.user.id).toBe('ctx-1');
    expect(cacheCtxUserMock).toHaveBeenCalledWith(ctxUser('enabled', null));
  });

  it('wraps a failed CTX enable as CtxSignInUnavailableError', async () => {
    loadOrCreateMock.mockResolvedValue(ctxUser('email_unverified'));
    enableCtxUserMock.mockRejectedValue(new CtxUserRolesError('forbidden', 403));
    await expect(signInCtxUserByEmail('a@b.com')).rejects.toBeInstanceOf(CtxSignInUnavailableError);
    expect(cacheCtxUserMock).not.toHaveBeenCalled();
  });

  it.each(['suspended', 'disabled'] as const)(
    'refuses a %s CTX user after caching its status',
    async (status) => {
      loadOrCreateMock.mockResolvedValue(ctxUser(status));
      await expect(signInCtxUserByEmail('a@b.com')).rejects.toBeInstanceOf(CtxUserNotEnabledError);
      expect(cacheCtxUserMock).toHaveBeenCalledWith(expect.objectContaining({ status }));
    },
  );

  it('propagates CTX refusing to create the customer', async () => {
    loadOrCreateMock.mockRejectedValue(new CtxUserCreationDisabledError());
    await expect(signInCtxUserByEmail('a@b.com')).rejects.toBeInstanceOf(
      CtxUserCreationDisabledError,
    );
    expect(cacheCtxUserMock).not.toHaveBeenCalled();
  });

  it('wraps any other CTX failure as CtxSignInUnavailableError', async () => {
    const cause = new CtxUserRolesError('CTX user lookup returned 502', 502);
    loadOrCreateMock.mockRejectedValue(cause);
    const err = await signInCtxUserByEmail('a@b.com').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CtxSignInUnavailableError);
    expect((err as Error).cause).toBe(cause);
  });

  it('propagates a cache write failure unwrapped', async () => {
    loadOrCreateMock.mockResolvedValue(ctxUser());
    const dbErr = new Error('db down');
    cacheCtxUserMock.mockRejectedValue(dbErr);
    await expect(signInCtxUserByEmail('a@b.com')).rejects.toBe(dbErr);
  });
});

describe('signInCtxUserById', () => {
  it('fetches the CTX user, caches it and returns the enabled user', async () => {
    fetchCtxUserMock.mockResolvedValue(ctxUser());
    const user = await signInCtxUserById('ctx-1');
    expect(fetchCtxUserMock).toHaveBeenCalledWith('ctx-1');
    expect(cacheCtxUserMock).toHaveBeenCalledWith(ctxUser());
    expect(user.id).toBe('ctx-1');
  });

  it('refuses a suspended CTX user after caching its status', async () => {
    fetchCtxUserMock.mockResolvedValue(ctxUser('suspended'));
    await expect(signInCtxUserById('ctx-1')).rejects.toBeInstanceOf(CtxUserNotEnabledError);
    expect(cacheCtxUserMock).toHaveBeenCalled();
  });

  it('treats a CTX 404 as a user that is not enabled', async () => {
    fetchCtxUserMock.mockRejectedValue(new CtxUserRolesError('CTX user lookup returned 404', 404));
    await expect(signInCtxUserById('ctx-1')).rejects.toBeInstanceOf(CtxUserNotEnabledError);
    expect(cacheCtxUserMock).not.toHaveBeenCalled();
  });

  it('wraps a CTX outage as CtxSignInUnavailableError', async () => {
    fetchCtxUserMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(signInCtxUserById('ctx-1')).rejects.toBeInstanceOf(CtxSignInUnavailableError);
  });

  it('propagates a cache write failure unwrapped', async () => {
    fetchCtxUserMock.mockResolvedValue(ctxUser());
    const dbErr = new Error('db down');
    cacheCtxUserMock.mockRejectedValue(dbErr);
    await expect(signInCtxUserById('ctx-1')).rejects.toBe(dbErr);
  });
});

describe('ctxSignInErrorResponse', () => {
  it.each([
    [new CtxUserCreationDisabledError(), 403, 'SIGNUP_DISABLED'],
    [new CtxUserNotEnabledError('ctx-1'), 403, 'USER_DEACTIVATED'],
    [new CtxSignInUnavailableError(new Error('ctx down')), 503, 'SERVICE_UNAVAILABLE'],
  ])('maps %s to %i %s', async (err, status, code) => {
    const res = ctxSignInErrorResponse(makeCtx(), err);
    expect(res?.status).toBe(status);
    expect(((await res?.json()) as { code: string }).code).toBe(code);
  });

  it('returns null for an error outside the CTX sign-in set', () => {
    expect(ctxSignInErrorResponse(makeCtx(), new Error('db down'))).toBeNull();
  });
});
