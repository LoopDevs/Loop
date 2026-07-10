# ADR 049: Soroban vault client is hand-rolled on `@stellar/stellar-sdk` — no `@defindex/sdk` dependency

Status: Accepted
Date: 2026-07-10
Related: ADR 031 (per-currency yield architecture — §Detailed design D1/D2), ADR 016 (Stellar SDK payout submit), ADR 019 (shared-package policy's "justify every dependency" spirit extended to backend deps)

## Context

ADR 031 §Detailed design D9 step 2 calls for building "the Soroban deposit/redeem/transfer integration" for the LOOPUSD/LOOPEUR DeFindex vaults (V1 — schema + read-layer registry — shipped in #1645). D2 specifies the interaction spec against the vault ABI (`deposit`, `withdraw`, `total_supply`, `fetch_total_managed_funds`, the share-token `transfer`) and says plainly: "Vault calls use `@stellar/stellar-sdk` against the Soroban RPC, operator-signed."

Before writing that client, this ADR evaluates whether `@defindex/sdk` (the official DeFindex npm package) should be used to build the unsigned transactions, per repo policy that any new dependency needs an ADR before `npm install` (AGENTS.md "Documentation update rules").

## Investigation

`@defindex/sdk` exists on npm (`0.3.0`, MIT, published ~3 months ago, maintained by the PaltaLabs/DeFindex team). It was pulled and inspected directly (`npm pack @defindex/sdk@0.3.0`, unpacked, read `dist/*.d.ts` + `README.md`) rather than trusted from its description:

- **It is an HTTP client to DeFindex's hosted API**, not a local Soroban-transaction builder. Its only runtime dependency is `axios`; it does **not** depend on `@stellar/stellar-sdk` or `@stellar/stellar-base` at all. Every method (`depositToVault`, `withdrawFromVault`, `getVaultInfo`, …) is a `POST`/`GET` to `https://api.defindex.io` (configurable `baseUrl`), authenticated with a bearer `DEFINDEX_API_KEY`. The **remote API** builds the XDR server-side and returns it to the caller; the SDK itself does no ABI encoding, no ScVal construction, no local simulation.
- **Money amounts are typed as JS `number`**, not `bigint` or decimal-string (`DepositParams.amounts: number[]`, `WithdrawParams.amounts: number[]`, `WithdrawSharesParams.shares: number`). `number` loses precision above 2^53 and is inconsistent with every other money-moving primitive in this codebase (`payments/payout-submit.ts` takes `amountStroops: bigint`; the ledger is bigint-minor-units throughout).
- The README's own "Current Status" section flags immaturity: "APY Calculation: Working but some fields may be undefined for new vaults."
- Using it would mean every deposit/withdraw depends on a **third party's hosted service being up and correctly authenticated** as a hard runtime dependency of Loop's money-movement path — not just a client library, an operational dependency (availability, auth, potential rate limits) that ADR 031 D2 never assumed and that doesn't exist for any other Stellar operation in this codebase (Horizon submissions go through Loop-controlled `@stellar/stellar-sdk` calls against public/self-hosted infrastructure, never a third party's proprietary API).

## Decision

**Hand-roll the vault client on `@stellar/stellar-sdk`, already a dependency (`15.1.0`) used for every other Stellar operation in this repo (`payments/payout-submit.ts`, `payments/horizon*.ts`, `payments/issuer-signers.ts`). No new dependency is added.**

Verified (via `npm pack @stellar/stellar-sdk@15.1.0` + `@stellar/stellar-base@15.0.0` and reading their shipped `.d.ts`) that everything ADR 031 D2's spec needs is already present:

- `rpc.Server` (`@stellar/stellar-sdk/rpc` or the `rpc` namespace export) — `getAccount`, `simulateTransaction`, `prepareTransaction` (simulate+assemble in one call), `sendTransaction`, `getTransaction`, `pollTransaction`, plus `Api.isSimulationError` / `Api.isSimulationSuccess` / `Api.GetTransactionStatus` / `assembleTransaction` for the manual simulate→assemble path.
- `Contract` (from `@stellar/stellar-base`, re-exported at the SDK's root) — `new Contract(contractId).call(method, ...args: xdr.ScVal[])` builds the `invokeHostFunction` operation directly; `contract.call()` is exactly the "one line" primitive the ABI in D2 needs.
- `Address`, `nativeToScVal`, `scValToNative` — encode/decode the `Address`, `i128`, `Vec<i128>`, and `bool` argument/return types the vault ABI uses (`deposit(Vec<i128>, Vec<i128>, Address, bool)`, `withdraw(i128, Vec<i128>, Address)`, `transfer(Address, Address, i128)`, `total_supply() -> i128`).
- `xdr.HostFunction` / `xdr.InvokeContractArgs` (`.contractAddress()`, `.functionName()`, `.args()`) — needed to **decode a built transaction back out** for the mandatory verify-before-sign check (ADR 031's money-review requirement); this only works because we control transaction construction end-to-end, not because a remote API handed us an opaque XDR blob to trust.

Everything is reachable from the SDK's public entrypoints (`.`, `./rpc`) with no subpath-export friction.

## Consequences

### Positive

- **No new dependency, no new secret.** `LOOP_STELLAR_OPERATOR_SECRET` (already used for payouts, ADR 016) signs vault calls too — nothing new to provision, rotate, or leak. `package.json`/`package-lock.json` are untouched by this PR.
- **No new external runtime dependency in the money path.** A deposit/withdraw depends only on Loop's own code + a Soroban RPC endpoint (self-selectable, `LOOP_SOROBAN_RPC_URL`) + the deployed DeFindex vault contract on-chain — the same trust boundary shape as every other Stellar operation in this repo, not an additional third-party API with its own uptime/auth/rate-limit surface.
- **bigint amounts throughout**, matching the ledger and `payout-submit.ts` convention — no `number`-precision footgun on a money-moving path.
- **Verify-before-sign is meaningful and cheap**: because Loop's own code constructs the ScVal args from typed `bigint`/`string` inputs and the transaction locally, decoding the built op and asserting contract id / function name / args before signing catches a bug in _our_ encoding path (wrong registry row, swapped `from`/`to`, stale contract id) — exactly the class of mistake ADR 031's money-review flagged as the reason verify-before-sign is mandatory, "NEVER blindly sign whatever the SDK (or your builder) produced."
- Matches ADR 031 §D2 exactly as written — no architecture drift to reconcile later.

### Negative / acknowledged

- More code to write and test than "call `sdk.depositToVault(...)`, sign the returned XDR" — Loop owns the ScVal encoding, the simulate→assemble→sign→send→poll pipeline, and the error classification that `@defindex/sdk` (or a hand-rolled client either way) would otherwise abstract. Judged worth it: this is a money-moving path, and owning the construction is what makes verify-before-sign possible in the first place.
- The exact on-chain XDR shape of `fetch_total_managed_funds()`'s return value (a `Vec<AssetManagedFunds>`-shaped struct per the DeFindex REST API's TS types, used here only as a proxy for the on-chain struct layout — this repo has never called the real contract) is **unverified against a real deployed vault**. `vault-client.ts`'s `readVaultState` decodes it defensively (walks whatever `scValToNative` returns and sums recognizable `total_amount`-shaped fields) and throws a typed, clearly-labeled error rather than silently returning a wrong number if the shape doesn't match what's expected — but this needs revalidation against a real testnet vault before D9 step 4 (extending the drift/solvency watchers) depends on it. Tracked as a follow-up in the V2 PR description, not blocking V2 (mock-tested only, not wired into any flow).
- Should `@defindex/sdk` mature (a future version that builds XDR locally against `@stellar/stellar-sdk` rather than a hosted API, with `bigint` amounts) it may become worth revisiting — re-open this ADR rather than silently swapping later.

## Alternatives considered

1. **`@defindex/sdk` as the transaction builder.** Rejected — see Investigation. Hosted-API dependency + `number`-typed amounts are both disqualifying for a money-moving client, independent of maturity.
2. **`@defindex/sdk` for reads only (`getVaultInfo`, `getVaultAPY`), hand-rolled for writes.** Considered and rejected for simplicity: `readVaultState` needs the exact same RPC connection and ScVal decoding machinery the write path needs, and splitting the read/write client across two different transports (a REST API for reads, direct RPC for writes) adds an inconsistency with no real benefit — both still need `LOOP_SOROBAN_RPC_URL` reachable, and D2 already scopes the read spec (`total_supply()` + `fetch_total_managed_funds()`) as direct contract calls.
3. **Hand-roll with a lower-level Soroban binding than `@stellar/stellar-sdk`** (e.g. raw `js-xdr` + hand-built envelopes). Rejected — `@stellar/stellar-sdk`'s `Contract`/`rpc.Server`/`nativeToScVal` already provide exactly what's needed at the right abstraction level; going lower would just re-implement what the SDK already does correctly.
