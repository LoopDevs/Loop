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
    if (s === 'SABCDEF') return { publicKey: () => 'GOPERATOR' };
    // ADR 044: channel-account tests use distinct secrets (e.g.
    // 'SCHANNEL1') and need a distinct derived pubkey per secret so
    // assertions can tell "loaded the channel" from "loaded the
    // funding account" apart. Every pre-existing test only ever uses
    // 'SABCDEF' or 'invalid', so this branch is additive.
    return { publicKey: () => `G${s}` };
  });
  const assetCtorMock = vi.fn();
  const txBuilderMock = vi.fn();
  // ADR 044: records every `tx.sign(keypair)` call (by the keypair's
  // derived pubkey) so channel-account tests can assert BOTH the
  // channel and funding keypairs signed — Stellar requires a
  // signature from every distinct `source` referenced (tx-level +
  // any op-level override).
  const signMock = vi.fn<(pubkey: string) => void>();

  return {
    sdkState: state,
    mocks: {
      loadAccountMock,
      submitTransactionMock,
      fromSecretMock,
      assetCtorMock,
      txBuilderMock,
      signMock,
    },
  };
});

vi.mock('@stellar/stellar-sdk', () => {
  class Asset {
    static native(): { _kind: 'native' } {
      return { _kind: 'native' };
    }
    constructor(
      public readonly code: string,
      public readonly issuer: string,
    ) {
      if (code === 'BADASSET') throw new Error('bad asset');
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
        sign: (kp: unknown) => {
          mocks.signMock((kp as { publicKey: () => string }).publicKey());
        },
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
      payment: (arg: unknown) => {
        if ((arg as { destination?: string }).destination === 'GBUILDERFAIL') {
          throw new Error('bad payment op');
        }
        return { _kind: 'payment', arg };
      },
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

import {
  submitPayout,
  submitNativePayment,
  submitPreSignedTransaction,
  PayoutSubmitError,
  type PreSignedSubmitArgs,
} from '../payout-submit.js';

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

const BASE_NATIVE_ARGS = {
  secret: 'SABCDEF',
  horizonUrl: 'https://horizon.example',
  networkPassphrase: 'PUBLIC_NETWORK',
  intent: {
    to: 'GCTX',
    amount: '0.1198323',
    memoText: 'order-native',
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
  mocks.signMock.mockClear();
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

describe('submitPayout — CF-18 onSigned (persist hash before submit)', () => {
  it('fires onSigned with the deterministic hash BEFORE the network submit', async () => {
    const order: string[] = [];
    mocks.submitTransactionMock.mockImplementationOnce(async (tx: unknown) => {
      order.push('submit');
      sdkState.submittedTxs.push(tx);
      return sdkState.submitResult;
    });
    const onSigned = vi.fn(async (hash: string) => {
      order.push(`onSigned:${hash}`);
    });
    await submitPayout({ ...BASE_ARGS, onSigned });
    // onSigned ran first, with the client-computed (deterministic) hash.
    expect(onSigned).toHaveBeenCalledWith('client-computed-hash');
    expect(order).toEqual(['onSigned:client-computed-hash', 'submit']);
  });

  it('aborts (terminal_other) without submitting when onSigned throws — the persist failed', async () => {
    const onSigned = vi.fn(async () => {
      throw new Error('row vanished');
    });
    await expect(submitPayout({ ...BASE_ARGS, onSigned })).rejects.toMatchObject({
      kind: 'terminal_other',
    });
    // The network submit must NOT have run — no double-pay.
    expect(mocks.submitTransactionMock).not.toHaveBeenCalled();
  });

  it('is a no-op when onSigned is not provided (legacy callers)', async () => {
    const res = await submitPayout(BASE_ARGS);
    expect(res.txHash).toBe('tx-hash-from-horizon');
    expect(mocks.submitTransactionMock).toHaveBeenCalledTimes(1);
  });
});

describe('submitPayout — ADR 044 channel accounts', () => {
  it('without channelSecret: unchanged from pre-ADR-044 — one sequence source, one signature, no op-level source', async () => {
    await submitPayout(BASE_ARGS);
    // loadAccount ran against the FUNDING account (no channel).
    expect(mocks.loadAccountMock).toHaveBeenCalledWith('GOPERATOR');
    expect(mocks.loadAccountMock).toHaveBeenCalledTimes(1);
    // Exactly one signature — the funding keypair.
    expect(mocks.signMock).toHaveBeenCalledTimes(1);
    expect(mocks.signMock).toHaveBeenCalledWith('GOPERATOR');
    // The Payment op carries no `source` override.
    const tx = sdkState.submittedTxs[0] as {
      _fingerprint?: { ops: Array<{ arg?: { source?: string } }> };
    };
    expect(tx._fingerprint?.ops[0]?.arg?.source).toBeUndefined();
  });

  it('with channelSecret: the CHANNEL is the sequence source (loadAccount + tx-level source)', async () => {
    await submitPayout({ ...BASE_ARGS, channelSecret: 'SCHANNEL1' });
    // loadAccount ran against the CHANNEL account, not the operator.
    expect(mocks.loadAccountMock).toHaveBeenCalledWith('GSCHANNEL1');
    expect(mocks.loadAccountMock).not.toHaveBeenCalledWith('GOPERATOR');
  });

  it('with channelSecret: the Payment op gets an explicit source override naming the FUNDING account', async () => {
    await submitPayout({ ...BASE_ARGS, channelSecret: 'SCHANNEL1' });
    const tx = sdkState.submittedTxs[0] as {
      _fingerprint?: { ops: Array<{ arg?: { source?: string; destination?: string } }> };
    };
    expect(tx._fingerprint?.ops[0]?.arg?.source).toBe('GOPERATOR');
    expect(tx._fingerprint?.ops[0]?.arg?.destination).toBe('GDESTINATION');
  });

  it('with channelSecret: BOTH the channel and funding keypairs sign', async () => {
    await submitPayout({ ...BASE_ARGS, channelSecret: 'SCHANNEL1' });
    expect(mocks.signMock).toHaveBeenCalledTimes(2);
    expect(mocks.signMock).toHaveBeenCalledWith('GSCHANNEL1');
    expect(mocks.signMock).toHaveBeenCalledWith('GOPERATOR');
  });

  it('two different channels load two different sequence sources (per-channel isolation)', async () => {
    await submitPayout({ ...BASE_ARGS, channelSecret: 'SCHANNEL1' });
    await submitPayout({ ...BASE_ARGS, channelSecret: 'SCHANNEL2' });
    expect(mocks.loadAccountMock).toHaveBeenNthCalledWith(1, 'GSCHANNEL1');
    expect(mocks.loadAccountMock).toHaveBeenNthCalledWith(2, 'GSCHANNEL2');
  });

  it('throws terminal_bad_auth when channelSecret is undecodable', async () => {
    await expect(submitPayout({ ...BASE_ARGS, channelSecret: 'invalid' })).rejects.toMatchObject({
      kind: 'terminal_bad_auth',
    });
    // Never reached loadAccount/submit — fails before any network call.
    expect(mocks.loadAccountMock).not.toHaveBeenCalled();
    expect(mocks.submitTransactionMock).not.toHaveBeenCalled();
  });

  it('the deterministic hash still fires onSigned BEFORE the network submit when a channel is used', async () => {
    const order: string[] = [];
    mocks.submitTransactionMock.mockImplementationOnce(async (tx: unknown) => {
      order.push('submit');
      sdkState.submittedTxs.push(tx);
      return sdkState.submitResult;
    });
    const onSigned = vi.fn(async (hash: string) => {
      order.push(`onSigned:${hash}`);
    });
    await submitPayout({ ...BASE_ARGS, channelSecret: 'SCHANNEL1', onSigned });
    expect(order).toEqual(['onSigned:client-computed-hash', 'submit']);
  });
});

describe('submitPayout — keypair + asset errors', () => {
  it('throws terminal_bad_auth when Keypair.fromSecret throws', async () => {
    await expect(submitPayout({ ...BASE_ARGS, secret: 'invalid' })).rejects.toMatchObject({
      kind: 'terminal_bad_auth',
    });
  });

  it('throws terminal_other when the asset code/issuer pair is invalid', async () => {
    await expect(
      submitPayout({
        ...BASE_ARGS,
        intent: { ...BASE_ARGS.intent, assetCode: 'BADASSET' },
      }),
    ).rejects.toMatchObject({
      kind: 'terminal_other',
      message: 'bad asset',
    });
  });
});

describe('submitPayout — transaction build failures', () => {
  it('wraps SDK payment/build failures as terminal_other', async () => {
    await expect(
      submitPayout({
        ...BASE_ARGS,
        intent: { ...BASE_ARGS.intent, to: 'GBUILDERFAIL' },
      }),
    ).rejects.toMatchObject({
      kind: 'terminal_other',
      message: 'bad payment op',
    });
    expect(mocks.submitTransactionMock).not.toHaveBeenCalled();
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

describe('submitNativePayment', () => {
  it('builds and submits a native XLM payment without re-encoding the decimal amount', async () => {
    const res = await submitNativePayment(BASE_NATIVE_ARGS);

    expect(res).toEqual({ txHash: 'tx-hash-from-horizon', ledger: 4242 });
    const tx = sdkState.submittedTxs[0] as {
      _fingerprint?: { ops: Array<{ arg?: { amount?: string; asset?: unknown } }> };
    };
    expect(tx._fingerprint?.ops[0]?.arg?.amount).toBe('0.1198323');
    expect(tx._fingerprint?.ops[0]?.arg?.asset).toEqual({ _kind: 'native' });
  });

  it('uses the signed hash fallback when Horizon omits hash and ledger', async () => {
    sdkState.submitResult = {};
    await expect(submitNativePayment(BASE_NATIVE_ARGS)).resolves.toEqual({
      txHash: 'client-computed-hash',
      ledger: null,
    });
  });

  it('aborts before submit if onSigned cannot persist the signed hash', async () => {
    await expect(
      submitNativePayment({
        ...BASE_NATIVE_ARGS,
        onSigned: async () => {
          throw new Error('persist failed');
        },
      }),
    ).rejects.toMatchObject({
      kind: 'terminal_other',
      message: 'onSigned persist failed: persist failed',
    });
    expect(mocks.submitTransactionMock).not.toHaveBeenCalled();
  });

  it('wraps invalid native submit secrets as terminal_bad_auth', async () => {
    await expect(
      submitNativePayment({ ...BASE_NATIVE_ARGS, secret: 'invalid' }),
    ).rejects.toMatchObject({
      kind: 'terminal_bad_auth',
    });
  });

  it('wraps native loadAccount failures as transient_horizon', async () => {
    sdkState.loadAccountThrow = new Error('horizon down');
    await expect(submitNativePayment(BASE_NATIVE_ARGS)).rejects.toMatchObject({
      kind: 'transient_horizon',
    });
  });

  it('wraps native transaction build failures as terminal_other', async () => {
    await expect(
      submitNativePayment({
        ...BASE_NATIVE_ARGS,
        intent: { ...BASE_NATIVE_ARGS.intent, to: 'GBUILDERFAIL' },
      }),
    ).rejects.toMatchObject({
      kind: 'terminal_other',
      message: 'bad payment op',
    });
  });
});

describe('submitPreSignedTransaction', () => {
  function signedTx(hash = 'pre-signed-hash'): PreSignedSubmitArgs['tx'] {
    return { hash: () => ({ toString: () => hash }) } as unknown as PreSignedSubmitArgs['tx'];
  }

  it('submits a pre-signed transaction and returns Horizon hash + ledger', async () => {
    await expect(
      submitPreSignedTransaction({
        horizonUrl: 'https://horizon.example',
        tx: signedTx(),
      }),
    ).resolves.toEqual({ txHash: 'tx-hash-from-horizon', ledger: 4242 });
  });

  it('uses the transaction hash fallback when Horizon omits hash', async () => {
    sdkState.submitResult = { ledger: 8 };
    await expect(
      submitPreSignedTransaction({
        horizonUrl: 'https://horizon.example',
        tx: signedTx('fallback-pre-signed-hash'),
      }),
    ).resolves.toEqual({ txHash: 'fallback-pre-signed-hash', ledger: 8 });
  });

  it('shares submit-error classification with operator-signed payouts', async () => {
    sdkState.submitThrow = {
      response: {
        status: 400,
        data: {
          extras: { result_codes: { transaction: 'tx_failed', operations: ['op_no_trust'] } },
        },
      },
    };
    await expect(
      submitPreSignedTransaction({
        horizonUrl: 'https://horizon.example',
        tx: signedTx(),
      }),
    ).rejects.toMatchObject({
      kind: 'terminal_no_trust',
    });
  });
});
