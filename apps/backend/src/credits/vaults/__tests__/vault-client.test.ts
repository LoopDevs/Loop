import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Networks, nativeToScVal, xdr, Address } from '@stellar/stellar-sdk';

const OPERATOR_SECRET = Keypair.random().secret();
const OPERATOR_PUBLIC = Keypair.fromSecret(OPERATOR_SECRET).publicKey();
const USER_ADDRESS = Keypair.random().publicKey();
const VAULT_CONTRACT_ID = Address.contract(Buffer.alloc(32, 3)).toString();
const SHARE_CONTRACT_ID = Address.contract(Buffer.alloc(32, 4)).toString();

const { mutableEnv, vaultsEnabledMock, submitMock, simulateMock } = vi.hoisted(() => {
  return {
    mutableEnv: { LOOP_VAULTS_ENABLED: true } as {
      LOOP_VAULTS_ENABLED: boolean;
      LOOP_SOROBAN_RPC_URL?: string;
      LOOP_STELLAR_OPERATOR_SECRET?: string;
    },
    vaultsEnabledMock: vi.fn(() => true),
    submitMock: vi.fn(),
    simulateMock: vi.fn(),
  };
});

vi.mock('../../../env.js', () => ({ env: mutableEnv }));
vi.mock('../registry.js', () => ({ vaultsEnabled: vaultsEnabledMock }));
vi.mock('../soroban-submit.js', () => ({
  submitSorobanInvocation: submitMock,
  simulateSorobanCall: simulateMock,
}));

import {
  depositToVault,
  withdrawFromVault,
  transferShares,
  readVaultState,
  VaultDisabledError,
  VaultSlippageError,
  VaultNotImplementedError,
  type DepositToVaultArgs,
} from '../vault-client.js';
import type { LoopVaultRow } from '../registry.js';

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
  vaultsEnabledMock.mockReset();
  vaultsEnabledMock.mockReturnValue(true);
  submitMock.mockReset();
  simulateMock.mockReset();
});

describe('vaultsEnabled gate', () => {
  it('depositToVault throws VaultDisabledError and never calls submit when the flag is off', async () => {
    vaultsEnabledMock.mockReturnValue(false);
    await expect(
      depositToVault({ vault: VAULT, underlyingAmount: 100n, minShares: 1n }),
    ).rejects.toThrow(VaultDisabledError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('withdrawFromVault throws VaultDisabledError when the flag is off', async () => {
    vaultsEnabledMock.mockReturnValue(false);
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 100n, minAmountsOut: 1n }),
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
      depositToVault({ vault: VAULT, underlyingAmount: 0n, minShares: 1n }),
    ).rejects.toThrow(VaultSlippageError);
    await expect(
      depositToVault({ vault: VAULT, underlyingAmount: -1n, minShares: 1n }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses an absent/zero minShares slippage floor without calling submit', async () => {
    const noFloor = { vault: VAULT, underlyingAmount: 100n, minShares: 0n } as DepositToVaultArgs;
    await expect(depositToVault(noFloor)).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses when the chain-returned shares fall below the caller-supplied minShares floor', async () => {
    submitMock.mockResolvedValue({
      txHash: 'dep-hash',
      returnValue: depositReturn([5_000_000n], 999n), // way below the floor
      deduped: false,
    });
    await expect(
      depositToVault({ vault: VAULT, underlyingAmount: 5_000_000n, minShares: 4_000_000n }),
    ).rejects.toThrow(VaultSlippageError);
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
    const result = await withdrawFromVault({ vault: VAULT, shares: 1n, minAmountsOut: 1n });
    expect(result.amountsOut).toEqual([3_000_000n]);
  });

  it('refuses shares <= 0 or an absent/zero minAmountsOut floor without calling submit', async () => {
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 0n, minAmountsOut: 1n }),
    ).rejects.toThrow(VaultSlippageError);
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 1n, minAmountsOut: 0n }),
    ).rejects.toThrow(VaultSlippageError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses when the chain-returned amount falls below minAmountsOut', async () => {
    submitMock.mockResolvedValue({
      txHash: 'wd-hash',
      returnValue: xdr.ScVal.scvVec([nativeToScVal(1n, { type: 'i128' })]),
      deduped: false,
    });
    await expect(
      withdrawFromVault({ vault: VAULT, shares: 1n, minAmountsOut: 1_000_000n }),
    ).rejects.toThrow(VaultSlippageError);
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

  it("signWith='provider' throws VaultNotImplementedError (V4 stub) without calling submit", async () => {
    await expect(
      transferShares({
        vault: VAULT,
        from: USER_ADDRESS,
        to: OPERATOR_PUBLIC,
        amount: 1n,
        signWith: 'provider',
      }),
    ).rejects.toThrow(VaultNotImplementedError);
    expect(submitMock).not.toHaveBeenCalled();
  });

  it('refuses amount <= 0 without calling submit', async () => {
    await expect(
      transferShares({
        vault: VAULT,
        from: OPERATOR_PUBLIC,
        to: USER_ADDRESS,
        amount: 0n,
        signWith: 'operator',
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
});
