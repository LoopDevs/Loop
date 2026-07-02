/**
 * Staff-role repo (ADR 037) — grant/revoke semantics under a
 * scripted transaction: last-admin protection, the is_admin mirror,
 * the row-wins effective-role resolution. The real locked
 * count-then-write atomicity needs postgres (flywheel-integration);
 * these pin the decision logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { txState } = vi.hoisted(() => ({
  txState: {
    /** Results dequeued per awaited tx.select(...) chain. */
    selectResults: [] as unknown[][],
    executes: 0,
    inserted: null as Record<string, unknown> | null,
    updated: [] as Array<Record<string, unknown>>,
    deleted: 0,
  },
}));

vi.mock('../client.js', () => {
  const selectChain = (): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    for (const m of ['from', 'leftJoin', 'where', 'orderBy']) chain[m] = () => chain;
    chain['then'] = (resolve: (rows: unknown[]) => void) =>
      Promise.resolve(resolve(txState.selectResults.shift() ?? []));
    return chain;
  };
  const tx = {
    execute: vi.fn(async () => {
      txState.executes++;
      return [];
    }),
    select: () => selectChain(),
    insert: () => ({
      values: (v: Record<string, unknown>) => ({
        onConflictDoUpdate: () => {
          txState.inserted = v;
          return Promise.resolve([]);
        },
      }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          txState.updated.push(v);
          return [];
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        txState.deleted++;
        return [];
      },
    }),
  };
  return {
    db: {
      transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
      query: { staffRoles: { findFirst: vi.fn() } },
      select: () => selectChain(),
    },
  };
});

import {
  grantStaffRole,
  LastAdminError,
  revokeStaffRole,
  StaffRoleNotFoundError,
} from '../staff-roles.js';

const TARGET = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ACTOR = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  txState.selectResults = [];
  txState.executes = 0;
  txState.inserted = null;
  txState.updated = [];
  txState.deleted = 0;
});

describe('grantStaffRole', () => {
  it('grants support and mirrors is_admin=false (advisory lock taken)', async () => {
    txState.selectResults = [[{ role: null }]]; // not currently staff
    const out = await grantStaffRole({
      userId: TARGET,
      role: 'support',
      grantedByUserId: ACTOR,
      reason: 'hire',
    });
    expect(out.priorRole).toBeNull();
    expect(txState.executes).toBe(1); // pg_advisory_xact_lock
    expect(txState.inserted).toMatchObject({ userId: TARGET, role: 'support' });
    expect(txState.updated[0]).toMatchObject({ isAdmin: false });
  });

  it('grants admin and mirrors is_admin=true', async () => {
    txState.selectResults = [[{ role: 'support' }]];
    const out = await grantStaffRole({
      userId: TARGET,
      role: 'admin',
      grantedByUserId: ACTOR,
      reason: 'promotion',
    });
    expect(out.priorRole).toBe('support');
    expect(txState.updated[0]).toMatchObject({ isAdmin: true });
  });

  it('refuses to demote the final effective admin', async () => {
    txState.selectResults = [[{ role: 'admin' }], [{ n: 1 }]];
    await expect(
      grantStaffRole({ userId: TARGET, role: 'support', grantedByUserId: ACTOR, reason: 'demote' }),
    ).rejects.toBeInstanceOf(LastAdminError);
    expect(txState.inserted).toBeNull(); // nothing written
  });

  it('demotes when another admin remains', async () => {
    txState.selectResults = [[{ role: 'admin' }], [{ n: 2 }]];
    const out = await grantStaffRole({
      userId: TARGET,
      role: 'support',
      grantedByUserId: ACTOR,
      reason: 'demote',
    });
    expect(out.priorRole).toBe('admin');
    expect(txState.inserted).toMatchObject({ role: 'support' });
  });
});

describe('revokeStaffRole', () => {
  it('throws StaffRoleNotFoundError for a non-staff user', async () => {
    txState.selectResults = [[{ role: null }]];
    await expect(revokeStaffRole({ userId: TARGET })).rejects.toBeInstanceOf(
      StaffRoleNotFoundError,
    );
    expect(txState.deleted).toBe(0);
  });

  it('refuses to revoke the final effective admin (legacy shim counts)', async () => {
    // Effective admin via the is_admin shim — no staff_roles row.
    txState.selectResults = [[{ role: 'admin' }], [{ n: 1 }]];
    await expect(revokeStaffRole({ userId: TARGET })).rejects.toBeInstanceOf(LastAdminError);
  });

  it('revokes a support role without a count check and clears the mirror', async () => {
    txState.selectResults = [[{ role: 'support' }]];
    const out = await revokeStaffRole({ userId: TARGET });
    expect(out.priorRole).toBe('support');
    expect(txState.deleted).toBe(1);
    expect(txState.updated[0]).toMatchObject({ isAdmin: false });
  });

  it('revokes an admin when another remains', async () => {
    txState.selectResults = [[{ role: 'admin' }], [{ n: 3 }]];
    const out = await revokeStaffRole({ userId: TARGET });
    expect(out.priorRole).toBe('admin');
    expect(txState.deleted).toBe(1);
  });
});
