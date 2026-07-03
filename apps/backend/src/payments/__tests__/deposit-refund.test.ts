import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const { mocks } = vi.hoisted(() => ({
  mocks: {
    loadRow: vi.fn(),
    // Result of an `update().set().where().returning()` — drives the
    // CAS claim (non-empty array = claim won).
    claimReturn: (): unknown[] => [] as unknown[],
    markRefunded: vi.fn(),
    releaseClaim: vi.fn(),
    persistHash: vi.fn(),
    submitPayout: vi.fn(),
    submitNative: vi.fn(),
    findByMemo: vi.fn(),
    getByTxHash: vi.fn(),
    resolveConfig: vi.fn(),
  },
}));

// Mock the DB layer via a tiny query-builder stub keyed on which
// operation runs. We drive loadSkip/claim/mark/release through the
// mock functions by intercepting `db.select`/`db.update`.
vi.mock('../../db/client.js', () => {
  const update = (): unknown => ({
    set: (): unknown => ({
      where: (..._a: unknown[]): unknown => ({
        returning: (): unknown => mocks.claimReturn(),
      }),
    }),
  });
  return {
    db: {
      select: (): unknown => ({ from: (): unknown => ({ where: (): unknown => mocks.loadRow() }) }),
      update,
    },
  };
});
vi.mock('../../db/schema.js', () => ({ paymentWatcherSkips: {} }));
vi.mock('../payout-submit.js', () => ({
  submitPayout: (a: unknown) => mocks.submitPayout(a),
  submitNativePayment: (a: unknown) => mocks.submitNative(a),
  PayoutSubmitError: class extends Error {
    kind: string;
    constructor(message: string, kind = 'terminal_other') {
      super(message);
      this.kind = kind;
    }
  },
}));
vi.mock('../horizon-find-outbound.js', () => ({
  findOutboundPaymentByMemo: (a: unknown) => mocks.findByMemo(a),
  getOutboundPaymentByTxHash: (h: string) => mocks.getByTxHash(h),
}));
vi.mock('../payout-worker.js', () => ({
  resolvePayoutConfig: () => mocks.resolveConfig(),
}));

import { refundDeposit, refundIntentFromPayment } from '../deposit-refund.js';
// The mocked PayoutSubmitError (kind is constructor-settable above), so
// `err instanceof PayoutSubmitError` in the source matches these.
import { PayoutSubmitError } from '../payout-submit.js';

// Because the db mock returns the same builder for every update, we
// route the specific update results via a single `claimReturn` hook and
// assert on submit calls instead. For clarity the tests set loadRow +
// claimReturn per case.

const NATIVE_PAYMENT = {
  id: 'op-1',
  paging_token: 'pt',
  type: 'payment',
  from: 'GSENDER',
  to: 'GDEPOSIT',
  asset_type: 'native',
  amount: '12.5000000',
  transaction_hash: 'txin',
  transaction_successful: true,
  transaction: { successful: true },
};
const USDC_PAYMENT = {
  ...NATIVE_PAYMENT,
  asset_type: 'credit_alphanum4',
  asset_code: 'USDC',
  asset_issuer: 'GISSUER',
};

const CFG = {
  operatorSecret: 'SOPERATOR',
  operatorAccount: 'GOPERATOR',
  horizonUrl: 'https://horizon',
  networkPassphrase: 'Test',
};

beforeEach(() => {
  Object.values(mocks).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset?.());
  mocks.claimReturn = () => [{ paymentId: 'op-1' }]; // claim wins by default
  mocks.resolveConfig.mockReturnValue(CFG);
  mocks.submitPayout.mockResolvedValue({ txHash: 'txout', ledger: 1 });
  mocks.submitNative.mockResolvedValue({ txHash: 'txout', ledger: 1 });
  mocks.findByMemo.mockResolvedValue(null); // no prior refund landed, by default
  mocks.getByTxHash.mockResolvedValue(null); // persisted hash didn't land, by default
});

describe('refundIntentFromPayment', () => {
  it('derives a native (XLM) refund intent', () => {
    const r = refundIntentFromPayment(NATIVE_PAYMENT);
    expect(r).toMatchObject({ to: 'GSENDER', isNative: true, assetCode: 'XLM' });
  });
  it('derives a credit-asset refund intent', () => {
    const r = refundIntentFromPayment(USDC_PAYMENT);
    expect(r).toMatchObject({
      to: 'GSENDER',
      isNative: false,
      assetCode: 'USDC',
      assetIssuer: 'GISSUER',
    });
  });
  it('rejects a payment with no sender', () => {
    expect(refundIntentFromPayment({ ...NATIVE_PAYMENT, from: undefined })).toBe(
      'no sender address on the deposit',
    );
  });
  it('rejects a non-payment op', () => {
    expect(typeof refundIntentFromPayment({ ...NATIVE_PAYMENT, type: 'create_account' })).toBe(
      'string',
    );
  });
  it('rejects a non-native asset missing issuer', () => {
    expect(typeof refundIntentFromPayment({ ...USDC_PAYMENT, asset_issuer: undefined })).toBe(
      'string',
    );
  });
});

const OLD = new Date('2020-01-01T00:00:00Z');
const row = (over: Record<string, unknown> = {}): unknown => ({
  paymentId: 'op-1',
  status: 'abandoned',
  refundTxHash: null,
  payment: NATIVE_PAYMENT,
  updatedAt: OLD,
  ...over,
});

// A rejected submit that is DEFINITIVELY not landed (safe to release).
const terminalError = (): Error =>
  new (PayoutSubmitError as unknown as new (m: string, k: string) => Error)(
    'underfunded',
    'terminal_underfunded',
  );
// The ambiguous kind — response lost, might have landed.
const transientHorizonError = (): Error =>
  new (PayoutSubmitError as unknown as new (m: string, k: string) => Error)(
    'response lost',
    'transient_horizon',
  );

describe('refundDeposit', () => {
  it('returns not_found when the skip row is absent', async () => {
    mocks.loadRow.mockResolvedValue([]);
    expect((await refundDeposit('op-1')).kind).toBe('not_found');
  });

  it('replays already_refunded without submitting or scanning', async () => {
    mocks.loadRow.mockResolvedValue([row({ status: 'refunded', refundTxHash: 'prior' })]);
    const r = await refundDeposit('op-1');
    expect(r).toEqual({ kind: 'already_refunded', txHash: 'prior' });
    expect(mocks.submitNative).not.toHaveBeenCalled();
  });

  it('refunds an abandoned native deposit via submitNativePayment', async () => {
    mocks.loadRow.mockResolvedValue([row()]);
    const r = await refundDeposit('op-1');
    expect(r).toEqual({ kind: 'refunded', txHash: 'txout' });
    expect(mocks.submitNative).toHaveBeenCalledOnce();
    expect(mocks.submitPayout).not.toHaveBeenCalled();
  });

  it('refunds an abandoned USDC deposit via submitPayout', async () => {
    mocks.loadRow.mockResolvedValue([row({ payment: USDC_PAYMENT })]);
    const r = await refundDeposit('op-1');
    expect(r).toEqual({ kind: 'refunded', txHash: 'txout' });
    expect(mocks.submitPayout).toHaveBeenCalledOnce();
  });

  // ── money-review P0: the double-pay guard ───────────────────────────
  it('P0: converges to already_refunded WITHOUT submitting when the memo pre-check finds a prior landed refund', async () => {
    mocks.loadRow.mockResolvedValue([row()]); // status still abandoned...
    mocks.findByMemo.mockResolvedValue({
      txHash: 'landed-earlier',
      amount: '12.5',
      assetCode: null,
    });
    const r = await refundDeposit('op-1');
    expect(r).toEqual({ kind: 'already_refunded', txHash: 'landed-earlier' });
    // The critical assertion: NO second payment is sent.
    expect(mocks.submitNative).not.toHaveBeenCalled();
    expect(mocks.submitPayout).not.toHaveBeenCalled();
  });

  it('P1: converges via the WINDOWLESS hash lookup (persisted refundTxHash) without the memo scan', async () => {
    // A prior lost-response attempt persisted the hash; the tx landed.
    // The hash lookup must catch it even if the memo scan would miss it
    // (window scroll under volume).
    mocks.loadRow.mockResolvedValue([row({ refundTxHash: 'H1' })]);
    mocks.getByTxHash.mockResolvedValue({ landed: true });
    mocks.findByMemo.mockResolvedValue(null); // memo scan would MISS it
    const r = await refundDeposit('op-1');
    expect(r).toEqual({ kind: 'already_refunded', txHash: 'H1' });
    expect(mocks.getByTxHash).toHaveBeenCalledWith('H1');
    expect(mocks.submitNative).not.toHaveBeenCalled();
  });

  it('P0: fails CLOSED (in_progress, no submit) when the pre-check Horizon read fails', async () => {
    mocks.loadRow.mockResolvedValue([row()]);
    mocks.findByMemo.mockRejectedValue(new Error('horizon 500'));
    const r = await refundDeposit('op-1');
    expect(r.kind).toBe('in_progress');
    expect(mocks.submitNative).not.toHaveBeenCalled();
  });

  it('returns not_refundable when the operator signer is unconfigured (never claims)', async () => {
    mocks.loadRow.mockResolvedValue([row()]);
    mocks.resolveConfig.mockReturnValue(null);
    const r = await refundDeposit('op-1');
    expect(r.kind).toBe('not_refundable');
    expect(mocks.findByMemo).not.toHaveBeenCalled();
    expect(mocks.submitNative).not.toHaveBeenCalled();
  });

  it('rejects a dust deposit below the refund floor', async () => {
    mocks.loadRow.mockResolvedValue([row({ payment: { ...NATIVE_PAYMENT, amount: '0.0000010' } })]);
    const r = await refundDeposit('op-1');
    expect(r.kind).toBe('not_refundable');
    expect(mocks.submitNative).not.toHaveBeenCalled();
  });

  it('returns in_progress when it loses the claim race', async () => {
    mocks.loadRow.mockResolvedValue([row()]);
    mocks.claimReturn = () => []; // another caller already claimed
    const r = await refundDeposit('op-1');
    expect(r.kind).toBe('in_progress');
    expect(mocks.submitNative).not.toHaveBeenCalled();
  });

  it('releases + submit_failed on a DEFINITIVELY-rejected submit (never landed)', async () => {
    mocks.loadRow.mockResolvedValue([row()]);
    mocks.submitNative.mockRejectedValue(terminalError());
    const r = await refundDeposit('op-1');
    expect(r.kind).toBe('submit_failed');
  });

  it('P0: HOLDS in refunding (in_progress) on an ambiguous transient_horizon error — does NOT release/retry', async () => {
    mocks.loadRow.mockResolvedValue([row()]);
    mocks.submitNative.mockRejectedValue(transientHorizonError());
    // The post-error re-scan doesn't (yet) see it.
    const r = await refundDeposit('op-1');
    expect(r.kind).toBe('in_progress');
  });

  it('converges to refunded when a submit error is followed by the tx appearing in the memo scan', async () => {
    mocks.loadRow.mockResolvedValue([row()]);
    mocks.submitNative.mockRejectedValue(transientHorizonError());
    // pre-check null (first call), post-error re-scan finds it.
    mocks.findByMemo.mockResolvedValueOnce(null).mockResolvedValueOnce({
      txHash: 'actually-landed',
      amount: '12.5',
      assetCode: null,
    });
    const r = await refundDeposit('op-1');
    expect(r).toEqual({ kind: 'refunded', txHash: 'actually-landed' });
  });

  it('does NOT re-claim a FRESH refunding row (recent prior attempt)', async () => {
    mocks.loadRow.mockResolvedValue([row({ status: 'refunding', updatedAt: new Date() })]);
    mocks.claimReturn = () => []; // WHERE (abandoned OR stale-refunding) matches nothing
    const r = await refundDeposit('op-1');
    expect(r.kind).toBe('in_progress');
    expect(mocks.submitNative).not.toHaveBeenCalled();
  });
});
