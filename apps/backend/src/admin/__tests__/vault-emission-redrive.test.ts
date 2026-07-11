/**
 * Admin vault-emission re-drive lever (ADR 031 V7). This file covers
 * the HANDLER edge — same pattern as `order-redrive.test.ts`: state
 * eligibility routing (failed rows reclaimed + driven, already-mirrored
 * refused, operator-confirmed-stuck rows driven as-is), the outcome →
 * status mapping, the no-snapshot-on-failure contract, and same-key
 * idempotent replay.
 *
 * The money-safety property the handler *delegates to* rather than
 * reimplements — resume-state inference never re-doing a completed
 * on-chain step — is proven directly in
 * `credits/vaults/__tests__/vault-emissions.test.ts`
 * (`inferVaultEmissionResumeState` / `reclaimFailedVaultEmissionForRedrive`
 * describe blocks) and end-to-end in `__tests__/integration/vault-emissions.test.ts`.
 * What IS proven here: the handler calls `driveOneVaultEmission` AT MOST
 * ONCE per redrive, passes it the RECLAIMED row (not a fresh 'pending'
 * one), never drives at all when a guard trips, and a same-key
 * double-click converges to one drive call via the idempotency-guard
 * replay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  reclaimResult: null as null | { kind: string; row?: Record<string, unknown> },
  driveCalls: [] as Array<Record<string, unknown>>,
  driveOutcome: 'mirrored' as string,
  postDriveRow: null as null | Record<string, unknown>,
  snapshotStored: false,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
  // money-review #1652 P1: when true, the emission sweep is holding the
  // fleet-wide advisory lock — the re-drive's own `withAdvisoryLock`
  // returns `{ ran: false }` and the handler must refuse rather than
  // drive un-serialised.
  sweepLockHeld: false,
  advisoryLockCalls: [] as bigint[],
}));

vi.mock('../../db/client.js', () => ({
  // Mirrors the real `withAdvisoryLock` contract (db/client.ts): runs
  // `fn` and returns `{ ran: true, value }` when the lock is free, or
  // `{ ran: false }` (without running `fn`) when another holder — here
  // the sweep — has it.
  withAdvisoryLock: vi.fn(async (key: bigint, fn: () => Promise<unknown>) => {
    state.advisoryLockCalls.push(key);
    if (state.sweepLockHeld) return { ran: false as const };
    return { ran: true as const, value: await fn() };
  }),
}));

vi.mock('../../credits/vaults/vault-emissions.js', () => ({
  vaultEmissionSweepLockKey: vi.fn(() => 424242n),
  getVaultEmissionById: vi.fn(async (id: string) => state.rows.get(id) ?? null),
  reclaimFailedVaultEmissionForRedrive: vi.fn(async (id: string) => {
    if (state.reclaimResult !== null) return state.reclaimResult;
    const row = state.rows.get(id);
    if (row === undefined) return { kind: 'not_found' };
    if (row['state'] !== 'failed') return { kind: 'not_failed', row };
    return { kind: 'reclaimed', row: { ...row, state: 'deposited', attempts: 0 } };
  }),
  driveOneVaultEmission: vi.fn(async (row: Record<string, unknown>) => {
    state.driveCalls.push(row);
    if (state.postDriveRow !== null) state.rows.set(row['id'] as string, state.postDriveRow);
    return state.driveOutcome;
  }),
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
      state.snapshotStored = true;
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
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { adminRedriveVaultEmissionHandler } from '../vault-emission-redrive.js';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const actor = { id: '11111111-1111-1111-1111-111111111111', email: 'admin@loop.test' };
const validKey = 'k'.repeat(32);

function makeCtx(args: { id?: string; headers?: Record<string, string>; body?: unknown }): Context {
  const store = new Map<string, unknown>([['user', actor]]);
  return {
    req: {
      param: (k: string) => (k === 'id' ? (args.id ?? ID) : undefined),
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

const redrive = (over?: Partial<Parameters<typeof makeCtx>[0]>): Promise<Response> =>
  adminRedriveVaultEmissionHandler(
    makeCtx({
      headers: { 'idempotency-key': validKey },
      body: { reason: 'stuck failed emission, worker looks dead, re-driving' },
      ...over,
    }),
  );

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ID,
    orderId: 'order-1',
    state: 'failed',
    attempts: 5,
    depositTxHash: 'd1',
    sharesMinted: 480n,
    depositedAt: new Date(),
    transferTxHash: null,
    transferredAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  state.rows = new Map([[ID, makeRow()]]);
  state.reclaimResult = null;
  state.driveCalls = [];
  state.driveOutcome = 'mirrored';
  state.postDriveRow = null;
  state.snapshotStored = false;
  state.priorSnapshot = null;
  state.discordCalls = [];
  state.sweepLockHeld = false;
  state.advisoryLockCalls = [];
});

describe('adminRedriveVaultEmissionHandler — failed rows', () => {
  it('200: reclaims a failed row and drives the RECLAIMED (resumed) row, not the raw failed one', async () => {
    const res = await redrive();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toMatchObject({
      vaultEmissionId: ID,
      orderId: 'order-1',
      priorState: 'failed',
      resumedFromState: 'deposited',
      outcome: 'mirrored',
    });
    expect(state.driveCalls).toHaveLength(1);
    expect(state.driveCalls[0]?.['state']).toBe('deposited'); // the RECLAIMED row, not 'failed'
    expect(state.discordCalls).toHaveLength(1);
  });

  it('reports the fresh post-drive state via a second read', async () => {
    state.postDriveRow = makeRow({ state: 'mirrored', attempts: 0 });
    const res = await redrive();
    const body = (await res.json()) as Record<string, any>;
    expect(body.result.state).toBe('mirrored');
  });

  it('race_changed (a concurrent redrive already reclaimed it) → 409, never drives', async () => {
    state.reclaimResult = { kind: 'not_failed', row: makeRow({ state: 'transferred' }) };
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('VAULT_EMISSION_REDRIVE_RACE');
    expect(state.driveCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });
});

describe('adminRedriveVaultEmissionHandler — serialised against the emission sweep (money-review #1652 P1)', () => {
  it('acquires the emission sweep advisory lock before driving', async () => {
    const res = await redrive();
    expect(res.status).toBe(200);
    // The drive ran INSIDE the advisory lock — exactly one lock
    // acquisition, keyed by the exported sweep lock key.
    expect(state.advisoryLockCalls).toEqual([424242n]);
    expect(state.driveCalls).toHaveLength(1);
  });

  it('409 VAULT_EMISSION_REDRIVE_SWEEP_IN_PROGRESS when the sweep holds the lock — NEVER drives, stores no snapshot', async () => {
    state.sweepLockHeld = true;
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'VAULT_EMISSION_REDRIVE_SWEEP_IN_PROGRESS',
    );
    // The lock was attempted, but because it was held the fn never ran:
    // no drive, no reclaim mutation, no stored idempotency snapshot (a
    // retry re-attempts once the sweep releases).
    expect(state.advisoryLockCalls).toEqual([424242n]);
    expect(state.driveCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });

  it('also refuses an operator-confirmed-stuck (non-failed) row when the sweep holds the lock', async () => {
    state.rows.set(ID, makeRow({ state: 'transferred', attempts: 1 }));
    state.sweepLockHeld = true;
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe(
      'VAULT_EMISSION_REDRIVE_SWEEP_IN_PROGRESS',
    );
    expect(state.driveCalls).toEqual([]);
  });
});

describe('adminRedriveVaultEmissionHandler — operator-confirmed-stuck (non-failed) rows', () => {
  it('drives a live non-terminal row AS-IS, with no state mutation before the drive call', async () => {
    state.rows.set(ID, makeRow({ state: 'transferred', attempts: 1 }));
    const res = await redrive();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toMatchObject({
      priorState: 'transferred',
      resumedFromState: 'transferred',
    });
    expect(state.driveCalls).toHaveLength(1);
    expect(state.driveCalls[0]?.['state']).toBe('transferred');
  });
});

describe('adminRedriveVaultEmissionHandler — already-terminal / not-found', () => {
  it('409 VAULT_EMISSION_ALREADY_MIRRORED — never drives, stores no snapshot', async () => {
    state.rows.set(ID, makeRow({ state: 'mirrored' }));
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('VAULT_EMISSION_ALREADY_MIRRORED');
    expect(state.driveCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });

  it('404 when the vault emission does not exist', async () => {
    state.rows = new Map();
    const res = await redrive();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    expect(state.driveCalls).toEqual([]);
  });
});

describe('adminRedriveVaultEmissionHandler — request validation', () => {
  it('400 on bad id / missing idempotency key / missing reason', async () => {
    expect((await redrive({ id: 'nope' })).status).toBe(400);
    expect((await redrive({ headers: {} })).status).toBe(400);
    expect((await redrive({ body: {} })).status).toBe(400);
    expect(state.driveCalls).toEqual([]);
  });
});

describe('adminRedriveVaultEmissionHandler — idempotency', () => {
  it('a same-key replay does NOT drive a second time (double-click safety)', async () => {
    const first = await redrive();
    expect(first.status).toBe(200);
    expect(state.driveCalls).toHaveLength(1);

    state.priorSnapshot = {
      status: 200,
      body: {
        result: {
          vaultEmissionId: ID,
          orderId: 'order-1',
          priorState: 'failed',
          resumedFromState: 'deposited',
          outcome: 'mirrored',
          state: 'mirrored',
          attempts: 0,
        },
        audit: {},
      },
    };

    const second = await redrive();
    expect(second.status).toBe(200);
    expect(state.driveCalls).toHaveLength(1);
    expect(state.discordCalls).toHaveLength(2); // audit fires on replay too
  });

  it('replays return the snapshot and mark the audit as replayed', async () => {
    state.priorSnapshot = {
      status: 200,
      body: {
        result: {
          vaultEmissionId: ID,
          orderId: 'order-1',
          priorState: 'failed',
          resumedFromState: 'deposited',
          outcome: 'mirrored',
          state: 'mirrored',
          attempts: 0,
        },
        audit: { replayed: false },
      },
    };
    const res = await redrive();
    expect(res.status).toBe(200);
    expect(state.driveCalls).toEqual([]);
    expect(state.discordCalls[0]).toMatchObject({ replayed: true });
  });
});
