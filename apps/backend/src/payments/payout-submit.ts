/**
 * Stellar payout-submit primitive (ADR 016).
 *
 * Pure-ish wrapper around `@stellar/stellar-sdk` for the one
 * operation Loop's backend needs to write to the chain: signed
 * `Payment` of a LOOP-branded asset from the operator account to a
 * user's linked Stellar address.
 *
 * Intentionally *one function*. The retry + idempotency policy
 * (ADR 016) lives in the worker loop that calls this; here we
 * build + sign + submit exactly one tx and classify the outcome
 * so the worker can decide transient-vs-terminal.
 */
import {
  Asset,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  type FeeBumpTransaction,
  type Transaction,
} from '@stellar/stellar-sdk';

export interface PayoutSubmitArgs {
  /** Operator Stellar secret key (`S...`). Never logged. */
  secret: string;
  /** Horizon base URL. Pinned per-deployment via env. */
  horizonUrl: string;
  /** Network passphrase — PUBLIC or TESTNET constant from the SDK. */
  networkPassphrase: string;
  intent: {
    to: string;
    assetCode: string;
    assetIssuer: string;
    amountStroops: bigint;
    memoText: string;
  };
  /**
   * Transaction timebounds in seconds from now. ADR 016 picks 60s
   * so an expired tx can't land retroactively after we've rebuilt.
   */
  timeoutSeconds?: number;
  /**
   * Optional fee override in stroops. Defaults to SDK `BASE_FEE`
   * (100 stroops). The worker can bump on `tx_insufficient_fee`
   * retries.
   */
  feeStroops?: string;
  /**
   * CF-18: fired with the deterministic tx hash AFTER the tx is built
   * + signed but BEFORE it's submitted to the network. The worker
   * persists this hash to the `pending_payouts` row so that, if the
   * submit network call lands the tx but we crash / lose the response
   * before recording it, the next re-pick can ask Horizon directly
   * ("did THIS hash land?") instead of relying on the bounded memo
   * scan — closing the double-pay window. Awaited so a persist failure
   * aborts the submit (fail-closed: better to retry than to submit
   * without having recorded the hash). Errors thrown here propagate as
   * a `terminal_other` PayoutSubmitError below.
   */
  onSigned?: (txHash: string) => Promise<void> | void;
}

export interface PayoutSubmitResult {
  txHash: string;
  /** Ledger sequence the tx was included in (if Horizon returned it). */
  ledger: number | null;
}

/**
 * Classification for the worker's retry policy. Every thrown error
 * from `submitPayout` is a `PayoutSubmitError` with a `kind`.
 */
export type PayoutSubmitErrorKind =
  /** Network / 5xx / timeout — safe to retry on next tick. */
  | 'transient_horizon'
  /** `tx_bad_seq`, `tx_too_late`, `tx_insufficient_fee` — retry with fresh seq. */
  | 'transient_rebuild'
  /** `op_no_trust` — destination account missing the asset trustline. */
  | 'terminal_no_trust'
  /** `op_underfunded` — operator doesn't hold enough of the asset. */
  | 'terminal_underfunded'
  /** `tx_bad_auth` / configuration bug — signing key wrong. */
  | 'terminal_bad_auth'
  /** Malformed intent or SDK throw we can't classify — fail loud. */
  | 'terminal_other';

export class PayoutSubmitError extends Error {
  readonly kind: PayoutSubmitErrorKind;
  readonly resultCodes: { transaction?: string; operations?: string[] } | null;

  constructor(
    kind: PayoutSubmitErrorKind,
    message: string,
    resultCodes: PayoutSubmitError['resultCodes'] = null,
  ) {
    super(message);
    this.name = 'PayoutSubmitError';
    this.kind = kind;
    this.resultCodes = resultCodes;
  }
}

/**
 * Converts stroops (7-decimal integer) to the decimal-string form
 * the SDK's `Operation.payment` wants. 50_000_000 stroops → "5.0000000".
 */
function stroopsToAmount(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const frac = (stroops % 10_000_000n).toString().padStart(7, '0');
  return `${whole}.${frac}`;
}

export interface NativePaymentSubmitArgs {
  /** Operator Stellar secret key (`S...`). Never logged. */
  secret: string;
  /** Horizon base URL. Pinned per-deployment via env. */
  horizonUrl: string;
  /** Network passphrase — PUBLIC or TESTNET constant from the SDK. */
  networkPassphrase: string;
  intent: {
    to: string;
    /**
     * Decimal-string amount as the SDK's `Operation.payment` wants
     * (e.g. `"0.1198323"`). Not stroops — the CTX `paymentUrls.XLM`
     * URI carries this in decimal form already, and re-encoding it
     * via stroops invites a rounding wobble on the wire string.
     */

    amount: string;
    memoText: string;
  };
  timeoutSeconds?: number;
  feeStroops?: string;
  /**
   * CF-18: fired with the deterministic tx hash after sign, before
   * submit. See `PayoutSubmitArgs.onSigned`. The pay-CTX path has no
   * `pending_payouts` row to persist into (its idempotency is the
   * `Idempotency-Key: order.id` CTX returns + the memo scan), so it
   * passes nothing today; the hook is here for symmetry and any future
   * order-side hash persistence.
   */
  onSigned?: (txHash: string) => Promise<void> | void;
}

/**
 * Builds + signs + submits a NATIVE XLM payment. Mirror of
 * `submitPayout` for the principal-switch flow (ADR 010) where Loop
 * forwards user-paid XLM to CTX's per-order deposit URI returned by
 * `POST /gift-cards`. Native asset (`Asset.native()`), no issuer
 * involved, amount passed as a decimal string straight from the
 * SEP-7 URI.
 *
 * Same retry classification as `submitPayout` — both share
 * `classifySubmitError`.
 */
export async function submitNativePayment(
  args: NativePaymentSubmitArgs,
): Promise<PayoutSubmitResult> {
  const timeout = args.timeoutSeconds ?? 60;
  const fee = args.feeStroops ?? BASE_FEE;

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(args.secret);
  } catch (err) {
    throw new PayoutSubmitError(
      'terminal_bad_auth',
      err instanceof Error ? err.message : 'Invalid operator secret',
    );
  }

  const server = new Horizon.Server(args.horizonUrl);

  let account: Awaited<ReturnType<Horizon.Server['loadAccount']>>;
  try {
    account = await server.loadAccount(keypair.publicKey());
  } catch (err) {
    throw new PayoutSubmitError(
      'transient_horizon',
      err instanceof Error ? err.message : 'loadAccount failed',
    );
  }

  let tx;
  try {
    tx = new TransactionBuilder(account, {
      fee,
      networkPassphrase: args.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: args.intent.to,
          asset: Asset.native(),
          amount: args.intent.amount,
        }),
      )
      .addMemo(Memo.text(args.intent.memoText))
      .setTimeout(timeout)
      .build();
    tx.sign(keypair);
  } catch (err) {
    throw new PayoutSubmitError(
      'terminal_other',
      err instanceof Error ? err.message : 'TransactionBuilder failed',
    );
  }

  // CF-18: deterministic hash known before the network submit (see
  // `submitPayout`). Persist via `onSigned` before submitting if a
  // caller wired it; abort fail-closed on a persist failure.
  const signedHash = tx.hash().toString('hex');
  if (args.onSigned !== undefined) {
    try {
      await args.onSigned(signedHash);
    } catch (err) {
      throw new PayoutSubmitError(
        'terminal_other',
        err instanceof Error
          ? `onSigned persist failed: ${err.message}`
          : 'onSigned persist failed',
      );
    }
  }

  try {
    const res = await server.submitTransaction(tx);
    const hash = (res as { hash?: string }).hash ?? signedHash;
    const ledger = (res as { ledger?: number }).ledger ?? null;
    return { txHash: hash, ledger };
  } catch (err) {
    throw classifySubmitError(err);
  }
}

/**
 * Builds + signs + submits one payout tx. On success, returns the
 * Horizon-confirmed tx hash. On failure, throws a `PayoutSubmitError`
 * whose `kind` tells the worker whether to retry.
 *
 * Idempotency guarantees live in the caller (see ADR 016's
 * `findOutboundPaymentByMemo` pre-check). This function makes no
 * attempt to check for prior submissions — it's the raw submit.
 */
export async function submitPayout(args: PayoutSubmitArgs): Promise<PayoutSubmitResult> {
  const timeout = args.timeoutSeconds ?? 60;
  const fee = args.feeStroops ?? BASE_FEE;

  let keypair: Keypair;
  try {
    keypair = Keypair.fromSecret(args.secret);
  } catch (err) {
    throw new PayoutSubmitError(
      'terminal_bad_auth',
      err instanceof Error ? err.message : 'Invalid operator secret',
    );
  }

  let asset: Asset;
  try {
    asset = new Asset(args.intent.assetCode, args.intent.assetIssuer);
  } catch (err) {
    throw new PayoutSubmitError(
      'terminal_other',
      err instanceof Error ? err.message : 'Invalid asset code/issuer',
    );
  }

  const server = new Horizon.Server(args.horizonUrl);

  let account: Awaited<ReturnType<Horizon.Server['loadAccount']>>;
  try {
    // Fresh seq on every submit — ADR 016 design, prevents
    // stale-seq from a prior timeout poisoning the retry.
    account = await server.loadAccount(keypair.publicKey());
  } catch (err) {
    throw new PayoutSubmitError(
      'transient_horizon',
      err instanceof Error ? err.message : 'loadAccount failed',
    );
  }

  let tx;
  try {
    tx = new TransactionBuilder(account, {
      fee,
      networkPassphrase: args.networkPassphrase,
    })
      .addOperation(
        Operation.payment({
          destination: args.intent.to,
          asset,
          amount: stroopsToAmount(args.intent.amountStroops),
        }),
      )
      .addMemo(Memo.text(args.intent.memoText))
      .setTimeout(timeout)
      .build();
    tx.sign(keypair);
  } catch (err) {
    throw new PayoutSubmitError(
      'terminal_other',
      err instanceof Error ? err.message : 'TransactionBuilder failed',
    );
  }

  // CF-18: record the deterministic hash BEFORE the network submit.
  // `tx.hash()` is fully determined by the signed tx (seq + ops + memo +
  // fee + network), so we know it without contacting Horizon. If
  // `onSigned` throws (the row persist failed), abort: a failed persist
  // means we can't safely prove later whether this submit landed, so
  // fail-closed and let the next tick retry.
  const signedHash = tx.hash().toString('hex');
  if (args.onSigned !== undefined) {
    try {
      await args.onSigned(signedHash);
    } catch (err) {
      throw new PayoutSubmitError(
        'terminal_other',
        err instanceof Error
          ? `onSigned persist failed: ${err.message}`
          : 'onSigned persist failed',
      );
    }
  }

  try {
    const res = await server.submitTransaction(tx);
    // Types on the SDK's submit response differ across versions;
    // narrow defensively. `hash` is stable across 10-15.x.
    const hash = (res as { hash?: string }).hash ?? signedHash;
    const ledger = (res as { ledger?: number }).ledger ?? null;
    return { txHash: hash, ledger };
  } catch (err) {
    throw classifySubmitError(err);
  }
}

export interface PreSignedSubmitArgs {
  /** Horizon base URL. Pinned per-deployment via env. */
  horizonUrl: string;
  /**
   * Fully built AND fully signed transaction. Fee-bump envelopes
   * (ADR 030 Phase C3 — operator pays the fee on a user-signed inner
   * tx) submit through the same path; Horizon's error taxonomy is
   * identical for both.
   */
  tx: Transaction | FeeBumpTransaction;
}

/**
 * Submits a transaction that was built and signed elsewhere (ADR 030
 * Phase B: user-embedded-wallet signatures attached via
 * `wallet/user-signer.ts`). Shares `classifySubmitError` with the
 * operator-signed paths above so every Stellar submit in the backend
 * throws the same `PayoutSubmitError` kinds. The operator-keypair
 * functions (`submitPayout` / `submitNativePayment`) are untouched —
 * this is additive, not a re-route.
 *
 * As with `submitPayout`, idempotency lives in the caller; this is
 * the raw submit.
 */
export async function submitPreSignedTransaction(
  args: PreSignedSubmitArgs,
): Promise<PayoutSubmitResult> {
  const server = new Horizon.Server(args.horizonUrl);
  try {
    const res = await server.submitTransaction(args.tx);
    const hash = (res as { hash?: string }).hash ?? args.tx.hash().toString('hex');
    const ledger = (res as { ledger?: number }).ledger ?? null;
    return { txHash: hash, ledger };
  } catch (err) {
    throw classifySubmitError(err);
  }
}

/**
 * Classifies a Horizon submit error into a retry bucket. The SDK
 * wraps failures as an object with a `response.data.extras.result_codes`
 * shape; we normalise to `PayoutSubmitError` with `kind` the worker
 * can branch on.
 */
function classifySubmitError(err: unknown): PayoutSubmitError {
  // Network / non-4xx: transient.
  const response = (err as { response?: { status?: number; data?: unknown } }).response;
  if (response === undefined) {
    return new PayoutSubmitError(
      'transient_horizon',
      err instanceof Error ? err.message : 'submitTransaction threw without a Horizon response',
    );
  }
  if (typeof response.status === 'number' && response.status >= 500) {
    return new PayoutSubmitError('transient_horizon', `Horizon ${response.status}`);
  }
  const data = (response.data ?? {}) as { extras?: { result_codes?: unknown } };
  const codes = (data.extras?.result_codes ?? {}) as {
    transaction?: string;
    operations?: string[];
  };
  const tx = codes.transaction;
  const ops = codes.operations ?? [];
  if (tx === 'tx_bad_seq' || tx === 'tx_too_late' || tx === 'tx_insufficient_fee') {
    return new PayoutSubmitError('transient_rebuild', `Horizon tx code: ${tx}`, codes);
  }
  if (tx === 'tx_bad_auth' || tx === 'tx_bad_auth_extra') {
    return new PayoutSubmitError('terminal_bad_auth', `Horizon tx code: ${tx}`, codes);
  }
  if (ops.includes('op_no_trust')) {
    return new PayoutSubmitError(
      'terminal_no_trust',
      'Destination account has no trustline to this asset',
      codes,
    );
  }
  if (ops.includes('op_underfunded')) {
    return new PayoutSubmitError(
      'terminal_underfunded',
      'Operator account has insufficient balance of this asset',
      codes,
    );
  }
  return new PayoutSubmitError(
    'terminal_other',
    `Unclassified Horizon error: tx=${tx ?? 'none'} ops=${JSON.stringify(ops)}`,
    codes,
  );
}

/** Re-exported for callers that need the MAINNET/TESTNET constants. */
export const STELLAR_NETWORKS = Networks;
