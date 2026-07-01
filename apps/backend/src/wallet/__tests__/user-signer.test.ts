import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  Account,
  Asset,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';

/**
 * User-signer roundtrip tests (ADR 030 Phase B).
 *
 * The crucial property under test: the hex → base64 → decorated-
 * signature plumbing is correct end-to-end, proven with a REAL local
 * ed25519 keypair standing in for Privy — the mock `rawSign` signs
 * the hash with the keypair's secret, and the assertions verify the
 * attached signature with the keypair's public key. Zero network,
 * zero SDK mocking on the signature path.
 */

// Only `submitPreSignedTransaction` is stubbed — Horizon submission
// is payout-submit's concern and is covered by its own suite.
import type * as PayoutSubmitModule from '../../payments/payout-submit.js';
const { submitMock } = vi.hoisted(() => ({
  submitMock: vi.fn(async (_args: unknown) => ({ txHash: 'deadbeef', ledger: 123 })),
}));
vi.mock('../../payments/payout-submit.js', async () => {
  const actual = await vi.importActual<typeof PayoutSubmitModule>(
    '../../payments/payout-submit.js',
  );
  return { ...actual, submitPreSignedTransaction: submitMock };
});

import { attachUserWalletSignature, signAndSubmitUserTransaction } from '../user-signer.js';
import { WalletProviderError, type WalletProvider } from '../provider.js';

const userKeypair = Keypair.random();
const DESTINATION = Keypair.random().publicKey();
const WALLET_ID = 'clxyzwallet0000privy';

function buildTx(): Transaction {
  // Sequence is per-Transaction state — build a fresh one per test
  // so signatures from one test can't leak into the next.
  const account = new Account(userKeypair.publicKey(), '0');
  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({ destination: DESTINATION, asset: Asset.native(), amount: '1' }),
    )
    .setTimeout(60)
    .build();
}

/** A provider whose rawSign is the real keypair — Privy stand-in. */
function realSigningProvider(
  transform: (signatureHex: string) => string = (s) => s,
): WalletProvider {
  return {
    name: 'privy',
    createWallet: vi.fn(),
    rawSign: vi.fn(async (_walletId: string, hashHex: string) => {
      const signature = userKeypair.sign(Buffer.from(hashHex, 'hex'));
      return transform(signature.toString('hex'));
    }),
  };
}

beforeEach(() => {
  submitMock.mockClear();
});

describe('attachUserWalletSignature', () => {
  it('attaches a valid decorated signature the wallet public key verifies', async () => {
    const tx = buildTx();
    const provider = realSigningProvider();
    expect(tx.signatures).toHaveLength(0);

    await attachUserWalletSignature({
      provider,
      walletId: WALLET_ID,
      address: userKeypair.publicKey(),
      tx,
    });

    expect(provider.rawSign).toHaveBeenCalledWith(WALLET_ID, tx.hash().toString('hex'));
    expect(tx.signatures).toHaveLength(1);
    const decorated = tx.signatures[0]!;
    // Hint must be the wallet key's hint — proves addSignature
    // accepted our base64 conversion against the right account.
    expect(decorated.hint().equals(userKeypair.signatureHint())).toBe(true);
    // And the raw signature bytes verify against the tx hash.
    expect(userKeypair.verify(tx.hash(), decorated.signature())).toBe(true);
  });

  it('accepts a 0x-prefixed signature from the provider', async () => {
    const tx = buildTx();
    await attachUserWalletSignature({
      provider: realSigningProvider((hex) => `0x${hex}`),
      walletId: WALLET_ID,
      address: userKeypair.publicKey(),
      tx,
    });
    expect(tx.signatures).toHaveLength(1);
    expect(userKeypair.verify(tx.hash(), tx.signatures[0]!.signature())).toBe(true);
  });

  it('fails loudly BEFORE attaching when the signature is from the wrong key', async () => {
    const tx = buildTx();
    const wrongKeypair = Keypair.random();
    const provider: WalletProvider = {
      name: 'privy',
      createWallet: vi.fn(),
      rawSign: vi.fn(async (_walletId: string, hashHex: string) =>
        wrongKeypair.sign(Buffer.from(hashHex, 'hex')).toString('hex'),
      ),
    };

    await expect(
      attachUserWalletSignature({
        provider,
        walletId: WALLET_ID,
        address: userKeypair.publicKey(),
        tx,
      }),
    ).rejects.toMatchObject({
      name: 'WalletProviderError',
      kind: 'terminal_provider',
    });
    // The bad material never reached the transaction.
    expect(tx.signatures).toHaveLength(0);
  });

  it('rejects malformed (non-128-hex) signature material without attaching', async () => {
    const tx = buildTx();
    await expect(
      attachUserWalletSignature({
        provider: realSigningProvider(() => 'zz'.repeat(64)),
        walletId: WALLET_ID,
        address: userKeypair.publicKey(),
        tx,
      }),
    ).rejects.toBeInstanceOf(WalletProviderError);
    expect(tx.signatures).toHaveLength(0);
  });

  it('rejects a wrong-length signature without attaching', async () => {
    const tx = buildTx();
    await expect(
      attachUserWalletSignature({
        provider: realSigningProvider((hex) => hex.slice(0, 64)),
        walletId: WALLET_ID,
        address: userKeypair.publicKey(),
        tx,
      }),
    ).rejects.toBeInstanceOf(WalletProviderError);
    expect(tx.signatures).toHaveLength(0);
  });
});

describe('signAndSubmitUserTransaction', () => {
  it('signs, then hands the signed tx to the existing submit machinery', async () => {
    const tx = buildTx();
    const result = await signAndSubmitUserTransaction({
      provider: realSigningProvider(),
      walletId: WALLET_ID,
      address: userKeypair.publicKey(),
      tx,
      horizonUrl: 'https://horizon-testnet.stellar.org',
    });

    expect(result).toEqual({ txHash: 'deadbeef', ledger: 123 });
    expect(submitMock).toHaveBeenCalledTimes(1);
    const submitArgs = submitMock.mock.calls[0]?.[0] as unknown as {
      horizonUrl: string;
      tx: Transaction;
    };
    expect(submitArgs.horizonUrl).toBe('https://horizon-testnet.stellar.org');
    // The tx reached the submit path already carrying the verified
    // user signature.
    expect(submitArgs.tx.signatures).toHaveLength(1);
    expect(userKeypair.verify(submitArgs.tx.hash(), submitArgs.tx.signatures[0]!.signature())).toBe(
      true,
    );
  });

  it('does not submit when signing fails', async () => {
    const tx = buildTx();
    await expect(
      signAndSubmitUserTransaction({
        provider: realSigningProvider(() => 'ab'.repeat(10)),
        walletId: WALLET_ID,
        address: userKeypair.publicKey(),
        tx,
        horizonUrl: 'https://horizon-testnet.stellar.org',
      }),
    ).rejects.toBeInstanceOf(WalletProviderError);
    expect(submitMock).not.toHaveBeenCalled();
  });
});
