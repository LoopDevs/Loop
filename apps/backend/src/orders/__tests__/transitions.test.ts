import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Transitions exercise `UPDATE ... WHERE state = <expected> RETURNING`
 * + an optional txn (markOrderFulfilled). We mock the db as a
 * chainable thing that:
 *   - records the last set + where payloads
 *   - returns a stashed row from `.returning()`
 *   - forwards `db.transaction(cb)` → `cb(txMock)` so the fulfilled
 *     path's multi-step write can be observed.
 */
const { dbMock, state } = vi.hoisted(() => {
  interface State {
    returningRows: unknown[];
    updateSet: unknown;
    updateWhereCount: number;
    insertCreditCalls: unknown[];
    upsertUserCreditsCalls: unknown[];
    insertPendingPayoutCalls: unknown[];
    upsertSet: unknown;
    // User-row lookup inside the fulfilled txn (ADR 015).
    userLookupRows: unknown[];
    // user_credits FOR UPDATE lookup inside markOrderPaid's
    // loop_asset branch (A4-110 + ADR 036).
    creditRowLookup: unknown[];
  }
  const s: State = {
    returningRows: [],
    updateSet: undefined,
    updateWhereCount: 0,
    insertCreditCalls: [],
    upsertUserCreditsCalls: [],
    insertPendingPayoutCalls: [],
    upsertSet: undefined,
    userLookupRows: [],
    creditRowLookup: [],
  };

  // Outer db chain — shared between the non-txn path and the tx
  // callback. The chain methods all return `chain` so Drizzle's
  // fluent syntax works.
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain['update'] = vi.fn(() => chain);
  chain['set'] = vi.fn((v: unknown) => {
    s.updateSet = v;
    return chain;
  });
  chain['where'] = vi.fn(() => {
    s.updateWhereCount++;
    return chain;
  });
  chain['returning'] = vi.fn(async (_projection?: unknown) => s.returningRows);
  chain['insert'] = vi.fn((table: unknown) => {
    const name = (table as Record<string, unknown>)['__name'];
    // Tag the current insert so .values can route to the right bucket.
    (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'] =
      typeof name === 'string' ? name : undefined;
    return chain;
  });
  chain['values'] = vi.fn((v: unknown) => {
    const last = (chain as unknown as { _lastInsert: string | undefined })['_lastInsert'];
    if (last === 'creditTransactions') s.insertCreditCalls.push(v);
    else if (last === 'userCredits') s.upsertUserCreditsCalls.push(v);
    else if (last === 'pendingPayouts') s.insertPendingPayoutCalls.push(v);
    return chain;
  });
  chain['onConflictDoUpdate'] = vi.fn((arg: { set: unknown }) => {
    s.upsertSet = arg.set;
    return chain;
  });
  // The pending_payouts insert calls onConflictDoNothing — a no-op on
  // the mock chain; the insert gets captured upstream.
  chain['onConflictDoNothing'] = vi.fn(() => chain);

  // `select({ ... }).from(users).where(...)` path used by the
  // fulfillment txn to look up the user's stellar_address +
  // home_currency. Resolves to `state.userLookupRows` so tests
  // control what the user row looks like (or is missing).
  chain['select'] = vi.fn(() => chain);
  chain['from'] = vi.fn(() => chain);
  // .where is shared with the update path above; overwrite behaviour
  // to still track updates AND resolve select(...).from(...).where(...)
  // as a thenable returning the user rows.
  const selectAwarePromise = {
    then: (resolve: (rows: unknown[]) => unknown): unknown => resolve(s.userLookupRows),
  };
  (chain as unknown as { where: unknown })['where'] = vi.fn(() => {
    s.updateWhereCount++;
    // The caller either `.returning()`s (update path) or `await`s
    // directly (select path). Returning a value that supports both
    // keeps the chain happy for both callers.
    return Object.assign(chain, selectAwarePromise);
  });

  // markOrderPaid's loop_asset branch ends its balance read with
  // `.for('update')` — resolve it from creditRowLookup.
  chain['for'] = vi.fn(async () => s.creditRowLookup);

  // db.transaction(cb) just calls cb with the same chain — we want
  // to observe writes against the mock, not fight with an isolated
  // transactional mock.
  chain['transaction'] = vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(chain));

  return { dbMock: chain, state: s };
});

vi.mock('../../db/client.js', () => ({ db: dbMock }));
vi.mock('../../db/schema.js', () => ({
  orders: {
    id: 'id',
    state: 'state',
    ctxOrderId: 'ctx_order_id',
    ctxOperatorId: 'ctx_operator_id',
    paidAt: 'paid_at',
    paymentReceivedAt: 'payment_received_at',
    procuredAt: 'procured_at',
    fulfilledAt: 'fulfilled_at',
    failedAt: 'failed_at',
    failureReason: 'failure_reason',
    createdAt: 'created_at',
    __name: 'orders',
  },
  creditTransactions: {
    userId: 'user_id',
    type: 'type',
    amountMinor: 'amount_minor',
    currency: 'currency',
    referenceType: 'reference_type',
    referenceId: 'reference_id',
    __name: 'creditTransactions',
  },
  userCredits: {
    userId: 'user_id',
    currency: 'currency',
    balanceMinor: 'balance_minor',
    updatedAt: 'updated_at',
    __name: 'userCredits',
  },
  users: {
    id: 'id',
    stellarAddress: 'stellar_address',
    homeCurrency: 'home_currency',
    __name: 'users',
  },
  pendingPayouts: {
    orderId: 'order_id',
    __name: 'pendingPayouts',
  },
  HOME_CURRENCIES: ['USD', 'GBP', 'EUR'] as const,
}));
vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));
const {
  notifyStuckProcurementSweptMock,
  notifyOrderFailedAfterCtxPaidMock,
  notifyPegBreakMock,
  getCtxSettlementMock,
  markCtxSettlementConfirmedMock,
  hashLookupMock,
  autoRefundMock,
} = vi.hoisted(() => ({
  notifyStuckProcurementSweptMock: vi.fn(),
  notifyOrderFailedAfterCtxPaidMock: vi.fn(),
  notifyPegBreakMock: vi.fn(),
  // Hardening A5: the stuck-procurement sweep reads the durable
  // CTX-settlement record + the authoritative Horizon hash lookup and
  // auto-refunds the CTX-unpaid rows.
  getCtxSettlementMock: vi.fn(),
  markCtxSettlementConfirmedMock: vi.fn(),
  hashLookupMock: vi.fn(),
  autoRefundMock: vi.fn(),
}));
vi.mock('../ctx-settlements.js', () => ({
  getCtxSettlementByOrderId: (orderId: string) => getCtxSettlementMock(orderId),
  markCtxSettlementConfirmed: (id: string) => markCtxSettlementConfirmedMock(id),
}));
vi.mock('../../payments/horizon.js', () => ({
  getOutboundPaymentByTxHash: (h: string) => hashLookupMock(h),
}));
vi.mock('../../credits/refunds.js', () => ({
  applyOrderAutoRefund: (args: unknown) => autoRefundMock(args),
  RefundAlreadyIssuedError: class RefundAlreadyIssuedError extends Error {},
  RefundOrderInvalidError: class RefundOrderInvalidError extends Error {
    constructor(public readonly reason: string) {
      super(reason);
    }
  },
}));
vi.mock('../../discord.js', () => ({
  notifyStuckProcurementSwept: (args: unknown) => notifyStuckProcurementSweptMock(args),
  notifyOrderFailedAfterCtxPaid: (args: unknown) => notifyOrderFailedAfterCtxPaidMock(args),
  // other notify* functions are not called from transitions.ts —
  // stub to no-op so the module's import surface stays satisfied.
  notifyCashbackCredited: vi.fn(),
  notifyOrderFulfilled: vi.fn(),
  notifyCashbackRecycled: vi.fn(),
  notifyFirstCashbackRecycled: vi.fn(),
  notifyOrderCreated: vi.fn(),
  // A4-023: peg-break notifier called from fulfillment.ts when
  // chargeCurrency diverges from user.home_currency. Hoisted so the
  // notify-after-commit tests below can assert call ordering.
  notifyPegBreakOnFulfillment: (args: unknown) => notifyPegBreakMock(args),
}));
// Payout-intent builder — default: "pay" when userCashbackMinor > 0,
// with a fixed issuer/asset/address. Tests that need skip paths can
// override via `payoutBuilderMock.decision = { kind: 'skip', reason: 'no_address' }`.
const { payoutBuilderMock } = vi.hoisted(() => ({
  payoutBuilderMock: {
    decision: null as unknown,
  },
}));
vi.mock('../../credits/payout-builder.js', () => ({
  generatePayoutMemo: () => 'mock-burn-memo-20char',
  buildPayoutIntent: (args: {
    userCashbackMinor: bigint;
    embeddedWalletAddress?: string | null;
    stellarAddress: string | null;
    homeCurrency: string;
    memoText?: string;
  }) => {
    if (payoutBuilderMock.decision !== null) return payoutBuilderMock.decision;
    if (args.userCashbackMinor <= 0n) return { kind: 'skip', reason: 'no_cashback' };
    // ADR 030 Phase C2 — same precedence as the real builder: an
    // activated embedded wallet wins over the legacy linked address.
    const destination = args.embeddedWalletAddress ?? args.stellarAddress;
    if (destination === null || destination === undefined) {
      return { kind: 'skip', reason: 'no_address' };
    }
    return {
      kind: 'pay',
      intent: {
        to: destination,
        assetCode: `${args.homeCurrency}LOOP`,
        assetIssuer: 'GISSUER',
        amountStroops: args.userCashbackMinor * 100_000n,
        memoText: args.memoText ?? 'mock-memo-20chars000',
      },
    };
  },
}));

const { payoutAssetMock } = vi.hoisted(() => ({
  payoutAssetMock: {
    issuer: 'GBURNISSUER' as string | null,
  },
}));
vi.mock('../../credits/payout-asset.js', () => ({
  payoutAssetFor: (homeCurrency: string) => ({
    code: `${homeCurrency}LOOP`,
    issuer: payoutAssetMock.issuer,
  }),
}));

import {
  markOrderPaid,
  markOrderProcuring,
  markOrderFulfilled,
  markOrderFailed,
  LoopAssetMissingCreditRowError,
  LoopAssetBurnUnavailableError,
  sweepExpiredOrders,
} from '../transitions.js';

beforeEach(() => {
  state.returningRows = [];
  state.updateSet = undefined;
  state.updateWhereCount = 0;
  state.insertCreditCalls = [];
  state.upsertUserCreditsCalls = [];
  state.insertPendingPayoutCalls = [];
  state.upsertSet = undefined;
  state.userLookupRows = [];
  state.creditRowLookup = [];
  payoutAssetMock.issuer = 'GBURNISSUER';
  payoutBuilderMock.decision = null;
  notifyPegBreakMock.mockClear();
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('markOrderPaid', () => {
  it('returns the updated row on a valid pending_payment → paid transition', async () => {
    const row = { id: 'o-1', state: 'paid' };
    state.returningRows = [row];
    const result = await markOrderPaid('o-1');
    expect(result).toEqual(row);
    expect(state.updateSet).toMatchObject({ state: 'paid' });
  });

  it('returns null when no row matches the expected state', async () => {
    state.returningRows = [];
    const result = await markOrderPaid('missing');
    expect(result).toBeNull();
  });

  it('honours a supplied payment_received_at', async () => {
    state.returningRows = [{ id: 'o-1' }];
    const at = new Date('2026-04-21T12:00:00Z');
    await markOrderPaid('o-1', { paymentReceivedAt: at });
    expect(state.updateSet).toMatchObject({ paymentReceivedAt: at });
  });

  it('persists the Horizon payment identity that funded the order', async () => {
    state.returningRows = [{ id: 'o-1' }];
    const payment = { id: 'horizon-op-1', amount: '10.0000000' };
    await markOrderPaid('o-1', {
      paymentReceivedHorizonId: 'horizon-op-1',
      paymentReceivedTxHash: 'tx-1',
      paymentReceivedPayment: payment,
    });
    expect(state.updateSet).toMatchObject({
      paymentReceivedHorizonId: 'horizon-op-1',
      paymentReceivedTxHash: 'tx-1',
      paymentReceivedPayment: payment,
    });
  });
});

describe('markOrderPaid — loop_asset redemption (A4-110 + ADR 036)', () => {
  const PAID_ROW = {
    id: 'o-loop',
    state: 'paid',
    paymentMethod: 'loop_asset',
    userId: 'u-1',
    chargeMinor: 500n,
    chargeCurrency: 'GBP',
  };

  it('debits the mirror, writes a spend ledger row, and enqueues the issuer-return burn in one txn', async () => {
    state.returningRows = [PAID_ROW];
    state.creditRowLookup = [{ balanceMinor: 1000n }];

    const result = await markOrderPaid('o-loop');
    expect(result).toEqual(PAID_ROW);

    // The whole thing ran inside db.transaction.
    expect(dbMock['transaction']).toHaveBeenCalledOnce();

    // Spend ledger row: negative chargeMinor, referencing the order.
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'spend',
      amountMinor: -500n,
      currency: 'GBP',
      referenceType: 'order',
      referenceId: 'o-loop',
    });

    // ADR 036: burn row enqueued in the SAME txn — kind='burn',
    // destination = the asset's issuer, amount = the charge at the
    // 1:1 peg (100_000 stroops / minor).
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({
      userId: 'u-1',
      orderId: 'o-loop',
      kind: 'burn',
      assetCode: 'GBPLOOP',
      assetIssuer: 'GBURNISSUER',
      toAddress: 'GBURNISSUER',
      amountStroops: 500n * 100_000n,
      memoText: 'mock-burn-memo-20char',
    });
  });

  it('throws LoopAssetMissingCreditRowError when no user_credits row exists (state corruption)', async () => {
    state.returningRows = [PAID_ROW];
    state.creditRowLookup = [];
    await expect(markOrderPaid('o-loop')).rejects.toBeInstanceOf(LoopAssetMissingCreditRowError);
    // Neither the debit nor the burn landed.
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  it('throws LoopAssetBurnUnavailableError (rolling back the txn) when the issuer is unset', async () => {
    state.returningRows = [PAID_ROW];
    state.creditRowLookup = [{ balanceMinor: 1000n }];
    payoutAssetMock.issuer = null;
    await expect(markOrderPaid('o-loop')).rejects.toMatchObject({
      name: 'LoopAssetBurnUnavailableError',
      reason: 'issuer_unset',
      orderId: 'o-loop',
    });
    expect(markOrderPaid).toBeDefined(); // type anchor
    // The real txn rolls everything back; the mock just shows the
    // burn insert never happened.
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  it('throws LoopAssetBurnUnavailableError for a non-home-currency charge', async () => {
    state.returningRows = [{ ...PAID_ROW, chargeCurrency: 'JPY' }];
    state.creditRowLookup = [{ balanceMinor: 1000n }];
    await expect(markOrderPaid('o-loop')).rejects.toBeInstanceOf(LoopAssetBurnUnavailableError);
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  it('xlm / usdc orders flip state only — no debit, no burn', async () => {
    state.returningRows = [{ id: 'o-x', state: 'paid', paymentMethod: 'xlm', chargeMinor: 500n }];
    const result = await markOrderPaid('o-x');
    expect(result).toMatchObject({ id: 'o-x' });
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });
});

describe('markOrderProcuring', () => {
  it('sets state=procuring and captures the operator id', async () => {
    state.returningRows = [{ id: 'o-1', state: 'procuring' }];
    const result = await markOrderProcuring('o-1', { ctxOperatorId: 'primary' });
    expect(result?.state).toBe('procuring');
    expect(state.updateSet).toMatchObject({
      state: 'procuring',
      ctxOperatorId: 'primary',
    });
  });

  it('returns null when the order is not in paid state', async () => {
    state.returningRows = [];
    const result = await markOrderProcuring('o-1', { ctxOperatorId: 'primary' });
    expect(result).toBeNull();
  });
});

describe('markOrderFulfilled', () => {
  const baseOrder = {
    id: 'o-1',
    userId: 'u-1',
    merchantId: 'm-1',
    currency: 'GBP',
    chargeCurrency: 'GBP',
    userCashbackMinor: 500n,
    faceValueMinor: 10_000n,
    chargeMinor: 10_000n,
    state: 'fulfilled' as const,
  };

  it('writes the order update, a cashback credit_transactions row, and an upsert for user_credits', async () => {
    state.returningRows = [baseOrder];
    const result = await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(result?.id).toBe('o-1');
    // Order update called.
    expect(state.updateSet).toMatchObject({
      state: 'fulfilled',
      ctxOrderId: 'ctx-abc',
    });
    // Cashback transaction written.
    expect(state.insertCreditCalls).toHaveLength(1);
    expect(state.insertCreditCalls[0]).toMatchObject({
      userId: 'u-1',
      type: 'cashback',
      amountMinor: 500n,
      currency: 'GBP',
      referenceType: 'order',
      referenceId: 'o-1',
    });
    // user_credits upserted at +500.
    expect(state.upsertUserCreditsCalls).toHaveLength(1);
    expect(state.upsertUserCreditsCalls[0]).toMatchObject({
      userId: 'u-1',
      currency: 'GBP',
      balanceMinor: 500n,
    });
    expect(state.upsertSet).toBeDefined();
  });

  it('skips ledger writes when userCashbackMinor is 0', async () => {
    state.returningRows = [{ ...baseOrder, userCashbackMinor: 0n }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.upsertUserCreditsCalls).toHaveLength(0);
  });

  it('returns null and performs no ledger writes when the order is not procuring', async () => {
    state.returningRows = [];
    const result = await markOrderFulfilled('missing', { ctxOrderId: 'x' });
    expect(result).toBeNull();
    expect(state.insertCreditCalls).toHaveLength(0);
    expect(state.upsertUserCreditsCalls).toHaveLength(0);
  });

  it('runs inside a db.transaction so a partial failure rolls back', async () => {
    state.returningRows = [baseOrder];
    await markOrderFulfilled('o-1', { ctxOrderId: 'x' });
    expect(dbMock['transaction']!).toHaveBeenCalled();
  });

  // ─── ADR 015 — pending payout insert inside the fulfillment txn ───────────
  it('inserts a pending_payouts row when the user qualifies (address + home-currency match)', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({
      userId: 'u-1',
      orderId: 'o-1',
      toAddress: 'GDESTINATION',
      assetCode: 'GBPLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: 50_000_000n, // 500 × 100_000
    });
  });

  it('skips the payout when the user has no linked stellar address', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [{ stellarAddress: null, homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  // ADR 030 Phase C2 — activated embedded wallet wins over the legacy
  // linked address on the happy path.
  it('prefers the activated embedded wallet over the legacy linked address', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [
      {
        stellarAddress: 'GLEGACY',
        homeCurrency: 'GBP',
        walletAddress: 'GEMBEDDED',
        walletProvisioning: 'activated',
      },
    ];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({ toAddress: 'GEMBEDDED' });
  });

  it('falls back to the legacy address when the embedded wallet exists but is not yet activated', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [
      {
        stellarAddress: 'GLEGACY',
        homeCurrency: 'GBP',
        walletAddress: 'GEMBEDDED',
        walletProvisioning: 'wallet_created',
      },
    ];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({ toAddress: 'GLEGACY' });
  });

  it('skips the payout when no user row is found', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  it('CF-16: peg break writes a DURABLE payout row in the order chargeCurrency (was alert-only)', async () => {
    // Happens only if the user's home currency was changed post-order
    // by support. The ledger wrote in charge_currency; CF-16 (x-flows
    // F2-1) now also writes a durable pending_payouts row in the
    // order's chargeCurrency asset (USDLOOP here) so the on-chain
    // emission is actually reconciled — previously only a Discord warn
    // fired, leaving a permanent off-chain/on-chain divergence.
    state.returningRows = [{ ...baseOrder, chargeCurrency: 'USD' }];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    // Asset is pinned to the order's chargeCurrency, NOT the user's new
    // home currency — matches the peg-break runbook.
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({
      orderId: 'o-1',
      assetCode: 'USDLOOP',
    });
    // The Discord alert still fires (runbook reference).
    expect(notifyPegBreakMock).toHaveBeenCalledTimes(1);
  });

  it('CF-16: peg break with no linked wallet → no durable row, still alerts', async () => {
    state.returningRows = [{ ...baseOrder, chargeCurrency: 'USD' }];
    state.userLookupRows = [{ stellarAddress: null, homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    // builder skip (no_address) → no durable row, but ops still paged
    // so they can drive the on-chain side once the user links a wallet.
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
    expect(notifyPegBreakMock).toHaveBeenCalledTimes(1);
  });

  // Regression: the peg-break branch originally called buildPayoutIntent
  // without embeddedWalletAddress, silently falling back to the legacy
  // linked address (or no_address for embedded-wallet-only users) and
  // reopening the exact off-chain/on-chain divergence gap CF-16 closed,
  // scoped to users who never linked a legacy address.
  it('CF-16 / ADR 030 Phase C2: peg break routes the durable row to the activated embedded wallet', async () => {
    state.returningRows = [{ ...baseOrder, chargeCurrency: 'USD' }];
    state.userLookupRows = [
      {
        stellarAddress: null,
        homeCurrency: 'GBP',
        walletAddress: 'GEMBEDDED',
        walletProvisioning: 'activated',
      },
    ];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({
      toAddress: 'GEMBEDDED',
      assetCode: 'USDLOOP',
    });
    expect(notifyPegBreakMock).toHaveBeenCalledTimes(1);
  });

  it('pays out a cross-FX order where catalog currency differs from home (ledger is home-denominated)', async () => {
    // USD catalog gift card, GBP user. order.currency='USD' but
    // chargeCurrency='GBP' + userCashbackMinor is in GBP pence. The
    // payout MUST fire in GBPLOOP — previously blocked by the
    // `order.currency !== home` guard, now permitted because the
    // ledger-in-home-currency refactor made it safe.
    state.returningRows = [{ ...baseOrder, currency: 'USD', chargeCurrency: 'GBP' }];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(1);
    expect(state.insertPendingPayoutCalls[0]).toMatchObject({
      assetCode: 'GBPLOOP',
    });
  });

  it('skips the payout when builder returns a skip decision (e.g. no_issuer)', async () => {
    state.returningRows = [baseOrder];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    payoutBuilderMock.decision = { kind: 'skip', reason: 'no_issuer' };
    await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(state.insertPendingPayoutCalls).toHaveLength(0);
  });

  // ─── A4-023 — peg-break notify must fire after the txn, not inside it ─────
  it('A4-023: emits the peg-break Discord notify only after the transaction resolves', async () => {
    state.returningRows = [{ ...baseOrder, chargeCurrency: 'USD' }];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    let notifyCallsWhenTxnResolved = -1;
    dbMock['transaction']!.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
      const result = await cb(dbMock);
      // Snapshot taken at the moment the txn callback finishes —
      // i.e. before the (real) COMMIT would land.
      notifyCallsWhenTxnResolved = notifyPegBreakMock.mock.calls.length;
      return result;
    });
    const result = await markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' });
    expect(result?.id).toBe('o-1');
    expect(notifyCallsWhenTxnResolved).toBe(0);
    expect(notifyPegBreakMock).toHaveBeenCalledTimes(1);
    expect(notifyPegBreakMock).toHaveBeenCalledWith({
      orderId: 'o-1',
      userId: 'u-1',
      chargeCurrency: 'USD',
      userHomeCurrency: 'GBP',
      cashbackMinor: '500',
    });
  });

  it('A4-023: a transaction rollback suppresses the peg-break notify', async () => {
    state.returningRows = [{ ...baseOrder, chargeCurrency: 'USD' }];
    state.userLookupRows = [{ stellarAddress: 'GDESTINATION', homeCurrency: 'GBP' }];
    dbMock['transaction']!.mockImplementationOnce(async (cb: (tx: unknown) => Promise<unknown>) => {
      await cb(dbMock);
      throw new Error('serialization failure — txn rolled back');
    });
    await expect(markOrderFulfilled('o-1', { ctxOrderId: 'ctx-abc' })).rejects.toThrow(
      'txn rolled back',
    );
    expect(notifyPegBreakMock).not.toHaveBeenCalled();
  });
});

describe('markOrderFailed', () => {
  it('sets state=failed + failure_reason', async () => {
    state.returningRows = [{ id: 'o-1', state: 'failed', failureReason: 'CTX rejected' }];
    const result = await markOrderFailed('o-1', 'CTX rejected');
    expect(result?.state).toBe('failed');
    expect(state.updateSet).toMatchObject({
      state: 'failed',
      failureReason: 'CTX rejected',
    });
  });

  it('returns null for already-terminal orders', async () => {
    state.returningRows = [];
    const result = await markOrderFailed('already-fulfilled', 'too late');
    expect(result).toBeNull();
  });
});

describe('markOrderProcuring — procured_at pin', () => {
  it('sets procured_at alongside state=procuring', async () => {
    state.returningRows = [{ id: 'o-1', state: 'procuring' }];
    const { markOrderProcuring } = await import('../transitions.js');
    await markOrderProcuring('o-1', { ctxOperatorId: 'pool' });
    expect(state.updateSet).toMatchObject({
      state: 'procuring',
      ctxOperatorId: 'pool',
      procuredAt: expect.any(Date),
    });
  });
});

describe('sweepStuckProcurement (hardening A5 — refund disambiguation)', () => {
  const rowA = {
    id: 'a',
    userId: 'u-a',
    merchantId: 'm-1',
    chargeMinor: 1000n,
    chargeCurrency: 'GBP',
    ctxOperatorId: 'pool',
    procuredAt: new Date(Date.now() - 20 * 60 * 1000),
  };
  const rowB = {
    id: 'b',
    userId: 'u-b',
    merchantId: 'm-2',
    chargeMinor: 2500n,
    chargeCurrency: 'USD',
    ctxOperatorId: null,
    procuredAt: new Date(Date.now() - 20 * 60 * 1000),
  };

  beforeEach(() => {
    notifyStuckProcurementSweptMock.mockClear();
    notifyOrderFailedAfterCtxPaidMock.mockClear();
    getCtxSettlementMock.mockReset();
    markCtxSettlementConfirmedMock.mockReset();
    hashLookupMock.mockReset();
    autoRefundMock.mockReset();
    autoRefundMock.mockResolvedValue({ id: 'refund-tx' });
  });

  it('auto-refunds a row with NO settlement (Loop never paid)', async () => {
    state.returningRows = [rowA];
    getCtxSettlementMock.mockResolvedValue(null);
    const { sweepStuckProcurement } = await import('../transitions.js');
    const n = await sweepStuckProcurement(new Date(Date.now() - 15 * 60 * 1000));
    expect(n).toBe(1);
    expect(state.updateSet).toMatchObject({
      state: 'failed',
      failureReason: 'procurement_timeout',
    });
    expect(hashLookupMock).not.toHaveBeenCalled();
    expect(autoRefundMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'a', userId: 'u-a', amountMinor: 1000n, currency: 'GBP' }),
    );
    // Every swept row pages; here refunded + not-ctx-paid.
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'a', ctxPaid: false, refunded: true }),
    );
  });

  it('auto-refunds a settlement row with NO tx_hash (nothing was ever dispatched)', async () => {
    state.returningRows = [rowA];
    getCtxSettlementMock.mockResolvedValue({ id: 's0', txHash: null, confirmedAt: null });
    const { sweepStuckProcurement } = await import('../transitions.js');
    await sweepStuckProcurement(new Date());
    expect(hashLookupMock).not.toHaveBeenCalled();
    expect(autoRefundMock).toHaveBeenCalledTimes(1);
  });

  it('P0 fix: a persisted tx_hash that LANDED is treated as PAID → HOLD, no refund', async () => {
    // The crashed-after-submit population: tx_hash set, confirmed_at
    // null, but the payment actually landed. Keying on confirmed_at
    // would have double-refunded this user.
    state.returningRows = [rowB];
    getCtxSettlementMock.mockResolvedValue({ id: 's2', txHash: 'landed-tx', confirmedAt: null });
    hashLookupMock.mockResolvedValue({ landed: true });
    const { sweepStuckProcurement } = await import('../transitions.js');
    await sweepStuckProcurement(new Date());
    expect(hashLookupMock).toHaveBeenCalledWith('landed-tx');
    expect(markCtxSettlementConfirmedMock).toHaveBeenCalledWith('s2'); // backfilled
    expect(autoRefundMock).not.toHaveBeenCalled();
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'b', ctxPaid: true, refunded: false }),
    );
  });

  it('auto-refunds a persisted tx_hash that NEVER landed (signed but did not settle)', async () => {
    state.returningRows = [rowA];
    getCtxSettlementMock.mockResolvedValue({ id: 's3', txHash: 'never-landed', confirmedAt: null });
    hashLookupMock.mockResolvedValue(null);
    const { sweepStuckProcurement } = await import('../transitions.js');
    await sweepStuckProcurement(new Date());
    expect(autoRefundMock).toHaveBeenCalledTimes(1);
    expect(markCtxSettlementConfirmedMock).not.toHaveBeenCalled();
  });

  it('confirmed_at already set → PAID fast path, no Horizon call, HOLD', async () => {
    state.returningRows = [rowB];
    getCtxSettlementMock.mockResolvedValue({ id: 's4', txHash: 't', confirmedAt: new Date() });
    const { sweepStuckProcurement } = await import('../transitions.js');
    await sweepStuckProcurement(new Date());
    expect(hashLookupMock).not.toHaveBeenCalled();
    expect(autoRefundMock).not.toHaveBeenCalled();
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'b', ctxPaid: true, refunded: false }),
    );
  });

  it('fails closed (hold, no refund) when the settlement lookup throws', async () => {
    state.returningRows = [rowA];
    getCtxSettlementMock.mockRejectedValue(new Error('db down'));
    const { sweepStuckProcurement } = await import('../transitions.js');
    await sweepStuckProcurement(new Date());
    expect(autoRefundMock).not.toHaveBeenCalled();
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: 'a', ctxPaid: true }),
    );
  });

  it('fails closed (hold, no refund) when the Horizon hash lookup throws', async () => {
    state.returningRows = [rowA];
    getCtxSettlementMock.mockResolvedValue({ id: 's5', txHash: 'x', confirmedAt: null });
    hashLookupMock.mockRejectedValue(new Error('horizon 503'));
    const { sweepStuckProcurement } = await import('../transitions.js');
    await sweepStuckProcurement(new Date());
    expect(autoRefundMock).not.toHaveBeenCalled();
  });

  it('mixed batch: refunds the unpaid, holds the landed-paid, both flipped to failed', async () => {
    state.returningRows = [rowA, rowB];
    getCtxSettlementMock.mockImplementation(async (orderId: string) =>
      orderId === 'b' ? { id: 's2', txHash: 'landed', confirmedAt: new Date() } : null,
    );
    const { sweepStuckProcurement } = await import('../transitions.js');
    const n = await sweepStuckProcurement(new Date());
    expect(n).toBe(2);
    expect(autoRefundMock).toHaveBeenCalledTimes(1);
    expect(autoRefundMock).toHaveBeenCalledWith(expect.objectContaining({ orderId: 'a' }));
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledTimes(2);
  });

  it('a refund blip does not abort the batch (next row still processed)', async () => {
    state.returningRows = [rowA, rowB];
    getCtxSettlementMock.mockResolvedValue(null);
    autoRefundMock.mockRejectedValueOnce(new Error('refund write failed'));
    autoRefundMock.mockResolvedValueOnce({ id: 'refund-tx' });
    const { sweepStuckProcurement } = await import('../transitions.js');
    const n = await sweepStuckProcurement(new Date());
    expect(n).toBe(2);
    expect(autoRefundMock).toHaveBeenCalledTimes(2);
    // The failed-refund row still pages with refunded:false.
    expect(notifyOrderFailedAfterCtxPaidMock).toHaveBeenCalledWith(
      expect.objectContaining({ refunded: false }),
    );
  });

  it('returns 0 when nothing is stuck', async () => {
    state.returningRows = [];
    const { sweepStuckProcurement } = await import('../transitions.js');
    const n = await sweepStuckProcurement(new Date());
    expect(n).toBe(0);
    expect(autoRefundMock).not.toHaveBeenCalled();
  });
});

describe('sweepExpiredOrders', () => {
  it('returns the count of rows transitioned', async () => {
    state.returningRows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const cutoff = new Date(Date.now() - 60 * 60 * 1000);
    const n = await sweepExpiredOrders(cutoff);
    expect(n).toBe(3);
    expect(state.updateSet).toMatchObject({ state: 'expired' });
  });

  it('returns 0 when nothing is due for expiry', async () => {
    state.returningRows = [];
    const n = await sweepExpiredOrders(new Date());
    expect(n).toBe(0);
  });
});
