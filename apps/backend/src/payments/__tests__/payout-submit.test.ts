import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * SDK mock — vi.hoisted so the mock factory below can reference
 * the spies. The fixtures cover the slice of the SDK that
 * payout-submit actually uses:
 *   - Keypair.fromSecret
 *   - Asset constructor
 *   - Horizon.Server#loadAccount + submitTransaction
 *   - Memo.text
 *   - Operation.payment
 *   - TransactionBuilder chain
 */
const { sdkState, mocks } = vi.hoisted(() => {
  const state: {
    loadAccountResult: unknown;
    loadAccountThrow: Error | null;
    submitResult: unknown;
    submitThrow: unknown;
    submittedTxs: unknown[];
  } = {
    loadAccountResult: { accountId: 'GOP', sequenceNumber: () => '100' },
    loadAccountThrow: null,
    submitResult: { hash: 'tx-hash-from-horizon', ledger: 4242 },
    submitThrow: null,
    submittedTxs: [],
  };

  const loadAccountMock = vi.fn(async () => {
    if (state.loadAccountThrow !== null) throw state.loadAccountThrow;
    return state.loadAccountResult;
  });
  const submitTransactionMock = vi.fn(async (tx: unknown) => {
    state.submittedTxs.push(tx);
    if (state.submitThrow !== null) throw state.submitThrow;
    return state.submitResult;
  });
  const fromSecretMock = vi.fn((s: string) => {
    if (s === 'invalid') throw new Error('bad secret');
    return { publicKey: () => 'GOPERATOR' };
  });
  const assetCtorMock = vi.fn();
  const txBuilderMock = vi.fn();

  return {
    sdkState: state,
    mocks: { loadAccountMock, submitTransactionMock, fromSecretMock, assetCtorMock, txBuilderMock },
  };
});

vi.mock('@stellar/stellar-sdk', () => {
  class Asset {
    constructor(
      public readonly code: string,
      public readonly issuer: string,
    ) {
      mocks.assetCtorMock(code, issuer);
    }
  }
  class TransactionBuilder {
    private ops: unknown[] = [];
    private memoVal: unknown = null;
    private timeoutVal = 0;
    constructor(
      public account: unknown,
      public opts: { fee: string; networkPassphrase: string },
    ) {
      mocks.txBuilderMock(account, opts);
    }
    addOperation(op: unknown): this {
      this.ops.push(op);
      return this;
    }
    addMemo(m: unknown): this {
      this.memoVal = m;
      return this;
    }
    setTimeout(t: number): this {
      this.timeoutVal = t;
      return this;
    }
    build(): { sign: (_kp: unknown) => void; hash: () => { toString: () => string } } {
      const fingerprint = {
        ops: this.ops,
        memo: this.memoVal,
        timeout: this.timeoutVal,
        fee: this.opts.fee,
      };
      return {
        sign: (_kp: unknown) => undefined,
        hash: () => ({ toString: () => 'client-computed-hash' }),
        _fingerprint: fingerprint,
      } as unknown as { sign: (k: unknown) => void; hash: () => { toString: () => string } };
    }
  }
  return {
    Asset,
    TransactionBuilder,
    BASE_FEE: '100',
    Keypair: {
      fromSecret: (s: string) => mocks.fromSecretMock(s),
    },
    Memo: {
      text: (s: string) => ({ _kind: 'memoText', value: s }),
    },
    Networks: {
      PUBLIC: 'PUBLIC_NETWORK',
      TESTNET: 'TESTNET_NETWORK',
    },
    Operation: {
      payment: (arg: unknown) => ({ _kind: 'payment', arg }),
    },
    Horizon: {
      Server: class {
        constructor(public horizonUrl: string) {}
        loadAccount = mocks.loadAccountMock;
        submitTransaction = mocks.submitTransactionMock;
      },
    },
  };
});

import { submitPayout, PayoutSubmitError } from '../payout-submit.js';

const BASE_ARGS = {
  secret: 'SABCDEF',
  horizonUrl: 'https://horizon.example',
  networkPassphrase: 'PUBLIC_NETWORK',
  intent: {
    to: 'GDESTINATION',
    assetCode: 'GBPLOOP',
    assetIssuer: 'GISSUER',
    amountStroops: 50_000_000n,
    memoText: 'order-abc',
  },
};

beforeEach(() => {
  sdkState.loadAccountResult = { accountId: 'GOP', sequenceNumber: () => '100' };
  sdkState.loadAccountThrow = null;
  sdkState.submitResult = { hash: 'tx-hash-from-horizon', ledger: 4242 };
  sdkState.submitThrow = null;
  sdkState.submittedTxs = [];
  mocks.loadAccountMock.mockClear();
  mocks.submitTransactionMock.mockClear();
  mocks.fromSecretMock.mockClear();
  mocks.assetCtorMock.mockClear();
  mocks.txBuilderMock.mockClear();
});

describe('submitPayout — happy path', () => {
  it('builds + submits + returns the Horizon-confirmed hash + ledger', async () => {
    const res = await submitPayout(BASE_ARGS);
    expect(res).toEqual({ txHash: 'tx-hash-from-horizon', ledger: 4242 });
    // loadAccount ran against the operator pubkey.
    expect(mocks.loadAccountMock).toHaveBeenCalledWith('GOPERATOR');
    // Asset built with the right pair.
    expect(mocks.assetCtorMock).toHaveBeenCalledWith('GBPLOOP', 'GISSUER');
    // TransactionBuilder got the network passphrase + default fee.
    expect(mocks.txBuilderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fee: '100', networkPassphrase: 'PUBLIC_NETWORK' }),
    );
  });

  it('converts 50_000_000 stroops to "5.0000000" amount for the Payment op', async () => {
    await submitPayout(BASE_ARGS);
    const tx = sdkState.submittedTxs[0] as {
      _fingerprint?: { ops: Array<{ arg?: { amount?: string } }> };
    };
    expect(tx._fingerprint?.ops[0]?.arg?.amount).toBe('5.0000000');
  });

  it('honours custom timeoutSeconds + feeStroops overrides', async () => {
    await submitPayout({ ...BASE_ARGS, timeoutSeconds: 30, feeStroops: '500' });
    expect(mocks.txBuilderMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fee: '500' }),
    );
    const tx = sdkState.submittedTxs[0] as { _fingerprint?: { timeout: number } };
    expect(tx._fingerprint?.timeout).toBe(30);
  });

  it('falls back to a client-computed hash when Horizon omits hash', async () => {
    sdkState.submitResult = { ledger: 1 }; // no hash
    const res = await submitPayout(BASE_ARGS);
    expect(res.txHash).toBe('client-computed-hash');
  });
});

describe('submitPayout — keypair + asset errors', () => {
  it('throws terminal_bad_auth when Keypair.fromSecret throws', async () => {
    await expect(submitPayout({ ...BASE_ARGS, secret: 'invalid' })).rejects.toMatchObject({
      kind: 'terminal_bad_auth',
    });
  });
});

describe('submitPayout — loadAccount failures', () => {
  it('wraps a network error from loadAccount as transient_horizon', async () => {
    sdkState.loadAccountThrow = new Error('ECONNREFUSED');
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'transient_horizon',
    });
  });
});

describe('submitPayout — Horizon submit classifications', () => {
  function horizonError(
    status: number,
    transaction?: string,
    operations?: string[],
  ): { response: { status: number; data: unknown } } {
    return {
      response: {
        status,
        data: {
          extras: {
            result_codes: {
              ...(transaction !== undefined ? { transaction } : {}),
              ...(operations !== undefined ? { operations } : {}),
            },
          },
        },
      },
    };
  }

  it('classifies Horizon 5xx as transient_horizon', async () => {
    sdkState.submitThrow = horizonError(502);
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'transient_horizon',
    });
  });

  it('classifies tx_bad_seq as transient_rebuild', async () => {
    sdkState.submitThrow = horizonError(400, 'tx_bad_seq');
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'transient_rebuild',
    });
  });

  it('classifies tx_too_late as transient_rebuild', async () => {
    sdkState.submitThrow = horizonError(400, 'tx_too_late');
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'transient_rebuild',
    });
  });

  it('classifies tx_insufficient_fee as transient_rebuild', async () => {
    sdkState.submitThrow = horizonError(400, 'tx_insufficient_fee');
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'transient_rebuild',
    });
  });

  it('classifies tx_bad_auth as terminal_bad_auth', async () => {
    sdkState.submitThrow = horizonError(400, 'tx_bad_auth');
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'terminal_bad_auth',
    });
  });

  it('classifies op_no_trust as terminal_no_trust', async () => {
    sdkState.submitThrow = horizonError(400, 'tx_failed', ['op_no_trust']);
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'terminal_no_trust',
    });
  });

  it('classifies op_underfunded as terminal_underfunded', async () => {
    sdkState.submitThrow = horizonError(400, 'tx_failed', ['op_underfunded']);
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'terminal_underfunded',
    });
  });

  it('falls back to terminal_other for unclassified Horizon errors', async () => {
    sdkState.submitThrow = horizonError(400, 'something_unknown');
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'terminal_other',
    });
  });

  it('wraps a throw without a Horizon response as transient_horizon', async () => {
    sdkState.submitThrow = new Error('socket hang up');
    await expect(submitPayout(BASE_ARGS)).rejects.toMatchObject({
      kind: 'transient_horizon',
    });
  });

  it('preserves result_codes on the thrown PayoutSubmitError for debugging', async () => {
    sdkState.submitThrow = horizonError(400, 'tx_failed', ['op_no_trust']);
    try {
      await submitPayout(BASE_ARGS);
      expect.fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PayoutSubmitError);
      const e = err as PayoutSubmitError;
      expect(e.resultCodes?.operations).toEqual(['op_no_trust']);
    }
  });
});
