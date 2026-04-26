/**
 * A2-1905 — deleteUserViaAnonymisation tests.
 *
 * Critical invariants:
 *   - blocks deletion when a payout is `pending` or `submitted`
 *   - blocks deletion when an order is mid-fulfilment
 *   - on success, the user's email is replaced with the synthetic
 *     placeholder, ctx_user_id + stellar_address null out
 *   - identities are deleted, refresh tokens revoked
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { state } = vi.hoisted(() => {
  const s: {
    payoutBlockingRows: Array<{ id: string }>;
    orderBlockingRows: Array<{ id: string }>;
    /** Captures of writes for assertions. */
    deletedFromIdentitiesUserId: string | null;
    updatedUserSet: Record<string, unknown> | null;
    updatedUserWhereId: string | null;
    revokedForUserId: string | null;
    txnRan: boolean;
  } = {
    payoutBlockingRows: [],
    orderBlockingRows: [],
    deletedFromIdentitiesUserId: null,
    updatedUserSet: null,
    updatedUserWhereId: null,
    revokedForUserId: null,
    txnRan: false,
  };
  return { state: s };
});

vi.mock('../../db/schema.js', () => ({
  pendingPayouts: { __tag: 'pendingPayouts', userId: 'userId', state: 'state' },
  orders: { __tag: 'orders', userId: 'userId', state: 'state' },
  userIdentities: { __tag: 'userIdentities', userId: 'userId' },
  users: { __tag: 'users', id: 'id' },
  PAYOUT_STATES: ['pending', 'submitted', 'confirmed', 'failed'],
  ORDER_STATES: ['pending_payment', 'paid', 'procuring', 'fulfilled', 'failed', 'expired'],
}));

vi.mock('drizzle-orm', () => ({
  and: (...args: unknown[]) => ({ __and: args }),
  eq: (col: unknown, value: unknown) => ({ __eq: col, value }),
  inArray: (col: unknown, values: unknown[]) => ({ __inArray: col, values }),
}));

vi.mock('../../auth/refresh-tokens.js', () => ({
  revokeAllRefreshTokensForUser: vi.fn(async (userId: string) => {
    state.revokedForUserId = userId;
  }),
}));

vi.mock('../../db/client.js', () => {
  function selectChain(): {
    from: (t: { __tag: string }) => {
      where: (where: unknown) => { limit: (n: number) => Promise<Array<{ id: string }>> };
    };
  } {
    return {
      from: (t) => ({
        where: () => ({
          limit: async () => {
            if (t.__tag === 'pendingPayouts') return state.payoutBlockingRows;
            if (t.__tag === 'orders') return state.orderBlockingRows;
            return [];
          },
        }),
      }),
    };
  }
  function tx(): {
    delete: (t: { __tag: string }) => {
      where: (where: { value?: string }) => Promise<void>;
    };
    update: (t: { __tag: string }) => {
      set: (s: Record<string, unknown>) => {
        where: (where: { value?: string }) => Promise<void>;
      };
    };
  } {
    return {
      delete: (t) => ({
        where: async (where) => {
          if (t.__tag === 'userIdentities') {
            state.deletedFromIdentitiesUserId = (where as { value?: string }).value ?? null;
          }
        },
      }),
      update: (t) => ({
        set: (setBody) => ({
          where: async (where) => {
            if (t.__tag === 'users') {
              state.updatedUserSet = setBody;
              state.updatedUserWhereId = (where as { value?: string }).value ?? null;
            }
          },
        }),
      }),
    };
  }
  return {
    db: {
      select: () => selectChain(),
      transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => {
        state.txnRan = true;
        return cb(tx());
      }),
    },
  };
});

import { deleteUserViaAnonymisation, deletedEmailFor } from '../dsr-delete.js';

beforeEach(() => {
  state.payoutBlockingRows = [];
  state.orderBlockingRows = [];
  state.deletedFromIdentitiesUserId = null;
  state.updatedUserSet = null;
  state.updatedUserWhereId = null;
  state.revokedForUserId = null;
  state.txnRan = false;
});

describe('deleteUserViaAnonymisation (A2-1905)', () => {
  it('refuses with blockedBy=pending_payouts when a payout is in flight', async () => {
    state.payoutBlockingRows = [{ id: 'p-1' }];
    const out = await deleteUserViaAnonymisation('u-1');
    expect(out).toEqual({ ok: false, blockedBy: 'pending_payouts' });
    expect(state.txnRan).toBe(false);
    expect(state.revokedForUserId).toBeNull();
  });

  it('refuses with blockedBy=in_flight_orders when an order is mid-fulfilment', async () => {
    state.orderBlockingRows = [{ id: 'o-1' }];
    const out = await deleteUserViaAnonymisation('u-1');
    expect(out).toEqual({ ok: false, blockedBy: 'in_flight_orders' });
    expect(state.txnRan).toBe(false);
    expect(state.revokedForUserId).toBeNull();
  });

  it('on success, anonymises the row and revokes all refresh tokens', async () => {
    const out = await deleteUserViaAnonymisation('u-1');
    expect(out).toEqual({ ok: true });
    expect(state.txnRan).toBe(true);
    expect(state.deletedFromIdentitiesUserId).toBe('u-1');
    expect(state.updatedUserSet).toMatchObject({
      email: 'deleted-u-1@deleted.loopfinance.io',
      ctxUserId: null,
      stellarAddress: null,
    });
    expect(state.updatedUserWhereId).toBe('u-1');
    expect(state.revokedForUserId).toBe('u-1');
  });

  it('blocks-first wins: a pending payout AND a mid-fulfilment order both present → reports payouts', async () => {
    state.payoutBlockingRows = [{ id: 'p-1' }];
    state.orderBlockingRows = [{ id: 'o-1' }];
    const out = await deleteUserViaAnonymisation('u-1');
    expect(out.blockedBy).toBe('pending_payouts');
  });

  it('deletedEmailFor produces a unique synthetic email per userId', () => {
    expect(deletedEmailFor('u-1')).toBe('deleted-u-1@deleted.loopfinance.io');
    expect(deletedEmailFor('u-1')).not.toEqual(deletedEmailFor('u-2'));
    // Synthetic email is well-formed for the email regex used in OTP request.
    expect(deletedEmailFor('u-1')).toMatch(/^[\w.+-]+@[\w.-]+\.\w+$/);
  });
});
