import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HorizonPayment } from '../horizon.js';
import type * as HorizonModule from '../horizon.js';
import type * as SchemaModule from '../../db/schema.js';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const listPaymentsMock = vi.fn();
const findOrderMock = vi.fn();
const markPaidMock = vi.fn();

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
}));
vi.mock('../../orders/transitions.js', () => ({
  markOrderPaid: (id: string) => markPaidMock(id),
}));

// db mock — covers readCursor (findFirst) and writeCursor (upsert).
const { dbMock, state } = vi.hoisted(() => {
  const s: {
    cursor: string | null;
    writtenCursors: string[];
  } = { cursor: null, writtenCursors: [] };
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
    query: {
      watcherCursors: {
        findFirst: vi.fn(async () =>
          state.cursor === null ? undefined : { cursor: state.cursor },
        ),
      },
    },
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
  paymentMethod: 'xlm' | 'usdc' | 'credit';
  currency: string;
  faceValueMinor: bigint;
}

function makeOrder(overrides: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: 'order-1',
    paymentMethod: 'usdc',
    currency: 'USD',
    faceValueMinor: 1_000n, // $10.00
    ...overrides,
  };
}

beforeEach(() => {
  listPaymentsMock.mockReset();
  findOrderMock.mockReset();
  markPaidMock.mockReset();
  state.cursor = null;
  state.writtenCursors = [];
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
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

  it('accepts a USDC payment against a GBP order via fiat FX', async () => {
    // £10.00 order (1000 pence). Mocked FX: 128_206 stroops/pence.
    // Required: 128_206_000 stroops = 12.8206 USDC. A payment of 13 USDC
    // (130_000_000 stroops) comfortably clears.
    const p = usdcPayment('MEMO', '13.0000000');
    expect(await isAmountSufficient(p, makeOrder({ currency: 'GBP' }) as never)).toBe(true);
  });

  it('rejects a USDC underpayment against a GBP order', async () => {
    // £10.00 order requires ~12.82 USDC. 10 USDC (100_000_000 stroops) falls short.
    const p = usdcPayment('MEMO', '10.0000000');
    expect(await isAmountSufficient(p, makeOrder({ currency: 'GBP' }) as never)).toBe(false);
  });

  it('rejects USDC payment for a currency the FX oracle has no rate for', async () => {
    const p = usdcPayment('MEMO', '100.0000000');
    expect(await isAmountSufficient(p, makeOrder({ currency: 'JPY' }) as never)).toBe(false);
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
        makeOrder({ paymentMethod: 'xlm', currency: 'JPY' }) as never,
      ),
    ).toBe(false);
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
    expect(markPaidMock).toHaveBeenCalledWith('order-1');
    expect(state.writtenCursors).toEqual(['pt-1']);
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
  });

  it('uses nextCursor when the page is empty but Horizon says there is more', async () => {
    listPaymentsMock.mockResolvedValue({ records: [], nextCursor: 'pt-next' });
    await runPaymentWatcherTick({ account: ACCOUNT });
    expect(state.writtenCursors).toEqual(['pt-next']);
  });
});
