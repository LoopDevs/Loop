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

/** Thrown when a mandatory slippage floor is missing/zero, or the chain-returned amount violates it. */
export class VaultSlippageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultSlippageError';
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
 * `exactOptionalPropertyTypes` (repo-wide tsconfig setting) means an
 * explicit `{ priorTxHash: undefined }` is a type error against a
 * `priorTxHash?: string` field — the key must be OMITTED, not merely
 * `undefined`-valued. Every `submitSorobanInvocation` call site below
 * shares this same "pass CF-18 fields through only when the caller
 * supplied them" spread.
 */
function cf18Fields(
  priorTxHash: string | undefined,
  onSigned: ((txHash: string) => Promise<void> | void) | undefined,
): { priorTxHash?: string; onSigned?: (txHash: string) => Promise<void> | void } {
  return {
    ...(priorTxHash !== undefined ? { priorTxHash } : {}),
    ...(onSigned !== undefined ? { onSigned } : {}),
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
  /** CF-18: fired with the deterministic tx hash after sign, before submit. */
  onSigned?: (txHash: string) => Promise<void> | void;
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
  if (args.underlyingAmount <= 0n) {
    throw new VaultSlippageError('depositToVault: underlyingAmount must be > 0');
  }
  if (args.minShares <= 0n) {
    throw new VaultSlippageError(
      'depositToVault: minShares must be > 0 — an absent/zero slippage floor is refused (ADR 031)',
    );
  }

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
    throw new VaultSlippageError(
      `depositToVault: chain returned ${sharesMinted} shares, below the caller's minShares floor of ${args.minShares}`,
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
  onSigned?: (txHash: string) => Promise<void> | void;
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
  if (args.shares <= 0n) {
    throw new VaultSlippageError('withdrawFromVault: shares must be > 0');
  }
  if (args.minAmountsOut <= 0n) {
    throw new VaultSlippageError(
      'withdrawFromVault: minAmountsOut must be > 0 — an absent/zero slippage floor is refused (ADR 031)',
    );
  }

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

  const { amountsOut } = parseWithdrawReturn(result.returnValue);

  for (const amount of amountsOut) {
    if (amount < args.minAmountsOut) {
      throw new VaultSlippageError(
        `withdrawFromVault: chain returned ${amount}, below the caller's minAmountsOut floor of ${args.minAmountsOut}`,
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
 */
function parseWithdrawReturn(retval: xdr.ScVal): { amountsOut: bigint[] } {
  const elements = decodeVecElements(retval);
  const first = elements[0];
  if (first !== undefined && first.switch().name === 'scvVec') {
    return { amountsOut: decodeI128Vec(first) };
  }
  return { amountsOut: decodeI128Vec(retval) };
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
  onSigned?: (txHash: string) => Promise<void> | void;
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
  if (args.amount <= 0n) {
    throw new VaultSlippageError('transferShares: amount must be > 0');
  }

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
