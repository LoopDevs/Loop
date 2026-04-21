import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as SchemaModule from '../../db/schema.js';

const { dbMock, state } = vi.hoisted(() => {
  const s: {
    config: unknown;
    insertedRow: unknown;
    insertValues: unknown[];
  } = { config: undefined, insertedRow: null, insertValues: [] };
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  m['insert'] = vi.fn(() => m);
  m['values'] = vi.fn((v: unknown) => {
    s.insertValues.push(v);
    return m;
  });
  m['returning'] = vi.fn(async () => [s.insertedRow]);
  return { dbMock: m, state: s };
});

vi.mock('../../db/client.js', () => ({
  db: {
    insert: dbMock['insert'],
    query: {
      merchantCashbackConfigs: {
        findFirst: vi.fn(async () => state.config),
      },
    },
  },
}));
vi.mock('../../db/schema.js', async () => {
  const actual = await vi.importActual<typeof SchemaModule>('../../db/schema.js');
  return {
    ...actual,
    orders: {
      userId: 'userId',
      merchantId: 'merchantId',
      faceValueMinor: 'faceValueMinor',
      currency: 'currency',
      paymentMethod: 'paymentMethod',
      paymentMemo: 'paymentMemo',
    },
    merchantCashbackConfigs: {
      merchantId: 'merchantId',
    },
  };
});

import { computeCashbackSplit, createOrder, generatePaymentMemo } from '../repo.js';

beforeEach(() => {
  state.config = undefined;
  state.insertedRow = null;
  state.insertValues = [];
  for (const fn of Object.values(dbMock)) {
    if (typeof fn === 'function' && 'mockClear' in fn) {
      (fn as unknown as { mockClear: () => void }).mockClear();
    }
  }
});

describe('computeCashbackSplit', () => {
  it('falls back to 100% wholesale / 0% cashback / 0% margin when no config exists', async () => {
    const split = await computeCashbackSplit({
      merchantId: 'no-config',
      faceValueMinor: 10_000n,
    });
    expect(split.wholesaleMinor).toBe(10_000n);
    expect(split.userCashbackMinor).toBe(0n);
    expect(split.loopMarginMinor).toBe(0n);
    expect(split.wholesalePct).toBe('100.00');
  });

  it('falls back to the zero split when config.active = false', async () => {
    state.config = {
      merchantId: 'paused',
      wholesalePct: '80.00',
      userCashbackPct: '15.00',
      loopMarginPct: '5.00',
      active: false,
    };
    const split = await computeCashbackSplit({
      merchantId: 'paused',
      faceValueMinor: 10_000n,
    });
    expect(split.wholesaleMinor).toBe(10_000n);
    expect(split.userCashbackMinor).toBe(0n);
    expect(split.loopMarginMinor).toBe(0n);
  });

  it('splits according to the active config pcts', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '85.00',
      userCashbackPct: '10.00',
      loopMarginPct: '5.00',
      active: true,
    };
    // face = £100.00 = 10,000 pence
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 10_000n,
    });
    expect(split.userCashbackMinor).toBe(1_000n); // 10%
    expect(split.loopMarginMinor).toBe(500n); // 5%
    expect(split.wholesaleMinor).toBe(8_500n); // residual
    expect(split.wholesaleMinor + split.userCashbackMinor + split.loopMarginMinor).toBe(10_000n);
  });

  it('handles fractional pcts (7.50% cashback on £100.00 → 750p)', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '90.00',
      userCashbackPct: '7.50',
      loopMarginPct: '2.50',
      active: true,
    };
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 10_000n,
    });
    expect(split.userCashbackMinor).toBe(750n);
    expect(split.loopMarginMinor).toBe(250n);
    expect(split.wholesaleMinor).toBe(9_000n);
  });

  it('floors user cashback (rounding residual goes to wholesale, never to the user)', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '90.00',
      userCashbackPct: '7.33',
      loopMarginPct: '2.67',
      active: true,
    };
    // 7.33% of 999p = 73.23p → floor to 73p
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 999n,
    });
    expect(split.userCashbackMinor).toBe(73n);
    // 2.67% of 999p = 26.67p → floor to 26p
    expect(split.loopMarginMinor).toBe(26n);
    // wholesale picks up the residual
    expect(split.wholesaleMinor).toBe(999n - 73n - 26n);
    // total reconciles to face value
    expect(split.wholesaleMinor + split.userCashbackMinor + split.loopMarginMinor).toBe(999n);
  });

  it('passes the merchant pcts through verbatim onto the order row', async () => {
    state.config = {
      merchantId: 'm1',
      wholesalePct: '72.50',
      userCashbackPct: '22.50',
      loopMarginPct: '5.00',
      active: true,
    };
    const split = await computeCashbackSplit({
      merchantId: 'm1',
      faceValueMinor: 10_000n,
    });
    expect(split.wholesalePct).toBe('72.50');
    expect(split.userCashbackPct).toBe('22.50');
    expect(split.loopMarginPct).toBe('5.00');
  });
});

describe('generatePaymentMemo', () => {
  it('emits a 20-char base32 string', () => {
    for (let i = 0; i < 50; i++) {
      const m = generatePaymentMemo();
      expect(m).toMatch(/^[A-Z2-7]{20}$/);
    }
  });

  it('is (practically) unique across many calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generatePaymentMemo());
    // 100 bits of entropy — collision across 200 is effectively impossible.
    expect(seen.size).toBe(200);
  });
});

describe('createOrder', () => {
  beforeEach(() => {
    state.insertedRow = {
      id: 'order-uuid',
      userId: 'u-1',
      merchantId: 'm1',
      state: 'pending_payment',
    };
    state.config = {
      merchantId: 'm1',
      wholesalePct: '85.00',
      userCashbackPct: '10.00',
      loopMarginPct: '5.00',
      active: true,
    };
  });

  it('inserts with the pinned pcts + amounts from the active config', async () => {
    const row = await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'xlm',
    });
    expect(row.id).toBe('order-uuid');
    const values = state.insertValues[0] as Record<string, unknown>;
    expect(values['userId']).toBe('u-1');
    expect(values['merchantId']).toBe('m1');
    expect(values['faceValueMinor']).toBe(10_000n);
    expect(values['currency']).toBe('GBP');
    expect(values['paymentMethod']).toBe('xlm');
    expect(values['wholesalePct']).toBe('85.00');
    expect(values['userCashbackPct']).toBe('10.00');
    expect(values['loopMarginPct']).toBe('5.00');
    expect(values['wholesaleMinor']).toBe(8_500n);
    expect(values['userCashbackMinor']).toBe(1_000n);
    expect(values['loopMarginMinor']).toBe(500n);
    // xlm / usdc orders get a generated memo
    expect(typeof values['paymentMemo']).toBe('string');
    expect((values['paymentMemo'] as string).length).toBe(20);
  });

  it('leaves payment_memo null for credit-funded orders', async () => {
    await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'credit',
    });
    const values = state.insertValues[0] as Record<string, unknown>;
    expect(values['paymentMemo']).toBeNull();
  });

  it('honours an explicit paymentMemo override (for tests / replays)', async () => {
    await createOrder({
      userId: 'u-1',
      merchantId: 'm1',
      faceValueMinor: 10_000n,
      currency: 'GBP',
      paymentMethod: 'xlm',
      paymentMemo: 'FIXED-MEMO-12345',
    });
    const values = state.insertValues[0] as Record<string, unknown>;
    expect(values['paymentMemo']).toBe('FIXED-MEMO-12345');
  });

  it('throws when the insert returns no row', async () => {
    state.insertedRow = undefined;
    await expect(
      createOrder({
        userId: 'u-1',
        merchantId: 'm1',
        faceValueMinor: 10_000n,
        currency: 'GBP',
        paymentMethod: 'xlm',
      }),
    ).rejects.toThrow(/no row returned/);
  });
});
