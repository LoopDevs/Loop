import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as StellarSdkModule from '@stellar/stellar-sdk';

/**
 * Mocks ONLY the Soroban RPC network surface (`rpc.Server`'s
 * getAccount/simulateTransaction/sendTransaction/getTransaction/
 * pollTransaction, plus `rpc.assembleTransaction` — which needs real
 * Soroban resource-fee data we don't want to fake, so it's replaced
 * with a pass-through). Everything else — `Contract`, `Address`,
 * `TransactionBuilder`, `Keypair`, `nativeToScVal`/`scValToNative`,
 * `xdr`, `rpc.Api`'s pure helpers/enum — stays REAL, so the
 * verify-before-sign pass inside `submitSorobanInvocation` (shared
 * with `scval.test.ts`) exercises actual XDR encode/decode, matching
 * "mock the Soroban RPC — NO real network, like the payout tests mock
 * Horizon" (the payout tests mock Horizon's network calls, not the
 * SDK's tx-building primitives).
 */
const { rpcState, MockServer } = vi.hoisted(() => {
  const state: {
    accountSequence: string;
    getAccountThrow: Error | null;
    simulateResult: unknown;
    simulateThrow: Error | null;
    sendResult: unknown;
    sendThrow: Error | null;
    getTransactionResults: Map<string, unknown>;
    getTransactionThrow: Error | null;
    pollResult: unknown;
    pollThrow: Error | null;
    calls: {
      getAccount: string[];
      simulateTransaction: unknown[];
      sendTransaction: unknown[];
      getTransaction: string[];
      pollTransaction: string[];
    };
  } = {
    accountSequence: '100',
    getAccountThrow: null,
    simulateResult: null,
    simulateThrow: null,
    sendResult: { status: 'PENDING' },
    sendThrow: null,
    getTransactionResults: new Map(),
    getTransactionThrow: null,
    pollResult: null,
    pollThrow: null,
    calls: {
      getAccount: [],
      simulateTransaction: [],
      sendTransaction: [],
      getTransaction: [],
      pollTransaction: [],
    },
  };

  class FakeAccount {
    constructor(
      private id: string,
      private seq: string,
    ) {}
    accountId(): string {
      return this.id;
    }
    sequenceNumber(): string {
      return this.seq;
    }
    incrementSequenceNumber(): void {
      this.seq = (BigInt(this.seq) + 1n).toString();
    }
  }

  class MockServer {
    constructor(public url: string) {}
    async getAccount(pubkey: string): Promise<FakeAccount> {
      state.calls.getAccount.push(pubkey);
      if (state.getAccountThrow !== null) throw state.getAccountThrow;
      return new FakeAccount(pubkey, state.accountSequence);
    }
    async simulateTransaction(tx: unknown): Promise<unknown> {
      state.calls.simulateTransaction.push(tx);
      if (state.simulateThrow !== null) throw state.simulateThrow;
      return state.simulateResult;
    }
    async sendTransaction(tx: unknown): Promise<unknown> {
      state.calls.sendTransaction.push(tx);
      if (state.sendThrow !== null) throw state.sendThrow;
      return state.sendResult;
    }
    async getTransaction(hash: string): Promise<unknown> {
      state.calls.getTransaction.push(hash);
      if (state.getTransactionThrow !== null) throw state.getTransactionThrow;
      return state.getTransactionResults.get(hash) ?? { status: 'NOT_FOUND' };
    }
    async pollTransaction(hash: string): Promise<unknown> {
      state.calls.pollTransaction.push(hash);
      if (state.pollThrow !== null) throw state.pollThrow;
      return state.pollResult;
    }
  }

  return { rpcState: state, MockServer };
});

vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof StellarSdkModule>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: MockServer,
      // Real assembleTransaction needs genuine Soroban resource data
      // (footprint, resource fee) in the simulation response, which
      // this test suite has no reason to fake faithfully — the
      // pass-through preserves the built tx's operations unchanged,
      // which is all verify-before-sign / signing / hashing care about.
      assembleTransaction: (tx: unknown) => ({ build: () => tx }),
    },
  };
});

import { Address, Keypair, nativeToScVal, xdr, rpc, type Transaction } from '@stellar/stellar-sdk';
import {
  submitSorobanInvocation,
  SorobanSubmitError,
  simulateSorobanCall,
} from '../soroban-submit.js';

const CONTRACT_ID = Address.contract(Buffer.alloc(32, 7)).toString();
const SIGNER_SECRET = Keypair.random().secret();
const SIGNER_PUBLIC = Keypair.fromSecret(SIGNER_SECRET).publicKey();
const SC_ARGS = [nativeToScVal(5_000_000n, { type: 'i128' }), nativeToScVal(1n, { type: 'i128' })];

function successSim(retval: xdr.ScVal): unknown {
  return {
    id: 'sim-1',
    latestLedger: 100,
    events: [],
    _parsed: true,
    transactionData: {},
    minResourceFee: '100',
    result: { auth: [], retval },
  };
}

function errorSim(message: string): unknown {
  return { id: 'sim-err', latestLedger: 100, events: [], _parsed: true, error: message };
}

function successTx(hash: string, retval: xdr.ScVal): unknown {
  return { status: rpc.Api.GetTransactionStatus.SUCCESS, txHash: hash, returnValue: retval };
}

beforeEach(() => {
  rpcState.accountSequence = '100';
  rpcState.getAccountThrow = null;
  rpcState.simulateResult = successSim(xdr.ScVal.scvVoid());
  rpcState.simulateThrow = null;
  rpcState.sendResult = { status: 'PENDING' };
  rpcState.sendThrow = null;
  rpcState.getTransactionResults = new Map();
  rpcState.getTransactionThrow = null;
  rpcState.pollResult = null;
  rpcState.pollThrow = null;
  rpcState.calls = {
    getAccount: [],
    simulateTransaction: [],
    sendTransaction: [],
    getTransaction: [],
    pollTransaction: [],
  };
});

const baseArgs = {
  rpcUrl: 'https://rpc.example.test',
  networkPassphrase: 'Test SDF Network ; September 2015',
  signerSecret: SIGNER_SECRET,
  contractId: CONTRACT_ID,
  functionName: 'deposit',
  args: SC_ARGS,
};

describe('submitSorobanInvocation — happy path', () => {
  it('builds, verifies, simulates, assembles, signs, sends, and polls to SUCCESS', async () => {
    const retval = nativeToScVal(42n, { type: 'i128' });
    rpcState.simulateResult = successSim(retval);
    rpcState.pollResult = successTx('final-hash', retval);

    const onSigned = vi.fn();
    const result = await submitSorobanInvocation({ ...baseArgs, onSigned });

    expect(result.deduped).toBe(false);
    expect(result.returnValue.toXDR('base64')).toBe(retval.toXDR('base64'));
    expect(rpcState.calls.getAccount).toEqual([SIGNER_PUBLIC]);
    expect(rpcState.calls.simulateTransaction).toHaveLength(1);
    expect(rpcState.calls.sendTransaction).toHaveLength(1);
    expect(rpcState.calls.pollTransaction).toEqual([result.txHash]);

    // CF-18: onSigned fired with the SAME hash returned to the
    // caller. The "fired BEFORE sendTransaction, and a throw aborts
    // the submit" half of the contract is asserted separately below
    // (a throwing onSigned leaves sendTransaction uncalled — the only
    // way that's true is if onSigned runs first).
    expect(onSigned).toHaveBeenCalledWith(result.txHash);
  });

  it('the transaction actually built invokes the exact contract/function/args requested', async () => {
    rpcState.simulateResult = successSim(xdr.ScVal.scvVoid());
    rpcState.pollResult = successTx('h', xdr.ScVal.scvVoid());

    await submitSorobanInvocation(baseArgs);

    const builtTx = rpcState.calls.simulateTransaction[0] as Transaction;
    const op = builtTx.operations[0]!;
    expect(op.type).toBe('invokeHostFunction');
    if (op.type !== 'invokeHostFunction') throw new Error('unreachable');
    const invocation = op.func.invokeContract();
    expect(Address.fromScAddress(invocation.contractAddress()).toString()).toBe(CONTRACT_ID);
    expect(invocation.functionName().toString()).toBe('deposit');
    expect(invocation.args().map((a) => a.toXDR('base64'))).toEqual(
      SC_ARGS.map((a) => a.toXDR('base64')),
    );
  });
});

describe('submitSorobanInvocation — CF-18 at-most-once fence', () => {
  it('a retry with the prior hash short-circuits to the SAME hash without submitting a new tx (never a second deposit)', async () => {
    const retval = nativeToScVal(7n, { type: 'i128' });
    rpcState.simulateResult = successSim(retval);
    rpcState.pollResult = successTx('attempt-1-hash', retval);

    const first = await submitSorobanInvocation(baseArgs);
    expect(first.deduped).toBe(false);
    expect(rpcState.calls.sendTransaction).toHaveLength(1);

    // Simulate what a real caller's retry does: persist the hash from
    // the first attempt, then re-invoke with it as `priorTxHash`. Mark
    // that hash as already landed SUCCESS on-chain.
    rpcState.getTransactionResults.set(first.txHash, successTx(first.txHash, retval));

    const retry = await submitSorobanInvocation({ ...baseArgs, priorTxHash: first.txHash });

    expect(retry.deduped).toBe(true);
    expect(retry.txHash).toBe(first.txHash);
    // The critical assertion: NO second build/simulate/send happened.
    expect(rpcState.calls.sendTransaction).toHaveLength(1);
    expect(rpcState.calls.simulateTransaction).toHaveLength(1);
    expect(rpcState.calls.getAccount).toHaveLength(1);
  });

  it('a priorTxHash that has not landed yet (NOT_FOUND) falls through to a fresh submit', async () => {
    const retval = xdr.ScVal.scvVoid();
    rpcState.simulateResult = successSim(retval);
    rpcState.pollResult = successTx('fresh-hash', retval);
    // getTransactionResults has no entry for 'stale-hash' → NOT_FOUND.

    const result = await submitSorobanInvocation({ ...baseArgs, priorTxHash: 'stale-hash' });

    expect(result.deduped).toBe(false);
    expect(rpcState.calls.getTransaction).toEqual(['stale-hash']);
    expect(rpcState.calls.sendTransaction).toHaveLength(1);
  });

  it('onSigned is called BEFORE sendTransaction, and a thrown onSigned aborts fail-closed (no submit at all)', async () => {
    rpcState.simulateResult = successSim(xdr.ScVal.scvVoid());
    const onSigned = vi.fn(async () => {
      throw new Error('persist failed');
    });

    await expect(submitSorobanInvocation({ ...baseArgs, onSigned })).rejects.toThrow(
      SorobanSubmitError,
    );
    expect(rpcState.calls.sendTransaction).toHaveLength(0);
  });
});

describe('submitSorobanInvocation — error classification', () => {
  it('classifies a simulation error as terminal_contract_error and never sends', async () => {
    rpcState.simulateResult = errorSim('contract reverted');
    await expect(submitSorobanInvocation(baseArgs)).rejects.toMatchObject({
      name: 'SorobanSubmitError',
      kind: 'terminal_contract_error',
    });
    expect(rpcState.calls.sendTransaction).toHaveLength(0);
  });

  it('classifies sendTransaction ERROR status as terminal_send_error', async () => {
    rpcState.simulateResult = successSim(xdr.ScVal.scvVoid());
    rpcState.sendResult = { status: 'ERROR', errorResult: 'boom' };
    await expect(submitSorobanInvocation(baseArgs)).rejects.toMatchObject({
      kind: 'terminal_send_error',
    });
  });

  it('classifies sendTransaction TRY_AGAIN_LATER as transient_retry_later', async () => {
    rpcState.simulateResult = successSim(xdr.ScVal.scvVoid());
    rpcState.sendResult = { status: 'TRY_AGAIN_LATER' };
    await expect(submitSorobanInvocation(baseArgs)).rejects.toMatchObject({
      kind: 'transient_retry_later',
    });
  });

  it('classifies a FAILED poll result as terminal_tx_failed', async () => {
    rpcState.simulateResult = successSim(xdr.ScVal.scvVoid());
    rpcState.pollResult = { status: rpc.Api.GetTransactionStatus.FAILED, txHash: 'h' };
    await expect(submitSorobanInvocation(baseArgs)).rejects.toMatchObject({
      kind: 'terminal_tx_failed',
    });
  });

  it('classifies a NOT_FOUND poll result (polling budget exhausted) as terminal_not_found', async () => {
    rpcState.simulateResult = successSim(xdr.ScVal.scvVoid());
    rpcState.pollResult = { status: rpc.Api.GetTransactionStatus.NOT_FOUND, txHash: 'h' };
    await expect(submitSorobanInvocation(baseArgs)).rejects.toMatchObject({
      kind: 'terminal_not_found',
    });
  });

  it('classifies an invalid signer secret as terminal_bad_auth without any network call', async () => {
    await expect(
      submitSorobanInvocation({ ...baseArgs, signerSecret: 'not-a-real-secret' }),
    ).rejects.toMatchObject({ kind: 'terminal_bad_auth' });
    expect(rpcState.calls.getAccount).toHaveLength(0);
  });

  it('classifies a getAccount network failure as transient_rpc', async () => {
    rpcState.getAccountThrow = new Error('network down');
    await expect(submitSorobanInvocation(baseArgs)).rejects.toMatchObject({
      kind: 'transient_rpc',
    });
  });
});

describe('simulateSorobanCall — read-only, never signs or submits', () => {
  it('returns the simulation retval without touching sendTransaction/getTransaction/pollTransaction', async () => {
    const retval = nativeToScVal(1_050_000n, { type: 'i128' });
    rpcState.simulateResult = successSim(retval);

    const result = await simulateSorobanCall({
      rpcUrl: baseArgs.rpcUrl,
      networkPassphrase: baseArgs.networkPassphrase,
      sourceSecret: SIGNER_SECRET,
      contractId: CONTRACT_ID,
      functionName: 'total_supply',
      args: [],
    });

    expect(result.toXDR('base64')).toBe(retval.toXDR('base64'));
    expect(rpcState.calls.sendTransaction).toHaveLength(0);
    expect(rpcState.calls.getTransaction).toHaveLength(0);
    expect(rpcState.calls.pollTransaction).toHaveLength(0);
  });

  it('propagates a simulation error as terminal_contract_error', async () => {
    rpcState.simulateResult = errorSim('read reverted');
    await expect(
      simulateSorobanCall({
        rpcUrl: baseArgs.rpcUrl,
        networkPassphrase: baseArgs.networkPassphrase,
        sourceSecret: SIGNER_SECRET,
        contractId: CONTRACT_ID,
        functionName: 'total_supply',
        args: [],
      }),
    ).rejects.toMatchObject({ kind: 'terminal_contract_error' });
  });
});
