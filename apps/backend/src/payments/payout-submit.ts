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

  try {
    const res = await server.submitTransaction(tx);
    // Types on the SDK's submit response differ across versions;
    // narrow defensively. `hash` is stable across 10-15.x.
    const hash = (res as { hash?: string }).hash ?? tx.hash().toString('hex');
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
