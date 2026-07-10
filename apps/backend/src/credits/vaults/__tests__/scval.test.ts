import { describe, it, expect } from 'vitest';
import {
  Address,
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  Networks,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import {
  encodeI128,
  encodeI128Vec,
  encodeAddress,
  encodeBool,
  decodeI128,
  decodeI128Vec,
  decodeVecElements,
  VaultResultParseError,
  assertExpectedInvocation,
  VaultVerifyError,
  buildInvocationOperation,
} from '../scval.js';

/**
 * Real (unmocked) `@stellar/stellar-sdk` — this file exercises the
 * actual ScVal/XDR machinery so the verify-before-sign assertions
 * below are meaningful, not asserting against a hand-rolled fake.
 */

const CONTRACT_A = Address.contract(Buffer.alloc(32, 1)).toString();
const CONTRACT_B = Address.contract(Buffer.alloc(32, 2)).toString();
const SOURCE_SECRET = Keypair.random().secret();
const SOURCE_PUBLIC = Keypair.fromSecret(SOURCE_SECRET).publicKey();
const OTHER_ACCOUNT = Keypair.random().publicKey();

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

function buildTx(contractId: string, functionName: string, args: xdr.ScVal[]): Transaction {
  const account = new FakeAccount(SOURCE_PUBLIC, '100');
  return new TransactionBuilder(account as never, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(buildInvocationOperation(contractId, functionName, args))
    .setTimeout(30)
    .build();
}

describe('encode/decode round trips', () => {
  it('encodeI128 / decodeI128 round-trips a bigint', () => {
    expect(decodeI128(encodeI128(123456789012345n))).toBe(123456789012345n);
    expect(decodeI128(encodeI128(0n))).toBe(0n);
  });

  it('encodeI128Vec / decodeI128Vec round-trips an array of bigint', () => {
    const encoded = encodeI128Vec([1n, 2n, 3n]);
    expect(decodeI128Vec(encoded)).toEqual([1n, 2n, 3n]);
  });

  it('encodeAddress round-trips through Address.fromScVal', () => {
    const encoded = encodeAddress(SOURCE_PUBLIC);
    expect(Address.fromScVal(encoded).toString()).toBe(SOURCE_PUBLIC);
  });

  it('encodeBool produces a bool ScVal', () => {
    const encoded = encodeBool(true);
    expect(encoded.switch().name).toBe('scvBool');
    expect(encoded.b()).toBe(true);
  });

  it('decodeI128 throws VaultResultParseError on a non-i128 ScVal', () => {
    expect(() => decodeI128(encodeBool(true))).toThrow(VaultResultParseError);
  });

  it('decodeVecElements returns raw ScVal elements of a Vec', () => {
    const inner = encodeI128Vec([9n]);
    const scalar = encodeI128(42n);
    const tuple = xdr.ScVal.scvVec([inner, scalar]);
    const elements = decodeVecElements(tuple);
    expect(elements).toHaveLength(2);
    expect(decodeI128Vec(elements[0]!)).toEqual([9n]);
    expect(decodeI128(elements[1]!)).toBe(42n);
  });

  it('decodeVecElements throws on a non-Vec ScVal', () => {
    expect(() => decodeVecElements(encodeI128(1n))).toThrow(VaultResultParseError);
  });
});

describe('assertExpectedInvocation (verify-before-sign)', () => {
  const args = [
    encodeI128Vec([5_000_000n]),
    encodeI128Vec([1n]),
    encodeAddress(SOURCE_PUBLIC),
    encodeBool(true),
  ];

  it('passes for a correctly-built transaction', () => {
    const tx = buildTx(CONTRACT_A, 'deposit', args);
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).not.toThrow();
  });

  it('refuses a transaction invoking the WRONG contract (wrong-target tampering)', () => {
    const tx = buildTx(CONTRACT_B, 'deposit', args);
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).toThrow(VaultVerifyError);
  });

  it('refuses a transaction calling the WRONG function', () => {
    const tx = buildTx(CONTRACT_A, 'withdraw', args);
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).toThrow(VaultVerifyError);
  });

  it('refuses a transaction with a TAMPERED argument (e.g. a different destination address)', () => {
    const tamperedArgs = [
      encodeI128Vec([5_000_000n]),
      encodeI128Vec([1n]),
      encodeAddress(OTHER_ACCOUNT), // swapped destination
      encodeBool(true),
    ];
    const tx = buildTx(CONTRACT_A, 'deposit', tamperedArgs);
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).toThrow(VaultVerifyError);
  });

  it('refuses a transaction with a TAMPERED amount', () => {
    const tamperedArgs = [
      encodeI128Vec([999_000_000n]), // wildly different amount
      encodeI128Vec([1n]),
      encodeAddress(SOURCE_PUBLIC),
      encodeBool(true),
    ];
    const tx = buildTx(CONTRACT_A, 'deposit', tamperedArgs);
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).toThrow(VaultVerifyError);
  });

  it('refuses a transaction with extra args appended', () => {
    const tx = buildTx(CONTRACT_A, 'deposit', [...args, encodeBool(false)]);
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).toThrow(VaultVerifyError);
  });

  it('refuses a transaction with more than one operation', () => {
    const account = new FakeAccount(SOURCE_PUBLIC, '100');
    const tx = new TransactionBuilder(account as never, {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(buildInvocationOperation(CONTRACT_A, 'deposit', args))
      .addOperation(buildInvocationOperation(CONTRACT_A, 'deposit', args))
      .setTimeout(30)
      .build();
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).toThrow(VaultVerifyError);
  });

  it('refuses a transaction carrying Soroban auth entries when none were expected', () => {
    // `tx.operations` is a cached array (same reference on repeat
    // access), so patching the parsed operation's `.auth` after build
    // simulates a builder/SDK bug attaching an authorization entry we
    // never asked for — the same class of defect verify-before-sign
    // exists to catch.
    const tx = buildTx(CONTRACT_A, 'deposit', args);
    const patchedOp = tx.operations[0] as unknown as { auth?: unknown[] };
    patchedOp.auth = [{} as xdr.SorobanAuthorizationEntry];
    expect(() =>
      assertExpectedInvocation(tx, { contractId: CONTRACT_A, functionName: 'deposit', args }),
    ).toThrow(VaultVerifyError);
  });
});
