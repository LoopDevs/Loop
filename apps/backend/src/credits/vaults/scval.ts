/**
 * ScVal encode/decode helpers + the verify-before-sign assertion for
 * the Soroban vault client (ADR 031 §Detailed design D2, V2).
 *
 * ADR 049 explains why this is hand-rolled on `@stellar/stellar-sdk`
 * rather than a third-party SDK: because Loop's own code builds the
 * transaction end-to-end (never trusting an externally-supplied XDR
 * blob), `assertExpectedInvocation` below can decode the BUILT
 * transaction back out and assert it invokes exactly the contract /
 * function / args Loop intended, immediately before signing. This is
 * the money-critical "verify-before-sign" requirement (ADR 031 —
 * "NEVER blindly sign whatever the SDK (or your builder) produced").
 */
import {
  Address,
  Contract,
  nativeToScVal,
  scValToNative,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';

/** Thrown by `assertExpectedInvocation` — always a refusal to sign. */
export class VaultVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultVerifyError';
  }
}

/** Thrown when an on-chain return value doesn't decode into the shape a caller expected. */
export class VaultResultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultResultParseError';
  }
}

/** Encodes a single `i128` argument from a `bigint`. */
export function encodeI128(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: 'i128' });
}

/** Encodes a `Vec<i128>` argument from an array of `bigint`. */
export function encodeI128Vec(values: readonly bigint[]): xdr.ScVal {
  return xdr.ScVal.scvVec(values.map((v) => encodeI128(v)));
}

/** Encodes a Stellar `G...` (or `C...`) address as an `Address` ScVal. */
export function encodeAddress(address: string): xdr.ScVal {
  return new Address(address).toScVal();
}

/** Encodes a `bool` argument. */
export function encodeBool(value: boolean): xdr.ScVal {
  return nativeToScVal(value, { type: 'bool' });
}

/**
 * Decodes an `i128` return/argument ScVal to a `bigint`. Throws
 * `VaultResultParseError` (not a generic error) if the value doesn't
 * decode to a `bigint` — callers can catch this class specifically to
 * distinguish "chain returned something we don't understand" from a
 * programming error.
 */
export function decodeI128(value: xdr.ScVal): bigint {
  const native = scValToNative(value);
  if (typeof native === 'bigint') return native;
  if (typeof native === 'number' && Number.isInteger(native)) return BigInt(native);
  throw new VaultResultParseError(
    `expected an i128-decodable ScVal, got ${typeof native} (${JSON.stringify(native)})`,
  );
}

/** Decodes a `Vec<i128>` return/argument ScVal to `bigint[]`. */
export function decodeI128Vec(value: xdr.ScVal): bigint[] {
  const native = scValToNative(value);
  if (!Array.isArray(native)) {
    throw new VaultResultParseError(`expected a Vec-decodable ScVal, got ${typeof native}`);
  }
  return native.map((entry, i) => {
    if (typeof entry === 'bigint') return entry;
    if (typeof entry === 'number' && Number.isInteger(entry)) return BigInt(entry);
    if (typeof entry === 'string' && /^-?\d+$/.test(entry)) return BigInt(entry);
    throw new VaultResultParseError(
      `Vec element ${i} is not i128-decodable: ${JSON.stringify(entry)}`,
    );
  });
}

/**
 * Returns the raw `xdr.ScVal[]` elements of a `Vec`-typed ScVal
 * WITHOUT decoding them to native JS — used to unwrap a tuple return
 * (e.g. `deposit`'s `(Vec<i128>, i128, ...)`) one element at a time
 * with the right type-specific decoder per element, since
 * `scValToNative` on the whole tuple can't tell a `Vec<i128>` element
 * apart from a plain `i128` element by shape alone in every case.
 */
export function decodeVecElements(value: xdr.ScVal): xdr.ScVal[] {
  if (value.switch().name !== 'scvVec') {
    throw new VaultResultParseError(`expected a Vec ScVal, got ${value.switch().name}`);
  }
  return value.vec() ?? [];
}

/** Builds the `contract.call(functionName, ...args)` invocation operation. */
export function buildInvocationOperation(
  contractId: string,
  functionName: string,
  args: readonly xdr.ScVal[],
): xdr.Operation {
  return new Contract(contractId).call(functionName, ...args);
}

export interface ExpectedInvocation {
  /** Strkey contract address (`C...`) the operation must invoke. */
  contractId: string;
  /** Exact contract function name the operation must call. */
  functionName: string;
  /**
   * Exact positional args the operation must carry, compared by their
   * canonical XDR encoding (base64) — not by re-decoding to native
   * JS, which could mask a mismatch via lossy/normalizing decode.
   */
  args: readonly xdr.ScVal[];
}

/**
 * Decodes `tx`'s sole operation and asserts it is an `invokeHostFunction`
 * call to exactly `expected.contractId`/`expected.functionName` with
 * exactly `expected.args`, in order. Throws `VaultVerifyError` — never
 * returns a boolean — so a caller structurally cannot "forget" to
 * check the result; the only way past this function is a matching tx.
 *
 * Deliberately re-derives everything from `tx.operations` (the
 * SDK-parsed view of what was actually built into the transaction
 * envelope) rather than trusting the caller's own bookkeeping — a
 * mismatch here means the transaction we are about to sign is NOT the
 * one we intended, regardless of why.
 */
export function assertExpectedInvocation(tx: Transaction, expected: ExpectedInvocation): void {
  const ops = tx.operations;
  if (ops.length !== 1) {
    throw new VaultVerifyError(
      `verify-before-sign: expected exactly 1 operation, got ${ops.length}`,
    );
  }
  const op = ops[0];
  if (op === undefined || op.type !== 'invokeHostFunction') {
    throw new VaultVerifyError(
      `verify-before-sign: expected an invokeHostFunction operation, got ${op?.type ?? 'undefined'}`,
    );
  }
  if (op.auth !== undefined && op.auth.length > 0) {
    // The operator/issuer signs as the transaction source and never
    // needs Soroban auth entries for these calls (deposit/withdraw/
    // transfer are all invoked BY the signer, not authorizing a THIRD
    // party's invocation) — a populated auth list here means the
    // built tx is asking for authorization we never intended to grant.
    throw new VaultVerifyError(
      `verify-before-sign: expected no Soroban auth entries, got ${op.auth.length}`,
    );
  }

  const hostFn = op.func;
  if (hostFn.switch().name !== 'hostFunctionTypeInvokeContract') {
    throw new VaultVerifyError(
      `verify-before-sign: expected an invokeContract host function, got ${hostFn.switch().name}`,
    );
  }
  const invocation = hostFn.invokeContract();

  const actualContractId = Address.fromScAddress(invocation.contractAddress()).toString();
  if (actualContractId !== expected.contractId) {
    throw new VaultVerifyError(
      `verify-before-sign: contract mismatch — expected ${expected.contractId}, got ${actualContractId}`,
    );
  }

  const rawFunctionName = invocation.functionName();
  const actualFunctionName =
    typeof rawFunctionName === 'string' ? rawFunctionName : rawFunctionName.toString('utf8');
  if (actualFunctionName !== expected.functionName) {
    throw new VaultVerifyError(
      `verify-before-sign: function mismatch — expected "${expected.functionName}", got "${actualFunctionName}"`,
    );
  }

  const actualArgs = invocation.args();
  if (actualArgs.length !== expected.args.length) {
    throw new VaultVerifyError(
      `verify-before-sign: arg count mismatch — expected ${expected.args.length}, got ${actualArgs.length}`,
    );
  }
  for (let i = 0; i < actualArgs.length; i++) {
    const actualArg = actualArgs[i];
    const expectedArg = expected.args[i];
    if (actualArg === undefined || expectedArg === undefined) {
      throw new VaultVerifyError(`verify-before-sign: arg ${i} missing`);
    }
    if (actualArg.toXDR('base64') !== expectedArg.toXDR('base64')) {
      throw new VaultVerifyError(`verify-before-sign: arg ${i} mismatch`);
    }
  }
}
