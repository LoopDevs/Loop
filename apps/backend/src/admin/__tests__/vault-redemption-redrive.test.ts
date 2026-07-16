/**
 * Admin vault-redemption re-drive lever (ADR 031 V7). Mirrors
 * `vault-emission-redrive.test.ts`'s shape, plus the needs-refund
 * short-circuit that has no emission-side equivalent.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';

const state = vi.hoisted(() => ({
  rows: new Map<string, Record<string, unknown>>(),
  reclaimResult: null as null | { kind: string; row?: Record<string, unknown> },
  driveCalls: [] as Array<Record<string, unknown>>,
  driveOutcome: 'settled' as string,
  postDriveRow: null as null | Record<string, unknown>,
  snapshotStored: false,
  priorSnapshot: null as null | { status: number; body: Record<string, unknown> },
  discordCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../credits/vaults/vault-redemptions.js', () => ({
  getVaultRedemptionById: vi.fn(async (id: string) => state.rows.get(id) ?? null),
  reclaimFailedVaultRedemptionForRedrive: vi.fn(async (id: string) => {
    if (state.reclaimResult !== null) return state.reclaimResult;
    const row = state.rows.get(id);
    if (row === undefined) return { kind: 'not_found' };
    if (row['state'] !== 'failed') return { kind: 'not_failed', row };
    return { kind: 'reclaimed', row: { ...row, state: 'redeemed', attempts: 0 } };
  }),
  driveOneVaultRedemption: vi.fn(async (row: Record<string, unknown>) => {
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

import { adminRedriveVaultRedemptionHandler } from '../vault-redemption-redrive.js';

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
  adminRedriveVaultRedemptionHandler(
    makeCtx({
      headers: { 'idempotency-key': validKey },
      body: { reason: 'stuck failed redemption, worker looks dead, re-driving' },
      ...over,
    }),
  );

function makeRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: ID,
    sourceType: 'order_redeem',
    sourceId: 'order-1',
    state: 'failed',
    attempts: 5,
    collectTxHash: 'c1',
    collectedAt: new Date(),
    payoutPath: null,
    redeemedAt: null,
    lastError: 'Soroban RPC timeout',
    // NS-05: a real redemption row carries the value being redeemed
    // (vault currency minor units) + asset the value cap reads. Default
    // well under the 100_000 minor cap so happy-path cases pass the gate.
    valueMinor: 5_000n,
    assetCode: 'LOOPUSD',
    ...overrides,
  };
}

beforeEach(() => {
  state.rows = new Map([[ID, makeRow()]]);
  state.reclaimResult = null;
  state.driveCalls = [];
  state.driveOutcome = 'settled';
  state.postDriveRow = null;
  state.snapshotStored = false;
  state.priorSnapshot = null;
  state.discordCalls = [];
});

describe('adminRedriveVaultRedemptionHandler — failed rows', () => {
  it('200: reclaims a failed row and drives the RECLAIMED (resumed) row, not the raw failed one', async () => {
    const res = await redrive();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toMatchObject({
      vaultRedemptionId: ID,
      sourceType: 'order_redeem',
      sourceId: 'order-1',
      priorState: 'failed',
      resumedFromState: 'redeemed',
      outcome: 'settled',
    });
    expect(state.driveCalls).toHaveLength(1);
    expect(state.driveCalls[0]?.['state']).toBe('redeemed'); // the RECLAIMED row, not 'failed'
    expect(state.discordCalls).toHaveLength(1);
  });

  it('race_changed (a concurrent redrive already reclaimed it) → 409, never drives', async () => {
    state.reclaimResult = { kind: 'not_failed', row: makeRow({ state: 'collecting' }) };
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('VAULT_REDEMPTION_REDRIVE_RACE');
    expect(state.driveCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });
});

describe('adminRedriveVaultRedemptionHandler — needs-refund short-circuit', () => {
  it('409 VAULT_REDEMPTION_NEEDS_REFUND — never drives, stores no snapshot, does not re-attempt a payout', async () => {
    state.reclaimResult = {
      kind: 'needs_refund',
      row: makeRow({
        payoutPath: 'fast',
        redeemedAt: new Date(),
        lastError: 'order not payable at mirror time (order order-1 is expired, no longer payable)',
      }),
    };
    const res = await redrive();
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; message: string };
    expect(body.code).toBe('VAULT_REDEMPTION_NEEDS_REFUND');
    expect(body.message).toMatch(/manual refund/i);
    expect(state.driveCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });
});

describe('adminRedriveVaultRedemptionHandler — operator-confirmed-stuck (non-failed) rows', () => {
  it('drives a live non-terminal row AS-IS, with no state mutation before the drive call', async () => {
    state.rows.set(ID, makeRow({ state: 'collecting', attempts: 1 }));
    const res = await redrive();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.result).toMatchObject({ priorState: 'collecting', resumedFromState: 'collecting' });
    expect(state.driveCalls).toHaveLength(1);
    expect(state.driveCalls[0]?.['state']).toBe('collecting');
  });
});

describe('adminRedriveVaultRedemptionHandler — already-terminal / not-found', () => {
  it('409 VAULT_REDEMPTION_ALREADY_SETTLED — never drives, stores no snapshot', async () => {
    state.rows.set(ID, makeRow({ state: 'settled' }));
    const res = await redrive();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('VAULT_REDEMPTION_ALREADY_SETTLED');
    expect(state.driveCalls).toEqual([]);
    expect(state.snapshotStored).toBe(false);
  });

  it('404 when the vault redemption does not exist', async () => {
    state.rows = new Map();
    const res = await redrive();
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('NOT_FOUND');
    expect(state.driveCalls).toEqual([]);
  });
});

describe('adminRedriveVaultRedemptionHandler — NS-05 per-action value cap', () => {
  // Default cap is 100_000 minor ($1,000). driveOneVaultRedemption
  // collects shares + pays value out on-chain, so the cap rejects first.
  it('422 ADMIN_ACTION_VALUE_CAP_EXCEEDED when value > cap — never drives, no snapshot', async () => {
    state.rows.set(ID, makeRow({ valueMinor: 100_001n, assetCode: 'LOOPUSD' }));
    const res = await redrive();
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('ADMIN_ACTION_VALUE_CAP_EXCEEDED');
    expect(state.driveCalls).toEqual([]); // no money moved
    expect(state.snapshotStored).toBe(false); // rolled back, replay stays free
  });

  it('200 at exactly the cap boundary (100_000 minor) — reclaims and drives', async () => {
    state.rows.set(ID, makeRow({ valueMinor: 100_000n, assetCode: 'LOOPUSD' }));
    const res = await redrive();
    expect(res.status).toBe(200);
    expect(state.driveCalls).toHaveLength(1); // proceeds: money move authorised
  });
});

describe('adminRedriveVaultRedemptionHandler — request validation', () => {
  it('400 on bad id / missing idempotency key / missing reason', async () => {
    expect((await redrive({ id: 'nope' })).status).toBe(400);
    expect((await redrive({ headers: {} })).status).toBe(400);
    expect((await redrive({ body: {} })).status).toBe(400);
    expect(state.driveCalls).toEqual([]);
  });
});

describe('adminRedriveVaultRedemptionHandler — idempotency', () => {
  it('a same-key replay does NOT drive a second time (double-click safety)', async () => {
    const first = await redrive();
    expect(first.status).toBe(200);
    expect(state.driveCalls).toHaveLength(1);

    state.priorSnapshot = {
      status: 200,
      body: {
        result: {
          vaultRedemptionId: ID,
          sourceType: 'order_redeem',
          sourceId: 'order-1',
          priorState: 'failed',
          resumedFromState: 'redeemed',
          outcome: 'settled',
          state: 'settled',
          attempts: 0,
        },
        audit: {},
      },
    };

    const second = await redrive();
    expect(second.status).toBe(200);
    expect(state.driveCalls).toHaveLength(1);
    expect(state.discordCalls).toHaveLength(2);
  });

  it('replays return the snapshot and mark the audit as replayed', async () => {
    state.priorSnapshot = {
      status: 200,
      body: {
        result: {
          vaultRedemptionId: ID,
          sourceType: 'order_redeem',
          sourceId: 'order-1',
          priorState: 'failed',
          resumedFromState: 'redeemed',
          outcome: 'settled',
          state: 'settled',
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
