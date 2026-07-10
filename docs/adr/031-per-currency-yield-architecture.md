# ADR 031: Per-currency yield via Loop-curated vaults and treasury

Status: Proposed — **detailed to build-ready 2026-07-10** (deploy-by-config confirmed → no from-scratch contract audit; Privy downgraded from critical-path blocker to assumption + fallback per operator; full implementation spec added under §Detailed design). Remaining for **Accepted**: signing-path chosen (D1), vault config review + Blend/DeFindex protocol DD, counsel sign-off.
Date: 2026-05-05 (six iterations mid-session — see Decision history); detailed 2026-07-10
Supersedes: ADR 015 §"Defindex deposit automation — currently manual ops top-up" — replaced by Loop-curated DeFindex vaults backing LOOPUSD/LOOPEUR + treasury-managed yield for GBPLOOP.
Amends: ADR 015 §"Loop issues three branded Stellar assets" — three Loop-branded yield assets retained, with LOOP-prefix naming. LOOPUSD and LOOPEUR are DeFindex vault shares (Soroban) where Loop is the curator. GBPLOOP is a Stellar classic asset, 1:1 backed, since no Stellar GBP yield primitive exists. GBPLOOP retains its existing name — the v6 LOOPGBP rename was dropped in v7. None of the three assets has been issued in production.
Related: ADR 015 (stablecoin topology — amended), ADR 016 (operator-signed payouts), ADR 030 (Privy wallet)

## Decision history (intra-session, 2026-05-05)

This ADR went through six iterations during the 2026-05-05 design session. The full trail is preserved here so future readers understand the path.

- **v1 (rejected):** Loop-curated DeFindex vaults at thin fees (~50 bps mgmt). Revenue too small.
- **v2 (rejected):** Loop-issued 1:1 stablecoins all currencies + 4% off-chain accrual. Triples regulatory weight (multi-currency stablecoin issuance).
- **v3 (rejected):** Curator vaults with high fees, dfTokens visible to users with raw "df" prefix. Two-asset framing confusing.
- **v4 (rejected):** Branded Soroban vault tokens. Privy Soroban support became load-bearing DD; momentarily abandoned for v5 to skirt the blocker.
- **v5 (rejected):** All three currencies as Loop-issued Stellar **classic** assets, 1:1 backed, off-chain 4% accrual; backing for USD/EUR in Loop-curated vaults invisibly. Misread the user's "LOOP prefix differentiates from DeFindex shares" — interpreted as "not a vault share" when it actually meant "Loop is the curator, not Beans/etc." Reverted in v6.
- **v6 (rejected):** LOOPUSD and LOOPEUR as Loop-curated DeFindex vault shares; GBPLOOP renamed to LOOPGBP for naming consistency; 4% off-chain accrual on GBP at withdraw. Mostly correct, but rename was unwanted churn and accrual cadence/rate weren't right.
- **v7 (current):** Same as v6 except: GBPLOOP retains its existing name (no rename — currency-prefix asymmetry vs LOOP-prefix on vault shares is acceptable). GBP user-facing rate is **3% APY**, not 4%. GBP interest pays out **nightly** as on-chain GBPLOOP transfers (not on-withdraw lump sum). Privy is the primary wallet vendor with dfns documented as fallback if Privy's Soroban custody DD fails (ADR 030).

## Context

Tranche 2 acceptance: "Verify receipt of yield from held funds." Tranche 3 hedges: "Mainnet real yield on holdings (USDC definite, GBP/EUR/CAD dependent on provider availability)."

Per the 2026-05-05 product decision:

- Loop captures meaningful revenue from yield (target: ~50% of underlying)
- Variable user-facing APY is acceptable (no "fixed 4%" promise needed)
- Display: past-30-day realised APY with standard "no guarantee" disclaimer
- No yield-source disclosure: users see APY number only, never "Blend / DeFindex / strategy"
- Cashback always lands in user's home currency regardless of catalog currency (existing FX-pin per ADR 015)

The Stellar yield ecosystem provides on-chain primitives for USDC/EURC (Blend lending, accessible via DeFindex curator vaults). It does not yet provide one for GBP. The architecture asymmetry below reflects this.

## Decision

### Three Loop-branded yield assets, two architectures

| Asset       | Form                                  | Curator | Backing / strategy                                       | Fee structure      | User APY                                                           |
| ----------- | ------------------------------------- | ------- | -------------------------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| **LOOPUSD** | Soroban DeFindex vault share          | Loop    | USDC routed to Blend USDC pool                           | 0% mgmt + 50% perf | Past 30-day realised, ~3% at current rates                         |
| **LOOPEUR** | Soroban DeFindex vault share          | Loop    | EURC routed to Blend EURC pool                           | 0% mgmt + 50% perf | Past 30-day realised, ~4.6% at current rates                       |
| **GBPLOOP** | Stellar classic asset, 1:1 GBP-backed | n/a     | GBP fiat in Loop's treasury (UK custodian / MMF / gilts) | n/a                | **3% APY fixed**, paid nightly as on-chain GBPLOOP mint to holders |

GBPLOOP retains its existing name from ADR 015. The naming asymmetry (GBPLOOP currency-prefix vs LOOPUSD/LOOPEUR LOOP-prefix) reflects the structural asymmetry: GBPLOOP is a Loop-issued 1:1-backed stablecoin; LOOPUSD/LOOPEUR are Loop-curated DeFindex vault shares. Different asset classes, different naming.

### LOOPUSD and LOOPEUR — Loop-curated DeFindex vaults

Loop deploys two DeFindex curator vaults on Stellar Soroban — `LOOP_USD_VAULT` and `LOOP_EUR_VAULT`. The share token issued by each vault is the user-facing asset: LOOPUSD and LOOPEUR respectively. **Users hold the vault share token directly in their Privy wallet.** The LOOP prefix denotes Loop's curator role (distinct from BEANSEURC, BEANSXLM, and other DeFindex vaults curated by other parties).

Vault structure:

- **Underlying strategy**: single audited venue per vault — Blend USDC pool for LOOPUSD; Blend EURC pool for LOOPEUR. No multi-strategy rebalancing in v1.
- **Share-price model**: non-rebasing. User's LOOPUSD count is fixed; share price grows with `(strategy_yield − fees) × time`. UI computes effective USD/EUR value as `share_balance × current_share_price`.
- **Fee schedule**: performance-fee-only (0% management), set at vault creation and Manager-adjustable — this matches DeFindex's stock model (see the 2026-07-10 finding below). The performance fee is taken from strategy gains at the vault-contract level before the share-price update; the vault's **Fee Receiver (Loop's revenue address) collects 75% of it and the DeFindex protocol takes the other 25%**. So at a 50% performance fee the **user still keeps 50% of gains** (the split of the fee doesn't touch the user), but **Loop nets 37.5% of gains, not 50%**. **No high-water-mark** exists in the stock DeFindex contract — accepted here because the Blend lending strategy's yield is near-monotonic (interest, rarely negative), so the double-charge-on-recovery risk a HWM guards against barely applies; adding a HWM would require a contract fork and re-introduce a full audit, which is not worth it.
- **No assets held outside the vault** for normal operations. Loop does maintain a separate canonical-asset hot float at the operator account (see Liquidity safeguard).

> **Finding — DeFindex is deploy-by-config, no Loop contract, no from-scratch audit (2026-07-10).** Verified against DeFindex's docs (whitepaper, vault-contract, creating-a-vault, Blend strategy). LOOPUSD/LOOPEUR do **not** require Loop to write or fork any Soroban code: DeFindex ships a **Factory** that mints vault _instances_ of its own **audited** vault contract, and the **Blend USDC/EURC pool strategies are DeFindex's own curated + audited** strategies. Loop deploys each vault purely by configuration (name/symbol → `LOOPUSD`/`LOOPEUR`, underlying asset, selected Blend strategy, roles — Manager/Fee-Receiver/Emergency-Manager/Rebalance-Manager — the performance fee, and the upgradable flag), via their Factory/SDK/UI. **Consequence:** the "$30–80k / 4–8-week vault contract audit" this ADR previously budgeted (§Negative, Open-question 3) **evaporates** — there is no Loop-authored contract to audit. It collapses to (a) a deployment/configuration review (roles, fee, upgradability, admin-key custody) and (b) protocol/counterparty due-diligence on Blend + DeFindex (Open-questions 4/5). What does **not** change: the Privy-Soroban-custody blocker (Open-questions 1/2 — still critical-path; if Privy can't custody/sign for the Soroban share token, fall back to the v5 classic-asset wrapper, which _would_ be custom Loop code), the investment-service regulatory framing (§Negative — a fee-bearing curated vault is still MiCA/SEC/FCA perimeter regardless of who wrote the contract), and Blend redemption-liquidity DD (hence the per-currency hot float). Revenue math corrected above (DeFindex takes 25% of the fee). This resolves Open-question 3 and re-scopes the Gate's audit item.

Cashback emission flow (USD home-currency example):

1. User earns $5 cashback on a gift-card order (FX-pinned at order creation per ADR 015)
2. Backend operator deposits 5 USDC into `LOOP_USD_VAULT` → receives N LOOPUSD shares (where N = $5 / current_share_price)
3. Operator transfers N LOOPUSD to user's Privy wallet via Privy server-signed Soroban tx

Same per home currency: EUR users get LOOPEUR with EURC backing; GBP users get GBPLOOP via the classic-asset path.

Withdraw flow:

1. User taps "Withdraw $50"
2. Backend computes LOOPUSD count needed: `50 / current_share_price + small_buffer`
3. Privy server signs transfer of N LOOPUSD from user wallet → Loop operator
4. Operator submits vault `redeem(N)` → receives USDC
5. USDC sent to user's destination (external Stellar wallet via SEP-24, fiat off-ramp, or gift-card payment routing). Settles ~5–10s on-chain (vault redeem + transfer)

Gift card spend follows the same redemption mechanic with USDC routing to the order's payment path.

### GBPLOOP — Stellar classic asset with nightly on-chain interest payouts

GBPLOOP is a Stellar classic asset issued from a Loop-controlled Stellar issuer account, 1:1-backed by GBP reserves held in **Loop's Revolut Business banking account**. Treasury can extend into Revolut's yield products (Flexible Cash Funds, etc), gilts via a separate custodian if needed, or other low-risk GBP instruments — but the operational hub for GBP custody, fiat off-ramping on user withdraws, and Faster Payments settlement is Revolut.

**Why not also a vault**: there is no on-chain GBP yield primitive on Stellar. A "vault" routing GBP to a Stellar yield strategy doesn't exist. The classic-asset + Loop-paid-interest model is the only choice for GBP today.

**Nightly payout mechanism**:

- GBPLOOP balance in user wallet = current balance (principal + previously paid interest)
- A nightly cron computes interest owed: `current_balance × (3% / 365)` per GBPLOOP holder
- Operator account mints and transfers the interest amount as additional GBPLOOP to each user's Privy wallet
- User sees their GBPLOOP balance grow on-chain each night
- No off-chain accrual ledger needed for GBP; the on-chain balance is authoritative

**Why nightly on-chain mint rather than off-chain accrual**: simpler accounting (no `accrued_interest_minor` column to reconcile), simpler withdraw (no special "pay accrued + principal in one settlement" path — withdraw is just "redeem GBPLOOP at face"), more visible UX (user sees balance tick up every night). Operational tradeoff: one Stellar tx per holder per night. At launch volumes this is ~negligible (Stellar fees ~$0.0001/tx); at 100k holders it's $10/night ≈ $3.6k/yr. Affordable. A failed cron means missed interest for the night, which the operator runbook covers (re-run partial cron, idempotent via per-day ledger of paid amounts).

**Loop's revenue**: `treasury_yield − 3%` on backing AUM. At Revolut's current GBP yield products (~4-5% on Flexible Cash Funds at UK base rate ~5%) with 3% paid to users, spread is ~1-2% on backing. At £10M GBPLOOP issuance: ~£100-200k/yr. Same EMI/fintech treasury spread model as Wise / Monzo (Loop is itself one tier higher than Revolut Business in this model — Revolut is the bank, Loop is the customer earning yield via their products and re-distributing to GBPLOOP holders).

**3% rate-setting policy**: 3% is a Loop policy, not a contract. Adjustable downward with reasonable user notice (e.g., 30 days) if treasury yield environment shifts sustainably below 3%. Adjustable upward at Loop's discretion. Past 30-day APY display still applies to GBPLOOP (computed from on-chain mint history) for consistency with LOOPUSD/LOOPEUR display.

### Cross-currency cashback (FX-pin behaviour preserved)

A UK user (GBPLOOP home currency) buying a US gift card:

1. Order's `currency` = USD; `chargeCurrency` = GBP (FX-pinned via Frankfurter, ADR 015)
2. Cashback amount computed against `chargeMinor` in GBP
3. Cashback emitted as GBPLOOP to user's Privy wallet
4. User sees their GBP balance grow, accruing in GBP

Same logic per home/catalog pairing. **Cashback always lands in user's home currency.**

### Liquidity safeguard — hot float per currency

Loop maintains hot float per currency to absorb normal-volume withdrawals instantly:

- **LOOPUSD/LOOPEUR**: float held as canonical USDC/EURC at the operator account (not in vault), sized at 5–10% of vault TVL. User withdraw → Loop transfers from float, vault redeems async to replenish.
- **GBPLOOP**: float held as GBP fiat in Loop's Revolut Business operating account, sized 5–10% of backing AUM. User withdraw → Faster Payments out via Revolut to user's destination GBP account, settles in seconds.

Mass-withdraw stress: queue withdraws above hot-float capacity with visible "ETA" UX while treasury redeems from underlying. Standard EMI/fintech pattern.

### Fee adjustment process (LOOPUSD / LOOPEUR vaults)

> **Superseded in part by §Detailed design D7 (2026-07-10).** The "caps in vault contract" and the on-chain `propose_fee_change` / `apply_fee_change` 7-day timelock below assumed Loop-authored contract logic. Under deploy-by-config Loop authors no contract: the stock DeFindex fee is performance-only and **Manager-adjustable at any time**, DeFindex keeps 25% of collected fees and Loop's Fee Receiver 75%, and Loop's governance (multisig approval + user-notice hold) is **off-chain**. Read D7 as the current model; the below is retained for the design rationale.

Vault fee schedule is on-chain state with caps:

- Initial: 0% management + 50% performance, single schedule across both vaults
- Caps in vault contract: 5% management + 75% performance, contract-enforced (bounds worst-case fee abuse via compromised admin)
- Adjustment path: ops proposes change → multisig approval → on-chain `propose_fee_change` → 7-day timelock → on-chain `apply_fee_change`
- Public on-chain emit per change; published in monthly internal ops report

Triggers for adjustment:

- Underlying yield environment moves materially (> 50 bps sustained on Blend USDC or EURC)
- Net APY drifts outside acceptable user-facing range (currently no hard floor; revisit if user complaints / churn correlate with yield drops)
- Competitive landscape changes (BEANSEURC repricing, new Stellar DeFi yield products)

### GBPLOOP nightly mint operator runbook

The nightly cron is operationally critical — a missed run means visibly missed interest for that night. Runbook:

- Cron fires at fixed UTC time (e.g., 00:30 UTC)
- For each GBPLOOP holder: read current on-chain balance, compute `balance × (3% / 365)`, mint that amount, record in `gbploop_interest_payments` table with `(user_id, payment_date, amount_minor, tx_hash)`
- Idempotency key on `(user_id, payment_date)` — re-running the cron is a no-op
- Per-user mint failure → retry up to 3 times with exponential backoff, then alert ops
- Whole-cron failure → ops manually re-runs; idempotency key prevents double-pay
- Monthly reconciliation: total minted on-chain matches sum of `gbploop_interest_payments.amount_minor`

Rate-setting governance: ops proposes → multisig approval → backend config update on next-night-applies basis. Material rate changes (> 50 bps) communicated via in-app + email.

### User-facing display — past 30-day realised APY with disclaimer

All three currencies surface the same shape:

- **Top-level**: "LOOPUSD: $X.XX • Past 30 days: 3.12% APY\*"
- **Disclaimer (always visible adjacent to APY)**: "Past performance doesn't guarantee future returns."
- **Mid-level (one tap)**: "Loop pays variable yield based on market conditions. Past 30 days: 3.12%. Range over past 90 days: 2.8% – 3.5%. Withdraw anytime, funds settle in seconds."
- **Source-level (ToS / regulator-facing)**: full vault structure, fee schedule, change history, cap values

**No yield-source / strategy disclosure to users.** No mention of Blend, DeFindex, Soroban, lending pools, vaults, or treasury investment. The product is "earn yield on your Loop balance"; everything else is operational detail surfaced only to regulators.

## Detailed design (build-ready — 2026-07-10)

Details the LOOPUSD/LOOPEUR vault path to build-ready depth, incorporating the 2026-07-10 DeFindex deploy-by-config finding and the operator decision that Privy custody is **assumed workable, with a documented fallback rather than a hard blocker** (if Privy's Soroban support is insufficient, Loop swaps the signing layer — another provider or a self-managed signer — without changing the vault architecture). GBPLOOP's design is already built (`credits/interest-mint.ts`, migration 0041) and is unchanged; this section is the vault path only.

### D1. Custody & signing — two roles, and why the wallet-provider's job is narrow

The earlier framing ("Privy must sign arbitrary `vault.deposit` / `vault.redeem` calls") overstated the requirement. Split signing into two roles:

- **Operator / treasury signing (server-side, Loop-held key).** ALL vault-contract interactions — `deposit` (supply backing → receive shares), `withdraw` / `redeem` (burn shares → receive backing), and the fee sweep — are invoked from Loop's **operator account** and signed server-side with the operator secret (the same KMS/env-held signing already used for payouts, ADR 016, extended to Soroban `InvokeHostFunction`). The user's wallet is never involved in a vault call. The operator→user **share transfer** on emission is also operator-signed.
- **User-wallet signing (via the ADR 030 provider abstraction).** The ONLY user-side operation is signing a **transfer of the vault share token** from the user's wallet back to the operator on withdraw / spend. The provider must: (a) custody a Soroban token, (b) surface its balance, (c) sign one `transfer(from=user, to=operator, amount)` on the share-token contract via policy-gated server signing. Nothing more.

So the Soroban requirement on the wallet provider collapses to **"hold a Soroban token and sign a transfer of it"** — far closer to classic-asset support than "authorise arbitrary contract calls." That is the whole Privy dependency.

**Provider abstraction + fallback (operator decision, 2026-07-10).** Signing goes through `getWalletProvider()` (ADR 030); primary is Privy. If Privy's Soroban support is insufficient, the fallback is a **signing-layer swap only** — vault, backing, fee, and invariants are unchanged:

1. Another Soroban-capable custody provider (dfns / Turnkey) behind the same interface.
2. A Loop-managed signer: a KMS-custodied per-user keypair, transfers signed server-side under the same policy engine — acceptable for a yield-wallet instrument and consistent with a neobank-custodial posture.
3. Graceful degradation (the old v5 wrapper, now a fallback not a failure): if no provider can custody a Soroban token at all, the user instead holds a Loop-issued **classic** receipt asset 1:1 with their vault position while Loop holds the actual shares operator-side; withdraw burns the classic receipt and the operator redeems shares. More Loop-side code, zero Soroban custody requirement.

Because deposit / redeem are operator-signed regardless, none of these fallbacks touches the vault, the backing, the fee, or the invariants — only where the user's "I authorise this withdraw" signature originates.

### D2. Soroban interaction spec

Vault calls use `@stellar/stellar-sdk` against the Soroban RPC, operator-signed:

- **Emission deposit:** `vault.deposit(amounts=[backing], min_shares, from=operator, invest=true)` → operator receives N shares (Blend supply happens inside the strategy). `min_shares` guards against a share-price move between quote and submit.
- **Withdraw / redeem:** `vault.withdraw(shares=N, min_amounts=[backing], from=operator)` → burns N shares, returns backing (Blend withdraw inside the strategy). `min_amounts` slippage guard.
- **Submit pipeline:** build → `simulateTransaction` (resource fee + footprint) → assemble → operator-sign → `sendTransaction` → poll `getTransaction`. Wrap in a fee-bump (or a channel account, ADR 044) for reliability.
- **At-most-once fence (reuse CF-18):** build the tx deterministically, persist its hash before submit, submit; a retry re-submits the SAME hash (Stellar dedupes) rather than minting a second deposit — the same idempotency discipline the payout worker already uses.

### D3. Data model

New tables (`credits` / `payments` domain migrations):

- `loop_vaults` — registry: `asset_code` (LOOPUSD | LOOPEUR), `vault_contract_id`, `share_asset_id`, `underlying_asset` (USDC/EURC + issuer), `strategy` (Blend pool id), `network` (testnet | mainnet), `active`. One row per currency per network.
- `vault_share_price_snapshots` — `(vault, taken_at, share_price_ppm, source_ledger)`; a daily snapshot for APY + value display, plus an on-emission / on-withdraw snapshot.
- The off-chain conservation mirror reuses the EXISTING `credit_transactions` + `user_credits` (ADR 009), extended so a vault emission / redemption is a conserved event under the `assert_emission_conservation` trigger. Authority model (per ADR 036): the on-chain **share balance** is authoritative for the user's holding; `user_credits` mirrors the underlying-denominated liability (`shares × share_price`). Redemption extinguishes both halves (burn shares + zero the mirror slice), same shape as ADR 036's issuer-return burn.

### D4. Money invariants (vault path) + watchers

- **INV-V1 (no unbacked shares):** every user-held LOOPUSD/LOOPEUR share was minted against a real backing deposit in the same tx-chain. Enforced by the operator-signed emission (deposit → receive exactly-N shares → transfer N to user), the conservation trigger, and the drift watcher.
- **INV-V2 (redemption solvency):** `Σ user share value ≤ vault-redeemable backing + hot float` at all times. A scheduled watcher compares total user share value (`Σ shares × share_price`) against `vault_redeemable + hot_float` and pages on breach.
- **INV-V3 (fee ≠ backing):** the Fee-Receiver's accrued performance fee is Loop revenue, never counted as user backing / liability.
- Extend the existing `asset-drift-watcher` to the two share assets: on-chain shares held-for-users vs the off-chain mirror, plus the solvency band.

### D5. Emission flow (idempotent)

Cashback of $X (USD home) — every step idempotent on the cashback event id:

1. Backend records the emission intent (idempotency key = cashback event id).
2. Operator `vault.deposit([X USDC], min_shares, from=operator)` → receives N shares (CF-18 hash fence).
3. Operator `share.transfer(operator → user_wallet, N)`.
4. Write the conserved `credit_transactions` mirror row (`assert_emission_conservation`); snapshot the share price.
5. On any step failure the idempotency key + CF-18 fence make a retry resume, not duplicate. A partial state (deposited-but-not-transferred) is recoverable — the operator holds the shares; a re-drive completes the transfer — the same recovery discipline as the order-procurement sweep.

### D6. Withdraw / spend flow

1. User taps "Withdraw $50". Backend computes shares `N = 50 / share_price + buffer`.
2. Wallet provider signs `share.transfer(user → operator, N)` — the only user-side signature in the whole system.
3. **Fast path:** operator pays the user from the **hot float** (canonical USDC/EURC) immediately — settles in seconds; the received shares replenish the float asynchronously via a batched `vault.withdraw`.
4. **Slow path (float exhausted / mass withdraw):** operator `vault.withdraw(N)` synchronously, then pays out; above hot-float capacity, queue with a visible ETA (the EMI pattern, §Liquidity safeguard).
5. Gift-card spend uses the same redeem mechanic, routing the underlying USDC to the order's payment path.

### D7. Fee accounting — reconciled with deploy-by-config

The v6/v7 assumptions of a Loop-authored fee contract (5%/75% caps enforced in Loop's own code; a 7-day on-chain `propose_fee_change` / `apply_fee_change` timelock, §Fee adjustment) are **superseded** — Loop authors no contract. The real model:

- **DeFindex stock fee:** performance-only, set at vault creation, **Manager-adjustable at any time** (no built-in on-chain timelock). Of collected fees, **DeFindex protocol keeps 25%**, Loop's **Fee Receiver keeps 75%** (a 50% fee → Loop nets 37.5% of gains; the user keeps the other 50%). Any hard fee ceiling is DeFindex's, not Loop's — confirm during config review (OQ8).
- **Loop's fee governance is therefore OFF-CHAIN:** the multisig-approval + user-notice policy gates _who is allowed to call_ the Manager fee-change; the "timelock" is an operational hold, not a contract guarantee. If a contract-level timelock turns out to be required for the regulatory posture, that is the one concrete reason to reconsider a fork — otherwise default to off-chain governance.
- **Revenue realization:** the Fee Receiver (a Loop Stellar address, ideally a multisig) accrues the fee at the vault-contract level on yield events; Loop sweeps to treasury on a schedule.

### D8. APY computation

- Vaults: `APY = (share_price(now) / share_price(30d_ago)) ^ (365/30) − 1`, from `vault_share_price_snapshots`; the 90-day range from the same series. GBPLOOP: from `gbploop_interest_payments` mint history (already built).
- A read endpoint exposes `{ assetCode, past30dApy, past90dRange }` for the wallet display (§User-facing display); it never exposes the strategy / source.

### D9. Build sequence (ships dark behind `LOOP_PHASE_1_ONLY`)

1. Deploy testnet vaults via the DeFindex Factory (config: asset, Blend strategy, roles, fee, symbol) — no contract code.
2. Backend: the `loop_vaults` registry + the Soroban deposit/redeem/transfer integration + the conservation mirror + snapshots + the withdraw hot-float path, all behind the flag.
3. Wire the wallet provider's share-token custody + transfer signing (Privy; validate against a Privy dev account — the narrow "hold + transfer a Soroban token" requirement, D1).
4. Extend the drift / solvency watchers; add the APY endpoint + display.
5. Config review (roles, fee, upgradability, admin-key custody) + Blend/DeFindex protocol DD + counsel sign-off.
6. Deploy mainnet vaults; provision the hot floats; flip `LOOP_PHASE_1_ONLY=false` once T1 + the discount demo are done.

**Step 2 progress (2026-07-10):** V1 (registry read layer, migration
0060), V2 (`credits/vaults/vault-client.ts` — the Soroban deposit/
withdraw/transfer client), V3 (`credits/vaults/vault-emissions.ts`
— the cashback-EMISSION flow + conservation mirror, migration 0061),
and V4 (`credits/vaults/vault-redemptions.ts` — the WITHDRAW/REDEEM
flow: `pending -> collecting -> redeemed -> settled` (+`failed`),
migration 0062, `orders/redeem.ts`'s gated fork of the `loop_asset`
gift-card redemption path, and `treasury/hot-float.ts` — the
per-currency hot-float ledger from §Liquidity safeguard, fast/slow
payout paths, batched replenishment) shipped. §D1's user-wallet share
transfer (`transferShares({ signWith: 'provider' })`) is implemented
against the ADR 030 wallet-provider abstraction, reusing the SAME
`attachUserWalletSignature` raw-hash-signing mechanism
`orders/redeem.ts`'s classic-asset flow already uses — this is an
ASSUMPTION flagged for operator DD (§D1 open question 1), not yet
validated against a real Privy dev account.

**V5 (§D4, observability — required before `LOOP_VAULTS_ENABLED` flips
on) shipped**: `credits/vaults/vault-drift-watcher.ts` — the Soroban
LOOPUSD/LOOPEUR twin of `payments/asset-drift-watcher.ts`, checking
INV-V1 (on-chain user-held shares `totalSupply − operatorBalance` vs
the off-chain-tracked net, `credits/vaults/vault-share-accounting.ts`)
and INV-V2 (the vault path's OWN off-chain USD mirror liability vs
`totalManaged` + hot float — deliberately NOT `userShares × sharePrice`,
which is tautologically dead since `sharePrice = totalManaged/totalSupply`)
on a schedule, paging Discord fire-once/re-arm via
`watchdog_alert_state`. The user-holds/operator-holds split keys on the
CONFIRMED-landed timestamps (`transferred_at`/`collected_at`), NOT the
pre-submit CF-18 `*_tx_hash` (a terminal-`failed` emission whose
transfer never landed is correctly counted as operator-held, so it
can't mask a real shortfall). `treasury/hot-float-reconciliation.ts`
closes two V4-review gaps: (a) makes R3-1
(`payments/operator-float-reconciliation.ts`) vault-aware by recording
an explanatory `operator_manual_movements` row
(`treasury/vault-operator-movement.ts`) whenever a vault call moves the
operator's USDC balance — R3-1's indexer only sees classic Horizon
`payment` ops, so a Soroban `InvokeHostFunction` vault deposit/withdraw
was previously invisible and would have read as false drift; scoped to
USDC (LOOPUSD) only, LOOPEUR/EURC still has no R3-1 coverage — and (b)
detects (does not yet prevent) the V4-accepted slow-withdraw-race /
phantom-share float desync via a new `vault_float_reconciliation_runs`
audit table (migration 0063).

**Pre-flip config validation (required before `LOOP_VAULTS_ENABLED=true`
— confirm at the §D9 step 5 config review, full detail in
`vault-drift-watcher.ts`'s header):** (i) the DeFindex performance-fee
payout mechanics — if the fee is share-minted to a Fee-Receiver, those
shares can MASK a real negative drift/shortfall (not merely false-page),
so confirm it's taken from managed funds pre-share-price, or subtract
the Fee-Receiver balance; (ii) `DISCORD_WEBHOOK_MONITORING` is set (an
unset webhook makes `sendWebhook` succeed silently → a real breach is
swallowed and the fire-once alert never re-fires); (iii) the underlying
is a 7-decimal at-par SAC, `share_asset_issuer == vault_contract_id`,
and `LOOP_STELLAR_DEPOSIT_ADDRESS == the operator-secret pubkey`.

Still open: the scheduled share-price snapshotter (§D8 — the
`recordSharePriceSnapshot` helper exists and V3's mirror step calls it
per-emission, but no periodic snapshotter runs independently of an
emission), the APY endpoint + display, and real-Privy-Soroban
validation (the one remaining piece of step 3, wallet-side share-token
custody — the narrow "hold + transfer" requirement is coded, unverified
against a live provider).

### D10. Superseded by deploy-by-config

For the record, these earlier-version assumptions are void: "Loop owns the vault contract code" (§Negative → a config-only deploy); "caps in vault contract 5%/75%, contract-enforced" and the on-chain "propose/apply_fee_change 7-day timelock" (§Fee adjustment → Loop-authored-contract logic; the stock DeFindex fee is Manager-adjustable with governance moved off-chain, D7); and the from-scratch contract audit (retired — see the 2026-07-10 finding under §LOOPUSD/LOOPEUR).

## Consequences

### Positive

- **Single asset per currency in user wallet**: LOOPUSD, LOOPEUR, GBPLOOP. Clean UX.
- **Revenue captured per currency, scales with TVL**:
  - USD: 50% of ~6% gross → ~$300k/yr per $10M TVL in vault performance fees
  - EUR: 50% of ~9.15% gross → ~$457k/yr per €10M TVL in vault performance fees
  - GBP: ~2% spread on UK base rate → ~£200k/yr per £10M backing
  - At $100M aggregate: low-to-mid 7-figures annually
- **Cross-currency UX is consistent**: cashback always lands in home currency.
- **Tranche 2/3 acceptance satisfied**: yield exists for all three currencies.
- **Operationally simple fee structure**: single 50% performance fee across both vaults. No per-currency tuning. Easier to reason about, easier to disclose.
- **Variable APY removes Loop's rate-environment risk on USD/EUR**: vault performance fee is a percentage of yield, so Loop's revenue scales with underlying. If Blend yields drop, Loop's take drops proportionally — but user APY also drops proportionally. No "we promised 4%, now we owe margin" failure mode.
- **Disclaimer is standard practice**: "past performance doesn't guarantee future returns" is the universal financial-product disclaimer, applicable in every jurisdiction Loop operates.

### Negative / acknowledged

- **Privy Soroban dependency**: LOOPUSD and LOOPEUR are Soroban tokens (DeFindex vault shares). Privy's Stellar support has historically been classic-asset-focused; Soroban support is emerging. **Critical-path DD blocker** — see Open Questions. If Privy doesn't support Soroban token custody and programmatic signing, this design fails at v6 just as it did at v4.
- **Vault deployment review + protocol DD (NOT a from-scratch contract audit)**: superseded by the 2026-07-10 finding above. Loop writes/forks **no** vault contract, so the previously-budgeted $30–80k / 4–8-week from-scratch contract audit is gone. What remains is (a) a deployment/configuration review of each vault instance (Manager / Fee-Receiver / Emergency-Manager roles, the performance fee, the upgradable flag, admin-key custody) and (b) Blend + DeFindex protocol/counterparty DD (Open-questions 4/5). The only path that would resurrect a real audit — adding a high-water-marked fee — is deliberately declined (near-monotonic Blend yield makes it unnecessary; see fee schedule).
- **Curator regulatory framing**: operating Soroban vaults with fees tied to AUM is investment-service territory in EU (MiCA), US (SEC investment-contract analysis), UK (FCA collective-investment-scheme perimeter). Bundle into the same counsel review as GBPLOOP issuance and Privy custody (ADR 030).
- **GBPLOOP regulatory weight stands**: Loop issuing 1:1-backed GBP stablecoin = e-money issuance under UK FCA rules. EMI authorisation or partnership required.
- **Variable user APY**: users see APY fluctuate. Most retail users in 2026 expect this from yield products; disclaimer covers it. Marketing has to set expectations honestly.
- **EUR users see higher APY than USD users at current rates**: EUR Blend yield is ~9% vs USD ~6%; with 50% perf fee both see proportional yield but EUR users see ~4.6% vs USD ~3%. Defensible — "EUR market rate is currently higher than USD." If this becomes confusing, per-currency fee tuning is the lever.
- **Multiple in-session iterations** (six versions). Decision History above is canonical.

## Alternatives considered

1. **Thin curator fees ~50 bps (v1).** Too little revenue. Rejected.
2. **Loop-issued 1:1 stablecoins all currencies (v2).** Triples reg weight. Rejected.
3. **High-fee curator vaults exposing dfTokens with raw "df" prefix (v3).** Naming confusion; user explicitly chose LOOP-prefix branding. Rejected.
4. **Loop-issued classic assets backed by hidden vault layer (v5).** Misread user's "LOOP prefix" intent. Now corrected.
5. **Skip DeFindex layer; direct Blend integration via Loop operator account.** Simpler audit but loses curator vault tokenisation (vault share IS the user-facing token). Re-evaluate if Privy Soroban DD fails.
6. **GBP via tokenised gilts directly to user.** Not on Stellar mainnet. Re-evaluate when short-duration GBP-tokenised products launch.
7. **GBP via synthetic conversion (LOOPUSD yield + on-demand FX).** FX risk + spread cost. Rejected.
8. **Per-currency fee tuning to target ~4% APY across both vaults.** Higher fee on EUR (where underlying is higher) to suppress user APY to USD level. Trades simplicity for marketing parity. Reconsider if EUR > USD APY confusion harms product.

## Open questions

1. **Privy custody + transfer of the Soroban share token.** **Downgraded from critical-path blocker → assumption + fallback** (operator decision, 2026-07-10; see §Detailed design D1). The requirement is narrow: the wallet provider need only (a) custody a Soroban token, (b) display its balance, (c) sign a single `transfer(user → operator)` of it via policy-gated server signing — it does **not** sign vault calls (those are operator-signed). Validate against a Privy dev account; if insufficient, swap the signing layer (alt provider / Loop-managed KMS signer / the v5 classic-receipt wrapper, D1) — a signing-layer change, not a design failure.
2. ~~**Privy programmatic signing of Soroban contract calls (`vault.deposit` / `vault.redeem`).**~~ **Void (2026-07-10):** vault `deposit` / `redeem` are **operator-signed**, not user-wallet-signed (§Detailed design D1) — the wallet provider never touches a vault call. Folded into OQ1's narrow "custody + transfer a share token" requirement.
3. ~~**DeFindex curator template / fork lineage.**~~ **Resolved 2026-07-10**: neither — DeFindex is deploy-by-config (its Factory mints an instance of DeFindex's own **audited** vault contract; the Blend pool strategy is DeFindex-audited too). Loop authors no contract, so there is **no from-scratch contract audit** — see the finding under §LOOPUSD/LOOPEUR and the re-scoped §Negative item. Residual work is a deployment-configuration review + Blend/DeFindex protocol DD (Open-questions 4/5).
4. **DeFindex vault DD: USDC strategy (Blend USDC pool).** Depth, audit posture, historical worst-case redemption.
5. **DeFindex vault DD: EURC strategy (Blend EURC pool).** Same checks.
6. ~~**GBP custodian / banking partner.**~~ **Resolved 2026-05-05**: Revolut Business. Yield product for backing reserves (Flexible Cash Funds vs gilts vs other) and API integration for Faster Payments off-ramp on user withdraws still need scoping, but the partner choice is locked.
7. **Multi-jurisdictional regulatory review (bundled).** LOOPUSD/LOOPEUR vault curation + GBPLOOP issuance + Privy custody (ADR 030). 4–6 weeks of crypto-fintech counsel.
8. **Performance-fee level + revenue split.** Loop sets the vault's performance fee at creation (Manager-adjustable after). Of what the vault collects, the DeFindex **protocol keeps 25%** and Loop's **Fee Receiver keeps 75%** (so a 50% fee → Loop nets 37.5% of gains; the user still keeps the other 50% of gains regardless). Verify the chosen fee level survives counsel review (investment-service framing) and confirm any DeFindex-enforced fee ceiling — no custom cap logic to author (deploy-by-config, OQ3).
9. **Past-30-day APY computation source.** On-chain share-price history for vaults (compute from `share_price(now) / share_price(30d_ago) − 1` annualised). For GBPLOOP: on-chain mint history (per §rate-setting above; the `gbploop_interest_payments` table mirrors it for fast reads). Frontend reads via API endpoint exposing both.
10. **Hot-float sizing per currency.** 5–10% target — pin once historical withdraw volume data exists.
11. **Partial-withdraw × nightly-mint interaction (GBPLOOP).** Under v7 there is no accrued-interest ledger — a withdraw just redeems GBPLOOP at face (any interest already landed on-chain via prior nightly mints). Residual check: confirm the nightly cron reads post-withdraw on-chain balances so an intra-day withdraw doesn't earn that night's interest on the withdrawn amount.

## Gate for Accepted

This ADR stays **Proposed** — and no implementation work (vault contract, mint cron, payout-builder changes) starts — until every blocking condition below has a **recorded** answer:

1. **Wallet-provider signing path chosen** (Open question 1; operator decided 2026-07-10 that Privy is assumed workable with a fallback, so this is **no longer a hard blocker**). Confirm the narrow requirement — custody + `transfer` a Soroban share token, NOT vault-call signing (§Detailed design D1) — against a Privy dev account; if insufficient, select the fallback (alt provider / Loop-managed KMS signer / v5 classic-receipt wrapper). Accepted requires the signing path **chosen**, not a specific vendor passing.
2. ~~**DeFindex template / fork lineage chosen**~~ **Resolved 2026-07-10** (Open question 3): deploy-by-config, no fork — Loop authors no contract.
3. **Vault deployment-config review + Blend/DeFindex protocol DD** (§Negative; replaces the former from-scratch contract audit, now moot per item 2). Accepted requires the configuration review (roles, fee, upgradability, admin-key custody) + the protocol DD **recorded** — there is no external audit slot to book, so this is no longer an uncompressible-lead-time gate.
4. **Blend strategy DD recorded** (Open questions 4–5). Depth, audit posture, and historical worst-case redemption for the Blend USDC and EURC pools.
5. **Counsel sign-off scheduled** (Open question 7; bundled with ADR 030's custody review and GBPLOOP EMI framing). 4–6 weeks of crypto-fintech counsel; Accepted requires the engagement booked, mainnet requires the review complete.
6. **Performance-fee cap validated** (Open question 8). The proposed 75% contract cap is allowed by the DeFindex template and survives the counsel review.

As of 2026-06-11 none of these is scheduled; the Privy DD call (the cheapest unblock in the chain) is the first move. **2026-07-10 update:** the former contract-audit blocker (old Gate items 2/3) is retired — DeFindex is deploy-by-config with no Loop-authored contract, so the uncompressible $30–80k / 4–8-week audit lead time is off the critical path. The remaining chain is Privy Soroban custody DD (the still-critical-path blocker) → Blend/DeFindex protocol DD + vault config review → bundled counsel sign-off. Sources: DeFindex whitepaper + vault-contract + creating-a-vault + Blend-strategy docs (`docs.defindex.io`).

## Migration from ADR 015

ADR 015 sections affected:

- §"Loop issues three branded Stellar assets" — **partially retained**. Three branded assets per currency are issued, but only GBPLOOP is a 1:1-backed Stellar classic asset. LOOPUSD and LOOPEUR are Soroban DeFindex vault shares (Loop is the curator).
- §"Defindex deposit automation — currently manual ops top-up" — superseded by Loop-curated DeFindex vaults (this ADR) for USD/EUR + treasury-managed yield investment for GBPLOOP backing.
- Asset matrix: cashback → user — renamed assets and updated forms (USD→LOOPUSD vault share, EUR→LOOPEUR vault share, GBP→GBPLOOP classic asset). Watcher allowlist adds the renamed assets and Soroban contract identifiers.
- Onboarding currency picker (#357) — unchanged.
- `/settings/wallet` (#362) and Account page link (#366) — unchanged in shape; content updates to surface Privy wallet + per-currency past-30-day APY display + disclaimer.

ADR 015 should be marked Amended pointing at this ADR.

## File map

| Change                                                                                                                          | File / surface                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Asset retirement USDLOOP / EURLOOP → LOOPUSD / LOOPEUR vault shares (GBPLOOP name unchanged — v7 dropped the v6 LOOPGBP rename) | `apps/backend/src/credits/payout-asset.ts`, all references in `credits/`, `orders/`, schema CHECK constraints, web copy                                                                                             |
| Vault contract                                                                                                                  | `contracts/loop-vault/` (new Soroban project) — fork of DeFindex curator template, parameterised per currency for LOOPUSD and LOOPEUR                                                                               |
| Vault deployment + admin tooling                                                                                                | `apps/backend/src/treasury/vault-admin.ts` (new) — propose/apply fee changes, emergency pause                                                                                                                       |
| Cashback emission via vault                                                                                                     | `apps/backend/src/credits/payout-builder.ts` — extend to deposit-into-vault for USD/EUR (mints vault shares to user); existing classic-asset emit for GBP                                                           |
| Withdraw / spend redemption                                                                                                     | `apps/backend/src/credits/payout-builder.ts` — vault redeem for LOOPUSD/LOOPEUR; classic GBPLOOP transfer at face (interest already on-chain via nightly mints — no accrual settlement step)                        |
| Treasury yield investment (GBP)                                                                                                 | `apps/backend/src/treasury/gbp-investment.ts` (new) — operator-side; not user-facing                                                                                                                                |
| Hot-float bookkeeping                                                                                                           | `apps/backend/src/treasury/hot-float.ts` (new) — per-currency float, low-water alerts                                                                                                                               |
| Nightly GBPLOOP interest mint                                                                                                   | `apps/backend/src/credits/interest-mint.ts` (new) — nightly cron minting `balance × (3% / 365)` on-chain per holder; idempotent on `(user_id, payment_date)` per §runbook                                           |
| Schema: interest-payment ledger                                                                                                 | Migration adding `gbploop_interest_payments` (`user_id`, `payment_date`, `amount_minor`, `tx_hash`; unique on `(user_id, payment_date)`)                                                                            |
| Past-30-day APY computation                                                                                                     | `apps/backend/src/credits/apy-snapshot.ts` (new) — vault share-price history (USD/EUR) + on-chain mint history (GBP); exposed via API endpoint                                                                      |
| Balance display                                                                                                                 | `apps/web/app/components/features/cashback/CashbackBalanceCard.tsx` — read principal × share-price (USD/EUR) or the on-chain GBPLOOP balance (GBP — nightly mints land on-chain); show past-30-day APY + disclaimer |
| Yield disclosure surfaces                                                                                                       | `apps/web/app/routes/settings.cashback.tsx` + onboarding — past 30-day APY display + "no guarantee of future performance" disclaimer. No mention of Blend, DeFindex, vaults.                                        |
| Privy SDK Soroban integration                                                                                                   | `apps/web/app/services/privy.ts` — pending Privy Soroban support verification                                                                                                                                       |
| Operator runbook                                                                                                                | `docs/runbooks/loop-asset-operations.md` (new) — daily/weekly ops for vaults + GBPLOOP issuance + treasury investment                                                                                               |
