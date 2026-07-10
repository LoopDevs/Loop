/**
 * LOOPUSD/LOOPEUR Soroban vault client (ADR 031 §Detailed design
 * D1/D2, V2). Builds on the V1 registry (`registry.ts`) + the
 * low-level submit pipeline (`soroban-submit.ts`) to expose the four
 * operations D2/D9 scope for this PR: `depositToVault`,
 * `withdrawFromVault`, `transferShares`, `readVaultState`.
 *
 * ADR 049 records why this is hand-rolled on `@stellar/stellar-sdk`
 * rather than `@defindex/sdk` (a hosted-API client, not a local
 * transaction builder — unsuitable for a money-moving path).
 *
 * V2 is a CLIENT LIBRARY ONLY — nothing here is wired into the
 * emission/withdraw flows yet (that's ADR 031 §D5/§D6, later PRs).
 * Every function still asserts `vaultsEnabled()` first, belt-and-
 * suspenders with the fact that nothing calls these yet.
 *
 * Operator signing (ADR 031 §D1): every call here signs with
 * `LOOP_STELLAR_OPERATOR_SECRET` — the SAME key `payments/payout-
 * submit.ts` uses for Horizon payouts (ADR 016). No new signing key
 * is introduced. `transferShares({ signWith: 'provider' })` is a
 * deliberate stub — see its doc comment — for the ADR 030
 * wallet-provider-signed user→operator transfer, which is V4's job,
 * not V2's.
 */
import { Keypair, Networks, scValToNative, type xdr } from '@stellar/stellar-sdk';
import { env } from '../../env.js';
import { vaultsEnabled, type LoopVaultRow } from './registry.js';
import {
  encodeAddress,
  encodeBool,
  encodeI128,
  encodeI128Vec,
  decodeI128,
  decodeI128Vec,
  decodeVecElements,
  VaultResultParseError,
} from './scval.js';
import { submitSorobanInvocation, simulateSorobanCall } from './soroban-submit.js';

/** Thrown by every exported function here when `LOOP_VAULTS_ENABLED` is false. */
export class VaultDisabledError extends Error {
  constructor() {
    super(
      'Vault subsystem is disabled (LOOP_VAULTS_ENABLED=false) — refusing to build a Soroban vault call (ADR 031)',
    );
    this.name = 'VaultDisabledError';
  }
}

/**
 * Thrown for a PRE-FLIGHT slippage/amount violation — a missing/zero/
 * non-bigint floor or amount caught BEFORE any transaction is built.
 * Nothing moved on-chain; the caller can fix the args and retry safely.
 */
export class VaultSlippageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultSlippageError';
  }
}

/**
 * Thrown when the slippage floor is violated by the CHAIN-RETURNED
 * result — i.e. AFTER the transaction has already landed on-chain.
 * Distinct from `VaultSlippageError` because the semantics for the
 * caller are opposite: a `VaultSlippageError` means "nothing happened,
 * retry"; a `VaultPostSubmitSlippageError` means "the tx DID land
 * (shares were minted / burned) but returned less than the floor —
 * do NOT retry or refund blindly; reconcile against `txHash` first".
 * Carries the landed `txHash` so a V3 caller can look up what actually
 * happened.
 */
export class VaultPostSubmitSlippageError extends Error {
  readonly txHash: string;
  constructor(message: string, txHash: string) {
    super(message);
    this.name = 'VaultPostSubmitSlippageError';
    this.txHash = txHash;
  }
}

/** Thrown when required config (RPC URL, operator secret) is missing despite the subsystem being enabled. */
export class VaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultConfigError';
  }
}

/** Thrown by `transferShares({ signWith: 'provider' })` — see its doc comment. */
export class VaultNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultNotImplementedError';
  }
}

function requireVaultsEnabled(): void {
  if (!vaultsEnabled()) throw new VaultDisabledError();
}

/**
 * Refuses any amount / slippage floor that is not a positive bigint.
 * The `typeof` guard is load-bearing: a plain `x <= 0n` comparison
 * does NOT fire for `undefined` (`undefined <= 0n` is `false`), and an
 * `undefined` amount would then reach `nativeToScVal(undefined, {type:
 * 'i128'})` — which encodes as `scvVoid`, i.e. an UNBOUNDED slippage
 * floor / a void amount silently reaching the contract. So every
 * caller-supplied amount and floor must pass THIS, not a bare
 * comparison. TypeScript types these as `bigint`, but a JS caller (or
 * a value that widened through `any`/`unknown` upstream) can still
 * pass `undefined`/a number, so the runtime check is mandatory on a
 * money path.
 */
function assertPositiveBigint(value: unknown, label: string): asserts value is bigint {
  if (typeof value !== 'bigint' || value <= 0n) {
    throw new VaultSlippageError(
      `${label} must be a positive bigint (a missing/zero/non-bigint amount or slippage floor is refused before building any tx — ADR 031), got ${
        typeof value === 'bigint' ? value.toString() : `${typeof value} (${String(value)})`
      }`,
    );
  }
}

function networkPassphraseFor(network: LoopVaultRow['network']): string {
  return network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET;
}

function resolveRpcUrl(): string {
  if (env.LOOP_SOROBAN_RPC_URL === undefined) {
    throw new VaultConfigError(
      'LOOP_SOROBAN_RPC_URL is not set — cannot reach the Soroban RPC endpoint (ADR 031). ' +
        'env.ts should have refused to boot with LOOP_VAULTS_ENABLED=true and no RPC URL configured; ' +
        'seeing this error means that guard was bypassed (e.g. a test stubbing env directly).',
    );
  }
  return env.LOOP_SOROBAN_RPC_URL;
}

function resolveOperatorSecret(): string {
  if (env.LOOP_STELLAR_OPERATOR_SECRET === undefined) {
    throw new VaultConfigError(
      'LOOP_STELLAR_OPERATOR_SECRET is not set — cannot sign a vault call (ADR 031)',
    );
  }
  return env.LOOP_STELLAR_OPERATOR_SECRET;
}

/**
 * The operator's Stellar public key — the `from` of an
 * operator-signed share transfer (ADR 031 §D5 step 3, V3) and the
 * implicit signer/source of `depositToVault`/`withdrawFromVault`
 * above. Exported (unlike `resolveOperatorSecret`) because
 * `credits/vaults/vault-emissions.ts` needs the PUBLIC key to build
 * `transferShares({ from: ..., to: userWallet })` without duplicating
 * the env read + `Keypair.fromSecret` derivation this module already
 * does internally. Does NOT gate on `vaultsEnabled()` — it's a pure
 * derivation from config, not a network call; callers already sit
 * behind their own `vaultsEnabled()` check.
 */
export function resolveOperatorPublicKey(): string {
  return Keypair.fromSecret(resolveOperatorSecret()).publicKey();
}

/**
 * Threads the CF-18 fields into a `submitSorobanInvocation` call.
 * `onSigned` is REQUIRED on the money-submit path (see
 * `SubmitSorobanInvocationArgs`), so it's always passed. `priorTxHash`
 * is genuinely optional (only present on a retry), and under
 * `exactOptionalPropertyTypes` (repo-wide tsconfig) an explicit
 * `{ priorTxHash: undefined }` is a type error against a
 * `priorTxHash?: string` field — the key must be OMITTED, hence the
 * conditional spread.
 */
function cf18Fields(
  priorTxHash: string | undefined,
  onSigned: (txHash: string) => Promise<void> | void,
): { priorTxHash?: string; onSigned: (txHash: string) => Promise<void> | void } {
  return {
    onSigned,
    ...(priorTxHash !== undefined ? { priorTxHash } : {}),
  };
}

// ---------------------------------------------------------------------------
// deposit
// ---------------------------------------------------------------------------

export interface DepositToVaultArgs {
  vault: LoopVaultRow;
  /** Underlying amount to deposit, in the underlying asset's smallest unit. Must be > 0. */
  underlyingAmount: bigint;
  /**
   * Slippage floor — MANDATORY, must be > 0 (an absent/zero floor is
   * refused before any network call). Passed into the contract's
   * `amounts_min` positional slot per ADR 031 §D2's exact build spec:
   * `deposit([underlyingAmount], [minShares], operator, true)`. Note
   * that DeFindex's real `amounts_min` semantics are a floor on
   * `amounts_used` (the underlying actually pulled in), not literally
   * on `shares_minted` — this function ALSO asserts
   * `sharesMinted >= minShares` against the chain-returned result
   * after execution, so the caller's actual intent ("I want at least
   * this many shares") is enforced regardless of what the raw
   * contract parameter technically bounds.
   */
  minShares: bigint;
  /** CF-18: a hash persisted from a prior attempt, if any — see `soroban-submit.ts`. */
  priorTxHash?: string;
  /**
   * CF-18: fired with the deterministic tx hash after sign, before
   * submit — persist it durably so a retry can pass it back as
   * `priorTxHash`. REQUIRED (see `soroban-submit.ts`): at-most-once on
   * a money path depends on it, so it is not optional.
   */
  onSigned: (txHash: string) => Promise<void> | void;
}

export interface DepositToVaultResult {
  txHash: string;
  sharesMinted: bigint;
  amountsUsed: bigint[];
  /** true when a `priorTxHash` was already confirmed on-chain and nothing new was submitted. */
  deduped: boolean;
}

/** `deposit(amounts_desired=[underlyingAmount], amounts_min=[minShares], from=operator, invest=true)`. */
export async function depositToVault(args: DepositToVaultArgs): Promise<DepositToVaultResult> {
  requireVaultsEnabled();
  assertPositiveBigint(args.underlyingAmount, 'depositToVault: underlyingAmount');
  assertPositiveBigint(args.minShares, 'depositToVault: minShares (slippage floor)');

  const operatorSecret = resolveOperatorSecret();
  const operatorPublicKey = Keypair.fromSecret(operatorSecret).publicKey();

  const result = await submitSorobanInvocation({
    rpcUrl: resolveRpcUrl(),
    networkPassphrase: networkPassphraseFor(args.vault.network),
    signerSecret: operatorSecret,
    contractId: args.vault.vaultContractId,
    functionName: 'deposit',
    args: [
      encodeI128Vec([args.underlyingAmount]),
      encodeI128Vec([args.minShares]),
      encodeAddress(operatorPublicKey),
      encodeBool(true),
    ],
    ...cf18Fields(args.priorTxHash, args.onSigned),
  });

  const { amountsUsed, sharesMinted } = parseDepositReturn(result.returnValue);

  if (sharesMinted < args.minShares) {
    // POST-submit: the deposit ALREADY landed (shares were minted to
    // the operator) but returned fewer than the floor. This is NOT a
    // pre-flight refusal — do not retry blindly. Distinct error type
    // carries the landed txHash for reconciliation (P2-7).
    throw new VaultPostSubmitSlippageError(
      `depositToVault: chain returned ${sharesMinted} shares, below the caller's minShares floor of ${args.minShares} — the tx LANDED (reconcile against txHash, do not blindly retry)`,
      result.txHash,
    );
  }

  return { txHash: result.txHash, sharesMinted, amountsUsed, deduped: result.deduped };
}

/**
 * `deposit`'s return is documented as `(Vec<i128> amounts_used, i128
 * shares_minted, ...)` — a tuple, which the Soroban SDK serializes as
 * a `Vec` of the tuple's elements. Element 0 is the amounts-used vec,
 * element 1 is the shares-minted scalar.
 */
function parseDepositReturn(retval: xdr.ScVal): { amountsUsed: bigint[]; sharesMinted: bigint } {
  const elements = decodeVecElements(retval);
  const amountsUsedVal = elements[0];
  const sharesMintedVal = elements[1];
  if (amountsUsedVal === undefined || sharesMintedVal === undefined) {
    throw new VaultResultParseError(
      'deposit return value did not have the expected (amounts_used, shares_minted, ...) shape',
    );
  }
  return {
    amountsUsed: decodeI128Vec(amountsUsedVal),
    sharesMinted: decodeI128(sharesMintedVal),
  };
}

// ---------------------------------------------------------------------------
// withdraw
// ---------------------------------------------------------------------------

export interface WithdrawFromVaultArgs {
  vault: LoopVaultRow;
  /** Vault shares to burn. Must be > 0. */
  shares: bigint;
  /** Slippage floor on the underlying returned — MANDATORY, must be > 0. */
  minAmountsOut: bigint;
  priorTxHash?: string;
  /** CF-18: required — persist durably, pass back as `priorTxHash` on retry (see `soroban-submit.ts`). */
  onSigned: (txHash: string) => Promise<void> | void;
}

export interface WithdrawFromVaultResult {
  txHash: string;
  amountsOut: bigint[];
  deduped: boolean;
}

/** `withdraw(withdraw_shares=shares, min_amounts_out=[minAmountsOut], from=operator)`. */
export async function withdrawFromVault(
  args: WithdrawFromVaultArgs,
): Promise<WithdrawFromVaultResult> {
  requireVaultsEnabled();
  assertPositiveBigint(args.shares, 'withdrawFromVault: shares');
  assertPositiveBigint(args.minAmountsOut, 'withdrawFromVault: minAmountsOut (slippage floor)');

  const operatorSecret = resolveOperatorSecret();
  const operatorPublicKey = Keypair.fromSecret(operatorSecret).publicKey();

  const result = await submitSorobanInvocation({
    rpcUrl: resolveRpcUrl(),
    networkPassphrase: networkPassphraseFor(args.vault.network),
    signerSecret: operatorSecret,
    contractId: args.vault.vaultContractId,
    functionName: 'withdraw',
    args: [
      encodeI128(args.shares),
      encodeI128Vec([args.minAmountsOut]),
      encodeAddress(operatorPublicKey),
    ],
    ...cf18Fields(args.priorTxHash, args.onSigned),
  });

  // `parseWithdrawReturn` throws `VaultResultParseError` on an empty
  // return BEFORE this point (P2-2), so `amountsOut` is guaranteed
  // non-empty here — the slippage loop below can never be silently
  // skipped over a zero-length result.
  const { amountsOut } = parseWithdrawReturn(result.returnValue);

  for (const amount of amountsOut) {
    if (amount < args.minAmountsOut) {
      // POST-submit: shares already burned. Distinct error + txHash (P2-7).
      throw new VaultPostSubmitSlippageError(
        `withdrawFromVault: chain returned ${amount}, below the caller's minAmountsOut floor of ${args.minAmountsOut} — the tx LANDED (reconcile against txHash, do not blindly retry)`,
        result.txHash,
      );
    }
  }

  return { txHash: result.txHash, amountsOut, deduped: result.deduped };
}

/**
 * `withdraw`'s exact return shape (a bare `Vec<i128>` of amounts
 * released vs. a tuple wrapping one) is UNVERIFIED against a real
 * deployed vault — see ADR 049 §Negative. Handled defensively: if the
 * outer Vec's first element is itself a Vec, treat the outer value as
 * a tuple and unwrap; otherwise treat the outer value directly as the
 * amounts-out vec.
 *
 * Requires at least one amount (the vaults are single-asset, so a real
 * `withdraw` always releases exactly one underlying amount). An empty
 * result — from an unexpected return shape, an index-lagged read, or a
 * partial decode — throws `VaultResultParseError` rather than being
 * mistaken for "released nothing, but succeeded": returning
 * `amountsOut: []` past a caller that burned shares is a mirror-desync
 * vector (P2-2), so it fails CLOSED here.
 */
function parseWithdrawReturn(retval: xdr.ScVal): { amountsOut: bigint[] } {
  const elements = decodeVecElements(retval);
  const first = elements[0];
  const amountsOut =
    first !== undefined && first.switch().name === 'scvVec'
      ? decodeI128Vec(first)
      : decodeI128Vec(retval);
  if (amountsOut.length === 0) {
    throw new VaultResultParseError(
      'withdraw returned an empty amounts-out vec — refusing to treat a shares-burning withdraw as having released nothing (single-asset vault must release ≥1 amount)',
    );
  }
  return { amountsOut };
}

// ---------------------------------------------------------------------------
// transfer (share token)
// ---------------------------------------------------------------------------

export interface TransferSharesArgs {
  vault: LoopVaultRow;
  from: string;
  to: string;
  /** Shares to transfer. Must be > 0. */
  amount: bigint;
  /**
   * `'operator'` (V2, implemented + tested): the operator signs the
   * transfer — the emission path (operator → user) and any
   * operator-initiated rebalancing. `'provider'` (V4, a deliberate
   * stub — see below): the ADR 030 wallet-provider signs a
   * user-initiated transfer (user → operator on withdraw). ADR 031
   * §D1 scopes the user-wallet-signing surface to exactly this one
   * call; V2 does not build it.
   */
  signWith: 'operator' | 'provider';
  priorTxHash?: string;
  /** CF-18: required — persist durably, pass back as `priorTxHash` on retry (see `soroban-submit.ts`). */
  onSigned: (txHash: string) => Promise<void> | void;
}

export interface TransferSharesResult {
  txHash: string;
  deduped: boolean;
}

/**
 * SEP-41 `transfer(from, to, amount)` on the vault's share-token
 * contract (`vault.shareAssetIssuer` — the share token's contract
 * address, per the V1 registry schema's naming, distinct from
 * `vault.vaultContractId` which is the DeFindex vault contract
 * `deposit`/`withdraw` are invoked against).
 */
export async function transferShares(args: TransferSharesArgs): Promise<TransferSharesResult> {
  requireVaultsEnabled();
  assertPositiveBigint(args.amount, 'transferShares: amount');

  if (args.signWith === 'provider') {
    // TODO(ADR 031 §D6, V4): user-wallet-signed share transfer via the
    // ADR 030 wallet-provider abstraction (policy-gated server signing
    // of `transfer(from=user, to=operator)`). Deliberately NOT built
    // here — V2's scope is the operator-signed path only. Wiring this
    // requires the provider's Soroban-token-transfer capability
    // (`wallet/provider.ts`), which is a separate PR's job.
    throw new VaultNotImplementedError(
      "transferShares: signWith='provider' is not implemented in V2 " +
        '(ADR 031 §D6/V4 — user-wallet-signed transfers land in a later PR)',
    );
  }

  const operatorSecret = resolveOperatorSecret();

  const result = await submitSorobanInvocation({
    rpcUrl: resolveRpcUrl(),
    networkPassphrase: networkPassphraseFor(args.vault.network),
    signerSecret: operatorSecret,
    contractId: args.vault.shareAssetIssuer,
    functionName: 'transfer',
    args: [encodeAddress(args.from), encodeAddress(args.to), encodeI128(args.amount)],
    ...cf18Fields(args.priorTxHash, args.onSigned),
  });

  return { txHash: result.txHash, deduped: result.deduped };
}

// ---------------------------------------------------------------------------
// read state
// ---------------------------------------------------------------------------

export interface ReadVaultStateArgs {
  vault: LoopVaultRow;
}

export interface VaultState {
  totalSupply: bigint;
  totalManaged: bigint;
  /** Parts-per-million of underlying per share — matches V1's `share_price_ppm` column (1_050_000 = 1.05 underlying/share). */
  sharePricePpm: bigint;
}

/** `total_supply()` + `fetch_total_managed_funds()` → `sharePricePpm = totalManaged * 1_000_000 / totalSupply`. */
export async function readVaultState(args: ReadVaultStateArgs): Promise<VaultState> {
  requireVaultsEnabled();

  const rpcUrl = resolveRpcUrl();
  const networkPassphrase = networkPassphraseFor(args.vault.network);
  const operatorSecret = resolveOperatorSecret();

  const supplyRetval = await simulateSorobanCall({
    rpcUrl,
    networkPassphrase,
    sourceSecret: operatorSecret,
    contractId: args.vault.vaultContractId,
    functionName: 'total_supply',
    args: [],
  });
  const totalSupply = decodeI128(supplyRetval);

  const managedRetval = await simulateSorobanCall({
    rpcUrl,
    networkPassphrase,
    sourceSecret: operatorSecret,
    contractId: args.vault.vaultContractId,
    functionName: 'fetch_total_managed_funds',
    args: [],
  });
  const totalManaged = parseTotalManagedFunds(managedRetval);

  // Fresh vault, no shares yet: 1:1 is the standard first-depositor
  // convention (avoids a divide-by-zero rather than encoding a
  // meaningless price).
  const sharePricePpm = totalSupply === 0n ? 1_000_000n : (totalManaged * 1_000_000n) / totalSupply;

  return { totalSupply, totalManaged, sharePricePpm };
}

/**
 * `fetch_total_managed_funds()` returns `Vec<AssetManagedFunds>` per
 * the DeFindex REST API's TS types (used here only as a proxy for the
 * on-chain struct layout — UNVERIFIED against a real deployed vault,
 * see ADR 049 §Negative). Each entry decodes (via `scValToNative`) to
 * a plain object with a `total_amount` field for a single-asset
 * vault's one entry; summed defensively in case of multiple entries.
 * A shape that doesn't match throws rather than silently returning 0.
 */
function parseTotalManagedFunds(retval: xdr.ScVal): bigint {
  const native = scValToNative(retval);
  const entries: unknown[] = Array.isArray(native) ? native : [native];
  // An empty vec must THROW, not sum to 0n. A wrongly-NAMED field
  // already throws (via `coerceBigInt`), but an empty array would
  // silently yield 0 → `sharePricePpm` collapses to 0 against a real
  // `totalSupply` (the `totalSupply === 0n` guard in `readVaultState`
  // does NOT cover a populated supply with a zero-length managed-funds
  // read). Closing that asymmetry: unreadable managed funds fail
  // CLOSED (P1-3).
  if (entries.length === 0) {
    throw new VaultResultParseError(
      'fetch_total_managed_funds returned an empty vec — refusing to treat unreadable managed funds as 0 (would collapse sharePricePpm to 0 against a real total_supply)',
    );
  }
  let total = 0n;
  for (const entry of entries) {
    total += extractTotalAmount(entry);
  }
  return total;
}

function extractTotalAmount(entry: unknown): bigint {
  if (entry !== null && typeof entry === 'object' && 'total_amount' in entry) {
    return coerceBigInt((entry as Record<string, unknown>)['total_amount']);
  }
  // Fallback: fetch_total_managed_funds might return a bare i128
  // total directly for a single-asset vault rather than a struct
  // array — also unverified, kept as a defensive fallback.
  return coerceBigInt(entry);
}

function coerceBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new VaultResultParseError(
    `fetch_total_managed_funds: could not coerce ${JSON.stringify(value)} to bigint`,
  );
}
