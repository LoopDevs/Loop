import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  xdr,
  Address,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';

const OPERATOR_SECRET = Keypair.random().secret();
const OPERATOR_PUBLIC = Keypair.fromSecret(OPERATOR_SECRET).publicKey();
const USER_ADDRESS = Keypair.random().publicKey();
const VAULT_CONTRACT_ID = Address.contract(Buffer.alloc(32, 3)).toString();
const SHARE_CONTRACT_ID = Address.contract(Buffer.alloc(32, 4)).toString();

const {
  mutableEnv,
  vaultsEnabledMock,
  submitMock,
  simulateMock,
  checkPriorMock,
  prepareMock,
  attachSignatureMock,
  submitPreSignedMock,
} = vi.hoisted(() => {
  return {
    mutableEnv: {
      LOOP_VAULTS_ENABLED: true,
      LOOP_STELLAR_HORIZON_URL: 'https://horizon-testnet.stellar.org',
    } as {
      LOOP_VAULTS_ENABLED: boolean;
      LOOP_SOROBAN_RPC_URL?: string;
      LOOP_STELLAR_OPERATOR_SECRET?: string;
      LOOP_STELLAR_HORIZON_URL: string;
    },
    vaultsEnabledMock: vi.fn(() => true),
    submitMock: vi.fn(),
    simulateMock: vi.fn(),
    checkPriorMock: vi.fn(),
    prepareMock: vi.fn(),
    attachSignatureMock: vi.fn(async (_args: unknown) => {}),
    submitPreSignedMock: vi.fn(),
  };
});

vi.mock('../../../env.js', () => ({ env: mutableEnv }));
vi.mock('../registry.js', () => ({ vaultsEnabled: vaultsEnabledMock }));
vi.mock('../soroban-submit.js', () => ({
  submitSorobanInvocation: submitMock,
  simulateSorobanCall: simulateMock,
  checkPriorSorobanTx: checkPriorMock,
  prepareSorobanInvocationForExternalSigning: prepareMock,
  DEFAULT_MAX_ASSEMBLED_FEE_STROOPS: 100_000_000n,
}));
// ADR 031 §D1 (V4) — the provider-signed `transferShares` branch reuses
// `wallet/user-signer.ts` (attach the raw-signed signature) and
// `payments/payout-submit.ts` (submit a pre-built, pre-signed
// fee-bump envelope) rather than building its own signing/submit
// plumbing. Both are fully mocked here — this suite's job is proving
// `vault-client.ts` calls them with the right shape, not re-testing
// their own internals (covered by `wallet/__tests__/user-signer.test.ts`
// and `payments/__tests__/payout-submit.test.ts`).
vi.mock('../../../wallet/user-signer.js', () => ({
  attachUserWalletSignature: attachSignatureMock,
}));
vi.mock('../../../payments/payout-submit.js', () => ({
  submitPreSignedTransaction: submitPreSignedMock,
}));

import {
  depositToVault,
  withdrawFromVault,
  transferShares,
  readVaultState,
  getShareBalance,
  VaultDisabledError,
  VaultSlippageError,
  VaultPostSubmitSlippageError,
  VaultConfigError,
  type DepositToVaultArgs,
  type WithdrawFromVaultArgs,
  type TransferSharesArgs,
} from '../vault-client.js';
import { VaultResultParseError } from '../scval.js';
import type { LoopVaultRow } from '../registry.js';
import type { WalletProvider } from '../../../wallet/provider.js';

/** `onSigned` is required on the money-submit path; a shared no-op keeps calls terse. */
const noopOnSigned = (): void => {};

const VAULT: LoopVaultRow = {
  id: 'vault-1',
  assetCode: 'LOOPUSD',
  vaultContractId: VAULT_CONTRACT_ID,
  shareAssetCode: 'LOOPUSD',
  shareAssetIssuer: SHARE_CONTRACT_ID,
  underlyingAssetCode: 'USDC',
  underlyingAssetIssuer: 'GAUSDC...',
  strategyId: 'blend-usdc-pool',
  network: 'testnet',
  feeBps: 5000,
  active: true,
  createdAt: new Date(),
};

function depositReturn(amountsUsed: bigint[], sharesMinted: bigint): xdr.ScVal {
  return xdr.ScVal.scvVec([
    xdr.ScVal.scvVec(amountsUsed.map((a) => nativeToScVal(a, { type: 'i128' }))),
    nativeToScVal(sharesMinted, { type: 'i128' }),
  ]);
}

beforeEach(() => {
  mutableEnv.LOOP_VAULTS_ENABLED = true;
  mutableEnv.LOOP_SOROBAN_RPC_URL = 'https://rpc.example.test';
  mutableEnv.LOOP_STELLAR_OPERATOR_SECRET = OPERATOR_SECRET;
  mutableEnv.LOOP_STELLAR_HORIZON_URL = 'https://horizon-testnet.stellar.org';
  vaultsEnabledMock.mockReset();
  vaultsEnabledMock.mockReturnValue(true);
  submitMock.mockReset();
  simulateMock.mockReset();
  checkPriorMock.mockReset();
  prepareMock.mockReset();
  attachSignatureMock.mockReset();
  attachSignatureMock.mockResolvedValue(undefined);
  submitPreSignedMock.mockReset();
});

/** Builds a real (unsigned) Transaction with `sourcePublicKey` as its
 * source — stands in for what `prepareSorobanInvocationForExternalSigning`
 * (mocked) would hand back. Needs to be a genuine SDK `Transaction` so
 * `TransactionBuilder.buildFeeBumpTransaction` (a real SDK call inside
 * `transferSharesViaProvider`, not mocked) has something valid to wrap. */
function buildPreparedTx(sourcePublicKey: string): Transaction {
  const account = new Account(sourcePublicKey, '10');
  return new TransactionBuilder(account, { fee: '1000', networkPassphrase: Networks.TESTNET })
    .addOperation(
      Operation.payment({ destination: OPERATOR_PUBLIC, asset: Asset.native(), amount: '1' }),
    )
    .setTimeout(30)
    .build();
}

describe('vaultsEnabled gate', () => {
  it('depositToVault throws VaultDisabledError and never calls submit when the flag is off', async () => {
    vaultsEnabledMock.mockReturnValue(false);
    await expect(
      depositToVault({
        vault: VAULT,
        underlyingAmount: 100n,
        minShares: 1n,
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultDisabledError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('withdrawFromVault throws VaultDisabledError when the flag is off', async () => {
    vaultsEnabledMock.mockReturnValue(false);
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 100n, minAmountsOut: 1n, onSigned: noopOnSigned }),
    ).rejects.toThrow(VaultDisabledError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('transferShares throws VaultDisabledError when the flag is off', async () => {
    vaultsEnabledMock.mockReturnValue(false);
    await expect(
      transferShares({
        vault: VAULT,
        from: OPERATOR_PUBLIC,
        to: USER_ADDRESS,
        amount: 1n,
        signWith: 'operator',
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultDisabledError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('readVaultState throws VaultDisabledError when the flag is off', async () => {
    vaultsEnabledMock.mockReturnValue(false);
    await expect(readVaultState({ vault: VAULT })).rejects.toThrow(VaultDisabledError);
    expect(simulateMock).not.toHaveBeenCalled();
  });
});

describe('depositToVault', () => {
  it('builds deposit([amount], [minShares], operator, true) and parses the (amounts_used, shares_minted) return', async () => {
    submitMock.mockResolvedValue({
      txHash: 'dep-hash',
      returnValue: depositReturn([5_000_000n], 4_800_000n),
      deduped: false,
    });

    const result = await depositToVault({
      vault: VAULT,
      underlyingAmount: 5_000_000n,
      minShares: 4_000_000n,
      onSigned: noopOnSigned,
    });

    expect(result).toEqual({
      txHash: 'dep-hash',
      sharesMinted: 4_800_000n,
      amountsUsed: [5_000_000n],
      deduped: false,
    });

    expect(submitMock).toHaveBeenCalledTimes(1);
    const call = submitMock.mock.calls[0]![0];
    expect(call.rpcUrl).toBe('https://rpc.example.test');
    expect(call.networkPassphrase).toBe(Networks.TESTNET);
    expect(call.signerSecret).toBe(OPERATOR_SECRET);
    expect(call.contractId).toBe(VAULT_CONTRACT_ID);
    expect(call.functionName).toBe('deposit');
    const expectedArgs = [
      xdr.ScVal.scvVec([nativeToScVal(5_000_000n, { type: 'i128' })]),
      xdr.ScVal.scvVec([nativeToScVal(4_000_000n, { type: 'i128' })]),
      new Address(OPERATOR_PUBLIC).toScVal(),
      nativeToScVal(true, { type: 'bool' }),
    ];
    expect(call.args.map((a: xdr.ScVal) => a.toXDR('base64'))).toEqual(
      expectedArgs.map((a) => a.toXDR('base64')),
    );
  });

  it('refuses underlyingAmount <= 0 without calling submit', async () => {
    await expect(
      depositToVault({ vault: VAULT, underlyingAmount: 0n, minShares: 1n, onSigned: noopOnSigned }),
    ).rejects.toThrow(VaultSlippageError);
    await expect(
      depositToVault({
        vault: VAULT,
        underlyingAmount: -1n,
        minShares: 1n,
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses an absent/zero minShares slippage floor without calling submit', async () => {
    const noFloor: DepositToVaultArgs = {
      vault: VAULT,
      underlyingAmount: 100n,
      minShares: 0n,
      onSigned: noopOnSigned,
    };
    await expect(depositToVault(noFloor)).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  // P1-1: the `typeof x !== 'bigint'` guard — a bare `x <= 0n` does NOT
  // fire for `undefined` (`undefined <= 0n` is false), and an undefined
  // amount would reach `nativeToScVal(undefined, {type:'i128'})` →
  // scvVoid → unbounded slippage / void amount silently on-chain. A JS
  // caller (or a value widened through any/unknown) can pass undefined
  // or a number despite the TS types, so the runtime guard is mandatory.
  it('refuses undefined / non-bigint underlyingAmount BEFORE building the tx', async () => {
    await expect(
      depositToVault({
        vault: VAULT,
        minShares: 1n,
        onSigned: noopOnSigned,
      } as unknown as DepositToVaultArgs),
    ).rejects.toThrow(VaultSlippageError); // underlyingAmount undefined
    await expect(
      depositToVault({
        vault: VAULT,
        underlyingAmount: 100 as unknown as bigint, // a JS number, not bigint
        minShares: 1n,
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses undefined / non-bigint minShares floor BEFORE building the tx', async () => {
    await expect(
      depositToVault({
        vault: VAULT,
        underlyingAmount: 100n,
        onSigned: noopOnSigned,
      } as unknown as DepositToVaultArgs),
    ).rejects.toThrow(VaultSlippageError); // minShares undefined
    await expect(
      depositToVault({
        vault: VAULT,
        underlyingAmount: 100n,
        minShares: 1 as unknown as bigint,
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('POST-submit: chain-returned shares below the floor throw VaultPostSubmitSlippageError carrying the landed txHash', async () => {
    submitMock.mockResolvedValue({
      txHash: 'landed-dep-hash',
      returnValue: depositReturn([5_000_000n], 999n), // way below the floor
      deduped: false,
    });
    const err = await depositToVault({
      vault: VAULT,
      underlyingAmount: 5_000_000n,
      minShares: 4_000_000n,
      onSigned: noopOnSigned,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultPostSubmitSlippageError);
    expect((err as VaultPostSubmitSlippageError).txHash).toBe('landed-dep-hash');
  });

  it('propagates CF-18 fields through to submitSorobanInvocation', async () => {
    submitMock.mockResolvedValue({
      txHash: 'dep-hash',
      returnValue: depositReturn([1n], 1n),
      deduped: true,
    });
    const onSigned = vi.fn();
    await depositToVault({
      vault: VAULT,
      underlyingAmount: 1n,
      minShares: 1n,
      priorTxHash: 'prior-hash',
      onSigned,
    });
    const call = submitMock.mock.calls[0]![0];
    expect(call.priorTxHash).toBe('prior-hash');
    expect(call.onSigned).toBe(onSigned);
  });
});

describe('withdrawFromVault', () => {
  it('builds withdraw(shares, [minAmountsOut], operator) and parses a bare Vec<i128> return', async () => {
    submitMock.mockResolvedValue({
      txHash: 'wd-hash',
      returnValue: xdr.ScVal.scvVec([nativeToScVal(2_000_000n, { type: 'i128' })]),
      deduped: false,
    });

    const result = await withdrawFromVault({
      vault: VAULT,
      shares: 1_000_000n,
      minAmountsOut: 1_500_000n,
      onSigned: noopOnSigned,
    });

    expect(result).toEqual({ txHash: 'wd-hash', amountsOut: [2_000_000n], deduped: false });

    const call = submitMock.mock.calls[0]![0];
    expect(call.functionName).toBe('withdraw');
    expect(call.contractId).toBe(VAULT_CONTRACT_ID);
    const expectedArgs = [
      nativeToScVal(1_000_000n, { type: 'i128' }),
      xdr.ScVal.scvVec([nativeToScVal(1_500_000n, { type: 'i128' })]),
      new Address(OPERATOR_PUBLIC).toScVal(),
    ];
    expect(call.args.map((a: xdr.ScVal) => a.toXDR('base64'))).toEqual(
      expectedArgs.map((a) => a.toXDR('base64')),
    );
  });

  it('also parses a tuple-wrapped Vec<i128> return (first element is itself a Vec)', async () => {
    submitMock.mockResolvedValue({
      txHash: 'wd-hash',
      returnValue: xdr.ScVal.scvVec([
        xdr.ScVal.scvVec([nativeToScVal(3_000_000n, { type: 'i128' })]),
      ]),
      deduped: false,
    });
    const result = await withdrawFromVault({
      vault: VAULT,
      shares: 1n,
      minAmountsOut: 1n,
      onSigned: noopOnSigned,
    });
    expect(result.amountsOut).toEqual([3_000_000n]);
  });

  // P1-2: an empty amounts-out vec must THROW (VaultResultParseError),
  // not be treated as "released nothing but succeeded" — that would run
  // the slippage loop zero times and desync the mirror against burned
  // shares.
  it('throws VaultResultParseError on an empty amounts-out return (never silent success)', async () => {
    submitMock.mockResolvedValue({
      txHash: 'wd-hash',
      returnValue: xdr.ScVal.scvVec([]), // empty
      deduped: false,
    });
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 1n, minAmountsOut: 1n, onSigned: noopOnSigned }),
    ).rejects.toThrow(VaultResultParseError);
  });

  it('refuses shares <= 0 or an absent/zero minAmountsOut floor without calling submit', async () => {
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 0n, minAmountsOut: 1n, onSigned: noopOnSigned }),
    ).rejects.toThrow(VaultSlippageError);
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 1n, minAmountsOut: 0n, onSigned: noopOnSigned }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses undefined / non-bigint shares or minAmountsOut BEFORE building the tx (P1-1)', async () => {
    await expect(
      withdrawFromVault({
        vault: VAULT,
        minAmountsOut: 1n,
        onSigned: noopOnSigned,
      } as unknown as WithdrawFromVaultArgs),
    ).rejects.toThrow(VaultSlippageError); // shares undefined
    await expect(
      withdrawFromVault({
        vault: VAULT,
        shares: 1n,
        onSigned: noopOnSigned,
      } as unknown as WithdrawFromVaultArgs),
    ).rejects.toThrow(VaultSlippageError); // minAmountsOut undefined
    await expect(
      withdrawFromVault({
        vault: VAULT,
        shares: 1n,
        minAmountsOut: 100 as unknown as bigint, // number, not bigint
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('POST-submit: a chain-returned amount below the floor throws VaultPostSubmitSlippageError carrying the landed txHash', async () => {
    submitMock.mockResolvedValue({
      txHash: 'landed-wd-hash',
      returnValue: xdr.ScVal.scvVec([nativeToScVal(1n, { type: 'i128' })]),
      deduped: false,
    });
    const err = await withdrawFromVault({
      vault: VAULT,
      shares: 1n,
      minAmountsOut: 1_000_000n,
      onSigned: noopOnSigned,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultPostSubmitSlippageError);
    expect((err as VaultPostSubmitSlippageError).txHash).toBe('landed-wd-hash');
  });
});

describe('transferShares', () => {
  it("signWith='operator' invokes transfer(from, to, amount) on the share-token contract", async () => {
    submitMock.mockResolvedValue({ txHash: 'tr-hash', deduped: false });

    const result = await transferShares({
      vault: VAULT,
      from: OPERATOR_PUBLIC,
      to: USER_ADDRESS,
      amount: 250_000n,
      signWith: 'operator',
      onSigned: noopOnSigned,
    });

    expect(result).toEqual({ txHash: 'tr-hash', deduped: false });
    const call = submitMock.mock.calls[0]![0];
    expect(call.contractId).toBe(SHARE_CONTRACT_ID);
    expect(call.functionName).toBe('transfer');
    const expectedArgs = [
      new Address(OPERATOR_PUBLIC).toScVal(),
      new Address(USER_ADDRESS).toScVal(),
      nativeToScVal(250_000n, { type: 'i128' }),
    ];
    expect(call.args.map((a: xdr.ScVal) => a.toXDR('base64'))).toEqual(
      expectedArgs.map((a) => a.toXDR('base64')),
    );
  });

  // ADR 031 §D1 (V4) — the ONE user-wallet-signed call in the whole
  // vault system. `signWith: 'provider'` used to be a V2 stub that
  // threw `VaultNotImplementedError`; this PR implements the real
  // `transferSharesViaProvider` path (build -> CF-18 persist -> user
  // signs via the wallet provider -> operator fee-bumps -> submit
  // through the existing Horizon rails), mirroring
  // `orders/redeem.ts`'s classic-asset redemption shape.
  describe("signWith='provider' (transferSharesViaProvider)", () => {
    it('throws VaultConfigError when userWallet is not supplied, without preparing/submitting anything', async () => {
      await expect(
        transferShares({
          vault: VAULT,
          from: USER_ADDRESS,
          to: OPERATOR_PUBLIC,
          amount: 1n,
          signWith: 'provider',
          onSigned: noopOnSigned,
        }),
      ).rejects.toThrow(VaultConfigError);
      expect(prepareMock).not.toHaveBeenCalled();
      expect(attachSignatureMock).not.toHaveBeenCalled();
      expect(submitPreSignedMock).not.toHaveBeenCalled();
    });

    it('a landed priorTxHash short-circuits (CF-18 dedup) without preparing, signing, or submitting again', async () => {
      checkPriorMock.mockResolvedValue({ landed: true, returnValue: null });
      const fakeProvider: WalletProvider = {
        name: 'privy',
        createWallet: vi.fn(),
        rawSign: vi.fn(),
      };

      const result = await transferShares({
        vault: VAULT,
        from: USER_ADDRESS,
        to: OPERATOR_PUBLIC,
        amount: 250_000n,
        signWith: 'provider',
        userWallet: { provider: fakeProvider, walletId: 'wallet-1' },
        priorTxHash: 'prior-hash',
        onSigned: noopOnSigned,
      });

      expect(result).toEqual({ txHash: 'prior-hash', deduped: true });
      expect(checkPriorMock).toHaveBeenCalledWith('https://rpc.example.test', 'prior-hash');
      expect(prepareMock).not.toHaveBeenCalled();
      expect(attachSignatureMock).not.toHaveBeenCalled();
      expect(submitPreSignedMock).not.toHaveBeenCalled();
    });

    it('a NOT-landed priorTxHash falls through to building a fresh transaction', async () => {
      checkPriorMock.mockResolvedValue({ landed: false, returnValue: null });
      const preparedTx = buildPreparedTx(USER_ADDRESS);
      prepareMock.mockResolvedValue({ tx: preparedTx });
      submitPreSignedMock.mockResolvedValue({ txHash: 'fresh-hash', ledger: 1 });
      const fakeProvider: WalletProvider = {
        name: 'privy',
        createWallet: vi.fn(),
        rawSign: vi.fn(),
      };

      const result = await transferShares({
        vault: VAULT,
        from: USER_ADDRESS,
        to: OPERATOR_PUBLIC,
        amount: 1n,
        signWith: 'provider',
        userWallet: { provider: fakeProvider, walletId: 'wallet-1' },
        priorTxHash: 'stale-hash',
        onSigned: noopOnSigned,
      });

      expect(result).toEqual({ txHash: 'fresh-hash', deduped: false });
      expect(prepareMock).toHaveBeenCalledTimes(1);
    });

    it('builds, persists the CF-18 hash via onSigned BEFORE requesting the user signature, signs, fee-bumps with the operator, and submits', async () => {
      const preparedTx = buildPreparedTx(USER_ADDRESS);
      prepareMock.mockResolvedValue({ tx: preparedTx });

      const callOrder: string[] = [];
      const onSigned = vi.fn(async () => {
        callOrder.push('onSigned');
      });
      attachSignatureMock.mockImplementation(async () => {
        callOrder.push('attach');
      });
      submitPreSignedMock.mockImplementation(async () => {
        callOrder.push('submit');
        return { txHash: 'landed-hash', ledger: 42 };
      });
      const fakeProvider: WalletProvider = {
        name: 'privy',
        createWallet: vi.fn(),
        rawSign: vi.fn(),
      };

      const result = await transferShares({
        vault: VAULT,
        from: USER_ADDRESS,
        to: OPERATOR_PUBLIC,
        amount: 250_000n,
        signWith: 'provider',
        userWallet: { provider: fakeProvider, walletId: 'wallet-1' },
        onSigned,
      });

      expect(result).toEqual({ txHash: 'landed-hash', deduped: false });
      expect(callOrder).toEqual(['onSigned', 'attach', 'submit']);

      // CF-18: onSigned received the tx's own deterministic hash —
      // computed BEFORE signing, not after.
      expect(onSigned).toHaveBeenCalledWith(preparedTx.hash().toString('hex'));

      const prepareArgs = prepareMock.mock.calls[0]![0] as {
        sourcePublicKey: string;
        contractId: string;
        functionName: string;
      };
      expect(prepareArgs.sourcePublicKey).toBe(USER_ADDRESS);
      expect(prepareArgs.contractId).toBe(SHARE_CONTRACT_ID);
      expect(prepareArgs.functionName).toBe('transfer');

      const attachArgs = attachSignatureMock.mock.calls[0]![0] as {
        provider: WalletProvider;
        walletId: string;
        address: string;
        tx: Transaction;
      };
      expect(attachArgs.provider).toBe(fakeProvider);
      expect(attachArgs.walletId).toBe('wallet-1');
      expect(attachArgs.address).toBe(USER_ADDRESS);
      expect(attachArgs.tx).toBe(preparedTx);

      const submitArgs = submitPreSignedMock.mock.calls[0]![0] as {
        horizonUrl: string;
        tx: FeeBumpTransaction;
      };
      expect(submitArgs.horizonUrl).toBe('https://horizon-testnet.stellar.org');
      // Fee-bumped by the OPERATOR, wrapping the EXACT prepared inner tx.
      expect(submitArgs.tx.feeSource).toBe(OPERATOR_PUBLIC);
      expect(submitArgs.tx.innerTransaction.hash().toString('hex')).toBe(
        preparedTx.hash().toString('hex'),
      );
    });
  });

  it('refuses amount <= 0 without calling submit', async () => {
    await expect(
      transferShares({
        vault: VAULT,
        from: OPERATOR_PUBLIC,
        to: USER_ADDRESS,
        amount: 0n,
        signWith: 'operator',
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses undefined / non-bigint amount BEFORE building the tx (P1-1)', async () => {
    await expect(
      transferShares({
        vault: VAULT,
        from: OPERATOR_PUBLIC,
        to: USER_ADDRESS,
        signWith: 'operator',
        onSigned: noopOnSigned,
      } as unknown as TransferSharesArgs),
    ).rejects.toThrow(VaultSlippageError); // amount undefined
    await expect(
      transferShares({
        vault: VAULT,
        from: OPERATOR_PUBLIC,
        to: USER_ADDRESS,
        amount: 250 as unknown as bigint, // number, not bigint
        signWith: 'operator',
        onSigned: noopOnSigned,
      }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });
});

describe('readVaultState', () => {
  it('computes sharePricePpm from total_supply / fetch_total_managed_funds (non-1.0 price)', async () => {
    simulateMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === 'total_supply') {
        return nativeToScVal(2_000_000n, { type: 'i128' });
      }
      if (args.functionName === 'fetch_total_managed_funds') {
        return nativeToScVal([{ asset: 'CUNDERLYING', total_amount: '2100000' }]);
      }
      throw new Error(`unexpected function ${args.functionName}`);
    });

    const state = await readVaultState({ vault: VAULT });

    expect(state.totalSupply).toBe(2_000_000n);
    expect(state.totalManaged).toBe(2_100_000n);
    expect(state.sharePricePpm).toBe(1_050_000n); // 1.05 underlying per share
  });

  it('defaults sharePricePpm to 1_000_000n (1:1) for a fresh vault with zero supply', async () => {
    simulateMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === 'total_supply') return nativeToScVal(0n, { type: 'i128' });
      return nativeToScVal(0n, { type: 'i128' });
    });

    const state = await readVaultState({ vault: VAULT });

    expect(state.totalSupply).toBe(0n);
    expect(state.sharePricePpm).toBe(1_000_000n);
  });

  it('sums multiple managed-funds entries defensively', async () => {
    simulateMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === 'total_supply') return nativeToScVal(1_000_000n, { type: 'i128' });
      return nativeToScVal([
        { asset: 'A', total_amount: '600000' },
        { asset: 'B', total_amount: '500000' },
      ]);
    });
    const state = await readVaultState({ vault: VAULT });
    expect(state.totalManaged).toBe(1_100_000n);
    expect(state.sharePricePpm).toBe(1_100_000n);
  });

  // P1-3: an empty managed-funds vec must THROW, not sum to 0n — with a
  // real total_supply that would collapse sharePricePpm to 0 (the
  // `totalSupply === 0n` fast-path does NOT cover a populated supply +
  // empty managed-funds read). Closes the asymmetry where a wrongly-
  // NAMED field already threw but an empty vec silently yielded 0.
  it('throws VaultResultParseError when fetch_total_managed_funds returns an empty vec', async () => {
    simulateMock.mockImplementation(async (args: { functionName: string }) => {
      if (args.functionName === 'total_supply') return nativeToScVal(2_000_000n, { type: 'i128' });
      return nativeToScVal([]); // empty managed-funds
    });
    await expect(readVaultState({ vault: VAULT })).rejects.toThrow(VaultResultParseError);
  });
});

describe('getShareBalance', () => {
  it('reads SEP-41 balance(address) on the share-token contract', async () => {
    simulateMock.mockImplementation(async (args: { functionName: string; contractId: string }) => {
      expect(args.functionName).toBe('balance');
      expect(args.contractId).toBe(SHARE_CONTRACT_ID);
      return nativeToScVal(4_200_000n, { type: 'i128' });
    });
    const balance = await getShareBalance({ vault: VAULT, address: USER_ADDRESS });
    expect(balance).toBe(4_200_000n);
  });

  it('throws VaultDisabledError when the flag is off', async () => {
    vaultsEnabledMock.mockReturnValueOnce(false);
    await expect(getShareBalance({ vault: VAULT, address: USER_ADDRESS })).rejects.toThrow(
      VaultDisabledError,
    );
  });
});
