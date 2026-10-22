import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type * as ConfigModule from '../../config/index.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { ctxState } = vi.hoisted(() => ({
  ctxState: {
    credentials: { key: 'op-key', privateKey: '11'.repeat(32) },
  },
}));
vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        ctx: {
          ...actual.config.ctx,
          credentials: ctxState.credentials,
        },
      };
    },
  };
});

vi.mock('../../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamUrl: (path: string) => `http://ctx.test${path}`,
}));

import {
  CtxUserCreationDisabledError,
  findCtxCustomerIdByEmail,
  loadOrCreateCtxCustomer,
} from '../user-provisioning.js';
import { CtxUserRolesError } from '../user-roles.js';

type Route = (url: string, init: RequestInit) => Response | undefined;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function listOf(...users: Array<Record<string, unknown>>): Response {
  return json({ result: users, pagination: { page: 1, perPage: 50, total: users.length } });
}

function ctxUser(id: string): Response {
  return json({ id, email: 'u1@test.io', type: 'customer', status: 'enabled', roles: [] });
}

function routeFetch(...routes: Route[]): MockInstance<typeof fetch> {
  const queue = [...routes];
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const route = queue.shift();
    const res = route?.(String(input), init ?? {});
    if (res === undefined) throw new Error(`unexpected CTX call ${String(input)}`);
    return res;
  });
}

const lookup =
  (res: Response): Route =>
  (url, init) =>
    (init.method ?? 'GET') === 'GET' && url.startsWith('http://ctx.test/users?') ? res : undefined;
const create =
  (res: Response): Route =>
  (url, init) =>
    init.method === 'POST' && url === 'http://ctx.test/users' ? res : undefined;
const get =
  (id: string): Route =>
  (url, init) =>
    (init.method ?? 'GET') === 'GET' && url === `http://ctx.test/users/${id}`
      ? ctxUser(id)
      : undefined;

beforeEach(() => {
  vi.restoreAllMocks();
  ctxState.credentials = { key: 'op-key', privateKey: '11'.repeat(32) };
});

describe('findCtxCustomerIdByEmail', () => {
  it('queries customers by the regex-escaped email and returns the exact match', async () => {
    const fetchSpy = routeFetch(
      lookup(
        listOf(
          { id: 'ctx-other', email: 'xu1+a@test.io', type: 'customer' },
          { id: 'ctx-u1', email: 'U1+A@test.io', type: 'customer' },
          { id: 'ctx-admin', email: 'u1+a@test.io', type: 'admin' },
        ),
      ),
    );
    await expect(findCtxCustomerIdByEmail('u1+a@test.io')).resolves.toBe('ctx-u1');
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.searchParams.get('type')).toBe('customer');
    expect(url.searchParams.get('email')).toBe('u1\\+a@test\\.io');
  });

  it('returns null when CTX lists no customer for the email', async () => {
    routeFetch(lookup(listOf({ id: 'ctx-x', email: 'other@test.io', type: 'customer' })));
    await expect(findCtxCustomerIdByEmail('u1@test.io')).resolves.toBeNull();
  });

  it('throws when CTX lists more than one customer for the email', async () => {
    routeFetch(
      lookup(
        listOf(
          { id: 'ctx-a', email: 'u1@test.io', type: 'customer' },
          { id: 'ctx-b', email: 'u1@test.io', type: 'customer' },
        ),
      ),
    );
    await expect(findCtxCustomerIdByEmail('u1@test.io')).rejects.toBeInstanceOf(CtxUserRolesError);
  });

  it('throws with the CTX status on a non-ok lookup', async () => {
    routeFetch(lookup(new Response('boom', { status: 500 })));
    await expect(findCtxCustomerIdByEmail('u1@test.io')).rejects.toMatchObject({ status: 500 });
  });
});

describe('loadOrCreateCtxCustomer', () => {
  it('loads the existing CTX customer without creating one', async () => {
    const fetchSpy = routeFetch(
      lookup(listOf({ id: 'ctx-u1', email: 'u1@test.io', type: 'customer' })),
      get('ctx-u1'),
    );
    await expect(loadOrCreateCtxCustomer('u1@test.io', { country: 'GB' })).resolves.toMatchObject({
      id: 'ctx-u1',
      status: 'enabled',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('POSTs a signed customer create with the country, then loads the new user', async () => {
    const fetchSpy = routeFetch(
      lookup(listOf()),
      create(json({ id: 'ctx-new' }, 201)),
      get('ctx-new'),
    );
    await expect(loadOrCreateCtxCustomer('u1@test.io', { country: 'gb' })).resolves.toMatchObject({
      id: 'ctx-new',
    });
    const [url, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(String(url)).toBe('http://ctx.test/users');
    const headers = new Headers(init.headers);
    expect(headers.get('X-Api-Key')).toBe('op-key');
    expect(headers.get('X-Api-Secret')).toBeNull();
    expect(headers.get('X-Signature')).toHaveLength(130);
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'u1@test.io',
      type: 'customer',
      country: 'GB',
    });
  });

  it('creates the customer as enabled when the caller has verified the email', async () => {
    const fetchSpy = routeFetch(
      lookup(listOf()),
      create(json({ id: 'ctx-new' }, 201)),
      get('ctx-new'),
    );
    await loadOrCreateCtxCustomer('u1@test.io', { emailVerified: true });
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      email: 'u1@test.io',
      type: 'customer',
      status: 'enabled',
    });
  });

  it('omits the country and status from the create body when the caller has neither', async () => {
    const fetchSpy = routeFetch(
      lookup(listOf()),
      create(json({ id: 'ctx-new' }, 201)),
      get('ctx-new'),
    );
    await loadOrCreateCtxCustomer('u1@test.io');
    const [, init] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ email: 'u1@test.io', type: 'customer' });
  });

  it('re-reads the customer a concurrent sign-in created when CTX reports the email taken', async () => {
    routeFetch(
      lookup(listOf()),
      create(json({ error: 'bad request', fields: { email: ['already exists'] } }, 400)),
      lookup(listOf({ id: 'ctx-raced', email: 'u1@test.io', type: 'customer' })),
      get('ctx-raced'),
    );
    await expect(loadOrCreateCtxCustomer('u1@test.io')).resolves.toMatchObject({
      id: 'ctx-raced',
    });
  });

  it('throws when CTX reports the email taken but still lists no customer', async () => {
    routeFetch(
      lookup(listOf()),
      create(json({ error: 'bad request', fields: { email: ['already exists'] } }, 400)),
      lookup(listOf()),
    );
    await expect(loadOrCreateCtxCustomer('u1@test.io')).rejects.toBeInstanceOf(CtxUserRolesError);
  });

  it('throws CtxUserCreationDisabledError when CTX has user creation disabled for the company', async () => {
    routeFetch(
      lookup(listOf()),
      create(
        json(
          {
            error: 'ErrUserCreationDisabled',
            message: 'user creation is disabled for this company',
          },
          403,
        ),
      ),
    );
    await expect(loadOrCreateCtxCustomer('u1@test.io')).rejects.toBeInstanceOf(
      CtxUserCreationDisabledError,
    );
  });

  it('throws CtxUserRolesError with the CTX status on any other create rejection', async () => {
    routeFetch(lookup(listOf()), create(json({ error: 'forbidden' }, 403)));
    await expect(loadOrCreateCtxCustomer('u1@test.io')).rejects.toMatchObject({
      name: 'CtxUserRolesError',
      status: 403,
    });
  });

  it('throws on create-response schema drift', async () => {
    routeFetch(lookup(listOf()), create(json({ nope: true }, 201)));
    await expect(loadOrCreateCtxCustomer('u1@test.io')).rejects.toBeInstanceOf(CtxUserRolesError);
  });
});
