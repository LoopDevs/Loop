import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HorizonPayment } from '../horizon.js';
import type * as HorizonModule from '../horizon.js';
import type * as SchemaModule from '../../db/schema.js';
import type * as TransitionsModule from '../../orders/transitions.js';
import type { RetryOutcome } from '../skipped-payments.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const listPaymentsMock = vi.fn();
const findOrderMock = vi.fn();
// T0-1: the `unmatched` arm consults findAnyOrderByMemo to decide whether
// to record an expired-order deposit. Default null → no record (preserves
// pre-T0-1 unmatched behaviour for the existing cases).
const findAnyOrderMock = vi.fn();
const markPaidMock = vi.fn();

const { notifyOverpaymentMock } = vi.hoisted(() => ({
  notifyOverpaymentMock: vi.fn(),
}));
vi.mock('../../discord.js', () => ({
  notifyLoopAssetOverpayment: (args: unknown) => notifyOverpaymentMock(args),
}));

// ADR 045 (B-3) duplicate-account detection — fully mocked here so
// this suite's existing db mock (shaped for the cursor read/write,
// not a generic `orders` select) isn't exercised by the real module.
// Its own bounded-query / fail-closed-vs-swallow behaviour is covered
// by fraud/__tests__/duplicate-account-signals.test.ts.
const { checkDuplicateFundingSourceMock } = vi.hoisted(() => ({
  checkDuplicateFundingSourceMock: vi.fn(async (_args: unknown) => undefined),
}));
vi.mock('../../fraud/duplicate-account-signals.js', () => ({
  checkDuplicateFundingSource: (args: unknown) => checkDuplicateFundingSourceMock(args),
}));

vi.mock('../horizon.js', async () => {
  const actual = await vi.importActual<typeof HorizonModule>('../horizon.js');
  return {
    ...actual,
    listAccountPayments: (args: unknown) => listPaymentsMock(args),
  };
});
vi.mock('../price-feed.js', () => ({
  // Fixed rate: 1 XLM = $0.10 → 10 cents → 10_000_000 / 10 = 1_000_000
  // stroops per cent. Tests that want XLM acceptance to pass use this.
  stroopsPerCent: async (): Promise<bigint> => 1_000_000n,
  // A4-106: amount-sufficient now routes XLM through the
  // higher-precision requiredStroopsForCharge. Mock the same
  // 0.10 USD/XLM rate so the test expectations (1000 cents →
  // 1_000_000_000 stroops) hold under both code paths.
  requiredStroopsForCharge: async (chargeMinor: bigint): Promise<bigint> =>
    chargeMinor * 1_000_000n,
  // Fixed fiat FX: USD → 100_000 stroops/cent (1:1); GBP → 128_206
  // (roughly 0.78 USD/GBP, so £1 ≈ $1.282 ≈ 1.282 USDC = 12_820_513
  // stroops, per-penny = 128_206); EUR → 108_696 (roughly 0.92 USD/EUR).
  usdcStroopsPerCent: async (currency: string): Promise<bigint> => {
    if (currency === 'USD') return 100_000n;
    if (currency === 'GBP') return 128_206n;
    if (currency === 'EUR') return 108_696n;
    throw new Error(`no rate for ${currency}`);
  },
}));
vi.mock('../../orders/repo.js', () => ({
  findPendingOrderByMemo: (memo: string) => findOrderMock(memo),
  findAnyOrderByMemo: (memo: string) => findAnyOrderMock(memo),
}));
vi.mock('../../orders/transitions.js', async () => {
  // Keep the real LoopAssetMissingCreditRowError class — the
  // watcher's catch discriminates with `instanceof`, so the mock
  // must not replace it with undefined.
  const actual = await vi.importActual<typeof TransitionsModule>('../../orders/transitions.js');
  return {
    ...actual,
    markOrderPaid: (id: string, opts?: unknown) => markPaidMock(id, opts),
  };
});

// Skipped-deposit retry ledger (CRIT #1/#2) — mocked so the tick's
// skip persistence + sweep are observable without a real DB. The
// dedicated suite for the real module lives in
// `./skipped-payments.test.ts`.
const recordSkipMock = vi.fn(async (_args: unknown): Promise<void> => undefined);
const retrySkipsMock = vi.fn(async (_process: unknown) => ({
  retried: 0,
  resolved: 0,
  abandoned: 0,
  stillPending: 0,
}));
vi.mock('../skipped-payments.js', () => ({
  recordSkip: (args: unknown) => recordSkipMock(args),
  retrySkippedPayments: (process: unknown) => retrySkipsMock(process),
}));

// ADR 015 — mock the configured LOOP-asset allowlist. Tests that
// exercise the LOOP-asset path override this per-test.
const { loopAssetsState } = vi.hoisted(() => ({
  loopAssetsState: {
    assets: [] as Array<{ code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP'; issuer: string }>,
  },
}));
vi.mock('../../credits/payout-asset.js', () => ({
  configuredLoopPayableAssets: () => loopAssetsState.assets,
}));

// db mock — covers readCursor (findFirst) and writeCursor (upsert).
const { dbMock, state } = vi.hoisted(() => {
  const s: {
    cursor: string | null;
    writtenCursors: string[];
    /** S4-8: whether withAdvisoryLock's probe "acquires" the lock. */
    advisoryAcquired: boolean;
  } = { cursor: null, writtenCursors: [], advisoryAcquired: true };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn((v: { cursor?: string }) => {
    if (typeof v.cursor === 'string') s.writtenCursors.push(v.cursor);
    return m;
  });
  // .values() captured the cursor above; the upsert block passes the
  // same string in `set: { cursor }`, but we don't want to double-
  // count, so this is a pure no-op that completes the chain.
  m['onConflictDoUpdate'] = vi.fn(async () => undefined);
  return { dbMock: m, state: s };
});

vi.mock('../../db/client.js', () => ({
  db: {
    insert: dbMock['insert'],
    // A4-105: writeCursor's empty-page sibling `touchCursorUpdatedAt`
    // performs `db.update(watcherCursors).set({ updatedAt }).where()`.
    // The watcher tests assert behaviour without round-tripping the
    // cursor row to a real DB, so the chain returns nothing.
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    query: {
      watcherCursors: {
        findFirst: vi.fn(async () =>
          state.cursor === null ? undefined : { cursor: state.cursor },
        ),
      },
    },
  },
  // S4-8: withAdvisoryLock mock — same shape as interest-mint.test.ts.
  // Default acquires the lock and runs `fn`; `state.advisoryAcquired
  // = false` simulates another machine holding it fleet-wide.
  withAdvisoryLock: async <T>(
    _lockKey: bigint,
    fn: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> => {
    if (!state.advisoryAcquired) return { ran: false };
    return { ran: true, value: await fn() };
  },
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    watcherCursors: {
      name: 'name',
      cursor: 'cursor',
      updatedAt: 'updatedAt',
    },
  };
});

import { isAmountSufficient, parseStroops, runPaymentWatcherTick } from '../watcher.js';
import { loopAssetOverpaymentStroops } from '../amount-sufficient.js';

const ACCOUNT = 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGV';

function usdcPayment(memo: string, amount: string, pagingToken = 'pt-1'): HorizonPayment {
  return {
    id: `id-${pagingToken}`,
    paging_token: pagingToken,
    type: 'payment',
    from: 'GOTHER',
    to: ACCOUNT,
    asset_type: 'credit_alphanum4',
    asset_code: 'USDC',
    asset_issuer: 'GCENTRE',
    amount,
    transaction_hash: `tx-${pagingToken}`,
    transaction_successful: true,
    transaction: { memo, memo_type: 'text', successful: true },
  };
}

interface FakeOrder {
  id: string;
  paymentMethod: 'xlm' | 'usdc' | 'credit' | 'loop_asset';
  currency: string;
  faceValueMinor: bigint;
  chargeMinor: bigint;
  chargeCurrency: string;
}

function makeOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: 'order-1',
    paymentMethod: 'usdc',
    currency: 'USD',
    faceValueMinor: 1_000n, // $10.00
    chargeMinor: 1_000n,
    chargeCurrency: 'USD',
    ...overrides,
  };
}

beforeEach(() => {
  listPaymentsMock.mockReset();
  notifyOverpaymentMock.mockReset();
  findOrderMock.mockReset();
  findAnyOrderMock.mockReset();
  findAnyOrderMock.mockResolvedValue(null);
  markPaidMock.mockReset();
  checkDuplicateFundingSourceMock.mockReset();
  checkDuplicateFundingSourceMock.mockResolvedValue(undefined);
  recordSkipMock.mockReset();
  recordSkipMock.mockResolvedValue(undefined);
  retrySkipsMock.mockReset();
  retrySkipsMock.mockResolvedValue({ retried: 0, resolved: 0, abandoned: 0, stillPending: 0 });
  state.cursor = null;
  state.writtenCursors = [];
  state.advisoryAcquired = true;
  loopAssetsState.assets = [];
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('loopAssetOverpaymentStroops (A7)', () => {
  const lp = (amount: string): never => ({ amount }) as never;
  const gbpOrder = (): never =>
    makeOrder({
      paymentMethod: 'loop_asset',
      currency: 'GBP',
      chargeCurrency: 'GBP',
      chargeMinor: 1_000n,
    }) as never;

  it('returns the excess stroops on a material overpayment', () => {
    // charge 1000 minor → 100_000_000 stroops required; 12.5 GBPLOOP →
    // 125_000_000 received; excess 25_000_000.
    expect(loopAssetOverpaymentStroops(lp('12.5000000'), gbpOrder(), 'GBPLOOP')).toBe(25_000_000n);
  });

  it('returns 0n for an exact payment', () => {
    expect(loopAssetOverpaymentStroops(lp('10.0000000'), gbpOrder(), 'GBPLOOP')).toBe(0n);
  });

  it('returns 0n for an underpayment', () => {
    expect(loopAssetOverpaymentStroops(lp('9.0000000'), gbpOrder(), 'GBPLOOP')).toBe(0n);
  });

  it('ignores sub-dust excess (rounding noise)', () => {
    // 10.0000050 GBPLOOP = 100_000_050 stroops; excess 50 < 100 dust.
    expect(loopAssetOverpaymentStroops(lp('10.0000050'), gbpOrder(), 'GBPLOOP')).toBe(0n);
  });

  it('returns 0n when it is not a loop_asset payment', () => {
    expect(loopAssetOverpaymentStroops(lp('999.0000000'), gbpOrder(), null)).toBe(0n);
  });

  it('returns 0n on a currency mismatch (never over-credits cross-currency)', () => {
    expect(loopAssetOverpaymentStroops(lp('999.0000000'), gbpOrder(), 'USDLOOP')).toBe(0n);
  });
});

describe('parseStroops', () => {
  it('parses "10.0000000" as 10 × 10^7 stroops', () => {
    expect(parseStroops('10.0000000')).toBe(100_000_000n);
  });
  it('parses an integer-only amount', () => {
    expect(parseStroops('42')).toBe(420_000_000n);
  });
  it('handles trailing-zero truncation', () => {
    expect(parseStroops('0.0000001')).toBe(1n);
    expect(parseStroops('123.45')).toBe(1_234_500_000n);
  });
});

describe('isAmountSufficient', () => {
  it('accepts a USDC payment ≥ face value (USD order)', async () => {
    const p = usdcPayment('MEMO', '10.0000000');
    expect(await isAmountSufficient(p, makeOrder() as never)).toBe(true);
  });

  it('accepts an exact-face-value USDC payment', async () => {
    const p = usdcPayment('MEMO', '10.0000000');
    expect(await isAmountSufficient(p, makeOrder({ faceValueMinor: 1_000n }) as never)).toBe(true);
  });

  it('rejects a USDC underpayment', async () => {
    const p = usdcPayment('MEMO', '9.9999999');
    expect(await isAmountSufficient(p, makeOrder({ faceValueMinor: 1_000n }) as never)).toBe(false);
  });

  it('accepts a USDC payment against a GBP-charge order via fiat FX', async () => {
    // £10.00 charged to the user (chargeMinor=1000 pence, chargeCurrency=GBP).
    // Mocked FX: 128_206 stroops/pence. Required: 128_206_000 stroops =
    // 12.8206 USDC. A payment of 13 USDC (130_000_000 stroops) clears.
    const p = usdcPayment('MEMO', '13.0000000');
    expect(
      await isAmountSufficient(p, makeOrder({ currency: 'GBP', chargeCurrency: 'GBP' }) as never),
    ).toBe(true);
  });

  it('rejects a USDC underpayment against a GBP-charge order', async () => {
    // £10.00 charge requires ~12.82 USDC. 10 USDC (100_000_000 stroops) falls short.
    const p = usdcPayment('MEMO', '10.0000000');
    expect(
      await isAmountSufficient(p, makeOrder({ currency: 'GBP', chargeCurrency: 'GBP' }) as never),
    ).toBe(false);
  });

  it('rejects USDC payment for a charge currency the FX oracle has no rate for', async () => {
    const p = usdcPayment('MEMO', '100.0000000');
    expect(
      await isAmountSufficient(p, makeOrder({ currency: 'JPY', chargeCurrency: 'JPY' }) as never),
    ).toBe(false);
  });

  it('rejects credit-method orders — they are never watcher-transitioned', async () => {
    const p = usdcPayment('MEMO', '10.0000000');
    expect(await isAmountSufficient(p, makeOrder({ paymentMethod: 'credit' }) as never)).toBe(
      false,
    );
  });

  it('rejects an unparseable amount', async () => {
    const p = { ...usdcPayment('MEMO', '10.0000000'), amount: 'not-a-number' };
    expect(await isAmountSufficient(p, makeOrder() as never)).toBe(false);
  });

  it('accepts an XLM payment at the oracle rate', async () => {
    // Mocked stroopsPerCent = 1_000_000 (≈$0.10/XLM).
    // $10.00 order (1000 cents) needs 1_000_000_000 stroops = 100 XLM.
    const p = {
      ...usdcPayment('MEMO', '100.0000000'),
      asset_type: 'native',
      asset_code: undefined,
      asset_issuer: undefined,
    };
    expect(
      await isAmountSufficient(
        p as never,
        makeOrder({ paymentMethod: 'xlm', faceValueMinor: 1_000n }) as never,
      ),
    ).toBe(true);
  });

  it('rejects an XLM payment below the oracle-implied requirement', async () => {
    const p = {
      ...usdcPayment('MEMO', '50.0000000'),
      asset_type: 'native',
      asset_code: undefined,
      asset_issuer: undefined,
    };
    expect(
      await isAmountSufficient(
        p as never,
        makeOrder({ paymentMethod: 'xlm', faceValueMinor: 1_000n }) as never,
      ),
    ).toBe(false);
  });

  it('rejects XLM payment for a currency the oracle has no rate for', async () => {
    const p = {
      ...usdcPayment('MEMO', '1000.0000000'),
      asset_type: 'native',
      asset_code: undefined,
      asset_issuer: undefined,
    };
    expect(
      await isAmountSufficient(
        p as never,
        makeOrder({ paymentMethod: 'xlm', currency: 'JPY', chargeCurrency: 'JPY' }) as never,
      ),
    ).toBe(false);
  });

  // ─── A2-619: cross-currency orders validate in chargeCurrency ──

  it('A2-619 USDC: cross-ccy order (GBP catalog, USD charge) validates against chargeMinor in USD', async () => {
    // £100 Boots card (faceValueMinor=10000 GBP pence), user charged
    // $125 (chargeMinor=12500 USD cents) after FX pin. Mocked USDC
    // perCent for USD = 100_000 stroops/cent. Required: 12500 * 100k =
    // 1_250_000_000 stroops = 125 USDC. Pre-fix used faceValueMinor *
    // USDC-perCent-for-GBP (128_206) = 1_282_060_000 stroops = 128.21
    // USDC — so a user paying the expected 125 USDC got silently
    // rejected as underpayment.
    const p = usdcPayment('MEMO', '125.0000000');
    expect(
      await isAmountSufficient(
        p,
        makeOrder({
          paymentMethod: 'usdc',
          currency: 'GBP',
          faceValueMinor: 10_000n,
          chargeCurrency: 'USD',
          chargeMinor: 12_500n,
        }) as never,
      ),
    ).toBe(true);
  });

  it('A2-619 USDC: cross-ccy underpayment still rejected', async () => {
    // Same setup as above but user sends 124 USDC instead of 125.
    const p = usdcPayment('MEMO', '124.0000000');
    expect(
      await isAmountSufficient(
        p,
        makeOrder({
          paymentMethod: 'usdc',
          currency: 'GBP',
          faceValueMinor: 10_000n,
          chargeCurrency: 'USD',
          chargeMinor: 12_500n,
        }) as never,
      ),
    ).toBe(false);
  });

  it('A2-619 XLM: cross-ccy order validates against chargeMinor + chargeCurrency', async () => {
    // £100 catalog / $125 charge. Mocked XLM stroopsPerCent(USD) =
    // 1_000_000. Required: 12500 * 1M = 12_500_000_000 stroops = 1250
    // XLM. Payment of 1250 XLM (12_500_000_000 stroops) must clear.
    const p = {
      ...usdcPayment('MEMO', '1250.0000000'),
      asset_type: 'native',
      asset_code: undefined,
      asset_issuer: undefined,
    };
    expect(
      await isAmountSufficient(
        p as never,
        makeOrder({
          paymentMethod: 'xlm',
          currency: 'GBP',
          faceValueMinor: 10_000n,
          chargeCurrency: 'USD',
          chargeMinor: 12_500n,
        }) as never,
      ),
    ).toBe(true);
  });
});

describe('runPaymentWatcherTick', () => {
  it('no records → no transitions, no cursor writes', async () => {
    listPaymentsMock.mockResolvedValue({ records: [], nextCursor: null });
    const r = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(r.scanned).toBe(0);
    expect(r.paid).toBe(0);
    expect(markPaidMock).not.toHaveBeenCalled();
    expect(state.writtenCursors).toEqual([]);
  });

  it('matches memo + amount → markOrderPaid, advances cursor', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('MEMO-OK', '10.0000000', 'pt-1')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder({ id: 'order-1' }));
    markPaidMock.mockResolvedValue({ id: 'order-1' });
    const r = await runPaymentWatcherTick({
      account: ACCOUNT,
      usdcIssuer: 'GCENTRE',
    });
    expect(r.matched).toBe(1);
    expect(r.paid).toBe(1);
    expect(markPaidMock).toHaveBeenCalledWith('order-1', {
      paymentReceivedHorizonId: 'id-pt-1',
      paymentReceivedTxHash: 'tx-pt-1',
      paymentReceivedPayment: expect.objectContaining({ id: 'id-pt-1' }),
    });
    expect(state.writtenCursors).toEqual(['pt-1']);
  });

  it('ADR 045 (B-3): a fresh paid transition triggers the duplicate-account check AFTER the transition, never before', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('MEMO-OK', '10.0000000', 'pt-1')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue({ ...makeOrder({ id: 'order-1' }), userId: 'user-1' });
    markPaidMock.mockResolvedValue({ id: 'order-1', userId: 'user-1' });
    await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(checkDuplicateFundingSourceMock).toHaveBeenCalledTimes(1);
    expect(checkDuplicateFundingSourceMock).toHaveBeenCalledWith({
      userId: 'user-1',
      orderId: 'order-1',
      sourceAccount: 'GOTHER', // usdcPayment()'s fixture `from`
    });
    // Called after markOrderPaid resolved, not concurrently with it —
    // the mock call order proves the transition committed first.
    const markPaidOrder = markPaidMock.mock.invocationCallOrder[0] ?? -1;
    const dupCheckOrder = checkDuplicateFundingSourceMock.mock.invocationCallOrder[0] ?? -2;
    expect(markPaidOrder).toBeLessThan(dupCheckOrder);
  });

  it('ADR 045 (B-3): does NOT re-check on an already-paid (non-fresh) transition result', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('MEMO-OK', '10.0000000', 'pt-1')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue({ ...makeOrder({ id: 'order-1' }), userId: 'user-1' });
    // markOrderPaid returns null — the WHERE state='pending_payment'
    // guard found no row (already transitioned by a prior tick).
    markPaidMock.mockResolvedValue(null);
    await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(checkDuplicateFundingSourceMock).not.toHaveBeenCalled();
  });

  it('unknown memo → unmatchedMemo++, cursor still advances', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('GHOST-MEMO', '10.0000000', 'pt-7')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(null);
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.unmatchedMemo).toBe(1);
    expect(r.paid).toBe(0);
    expect(state.writtenCursors).toEqual(['pt-7']);
  });

  it('T0-1c: expired-order sub-dust late deposit is counted but not recorded', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('DUST-MEMO', '0.0009999', 'pt-dust')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(null);
    findAnyOrderMock.mockResolvedValue({ ...makeOrder({ id: 'expired-order' }), state: 'expired' });
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.unmatchedMemo).toBe(1);
    expect(recordSkipMock).not.toHaveBeenCalled();
    expect(state.writtenCursors).toEqual(['pt-dust']);
  });

  it('T0-1c: refundable late deposit at the dust floor is still recorded', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('REFUNDABLE-MEMO', '0.0010000', 'pt-refundable')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(null);
    findAnyOrderMock.mockResolvedValue({ ...makeOrder({ id: 'expired-order' }), state: 'expired' });
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.unmatchedMemo).toBe(1);
    expect(recordSkipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        memo: 'REFUNDABLE-MEMO',
        orderId: 'expired-order',
        reason: 'order_gone',
      }),
    );
  });

  it('T0-1b: duplicate deposit against a paid order is recorded for refund', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('PAID-MEMO', '10.0000000', 'pt-duplicate')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(null);
    findAnyOrderMock.mockResolvedValue({
      ...makeOrder({ id: 'paid-order' }),
      state: 'paid',
      paymentReceivedHorizonId: 'id-original',
      paymentReceivedTxHash: 'tx-original',
    });

    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    expect(r.unmatchedMemo).toBe(1);
    expect(recordSkipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payment: expect.objectContaining({ id: 'id-pt-duplicate' }),
        memo: 'PAID-MEMO',
        orderId: 'paid-order',
        reason: 'order_gone',
        detail: 'duplicate deposit arrived after order was already paid',
      }),
    );
  });

  it('T0-1b: re-reading the original paying deposit for a paid order is not recorded', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('PAID-MEMO', '10.0000000', 'pt-original')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(null);
    findAnyOrderMock.mockResolvedValue({
      ...makeOrder({ id: 'paid-order' }),
      state: 'paid',
      paymentReceivedHorizonId: 'id-pt-original',
      paymentReceivedTxHash: 'tx-pt-original',
    });

    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    expect(r.unmatchedMemo).toBe(1);
    expect(recordSkipMock).not.toHaveBeenCalled();
    expect(state.writtenCursors).toEqual(['pt-original']);
  });

  it('T0-1b: paid-order deposits without a stored paying id stay unrecorded', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('LEGACY-PAID-MEMO', '10.0000000', 'pt-legacy')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(null);
    findAnyOrderMock.mockResolvedValue({
      ...makeOrder({ id: 'legacy-paid-order' }),
      state: 'paid',
      paymentReceivedHorizonId: null,
      paymentReceivedTxHash: null,
    });

    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    expect(r.unmatchedMemo).toBe(1);
    expect(recordSkipMock).not.toHaveBeenCalled();
  });

  it('underpayment → skippedAmount++, no transition', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('MEMO-SHORT', '1.0000000', 'pt-2')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder({ faceValueMinor: 1_000n }));
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.matched).toBe(1);
    expect(r.paid).toBe(0);
    expect(r.skippedAmount).toBe(1);
    expect(markPaidMock).not.toHaveBeenCalled();
  });

  it('resumes from the persisted cursor', async () => {
    state.cursor = 'pt-99';
    listPaymentsMock.mockResolvedValue({ records: [], nextCursor: null });
    await runPaymentWatcherTick({ account: ACCOUNT });
    expect(listPaymentsMock).toHaveBeenCalledWith(expect.objectContaining({ cursor: 'pt-99' }));
  });

  it('skips non-payment or failed-tx records', async () => {
    const records: HorizonPayment[] = [
      { ...usdcPayment('MEMO', '10.0000000', 'pt-a'), type: 'create_account' },
      { ...usdcPayment('MEMO', '10.0000000', 'pt-b'), transaction_successful: false },
    ];
    listPaymentsMock.mockResolvedValue({ records, nextCursor: null });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.matched).toBe(0);
    expect(r.paid).toBe(0);
    // Cursor still advances to last record's paging token — we've
    // scanned them, they just didn't match.
    expect(state.writtenCursors).toEqual(['pt-b']);
    // AUDIT-2 finding C: neither record delivers value to the account
    // (create_account isn't payment-shaped; the second has a failed
    // tx) — `isInboundDeliveryToAccount` must reject both, so nothing
    // gets recorded here either.
    expect(recordSkipMock).not.toHaveBeenCalled();
  });

  it('uses nextCursor when the page is empty but Horizon says there is more', async () => {
    listPaymentsMock.mockResolvedValue({ records: [], nextCursor: 'pt-next' });
    await runPaymentWatcherTick({ account: ACCOUNT });
    expect(state.writtenCursors).toEqual(['pt-next']);
  });

  // ─── ADR 015 — LOOP-asset acceptance ──────────────────────────────────────
  const GBPLOOP_ISSUER = 'GB' + '2'.repeat(55);
  const USDLOOP_ISSUER = 'GA' + '1'.repeat(55);

  function loopAssetPayment(
    memo: string,
    amount: string,
    code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP',
    issuer: string,
    pagingToken = 'pt-loop',
  ): HorizonPayment {
    return {
      id: `id-${pagingToken}`,
      paging_token: pagingToken,
      type: 'payment',
      from: 'GOTHER',
      to: ACCOUNT,
      asset_type: 'credit_alphanum12',
      asset_code: code,
      asset_issuer: issuer,
      amount,
      transaction_hash: `tx-${pagingToken}`,
      transaction_successful: true,
      transaction: { memo, memo_type: 'text', successful: true },
    };
  }

  it('accepts a GBPLOOP payment for a GBP-charged order at 1:1 peg', async () => {
    loopAssetsState.assets = [{ code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }];
    listPaymentsMock.mockResolvedValue({
      // £10.00 = 1000 pence = 1000 × 100_000 stroops = 100_000_000
      // stroops = "10.0000000" in GBPLOOP's 7-decimal Stellar units.
      records: [loopAssetPayment('MEMO', '10.0000000', 'GBPLOOP', GBPLOOP_ISSUER)],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(
      makeOrder({
        // A4-107: a LOOP-asset deposit must be paired with an
        // order whose paymentMethod is `loop_asset`. Earlier the
        // watcher accepted a LOOP deposit against a `usdc` order,
        // which masked the cross-asset confusion bug. Update the
        // test to the now-required pairing.
        paymentMethod: 'loop_asset',
        currency: 'GBP',
        faceValueMinor: 1_000n,
        chargeMinor: 1_000n,
        chargeCurrency: 'GBP',
      }),
    );
    markPaidMock.mockResolvedValue({ id: 'order-1' });
    const r = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(r.paid).toBe(1);
    expect(r.skippedAmount).toBe(0);
  });

  it('A7: fulfils an overpaid GBPLOOP payment AND fires the attributed overpayment alert', async () => {
    loopAssetsState.assets = [{ code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }];
    listPaymentsMock.mockResolvedValue({
      // £10.00 charge, but 12.5 GBPLOOP sent → 2.5 excess =
      // 250_000 minor-stroops overpaid.
      records: [loopAssetPayment('MEMO', '12.5000000', 'GBPLOOP', GBPLOOP_ISSUER)],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(
      makeOrder({
        paymentMethod: 'loop_asset',
        currency: 'GBP',
        chargeCurrency: 'GBP',
        chargeMinor: 1_000n,
      }),
    );
    markPaidMock.mockResolvedValue({ id: 'order-1' });
    const r = await runPaymentWatcherTick({ account: ACCOUNT });
    // The order still fulfils — the user paid enough.
    expect(r.paid).toBe(1);
    expect(r.skippedAmount).toBe(0);
    // ...and the excess is surfaced attributed for a manual return.
    expect(notifyOverpaymentMock).toHaveBeenCalledOnce();
    const arg = notifyOverpaymentMock.mock.calls[0]![0] as {
      excessStroops: string;
      orderId: string;
    };
    // 12.5 GBPLOOP = 1_250_000_000 stroops; charge 1000 minor =
    // 100_000_000 stroops; excess 1_150_000_000... wait:
    // 1000 minor × 100_000 = 100_000_000 stroops required.
    // 12.5 GBPLOOP × 10^7 = 125_000_000 stroops received.
    // excess = 25_000_000 stroops.
    expect(arg.excessStroops).toBe('25000000');
  });

  it('A7: an EXACT GBPLOOP payment fires no overpayment alert', async () => {
    loopAssetsState.assets = [{ code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }];
    listPaymentsMock.mockResolvedValue({
      records: [loopAssetPayment('MEMO', '10.0000000', 'GBPLOOP', GBPLOOP_ISSUER)],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(
      makeOrder({
        paymentMethod: 'loop_asset',
        currency: 'GBP',
        chargeCurrency: 'GBP',
        chargeMinor: 1_000n,
      }),
    );
    markPaidMock.mockResolvedValue({ id: 'order-1' });
    await runPaymentWatcherTick({ account: ACCOUNT });
    expect(notifyOverpaymentMock).not.toHaveBeenCalled();
  });

  it('rejects a LOOP-asset payment whose currency does not match the order charge currency', async () => {
    // USDLOOP payment against a GBP-charged order — 1:1 assumption
    // breaks across currencies, so reject.
    loopAssetsState.assets = [{ code: 'USDLOOP', issuer: USDLOOP_ISSUER }];
    listPaymentsMock.mockResolvedValue({
      records: [loopAssetPayment('MEMO', '10.0000000', 'USDLOOP', USDLOOP_ISSUER)],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(
      makeOrder({
        paymentMethod: 'loop_asset',
        currency: 'GBP',
        chargeCurrency: 'GBP',
        chargeMinor: 1_000n,
      }),
    );
    const r = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(r.matched).toBe(1);
    expect(r.paid).toBe(0);
    expect(r.skippedAmount).toBe(1);
  });

  it('rejects an underpaid LOOP-asset payment', async () => {
    loopAssetsState.assets = [{ code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }];
    listPaymentsMock.mockResolvedValue({
      // Only 500 pence paid against a 1000 pence charge.
      records: [loopAssetPayment('MEMO', '5.0000000', 'GBPLOOP', GBPLOOP_ISSUER)],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(
      makeOrder({
        paymentMethod: 'loop_asset',
        chargeCurrency: 'GBP',
        chargeMinor: 1_000n,
        currency: 'GBP',
      }),
    );
    const r = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(r.paid).toBe(0);
    expect(r.skippedAmount).toBe(1);
  });

  it('ignores a LOOP-asset payment whose issuer is not the configured one (spoof guard)', async () => {
    // Allowlist has GBPLOOP at GBPLOOP_ISSUER, but an attacker issues
    // their own "GBPLOOP" asset from a different account. The payment
    // shouldn't match — isMatchingIncomingPayment keys on issuer.
    loopAssetsState.assets = [{ code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }];
    const imposterIssuer = 'GI' + '3'.repeat(55);
    listPaymentsMock.mockResolvedValue({
      records: [loopAssetPayment('MEMO', '10.0000000', 'GBPLOOP', imposterIssuer)],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT });
    // Didn't match the allowlist, so `unmatchedMemo` wasn't incremented
    // (we never even looked up the memo) and no order moved.
    expect(r.matched).toBe(0);
    expect(r.paid).toBe(0);
  });

  // AUDIT-2 finding A (two independent reviewers): the USDC path used
  // to spread `assetIssuer` into the matcher only when
  // `args.usdcIssuer` was defined, and `isMatchingIncomingPayment`
  // treated an omitted issuer as "any issuer matches" — an attacker
  // could self-issue their own "USDC" asset and get it treated as
  // real, triggering markOrderPaid and a real gift-card procurement
  // against real operator funds. horizon.ts now requires a pinned
  // issuer for any credit-asset match. These two tests pin the fixed
  // tick-level behaviour: rejected regardless of whether an issuer is
  // configured.
  it('AUDIT-2 finding A: rejects a fake "USDC" from an attacker issuer when the REAL issuer IS configured', async () => {
    const attackerIssuer = 'GATTACKER' + '9'.repeat(46);
    listPaymentsMock.mockResolvedValue({
      records: [{ ...usdcPayment('MEMO', '10.0000000'), asset_issuer: attackerIssuer }],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.matched).toBe(0);
    expect(r.paid).toBe(0);
    expect(markPaidMock).not.toHaveBeenCalled();
    // Didn't match on any asset, so the memo lookup never happened —
    // same "we never even looked up the memo" shape as the LOOP-asset
    // spoof-guard test above.
    expect(findOrderMock).not.toHaveBeenCalled();
  });

  it('AUDIT-2 finding A: rejects USDC of ANY issuer — matches nothing, not "any issuer" — when LOOP_STELLAR_USDC_ISSUER is unset', async () => {
    listPaymentsMock.mockResolvedValue({
      // A real Circle-issuer-shaped USDC payment against a pending
      // order's memo. Before the fix this matched (vacuous "any
      // issuer" truth) and paid the order; now it must not.
      records: [usdcPayment('MEMO', '10.0000000')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder());
    // No `usdcIssuer` passed — the unconfigured-LOOP_STELLAR_USDC_ISSUER shape.
    const r = await runPaymentWatcherTick({ account: ACCOUNT });
    expect(r.matched).toBe(0);
    expect(r.paid).toBe(0);
    expect(markPaidMock).not.toHaveBeenCalled();
    expect(findOrderMock).not.toHaveBeenCalled();
  });

  it('still accepts USDC alongside LOOP assets — allowlist is additive', async () => {
    loopAssetsState.assets = [{ code: 'GBPLOOP', issuer: GBPLOOP_ISSUER }];
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('MEMO', '10.0000000')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(
      makeOrder({ paymentMethod: 'usdc', currency: 'USD', faceValueMinor: 1_000n }),
    );
    markPaidMock.mockResolvedValue({ id: 'order-1' });
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(1);
  });

  it('S4-8: skips the tick when another machine holds the payment-watcher lock', async () => {
    state.advisoryAcquired = false;
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('MEMO', '10.0000000')],
      nextCursor: null,
    });
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r).toEqual({
      scanned: 0,
      matched: 0,
      paid: 0,
      skippedAmount: 0,
      unmatchedMemo: 0,
      errors: 0,
      skipsRecovered: 0,
      skippedLocked: true,
    });
    // Zero Horizon reads and zero cursor writes — the whole tick body
    // never ran.
    expect(listPaymentsMock).not.toHaveBeenCalled();
    expect(state.writtenCursors).toEqual([]);
  });

  it('releases the lock + returns empty when the tick body exceeds the lease deadline', async () => {
    // A hung Horizon: listAccountPayments never resolves. The lease
    // must fire so the fleet-wide lock is released and deposit
    // processing is not stalled on every machine.
    vi.useFakeTimers();
    try {
      let releaseHang: () => void = () => {};
      listPaymentsMock.mockReturnValue(
        new Promise((resolve) => {
          releaseHang = () => resolve({ records: [], nextCursor: null });
        }),
      );
      const tickPromise = runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
      // Advance past the 60s lease — the Promise.race timeout wins.
      await vi.advanceTimersByTimeAsync(60_001);
      const r = await tickPromise;
      expect(r).toEqual({
        scanned: 0,
        matched: 0,
        paid: 0,
        skippedAmount: 0,
        unmatchedMemo: 0,
        errors: 0,
        skipsRecovered: 0,
        skippedLocked: false,
      });
      expect(state.writtenCursors).toEqual([]);
      releaseHang();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AUDIT-2 finding C — unrecognized inbound deposit recording', () => {
  function pathPaymentUsdc(memo: string, amount: string, pagingToken: string): HorizonPayment {
    return {
      id: `id-${pagingToken}`,
      paging_token: pagingToken,
      type: 'path_payment_strict_receive',
      from: 'GOTHER',
      to: ACCOUNT,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GCENTRE',
      amount,
      transaction_hash: `tx-${pagingToken}`,
      transaction_successful: true,
      transaction: { memo, memo_type: 'text', successful: true },
    };
  }

  it('a path payment delivering the configured USDC asset + memo still pays the order (regression: widening the type gate does not break the happy path)', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [pathPaymentUsdc('MEMO', '10.0000000', 'pt-path-pay')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder());
    markPaidMock.mockResolvedValue({ id: 'order-1' });
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(1);
    expect(markPaidMock).toHaveBeenCalledWith(
      'order-1',
      expect.objectContaining({ paymentReceivedHorizonId: 'id-pt-path-pay' }),
    );
    expect(recordSkipMock).not.toHaveBeenCalled();
  });

  it('a path payment delivering an asset no rail recognizes records an unrecognized_deposit skip (not silently dropped, not double-counted)', async () => {
    const p: HorizonPayment = {
      id: 'id-pt-unrec',
      paging_token: 'pt-unrec',
      type: 'path_payment_strict_send',
      from: 'GOTHER',
      to: ACCOUNT,
      asset_type: 'credit_alphanum4',
      asset_code: 'EURC',
      asset_issuer: 'GEURCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      amount: '10.0000000',
      transaction_hash: 'tx-unrec',
      transaction_successful: true,
      transaction: { memo: 'SOME-MEMO', memo_type: 'text', successful: true },
    };
    listPaymentsMock.mockResolvedValue({ records: [p], nextCursor: null });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(0);
    expect(markPaidMock).not.toHaveBeenCalled();
    // Never even looked up the memo — the asset itself matched nothing.
    expect(findOrderMock).not.toHaveBeenCalled();
    expect(recordSkipMock).toHaveBeenCalledTimes(1);
    expect(recordSkipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payment: expect.objectContaining({ id: 'id-pt-unrec' }),
        orderId: null,
        reason: 'unrecognized_deposit',
      }),
    );
    expect(state.writtenCursors).toEqual(['pt-unrec']);
  });

  it('a memo-less direct payment to the deposit address records an unrecognized_deposit skip', async () => {
    const p: HorizonPayment = {
      id: 'id-pt-nomemo',
      paging_token: 'pt-nomemo',
      type: 'payment',
      from: 'GOTHER',
      to: ACCOUNT,
      asset_type: 'credit_alphanum4',
      asset_code: 'USDC',
      asset_issuer: 'GCENTRE',
      amount: '10.0000000',
      transaction_hash: 'tx-nomemo',
      transaction_successful: true,
      // No text memo — a real wallet payment that didn't set one.
      transaction: { memo_type: 'none', successful: true },
    };
    listPaymentsMock.mockResolvedValue({ records: [p], nextCursor: null });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(0);
    expect(recordSkipMock).toHaveBeenCalledTimes(1);
    expect(recordSkipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payment: expect.objectContaining({ id: 'id-pt-nomemo' }),
        memo: '',
        orderId: null,
        reason: 'unrecognized_deposit',
      }),
    );
  });

  it('an OUTBOUND operator payment (to !== account) is NEVER recorded — the critical noise guard (shared deposit/operator account)', async () => {
    const p: HorizonPayment = {
      id: 'id-pt-outbound',
      paging_token: 'pt-outbound',
      type: 'payment',
      from: ACCOUNT,
      to: 'GRECIPIENT',
      asset_type: 'native',
      amount: '5.0000000',
      transaction_hash: 'tx-outbound',
      transaction_successful: true,
      transaction: { memo: 'payout-memo', memo_type: 'text', successful: true },
    };
    listPaymentsMock.mockResolvedValue({ records: [p], nextCursor: null });
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(0);
    expect(recordSkipMock).not.toHaveBeenCalled();
    expect(state.writtenCursors).toEqual(['pt-outbound']);
  });

  // P2-d (2026-07-10): an account_merge delivering the source's whole
  // balance INTO the deposit address previously vanished with no DB
  // row at all — `isInboundDeliveryToAccount` only recognized
  // payment/path-payment ops (`to === account`), and account_merge
  // never populates `to` (only `source_account`/`into`). It now
  // records into the same unrecognized_deposit recovery trail.
  it('P2-d: an inbound account_merge (into the deposit address) records an unrecognized_deposit skip', async () => {
    const p: HorizonPayment = {
      id: 'id-pt-merge',
      paging_token: 'pt-merge',
      type: 'account_merge',
      source_account: 'GMERGEDSOURCEXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      into: ACCOUNT,
      transaction_hash: 'tx-merge',
      transaction_successful: true,
      transaction: { memo: 'MEMO', memo_type: 'text', successful: true },
    };
    listPaymentsMock.mockResolvedValue({ records: [p], nextCursor: null });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(0);
    expect(markPaidMock).not.toHaveBeenCalled();
    expect(recordSkipMock).toHaveBeenCalledTimes(1);
    expect(recordSkipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payment: expect.objectContaining({ id: 'id-pt-merge', type: 'account_merge' }),
        orderId: null,
        reason: 'unrecognized_deposit',
        detail: expect.stringContaining('account_merge'),
      }),
    );
    // The detail string resolves the source via `source_account` (the
    // real Horizon field), not the create_account-only `account` field.
    expect(recordSkipMock).toHaveBeenCalledWith(
      expect.objectContaining({ detail: expect.stringContaining('GMERGEDSOURCE') }),
    );
    expect(state.writtenCursors).toEqual(['pt-merge']);
  });

  it('P2-d: an OUTBOUND account_merge (this account merging INTO another) is never recorded', async () => {
    // The critical noise guard's account_merge twin — an `into` that
    // does NOT match `account` param must never record, the same way
    // an outbound payment (`to !== account`) never does.
    const p: HorizonPayment = {
      id: 'id-pt-merge-out',
      paging_token: 'pt-merge-out',
      type: 'account_merge',
      source_account: ACCOUNT,
      into: 'GSOMEOTHERACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      transaction_hash: 'tx-merge-out',
      transaction_successful: true,
      transaction: { memo: 'MEMO', memo_type: 'text', successful: true },
    };
    listPaymentsMock.mockResolvedValue({ records: [p], nextCursor: null });
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(0);
    expect(recordSkipMock).not.toHaveBeenCalled();
    expect(state.writtenCursors).toEqual(['pt-merge-out']);
  });

  it('a sub-dust unrecognized inbound deposit is counted but not recorded (T0-1c dust-floor parity)', async () => {
    const p: HorizonPayment = {
      id: 'id-pt-dust',
      paging_token: 'pt-dust',
      type: 'payment',
      from: 'GOTHER',
      to: ACCOUNT,
      asset_type: 'credit_alphanum4',
      asset_code: 'EURC',
      asset_issuer: 'GEURCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      amount: '0.0009999', // below REFUND_MIN_STROOPS (10_000 stroops = 0.0010000)
      transaction_hash: 'tx-dust',
      transaction_successful: true,
      transaction: { memo: 'MEMO', memo_type: 'text', successful: true },
    };
    listPaymentsMock.mockResolvedValue({ records: [p], nextCursor: null });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(0);
    expect(recordSkipMock).not.toHaveBeenCalled();
    expect(state.writtenCursors).toEqual(['pt-dust']);
  });

  it('a deposit at the refund dust floor IS recorded', async () => {
    const p: HorizonPayment = {
      id: 'id-pt-floor',
      paging_token: 'pt-floor',
      type: 'payment',
      from: 'GOTHER',
      to: ACCOUNT,
      asset_type: 'credit_alphanum4',
      asset_code: 'EURC',
      asset_issuer: 'GEURCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      amount: '0.0010000', // exactly REFUND_MIN_STROOPS
      transaction_hash: 'tx-floor',
      transaction_successful: true,
      transaction: { memo: 'MEMO', memo_type: 'text', successful: true },
    };
    listPaymentsMock.mockResolvedValue({ records: [p], nextCursor: null });
    findOrderMock.mockResolvedValue(makeOrder());
    const r = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(r.paid).toBe(0);
    expect(recordSkipMock).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'unrecognized_deposit' }),
    );
  });

  it('sweep re-evaluation preserves unrecognized_deposit on retry (not clobbered to processing_error)', async () => {
    listPaymentsMock.mockResolvedValue({ records: [], nextCursor: null });
    let capturedProcess: ((payment: HorizonPayment) => Promise<RetryOutcome>) | undefined;
    retrySkipsMock.mockImplementation(async (process: unknown) => {
      capturedProcess = process as (payment: HorizonPayment) => Promise<RetryOutcome>;
      return { retried: 0, resolved: 0, abandoned: 0, stillPending: 0 };
    });
    await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });
    expect(capturedProcess).toBeDefined();

    const stillUnrecognized: HorizonPayment = {
      id: 'id-retry-unrec',
      paging_token: 'pt-retry-unrec',
      type: 'payment',
      from: 'GOTHER',
      to: ACCOUNT,
      asset_type: 'credit_alphanum4',
      asset_code: 'EURC',
      asset_issuer: 'GEURCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      amount: '10.0000000',
      transaction_hash: 'tx-retry-unrec',
      transaction_successful: true,
      transaction: { memo: 'MEMO', memo_type: 'text', successful: true },
    };
    const outcome = await capturedProcess!(stillUnrecognized);
    expect(outcome).toEqual(
      expect.objectContaining({ kind: 'skip', reason: 'unrecognized_deposit', orderId: null }),
    );
  });

  it('sweep re-evaluation keeps an outbound no-match row on processing_error — never reclassified as a deposit', async () => {
    listPaymentsMock.mockResolvedValue({ records: [], nextCursor: null });
    let capturedProcess: ((payment: HorizonPayment) => Promise<RetryOutcome>) | undefined;
    retrySkipsMock.mockImplementation(async (process: unknown) => {
      capturedProcess = process as (payment: HorizonPayment) => Promise<RetryOutcome>;
      return { retried: 0, resolved: 0, abandoned: 0, stillPending: 0 };
    });
    await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    const outboundPayment: HorizonPayment = {
      id: 'id-retry-outbound',
      paging_token: 'pt-retry-outbound',
      type: 'payment',
      from: ACCOUNT,
      to: 'GRECIPIENT',
      asset_type: 'native',
      amount: '5.0000000',
      transaction_hash: 'tx-retry-outbound',
      transaction_successful: true,
      transaction: { memo: 'payout-memo', memo_type: 'text', successful: true },
    };
    const outcome = await capturedProcess!(outboundPayment);
    expect(outcome).toEqual(
      expect.objectContaining({ kind: 'skip', reason: 'processing_error', orderId: null }),
    );
  });
});

describe('skip persistence + poison isolation (comprehensive-audit CRIT #1/#2)', () => {
  it('underpayment records an amount_insufficient skip BEFORE the cursor advances', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('memo-1', '1.0000000', 'pt-10')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder());

    const result = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    expect(result.skippedAmount).toBe(1);
    expect(recordSkipMock).toHaveBeenCalledTimes(1);
    const call = recordSkipMock.mock.calls[0]?.[0] as {
      reason: string;
      orderId: string;
      memo: string;
    };
    expect(call.reason).toBe('amount_insufficient');
    expect(call.orderId).toBe('order-1');
    expect(call.memo).toBe('memo-1');
    // Cursor still advances — the skip row is the retry path now.
    expect(state.writtenCursors).toEqual(['pt-10']);
  });

  it('A4-107 asset mismatch records an asset_mismatch skip', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('memo-1', '100.0000000', 'pt-11')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder({ paymentMethod: 'xlm' }));

    await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    expect(recordSkipMock).toHaveBeenCalledTimes(1);
    expect((recordSkipMock.mock.calls[0]?.[0] as { reason: string }).reason).toBe('asset_mismatch');
  });

  it('poison payment is isolated: skip recorded, later payments processed, cursor advanced', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [
        usdcPayment('memo-poison', '100.0000000', 'pt-20'),
        usdcPayment('memo-good', '100.0000000', 'pt-21'),
      ],
      nextCursor: null,
    });
    findOrderMock.mockImplementation(async (memo: string) =>
      memo === 'memo-poison' ? makeOrder({ id: 'order-poison' }) : makeOrder({ id: 'order-good' }),
    );
    markPaidMock.mockImplementation(async (id: string) => {
      if (id === 'order-poison') throw new Error('user_credits_non_negative violation');
      return { id };
    });

    const result = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    // Pre-fix behaviour: the throw aborted the tick before the
    // cursor write, so the same page (poison included) re-ran
    // forever and 'memo-good' never got paid.
    expect(result.errors).toBe(1);
    expect(result.paid).toBe(1);
    expect(markPaidMock).toHaveBeenCalledWith('order-good', {
      paymentReceivedHorizonId: 'id-pt-21',
      paymentReceivedTxHash: 'tx-pt-21',
      paymentReceivedPayment: expect.objectContaining({ id: 'id-pt-21' }),
    });
    expect(recordSkipMock).toHaveBeenCalledTimes(1);
    const call = recordSkipMock.mock.calls[0]?.[0] as { reason: string; detail?: string };
    expect(call.reason).toBe('processing_error');
    expect(call.detail).toContain('user_credits_non_negative');
    expect(state.writtenCursors).toEqual(['pt-21']);
  });

  it('A4-110 missing credit row records a missing_credit_row skip and continues', async () => {
    const { LoopAssetMissingCreditRowError } = await vi.importActual<typeof TransitionsModule>(
      '../../orders/transitions.js',
    );
    loopAssetsState.assets = [{ code: 'USDLOOP', issuer: 'GISSUER' }];
    const payment = usdcPayment('memo-loop', '10.0000000', 'pt-30');
    payment.asset_code = 'USDLOOP';
    payment.asset_issuer = 'GISSUER';
    listPaymentsMock.mockResolvedValue({ records: [payment], nextCursor: null });
    findOrderMock.mockResolvedValue(makeOrder({ paymentMethod: 'loop_asset' }));
    markPaidMock.mockRejectedValue(new LoopAssetMissingCreditRowError('order-1', 'user-1', 'USD'));

    const result = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    expect(result.skippedAmount).toBe(1);
    expect(result.errors).toBe(0);
    expect((recordSkipMock.mock.calls[0]?.[0] as { reason: string }).reason).toBe(
      'missing_credit_row',
    );
    expect(state.writtenCursors).toEqual(['pt-30']);
  });

  it('recordSkip failure aborts the tick before the cursor write (skip must not be lost)', async () => {
    listPaymentsMock.mockResolvedValue({
      records: [usdcPayment('memo-1', '1.0000000', 'pt-40')],
      nextCursor: null,
    });
    findOrderMock.mockResolvedValue(makeOrder());
    recordSkipMock.mockRejectedValue(new Error('db down'));

    await expect(
      runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' }),
    ).rejects.toThrow('db down');
    expect(state.writtenCursors).toEqual([]);
  });

  it('sweep recoveries count into paid + skipsRecovered', async () => {
    retrySkipsMock.mockResolvedValue({ retried: 3, resolved: 2, abandoned: 1, stillPending: 0 });
    listPaymentsMock.mockResolvedValue({ records: [], nextCursor: null });

    const result = await runPaymentWatcherTick({ account: ACCOUNT, usdcIssuer: 'GCENTRE' });

    expect(result.skipsRecovered).toBe(2);
    expect(result.paid).toBe(2);
  });
});
