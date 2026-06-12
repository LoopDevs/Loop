/**
 * requireStaff (ADR 037) — role resolution + tiering + concealment.
 *
 * The alias zero-change proof lives in require-admin.test.ts (kept
 * byte-identical to its pre-ADR-037 state); this file covers what
 * is NEW: the staff_roles resolution, the legacy users.is_admin
 * shim, the row-wins-over-shim rule, the lookup-failure fallback,
 * the support/admin tiering, and the context caching contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const getUserByIdMock = vi.fn();
const getStaffRoleMock = vi.fn();

vi.mock('../../db/users.js', () => ({
  getUserById: (id: string) => getUserByIdMock(id),
}));
vi.mock('../../db/staff-roles.js', () => ({
  getStaffRole: (id: string) => getStaffRoleMock(id),
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
  },
}));

import { requireStaff } from '../require-staff.js';

const loopAuth = { kind: 'loop', userId: 'u1', email: 'a@b.com', bearerToken: 'tok' };

interface FakeCtx {
  store: Map<string, unknown>;
  ctx: Context;
}

function makeCtx(auth: unknown, preset?: Record<string, unknown>): FakeCtx {
  const store = new Map<string, unknown>();
  if (auth !== undefined) store.set('auth', auth);
  for (const [k, v] of Object.entries(preset ?? {})) store.set(k, v);
  return {
    store,
    ctx: {
      get: (k: string) => store.get(k),
      set: (k: string, v: unknown) => store.set(k, v),
      json: (body: unknown, status?: number) =>
        new Response(JSON.stringify(body), {
          status: status ?? 200,
          headers: { 'content-type': 'application/json' },
        }),
    } as unknown as Context,
  };
}

beforeEach(() => {
  getUserByIdMock.mockReset();
  getStaffRoleMock.mockReset();
  getStaffRoleMock.mockResolvedValue(null);
});

describe('requireStaff — auth preconditions (both tiers)', () => {
  it('401 when no auth context is present', async () => {
    const { ctx } = makeCtx(undefined);
    const res = (await requireStaff('support')(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
  });

  it('401 when the auth context is legacy ctx pass-through', async () => {
    const { ctx } = makeCtx({ kind: 'ctx', bearerToken: 'header.payload.sig' });
    const res = (await requireStaff('support')(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
  });

  it('401 when the token points at no user row', async () => {
    getUserByIdMock.mockResolvedValue(null);
    const { ctx } = makeCtx(loopAuth);
    const res = (await requireStaff('support')(ctx, async () => {})) as Response;
    expect(res.status).toBe(401);
  });

  it('500 when the user lookup throws', async () => {
    getUserByIdMock.mockRejectedValue(new Error('db down'));
    const { ctx } = makeCtx(loopAuth);
    const res = (await requireStaff('support')(ctx, async () => {})) as Response;
    expect(res.status).toBe(500);
  });
});

describe('requireStaff — role resolution', () => {
  it('staff_roles admin row passes both tiers and sets context', async () => {
    const user = { id: 'u1', isAdmin: false };
    getUserByIdMock.mockResolvedValue(user);
    getStaffRoleMock.mockResolvedValue({ userId: 'u1', role: 'admin' });
    for (const tier of ['support', 'admin'] as const) {
      const fake = makeCtx(loopAuth);
      const next = vi.fn().mockResolvedValue(undefined);
      await requireStaff(tier)(fake.ctx, next);
      expect(next).toHaveBeenCalledOnce();
      expect(fake.store.get('user')).toEqual(user);
      expect(fake.store.get('staffRole')).toBe('admin');
    }
  });

  it('staff_roles support row passes support but 404s the admin tier', async () => {
    getUserByIdMock.mockResolvedValue({ id: 'u1', isAdmin: false });
    getStaffRoleMock.mockResolvedValue({ userId: 'u1', role: 'support' });

    const ok = makeCtx(loopAuth);
    const next = vi.fn().mockResolvedValue(undefined);
    await requireStaff('support')(ok.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(ok.store.get('staffRole')).toBe('support');

    const denied = makeCtx(loopAuth);
    const res = (await requireStaff('admin')(denied.ctx, async () => {})) as Response;
    expect(res.status).toBe(404);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('NOT_FOUND'); // 404 not 403 — concealment
  });

  it('legacy shim: no row + is_admin resolves to admin', async () => {
    getUserByIdMock.mockResolvedValue({ id: 'u1', isAdmin: true });
    getStaffRoleMock.mockResolvedValue(null);
    const fake = makeCtx(loopAuth);
    const next = vi.fn().mockResolvedValue(undefined);
    await requireStaff('admin')(fake.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(fake.store.get('staffRole')).toBe('admin');
  });

  it('no row + not admin is 404 on both tiers', async () => {
    getUserByIdMock.mockResolvedValue({ id: 'u1', isAdmin: false });
    for (const tier of ['support', 'admin'] as const) {
      const { ctx } = makeCtx(loopAuth);
      const res = (await requireStaff(tier)(ctx, async () => {})) as Response;
      expect(res.status).toBe(404);
    }
  });

  it('the staff_roles row WINS over the is_admin shim (demoted admin)', async () => {
    // Demoted to support but the deprecated mirror is still true
    // (e.g. CTX-allowlist user): the table is authoritative.
    getUserByIdMock.mockResolvedValue({ id: 'u1', isAdmin: true });
    getStaffRoleMock.mockResolvedValue({ userId: 'u1', role: 'support' });
    const { ctx } = makeCtx(loopAuth);
    const res = (await requireStaff('admin')(ctx, async () => {})) as Response;
    expect(res.status).toBe(404);
  });

  it('falls back to the legacy shim when the staff_roles read throws', async () => {
    getStaffRoleMock.mockRejectedValue(new Error('relation does not exist'));

    // is_admin admin keeps access (pre-ADR-037 semantics)…
    getUserByIdMock.mockResolvedValue({ id: 'u1', isAdmin: true });
    const next = vi.fn().mockResolvedValue(undefined);
    await requireStaff('admin')(makeCtx(loopAuth).ctx, next);
    expect(next).toHaveBeenCalledOnce();

    // …support fails CLOSED to 404.
    getUserByIdMock.mockResolvedValue({ id: 'u1', isAdmin: false });
    const res = (await requireStaff('support')(makeCtx(loopAuth).ctx, async () => {})) as Response;
    expect(res.status).toBe(404);
  });
});

describe('requireStaff — context caching (blanket + per-mount chain)', () => {
  it('reuses a chain-resolved role without a second DB round-trip', async () => {
    const user = { id: 'u1', isAdmin: false };
    const fake = makeCtx(loopAuth, { user, staffRole: 'admin' });
    const next = vi.fn().mockResolvedValue(undefined);
    await requireStaff('admin')(fake.ctx, next);
    expect(next).toHaveBeenCalledOnce();
    expect(getUserByIdMock).not.toHaveBeenCalled();
    expect(getStaffRoleMock).not.toHaveBeenCalled();
  });

  it('cached support role still 404s the admin tier', async () => {
    const fake = makeCtx(loopAuth, { user: { id: 'u1', isAdmin: false }, staffRole: 'support' });
    const res = (await requireStaff('admin')(fake.ctx, async () => {})) as Response;
    expect(res.status).toBe(404);
    expect(getStaffRoleMock).not.toHaveBeenCalled();
  });
});
