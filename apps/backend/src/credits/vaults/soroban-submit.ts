/**
 * Low-level Soroban contract-invocation submit pipeline (ADR 031
 * §Detailed design D2, V2). One function, `submitSorobanInvocation`,
 * that builds → verifies (before signing) → simulates → assembles →
 * verifies again → signs → sends → polls exactly one
 * `invokeHostFunction` call, mirroring `payments/payout-submit.ts`'s
 * shape (ADR 016) for the Soroban side of the world.
 *
 * CF-18 at-most-once fence: the same discipline as
 * `payments/payout-submit.ts`'s `onSigned` hook, PLUS an explicit
 * `priorTxHash` pre-check (mirroring the CF-18 pre-check in
 * `payments/payout-worker-pay-one.ts`, which has no separate worker
 * yet on the vault side — V2 ships the client library only, not a
 * worker/table, so the pre-check lives here instead of a caller-side
 * DB row lookup). A caller that persists the hash `onSigned` returns
 * and passes it back in as `priorTxHash` on a retry gets the SAME
 * confirmed result without a second submission — never a second
 * deposit/withdraw/transfer.
 */
import {
  Keypair,
  TransactionBuilder,
  BASE_FEE,
  rpc,
  xdr,
  type Transaction,
} from '@stellar/stellar-sdk';
import {
  assertExpectedInvocation,
  buildInvocationOperation,
  type ExpectedInvocation,
} from './scval.js';

export type SorobanSubmitErrorKind =
  /** Network / 5xx / timeout on account load, simulate, or send — safe to retry. */
  | 'transient_rpc'
  /** `sendTransaction` returned `TRY_AGAIN_LATER` — safe to retry with a fresh build. */
  | 'transient_retry_later'
  /** Simulation failed — contract revert, resource-limit exceeded, or bad args. Not fixed by a blind retry. */
  | 'terminal_contract_error'
  /** Invalid signer secret. */
  | 'terminal_bad_auth'
  /** `sendTransaction` returned `ERROR`. */
  | 'terminal_send_error'
  /** `getTransaction` (post-submit) settled as `FAILED`. */
  | 'terminal_tx_failed'
  /** Polling exhausted without the tx ever reaching a terminal status. */
  | 'terminal_not_found'
  /** Verify-before-sign refused to sign the built transaction. */
  | 'terminal_verify_failed'
  /** Anything else / a thrown error we can't classify. */
  | 'terminal_other';

export class SorobanSubmitError extends Error {
  readonly kind: SorobanSubmitErrorKind;
  readonly detail: unknown;

  constructor(kind: SorobanSubmitErrorKind, message: string, detail: unknown = null) {
    super(message);
    this.name = 'SorobanSubmitError';
    this.kind = kind;
    this.detail = detail;
  }
}

export interface SubmitSorobanInvocationArgs {
  /** Soroban RPC base URL (`env.LOOP_SOROBAN_RPC_URL`). */
  rpcUrl: string;
  /** Network passphrase — PUBLIC or TESTNET. */
  networkPassphrase: string;
  /** Signer secret key (`S...`) — operator for deposit/withdraw/operator-transfer, issuer for a mint-shaped call. Never logged. */
  signerSecret: string;
  contractId: string;
  functionName: string;
  args: readonly xdr.ScVal[];
  timeoutSeconds?: number;
  feeStroops?: string;
  /**
   * CF-18: a tx hash persisted from a prior attempt (if any). Checked
   * BEFORE building a new transaction — if it already landed
   * successfully, the result is returned directly with `deduped:
   * true` and NOTHING is built, signed, or submitted.
   */
  priorTxHash?: string;
  /**
   * CF-18: fired with the deterministic tx hash after signing but
   * before submission, so the caller can persist it. Awaited; a
   * thrown/rejected hook aborts the submit fail-closed (mirrors
   * `payments/payout-submit.ts`).
   */
  onSigned?: (txHash: string) => Promise<void> | void;
  /** Polling budget (attempt count) for the post-submit `getTransaction` wait via `pollTransaction`. */
  pollAttempts?: number;
}

export interface SorobanSubmitResult {
  txHash: string;
  returnValue: xdr.ScVal;
  /** true when a `priorTxHash` was found already-confirmed and this call short-circuited without submitting anything new. */
  deduped: boolean;
}

/**
 * Builds, verifies, simulates, assembles, signs, submits, and polls
 * exactly one Soroban contract invocation to a terminal result.
 * Throws `SorobanSubmitError` on any failure, classified via `.kind`
 * for the caller's retry policy.
 */
export async function submitSorobanInvocation(
  args: SubmitSorobanInvocationArgs,
): Promise<SorobanSubmitResult> {
  const server = new rpc.Server(args.rpcUrl);

  // CF-18 pre-check: a prior attempt's hash, if the caller has one,
  // wins over building anything new. This is the "retry re-submits
  // the same hash, never a second deposit" guarantee.
  if (args.priorTxHash !== undefined) {
    const prior = await server.getTransaction(args.priorTxHash).catch(() => null);
    if (prior !== null && prior.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return {
        txHash: args.priorTxHash,
        returnValue: prior.returnValue ?? voidScVal(),
        deduped: true,
      };
    }
  }

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(args.signerSecret);
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_bad_auth',
      err instanceof Error ? err.message : 'Invalid signer secret',
    );
  }

  let account;
  try {
    account = await server.getAccount(keypair.publicKey());
  } catch (err) {
    throw new SorobanSubmitError(
      'transient_rpc',
      err instanceof Error ? err.message : 'getAccount failed',
    );
  }

  const expected: ExpectedInvocation = {
    contractId: args.contractId,
    functionName: args.functionName,
    args: args.args,
  };

  let builtTx: Transaction;
  try {
    builtTx = new TransactionBuilder(account, {
      fee: args.feeStroops ?? BASE_FEE,
      networkPassphrase: args.networkPassphrase,
    })
      .addOperation(buildInvocationOperation(args.contractId, args.functionName, args.args))
      .setTimeout(args.timeoutSeconds ?? 60)
      .build();
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_other',
      err instanceof Error ? err.message : 'TransactionBuilder failed',
    );
  }

  // Verify-before-sign, pass 1: on the raw built transaction, before
  // any network round-trip. Catches an encoding bug at the earliest
  // possible point.
  assertVerify(builtTx, expected);

  let sim: Awaited<ReturnType<typeof server.simulateTransaction>>;
  try {
    sim = await server.simulateTransaction(builtTx);
  } catch (err) {
    throw new SorobanSubmitError(
      'transient_rpc',
      err instanceof Error ? err.message : 'simulateTransaction failed',
    );
  }
  if (rpc.Api.isSimulationError(sim)) {
    throw new SorobanSubmitError('terminal_contract_error', sim.error, sim);
  }

  let prepared: Transaction;
  try {
    prepared = rpc.assembleTransaction(builtTx, sim).build();
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_other',
      err instanceof Error ? err.message : 'assembleTransaction failed',
    );
  }

  // Verify-before-sign, pass 2: assembling attaches Soroban resource
  // data (footprint + resource fee) but must NOT change the invoked
  // contract/function/args. Re-checking here is cheap insurance
  // against an SDK bug (or a future refactor) silently mutating the
  // operation between build and sign.
  assertVerify(prepared, expected);

  try {
    prepared.sign(keypair);
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_other',
      err instanceof Error ? err.message : 'sign failed',
    );
  }

  // CF-18: the hash is fully determined by the signed tx (source +
  // seq + ops + soroban data + fee), so we know it without contacting
  // the network. Persist BEFORE submitting; abort fail-closed if the
  // persist itself fails (better to retry than to submit without
  // having recorded the hash).
  const signedHash = prepared.hash().toString('hex');
  if (args.onSigned !== undefined) {
    try {
      await args.onSigned(signedHash);
    } catch (err) {
      throw new SorobanSubmitError(
        'terminal_other',
        err instanceof Error
          ? `onSigned persist failed: ${err.message}`
          : 'onSigned persist failed',
      );
    }
  }

  let sendRes: Awaited<ReturnType<typeof server.sendTransaction>>;
  try {
    sendRes = await server.sendTransaction(prepared);
  } catch (err) {
    throw new SorobanSubmitError(
      'transient_rpc',
      err instanceof Error ? err.message : 'sendTransaction failed',
    );
  }
  if (sendRes.status === 'ERROR') {
    throw new SorobanSubmitError('terminal_send_error', 'sendTransaction returned ERROR', sendRes);
  }
  if (sendRes.status === 'TRY_AGAIN_LATER') {
    throw new SorobanSubmitError(
      'transient_retry_later',
      'sendTransaction returned TRY_AGAIN_LATER',
      sendRes,
    );
  }
  // PENDING or DUPLICATE — either way, poll for the terminal result.

  const final = await server.pollTransaction(signedHash, {
    attempts: args.pollAttempts ?? 30,
    sleepStrategy: rpc.LinearSleepStrategy,
  });

  if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
    throw new SorobanSubmitError('terminal_tx_failed', 'Transaction failed on-chain', final);
  }
  if (final.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    throw new SorobanSubmitError(
      'terminal_not_found',
      `Transaction ${signedHash} not found after polling budget exhausted`,
      final,
    );
  }

  return {
    txHash: signedHash,
    returnValue: final.returnValue ?? voidScVal(),
    deduped: false,
  };
}

export interface SimulateSorobanCallArgs {
  rpcUrl: string;
  networkPassphrase: string;
  /** Any funded account can source a read-only simulation; the vault client uses the operator account for consistency. */
  sourceSecret: string;
  contractId: string;
  functionName: string;
  args: readonly xdr.ScVal[];
}

/**
 * Builds, verifies, and simulates a read-only contract call — NEVER
 * signs or submits anything. Kept as a separate function (rather than
 * a "don't actually submit" flag on `submitSorobanInvocation`) so a
 * money-moving submit path can never accidentally be reached from a
 * read call by a mis-set boolean.
 */
export async function simulateSorobanCall(args: SimulateSorobanCallArgs): Promise<xdr.ScVal> {
  const server = new rpc.Server(args.rpcUrl);

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(args.sourceSecret);
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_bad_auth',
      err instanceof Error ? err.message : 'Invalid source secret',
    );
  }

  let account;
  try {
    account = await server.getAccount(keypair.publicKey());
  } catch (err) {
    throw new SorobanSubmitError(
      'transient_rpc',
      err instanceof Error ? err.message : 'getAccount failed',
    );
  }

  const expected: ExpectedInvocation = {
    contractId: args.contractId,
    functionName: args.functionName,
    args: args.args,
  };

  let tx: Transaction;
  try {
    tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: args.networkPassphrase,
    })
      .addOperation(buildInvocationOperation(args.contractId, args.functionName, args.args))
      .setTimeout(30)
      .build();
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_other',
      err instanceof Error ? err.message : 'TransactionBuilder failed',
    );
  }

  assertVerify(tx, expected);

  let sim: Awaited<ReturnType<typeof server.simulateTransaction>>;
  try {
    sim = await server.simulateTransaction(tx);
  } catch (err) {
    throw new SorobanSubmitError(
      'transient_rpc',
      err instanceof Error ? err.message : 'simulateTransaction failed',
    );
  }
  if (rpc.Api.isSimulationError(sim)) {
    throw new SorobanSubmitError('terminal_contract_error', sim.error, sim);
  }

  const retval = sim.result?.retval;
  if (retval === undefined) {
    throw new SorobanSubmitError('terminal_other', 'Simulation succeeded but returned no result');
  }
  return retval;
}

function assertVerify(tx: Transaction, expected: ExpectedInvocation): void {
  try {
    assertExpectedInvocation(tx, expected);
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_verify_failed',
      err instanceof Error ? err.message : 'verify-before-sign refused to sign',
    );
  }
}

function voidScVal(): xdr.ScVal {
  return xdr.ScVal.scvVoid();
}
