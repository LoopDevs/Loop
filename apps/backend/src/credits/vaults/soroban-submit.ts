/**
 * Low-level Soroban contract-invocation submit pipeline (ADR 031
 * §Detailed design D2, V2). One function, `submitSorobanInvocation`,
 * that builds → verifies (before signing) → simulates → assembles →
 * verifies again → bounds the fee → signs → sends → polls exactly one
 * `invokeHostFunction` call, mirroring `payments/payout-submit.ts`'s
 * shape (ADR 016) for the Soroban side of the world.
 *
 * ## CF-18 at-most-once fence — what this DOES and does NOT guarantee
 *
 * Two mechanisms, both required, and NEITHER sufficient alone:
 *
 * 1. `onSigned(txHash)` — REQUIRED on this path (the field is
 *    non-optional). Fires with the deterministic hash after signing,
 *    before submit, so the caller can persist it. A caller that
 *    persists it and passes it back as `priorTxHash` on a retry gets
 *    the SAME landed tx, not a second submission.
 * 2. `priorTxHash` pre-check — on a retry, asks the RPC "did THIS hash
 *    already land?" and short-circuits if so. It fails CLOSED: any RPC
 *    error on the pre-check refuses to submit (see below) rather than
 *    risk a double-submit.
 *
 * **The guarantee is bounded.** Unlike the classic payout path
 * (`payments/payout-worker-pay-one.ts`), which has a SECOND idempotency
 * backstop — a memo scan of the operator's outbound payments — a
 * Soroban `InvokeHostFunction` tx carries no memo, so there is no
 * equivalent "find my prior attempt by content" fallback here. The
 * hash pre-check is the ONLY fence, and it only works if the caller
 * actually persisted the hash between attempts. If the process crashes
 * AFTER `onSigned` resolves but BEFORE the persisted hash is durably
 * committed, or the caller never re-supplies it, a retry WILL build a
 * fresh tx.
 *
 * // TODO(V3, ADR 031 §D5): before this is wired into a real emission
 * // flow, V3 MUST add a durable idempotency layer keyed on the
 * // emission event id — a dedup row CLAIMED (inserted) BEFORE the
 * // build, exactly like the payout worker's `pending_payouts` row
 * // claim. The claim row, not this hash pre-check, is what makes the
 * // fence complete: it survives a crash between attempts and does not
 * // depend on the caller remembering to thread `priorTxHash` back in.
 * // The hash pre-check remains as the fast in-flight de-dup; the claim
 * // row is the authoritative at-most-once guarantee. Do NOT wire an
 * // emission against this module until that layer exists.
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
  /** The assembled fee (from the RPC-supplied `minResourceFee`) exceeded the sanity cap — refused BEFORE signing (Lens1-F3). */
  | 'terminal_fee_too_high'
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

/**
 * Lens1-F3 fee sanity cap. `rpc.assembleTransaction` sets the total
 * transaction fee from `simulation.minResourceFee` — a value the
 * Soroban RPC endpoint supplies. A hostile or buggy RPC could return
 * an absurd resource fee and get the operator to sign a tx that drains
 * its XLM balance. We bound the assembled fee below this ceiling and
 * refuse to sign above it. 10 XLM (100_000_000 stroops) is far above
 * any legitimate single-invocation Soroban fee (even a Blend-strategy
 * deposit under congestion is well under 1 XLM) while still catching
 * an obviously-hostile fee. Callers can tighten it via
 * `maxFeeStroops`; they cannot disable it (an unset arg uses this
 * default, never "no cap").
 */
export const DEFAULT_MAX_ASSEMBLED_FEE_STROOPS = 100_000_000n;

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
   * Lens1-F3 fee sanity cap (stroops). The assembled fee — set by
   * `assembleTransaction` from the RPC-supplied `minResourceFee` — is
   * refused if it exceeds this, BEFORE signing. Optional only to let a
   * caller TIGHTEN it; unset uses `DEFAULT_MAX_ASSEMBLED_FEE_STROOPS`,
   * never "no cap".
   */
  maxFeeStroops?: bigint;
  /**
   * CF-18: a tx hash persisted from a prior attempt (if any). Checked
   * BEFORE building a new transaction — if it already landed
   * successfully, the result is returned directly with `deduped:
   * true` and NOTHING is built, signed, or submitted. Fails CLOSED: an
   * RPC error on this pre-check refuses to submit rather than risk a
   * double-submit.
   */
  priorTxHash?: string;
  /**
   * CF-18: fired with the deterministic tx hash after signing but
   * before submission, so the caller can persist it. Awaited; a
   * thrown/rejected hook aborts the submit fail-closed (mirrors
   * `payments/payout-submit.ts`).
   *
   * REQUIRED (non-optional) on this money-submit path: at-most-once
   * depends on the caller persisting this hash, so making it optional
   * would let a caller silently opt out of the only dedup mechanism
   * and guarantee a double-submit on any retry. The classic payout
   * path always wires its equivalent; so must this. The read-only
   * `simulateSorobanCall` path (which never signs or submits) does NOT
   * take this — it's specific to the submit path.
   */
  onSigned: (txHash: string) => Promise<void> | void;
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
export interface PriorSorobanTxCheck {
  landed: boolean;
  returnValue: xdr.ScVal | null;
}

/**
 * CF-18 pre-check, factored out of `submitSorobanInvocation` (V4) so
 * the provider-signed path (`prepareSorobanInvocationForExternalSigning`
 * callers, `vault-client.ts`'s `transferShares({ signWith: 'provider'
 * })`) can share the SAME fail-closed pre-check rather than
 * reimplementing it. Semantics unchanged from the inline version this
 * replaces: any RPC error refuses (throws `transient_rpc`) rather than
 * risk treating an ambiguous check as "never landed".
 */
export async function checkPriorSorobanTx(
  rpcUrl: string,
  priorTxHash: string,
): Promise<PriorSorobanTxCheck> {
  const server = new rpc.Server(rpcUrl);
  let prior: Awaited<ReturnType<typeof server.getTransaction>>;
  try {
    prior = await server.getTransaction(priorTxHash);
  } catch (err) {
    throw new SorobanSubmitError(
      'transient_rpc',
      err instanceof Error
        ? `CF-18 pre-check getTransaction failed — refusing to submit (fail-closed): ${err.message}`
        : 'CF-18 pre-check getTransaction failed — refusing to submit (fail-closed)',
    );
  }
  if (prior.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    return { landed: true, returnValue: prior.returnValue ?? voidScVal() };
  }
  // NOT_FOUND (never landed) or FAILED (reverted all state, consumed
  // its sequence, so a fresh higher-sequence submit won't collide):
  // both are a definitive "the prior attempt is not a landed success".
  // Only a THROWN error is ambiguous, and that path already bailed above.
  return { landed: false, returnValue: null };
}

export async function submitSorobanInvocation(
  args: SubmitSorobanInvocationArgs,
): Promise<SorobanSubmitResult> {
  const server = new rpc.Server(args.rpcUrl);

  // CF-18 pre-check: a prior attempt's hash, if the caller has one,
  // wins over building anything new.
  if (args.priorTxHash !== undefined) {
    const prior = await checkPriorSorobanTx(args.rpcUrl, args.priorTxHash);
    if (prior.landed) {
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

  // Lens1-F3 fee sanity cap: `assembleTransaction` set the fee from the
  // RPC-supplied `minResourceFee`. Bound it BEFORE signing so a hostile
  // / buggy RPC can't get the operator to sign a tx with a fee that
  // drains its XLM. Refuse above the cap rather than sign it.
  const feeCap = args.maxFeeStroops ?? DEFAULT_MAX_ASSEMBLED_FEE_STROOPS;
  let assembledFee: bigint;
  try {
    assembledFee = BigInt(prepared.fee);
  } catch {
    throw new SorobanSubmitError(
      'terminal_other',
      `assembled fee "${prepared.fee}" is not an integer stroop value`,
    );
  }
  if (assembledFee > feeCap) {
    throw new SorobanSubmitError(
      'terminal_fee_too_high',
      `assembled fee ${assembledFee} stroops exceeds the sanity cap of ${feeCap} stroops — ` +
        'refusing to sign (a hostile/buggy Soroban RPC could otherwise drain operator XLM)',
    );
  }

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
  // having recorded the hash). `onSigned` is required on this path
  // (see `SubmitSorobanInvocationArgs`), so this always runs.
  const signedHash = prepared.hash().toString('hex');
  try {
    await args.onSigned(signedHash);
  } catch (err) {
    throw new SorobanSubmitError(
      'terminal_other',
      err instanceof Error ? `onSigned persist failed: ${err.message}` : 'onSigned persist failed',
    );
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

export interface PrepareSorobanInvocationArgs {
  rpcUrl: string;
  networkPassphrase: string;
  /**
   * The PUBLIC key that will invoke + pay for the transaction — for
   * the provider-signed path (V4) this is the USER's embedded-wallet
   * address, not the operator. No secret key is needed to prepare: the
   * caller is expected to sign externally (`attachUserWalletSignature`)
   * and typically fee-bump-wrap with the operator afterward, since the
   * user holds no XLM by design (ADR 030 sponsored-reserves model,
   * same as `orders/redeem.ts`'s classic redemption tx).
   */
  sourcePublicKey: string;
  contractId: string;
  functionName: string;
  args: readonly xdr.ScVal[];
  timeoutSeconds?: number;
  /** Lens1-F3-style fee sanity cap — see `submitSorobanInvocation`'s twin field. */
  maxFeeStroops?: bigint;
}

export interface PreparedSorobanInvocation {
  /** Simulated + assembled (Soroban resource data attached) but NOT signed. */
  tx: Transaction;
}

/**
 * Builds, verifies, simulates, and assembles exactly one Soroban
 * contract invocation — WITHOUT signing or submitting anything. The
 * externally-signed twin of `submitSorobanInvocation`'s internal
 * build/verify/simulate/assemble/verify/fee-cap sequence, extracted so
 * a caller that needs an EXTERNAL signature (the ADR 031 §D1
 * provider-signed user->operator share transfer, V4) gets the exact
 * same verify-before-sign + fee-sanity discipline as the operator-
 * signed path, rather than a parallel, potentially-drifting
 * implementation.
 *
 * Deliberately does NOT do the CF-18 `priorTxHash` pre-check — callers
 * that need it call `checkPriorSorobanTx` themselves BEFORE calling
 * this (building a fresh tx is pointless if a prior attempt already
 * landed), and the CF-18 `onSigned` persist happens in the caller's
 * own signing flow, not here, since this function never has a
 * "signed" moment to hook.
 */
export async function prepareSorobanInvocationForExternalSigning(
  args: PrepareSorobanInvocationArgs,
): Promise<PreparedSorobanInvocation> {
  const server = new rpc.Server(args.rpcUrl);

  let account;
  try {
    account = await server.getAccount(args.sourcePublicKey);
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
      fee: BASE_FEE,
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

  // Verify-before-sign, pass 1 (see `submitSorobanInvocation`'s twin comment).
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

  // Verify-before-sign, pass 2.
  assertVerify(prepared, expected);

  const feeCap = args.maxFeeStroops ?? DEFAULT_MAX_ASSEMBLED_FEE_STROOPS;
  let assembledFee: bigint;
  try {
    assembledFee = BigInt(prepared.fee);
  } catch {
    throw new SorobanSubmitError(
      'terminal_other',
      `assembled fee "${prepared.fee}" is not an integer stroop value`,
    );
  }
  if (assembledFee > feeCap) {
    throw new SorobanSubmitError(
      'terminal_fee_too_high',
      `assembled fee ${assembledFee} stroops exceeds the sanity cap of ${feeCap} stroops — ` +
        'refusing to hand this off for signing (a hostile/buggy Soroban RPC could otherwise drain funds)',
    );
  }

  return { tx: prepared };
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
