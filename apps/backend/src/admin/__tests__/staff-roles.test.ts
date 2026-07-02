/**
 * Staff role-management handlers (ADR 037 §1): envelope shape,
 * self-revoke + last-admin guards, replay marking, target-missing
 * 404s. The repo's locked count-then-write atomicity is covered by
 * the typed-error mapping here plus the flywheel-integration job.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { LastAdminError, StaffRoleNotFoundError } from '../../db/staff-roles.js';

const state = vi.hoisted(() => ({
  grantResult: null as null | { priorRole: 'admin' | 'support' | null; grantedAt: Date },
  grantThrow: null as Error | null,
  grantArgs: null as null | Record<string, unknown>,
  revokeResult: null as null | { priorRole: 'admin' | 'support' },
  revokeThrow: null as Error | null,
  listResult: [] as unknown[],
  targetUser: null as null | Record<string, unknown>,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../db/staff-roles.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    listStaffEntries: vi.fn(async () => state.listResult),
    grantStaffRole: vi.fn(async (args: Record<string, unknown>) => {
      state.grantArgs = args;
      if (state.grantThrow !== null) throw state.grantThrow;
      return state.grantResult;
    }),
    revokeStaffRole: vi.fn(async () => {
      if (state.revokeThrow !== null) throw state.revokeThrow;
      return state.revokeResult;
    }),
  };
});

vi.mock('../../db/users.js', () => ({
  getUserById: vi.fn(async () => state.targetUser),
}));

vi.mock('../idempotency.js', () => ({
  IDEMPOTENCY_KEY_MIN: 16,
  IDEMPOTENCY_KEY_MAX: 128,
  validateIdempotencyKey: (k: string | undefined): k is string =>
    k !== undefined && k.length >= 16 && k.length <= 128,
  withIdempotencyGuard: vi.fn(
    async (
      _args: unknown,
      doWrite: () => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      if (state.priorSnapshot !== null) {
        return {
          replayed: true,
          status: state.priorSnapshot.status,
          body: state.priorSnapshot.body,
        };
      }
      const { status, body } = await doWrite();
      return { replayed: false, status, body };
    },
  ),
}));

vi.mock('../../discord.js', () => ({
  notifyAdminAudit: vi.fn((args: Record<string, unknown>) => {
    state.discordCalls.push(args);
  }),
}));

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

import {
  adminGrantStaffRoleHandler,
  adminListStaffHandler,
  adminRevokeStaffRoleHandler,
} from '../staff-roles.js';

const ACTOR_ID = '11111111-1111-1111-1111-111111111111';
const TARGET_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const actor = { id: ACTOR_ID, email: 'admin@loop.test', isAdmin: true };
const validKey = 'k'.repeat(32);

function makeCtx(args: {
  userId?: string;
  headers?: Record<string, string>;
  body?: unknown;
  noActor?: boolean;
}): Context {
  const store = new Map<string, unknown>();
  if (args.noActor !== true) store.set('user', actor);
  return {
    req: {
      param: (k: string) => (k === 'userId' ? (args.userId ?? TARGET_ID) : undefined),
      header: (k: string) => args.headers?.[k.toLowerCase()],
      json: async () => {
        if (args.body === undefined) throw new Error('no body');
        return args.body;
      },
    },
    get: (k: string) => store.get(k),
    json: (body: unknown, status?: number) =>
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
  } as unknown as Context;
}

beforeEach(() => {
  state.grantResult = { priorRole: null, grantedAt: new Date('2026-06-12T10:00:00Z') };
  state.grantThrow = null;
  state.grantArgs = null;
  state.revokeResult = { priorRole: 'support' };
  state.revokeThrow = null;
  state.listResult = [];
  state.targetUser = { id: TARGET_ID, email: 'target@loop.test', isAdmin: false };
  state.priorSnapshot = null;
  state.discordCalls = [];
});

describe('adminListStaffHandler', () => {
  it('returns the staff list', async () => {
    state.listResult = [{ userId: TARGET_ID, role: 'support' }];
    const res = await adminListStaffHandler(makeCtx({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ staff: [{ userId: TARGET_ID, role: 'support' }] });
  });
});

describe('adminGrantStaffRoleHandler', () => {
  const grant = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
    adminGrantStaffRoleHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { role: 'support', reason: 'new support hire' },
        ...over,
      }),
    );

  it('200 with the full ADR-017 envelope + Discord fanout', async () => {
    const res = await grant();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({
      userId: TARGET_ID,
      role: 'support',
      priorRole: null,
      grantedAt: '2026-06-12T10:00:00.000Z',
    });
    expect(body.audit).toMatchObject({
      actorUserId: ACTOR_ID,
      idempotencyKey: validKey,
      replayed: false,
    });
    expect(state.grantArgs).toMatchObject({
      userId: TARGET_ID,
      role: 'support',
      grantedByUserId: ACTOR_ID,
      reason: 'new support hire',
    });
    expect(state.discordCalls).toHaveLength(1);
    expect(state.discordCalls[0]).toMatchObject({
      endpoint: `PUT /api/admin/staff/${TARGET_ID}/role`,
    });
  });

  it('400 on bad uuid / missing key / bad body', async () => {
    expect((await grant({ userId: 'nope' })).status).toBe(400);
    expect((await grant({ headers: {} })).status).toBe(400);
    expect((await grant({ body: { role: 'superuser', reason: 'x'.repeat(10) } })).status).toBe(400);
  });

  it('409 STAFF_SELF_REVOKE when demoting yourself', async () => {
    const res = await grant({ userId: ACTOR_ID });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STAFF_SELF_REVOKE');
  });

  it('granting yourself admin (no-op re-grant) is allowed', async () => {
    const res = await adminGrantStaffRoleHandler(
      makeCtx({
        userId: ACTOR_ID,
        headers: { 'idempotency-key': validKey },
        body: { role: 'admin', reason: 'refresh grant metadata' },
      }),
    );
    expect(res.status).toBe(200);
  });

  it('404 USER_NOT_FOUND when the target does not exist', async () => {
    state.targetUser = null;
    const res = await grant();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('USER_NOT_FOUND');
  });

  it('409 STAFF_LAST_ADMIN when the repo refuses the demotion', async () => {
    state.grantThrow = new LastAdminError();
    const res = await grant();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STAFF_LAST_ADMIN');
  });

  it('replays mark the Discord fanout as replayed', async () => {
    state.priorSnapshot = {
      status: 200,
      body: { result: { userId: TARGET_ID }, audit: { replayed: true } },
    };
    const res = await grant();
    expect(res.status).toBe(200);
    expect(state.discordCalls[0]).toMatchObject({ replayed: true });
  });
});

describe('adminRevokeStaffRoleHandler', () => {
  const revoke = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
    adminRevokeStaffRoleHandler(
      makeCtx({
        headers: { 'idempotency-key': validKey },
        body: { reason: 'left the company' },
        ...over,
      }),
    );

  it('200 with envelope + prior role', async () => {
    const res = await revoke();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toEqual({ userId: TARGET_ID, priorRole: 'support' });
    expect(body.audit).toMatchObject({ replayed: false });
    expect(state.discordCalls).toHaveLength(1);
  });

  it('409 STAFF_SELF_REVOKE on self-revocation', async () => {
    const res = await revoke({ userId: ACTOR_ID });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STAFF_SELF_REVOKE');
  });

  it('404 when the target holds no staff role', async () => {
    state.revokeThrow = new StaffRoleNotFoundError();
    const res = await revoke();
    expect(res.status).toBe(404);
  });

  it('409 STAFF_LAST_ADMIN when revoking the final admin', async () => {
    state.revokeThrow = new LastAdminError();
    const res = await revoke();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('STAFF_LAST_ADMIN');
  });

  it('400 when reason is missing', async () => {
    const res = await revoke({ body: {} });
    expect(res.status).toBe(400);
  });
});
