import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Mirrors the refunds.test.ts pattern. db.transaction(cb) calls cb
 * with a chainable mock; each call records the writes so assertions
 * can read them back. ADR 036: the emission writer queues ONLY a
 * pending_payouts row — the assertions here pin that no
 * credit_transactions row is written and the user_credits balance is
 * never touched (no UPDATE set, no defensive INSERT).
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    forUpdateRows: unknown[];
    selectRows: unknown[];
    /** ADM-01: the bare-awaited daily-cap-sum query (`.where(...)` with no
     * further chain call) — distinct from `forUpdateRows` (`.for('update')`)
     * and `selectRows` (`.limit(1)`, the prior-payout lookup). */
    dayCapRows: unknown[];
    insertCreditCalls: unknown[];
    insertUserCreditsCalls: unknown[];
    insertPayoutCalls: unknown[];
    updateSets: unknown[];
    returnedCreditRow: unknown;
    returnedPayoutRow: unknown;
    creditInsertError: Error | null;
    payoutInsertError: Error | null;
  }
  const s: State = {
    forUpdateRows: [],
    selectRows: [],
    dayCapRows: [{ usedMinor: '0' }],
    insertCreditCalls: [],
    insertUserCreditsCalls: [],
    insertPayoutCalls: [],
    updateSets: [],
    returnedCreditRow: null,
    returnedPayoutRow: null,
    creditInsertError: null,
    payoutInsertError: null,
  };

  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  chain['execute'] = vi.fn(async () => []);
  // ADM-01: three distinct queries all land through `.where(...)`. The
  // daily-cap-sum query terminates with the bare awaited `.where(...)`
  // result; the balance-lock query chains `.for('update')` after
  // `.where`; the prior-active-withdrawal lookup chains `.limit(1)`.
  // Return a thenable that's ALSO chainable to `.for`/`.limit` so all
  // three call shapes resolve to their own independent fixture.
  chain['where'] = vi.fn(() => ({
    then: (resolve: (v: unknown) => unknown) => resolve(s.dayCapRows),
    for: vi.fn(async () => s.forUpdateRows),
    limit: vi.fn(async () => s.selectRows),
  }));
  chain['insert'] = vi.fn((table: unknown) => {
    const name = (table as Record<string, unknown>)['__name'];
    (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'] =
      typeof name === 'string' ? name : undefined;
    return chain;
  });
  chain['values'] = vi.fn((v: unknown) => {
    const last = (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'];
    if (last === 'creditTransactions') s.insertCreditCalls.push(v);
    else if (last === 'userCredits') s.insertUserCreditsCalls.push(v);
    else if (last === 'pendingPayouts') s.insertPayoutCalls.push(v);
    return chain;
  });
  chain['returning'] = vi.fn(async () => {
    const last = (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'];
    if (last === 'creditTransactions') {
      if (s.creditInsertError !== null) throw s.creditInsertError;
      return [s.returnedCreditRow];
    }
    if (last === 'pendingPayouts') {
      if (s.payoutInsertError !== null) throw s.payoutInsertError;
      return [s.returnedPayoutRow];
    }
    return [s.returnedCreditRow];
  });
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: unknown) => {
    s.updateSets.push(v);
    return chain;
  });
  chain['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));

  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  creditTransactions: { __name: 'creditTransactions' },
  userCredits: {
    userId: 'user_id',
    currency: 'currency',
    __name: 'userCredits',
  },
  pendingPayouts: {
    __name: 'pendingPayouts',
    id: 'id',
    userId: 'user_id',
    orderId: 'order_id',
    kind: 'kind',
    assetCode: 'asset_code',
    assetIssuer: 'asset_issuer',
    toAddress: 'to_address',
    amountStroops: 'amount_stroops',
    state: 'state',
    compensatedAt: 'compensated_at',
  },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  applyAdminEmission,
  EmissionAlreadyIssuedError,
  emittedNetMinorFor,
} from '../emissions.js';
import { InsufficientBalanceError } from '../adjustments.js';

// MNY-11-EMISSION-HARDENING: `amountStroops` MUST be the whole-minor
// stroops equivalent of the `amountMinor` these tests pass (500n) —
// 500 minor × 100_000 stroops/minor = 50_000_000 stroops. The
// consistency guard at the top of `applyAdminEmission` now rejects a
// mismatch at entry (a small `amountMinor` with a large `amountStroops`
// would otherwise satisfy the minor-denominated balance/conservation
// fences while minting the large stroops). Prior to that guard this
// fixture was accidentally 10× inconsistent (5_000_000 stroops = 50
// minor) — harmless only because the mock DB never derived stroops
// from minor.
const intent = {
  assetCode: 'USDLOOP',
  assetIssuer: 'GISSUER',
  toAddress: 'GUSER',
  amountStroops: 50_000_000n,
  memoText: 'EMIT1',
};

beforeEach(() => {
  state.forUpdateRows = [];
  state.selectRows = [];
  state.dayCapRows = [{ usedMinor: '0' }];
  state.insertCreditCalls = [];
  state.insertUserCreditsCalls = [];
  state.insertPayoutCalls = [];
  state.updateSets = [];
  state.returnedCreditRow = null;
  state.returnedPayoutRow = null;
  state.creditInsertError = null;
  state.payoutInsertError = null;
});

describe('applyAdminEmission (A2-901 / ADR-024 re-scoped by ADR 036)', () => {
  it('happy path: queues payout with kind=emission and no orderId', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.selectRows = [];
    state.returnedPayoutRow = { id: 'p-1', createdAt: new Date('2026-06-11') };
    const result = await applyAdminEmission({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      intent,
    });
    expect(result).toMatchObject({
      payoutId: 'p-1',
      amountMinor: 500n,
      balanceMinor: 2000n,
    });
    expect(state.insertPayoutCalls[0]).toMatchObject({
      userId: 'u-1',
      kind: 'emission',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUER',
      toAddress: 'GUSER',
      amountStroops: 50_000_000n,
      memoText: 'EMIT1',
    });
    expect(state.insertPayoutCalls[0]).not.toHaveProperty('orderId');
  });

  it('ADR 036: never writes a ledger row and never touches the mirror balance', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.selectRows = [];
    state.returnedPayoutRow = { id: 'p-1', createdAt: new Date('2026-06-11') };
    const result = await applyAdminEmission({
      userId: 'u-1',
      currency: 'USD',
      amountMinor: 500n,
      intent,
    });
    // No credit_transactions write, no user_credits UPDATE, no
    // defensive user_credits INSERT — the mirror is read-only here.
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
    expect(state.insertUserCreditsCalls).toHaveLength(0);
    // Reported balance is the untouched pre-emission balance.
    expect(result.balanceMinor).toBe(2000n);
  });

  it('rejects when mirror balance < amount with InsufficientBalanceError (unbacked-emission guard)', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 100n }];
    state.selectRows = [];
    state.returnedPayoutRow = { id: 'p-x', createdAt: new Date() };
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    // Guard fails before any insert runs.
    expect(state.insertPayoutCalls).toHaveLength(0);
    expect(state.insertCreditCalls).toHaveLength(0);
  });

  it('rejects when no balance row exists at all (treated as 0 balance)', async () => {
    state.forUpdateRows = [];
    state.selectRows = [];
    await expect(
      applyAdminEmission({
        userId: 'u-new',
        currency: 'USD',
        amountMinor: 500n,
        intent,
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('rejects zero / negative amount before touching the DB', async () => {
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 0n,
        intent,
      }),
    ).rejects.toThrow(/Emission amount must be positive/);
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: -100n,
        intent,
      }),
    ).rejects.toThrow(/Emission amount must be positive/);
  });

  // MNY-11-EMISSION-HARDENING: the caller supplies `amountMinor` and
  // `intent.amountStroops` independently. The minor drives the balance
  // + conservation fences; the stroops drive the actual mint + daily
  // cap. A mismatch must be rejected AT ENTRY, before any fence or DB
  // work, so a small minor can't wave through a large stroops mint.
  it('rejects an intent whose amountStroops does not match amountMinor, before any DB work', async () => {
    // Balance is huge and a payout row is primed: WITHOUT the guard the
    // small `amountMinor` (1) would clear the balance/conservation
    // fences and the large `amountStroops` (500 minor) would be minted.
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 100_000_000n }];
    state.selectRows = [];
    state.returnedPayoutRow = { id: 'p-should-not-exist', createdAt: new Date() };
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 1n, // clears the minor-denominated fences
        intent, // 50_000_000 stroops = 500 minor — 500× the checked minor
      }),
    ).rejects.toThrow(/inconsistent caller amounts/);
    // Rejected before the mint: no payout row queued.
    expect(state.insertPayoutCalls).toHaveLength(0);
    expect(state.insertCreditCalls).toHaveLength(0);
  });

  it('rejects a sub-minor (non-integral) stroops amount even when it floors to amountMinor', async () => {
    // 150_000 stroops = 1.5 minor; floor(150_000 / 100_000) = 1, so the
    // bare equality check would pass — the whole-minor modulo guard is
    // what catches the half-minor remainder that would otherwise mint.
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 100_000_000n }];
    state.selectRows = [];
    state.returnedPayoutRow = { id: 'p-should-not-exist', createdAt: new Date() };
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 1n,
        intent: { ...intent, amountStroops: 150_000n },
      }),
    ).rejects.toThrow(/whole-minor/);
    expect(state.insertPayoutCalls).toHaveLength(0);
  });

  it('maps a unique-violation on the active-emission fence to EmissionAlreadyIssuedError', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.selectRows = [];
    state.payoutInsertError = Object.assign(new Error('duplicate key'), {
      code: '23505',
      constraint_name: 'pending_payouts_active_emission_unique',
    });
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
      }),
    ).rejects.toBeInstanceOf(EmissionAlreadyIssuedError);
  });

  it('resolves the existing payout id via the post-hoc lookup on a fence violation', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    // First in-txn pre-check select returns nothing (race), the
    // post-catch lookup finds the winner.
    state.selectRows = [];
    state.payoutInsertError = Object.assign(new Error('duplicate'), {
      code: '23505',
      constraint_name: 'pending_payouts_active_emission_unique',
    });
    try {
      await applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
      });
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(EmissionAlreadyIssuedError);
      // Lookup found nothing → sentinel id.
      expect((err as EmissionAlreadyIssuedError).payoutId).toBe('<unknown>');
    }
  });

  it('rethrows unrelated pg errors as-is', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.selectRows = [];
    state.payoutInsertError = Object.assign(new Error('fk violation'), {
      code: '23503',
      constraint_name: 'pending_payouts_user_id_users_id_fk',
    });
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
      }),
    ).rejects.not.toBeInstanceOf(EmissionAlreadyIssuedError);
  });

  it('rejects a matching active emission before inserting a fresh payout row', async () => {
    state.forUpdateRows = [{ userId: 'u-1', currency: 'USD', balanceMinor: 2000n }];
    state.selectRows = [{ id: 'p-existing' }];
    await expect(
      applyAdminEmission({
        userId: 'u-1',
        currency: 'USD',
        amountMinor: 500n,
        intent,
      }),
    ).rejects.toMatchObject({ payoutId: 'p-existing' });
    expect(state.insertPayoutCalls).toHaveLength(0);
    expect(state.insertCreditCalls).toHaveLength(0);
  });
});

/**
 * CONV-MNY-01: the conservation pre-check's "already emitted" SUM must
 * scope by MIRROR CURRENCY, exactly as the DB trigger
 * `assert_emission_conservation` does after migration 0061
 * (`loop_asset_mirror_currency(pp.asset_code) = mirror_currency`), NOT
 * by the bare `asset_code`. USDLOOP + LOOPUSD share a single USD
 * mirror headroom; a bare-asset_code pre-check undercounts and passes
 * a shared-mirror emission the trigger then rejects, turning the
 * intended 409 EMISSION_EXCEEDS_UNEMITTED_BALANCE into an opaque 500.
 *
 * This exercises the real query the code builds (compiled via the
 * drizzle Pg dialect, no DB) — it fails against the pre-fix
 * `AND asset_code = $n` scope and passes against the corrected
 * mirror-currency scope.
 */
describe('emittedNetMinorFor — conservation SUM scope (CONV-MNY-01)', () => {
  it('scopes the aggregation by mirror currency, matching the 0061 trigger', async () => {
    let captured: SQL | undefined;
    const tx = {
      execute: async (query: SQL) => {
        captured = query;
        return [] as unknown as never;
      },
    } as unknown as Parameters<typeof emittedNetMinorFor>[0];

    await emittedNetMinorFor(tx, { userId: 'u-1', assetCode: 'USDLOOP' });

    expect(captured).toBeDefined();
    const compiled = new PgDialect().sqlToQuery(captured as SQL);
    const flat = compiled.sql.replace(/\s+/g, ' ');

    // Corrected scope present: both sides routed through the same
    // mirror-currency mapping the trigger uses.
    expect(flat).toContain('loop_asset_mirror_currency(asset_code) = loop_asset_mirror_currency(');
    // Pre-fix bare-asset_code scope must be gone — this is the exact
    // predicate that diverged from the trigger.
    expect(flat).not.toMatch(/\band asset_code =\s*\$/i);
    // The assetCode arg is bound as a parameter (not string-interpolated).
    expect(compiled.params).toContain('USDLOOP');
    expect(compiled.params).toContain('u-1');
  });
});
