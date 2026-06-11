# ADR 031: Per-currency yield via Loop-curated vaults and treasury

Status: Proposed
Date: 2026-05-05 (rewritten across six iterations mid-session — see Decision history)
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
- **Fee schedule**: 0% management fee + 50% performance fee. Performance fee is taken on yield events at the vault contract level before share-price update; routed to Loop's revenue Stellar address. High-water-mark gated to avoid double-charge on volatility.
- **No assets held outside the vault** for normal operations. Loop does maintain a separate canonical-asset hot float at the operator account (see Liquidity safeguard).

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
- **Vault audit cost**: Loop owns the vault contract code (forked from a DeFindex template or written fresh). Audit required pre-mainnet. Budget $30–80k, 4–8 weeks lead time. Apply once for both LOOPUSD and LOOPEUR (same code, parameterised per currency).
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

1. **Privy custody of Soroban tokens (vault shares).** **Critical-path blocker.** Verify with Privy via dev account: can they (a) custody a Soroban token, (b) display balance in their UI, (c) authorise programmatic transfer via policy-gated server signing? If any "no", this architecture fails. Fallback: if Privy can't support Soroban, fall back to v5-style classic-asset wrappers with hidden vault backing (more complex on Loop's side, simpler on Privy's).
2. **Privy programmatic signing of Soroban contract calls.** Specifically `vault.deposit(amount)` and `vault.redeem(amount)` on the LOOPUSD/LOOPEUR vault contracts. Need Privy to authorise these without per-tx user prompts.
3. **DeFindex curator template / fork lineage.** Audited template Loop forks, or write the vault contract from scratch? Determines audit scope.
4. **DeFindex vault DD: USDC strategy (Blend USDC pool).** Depth, audit posture, historical worst-case redemption.
5. **DeFindex vault DD: EURC strategy (Blend EURC pool).** Same checks.
6. ~~**GBP custodian / banking partner.**~~ **Resolved 2026-05-05**: Revolut Business. Yield product for backing reserves (Flexible Cash Funds vs gilts vs other) and API integration for Faster Payments off-ramp on user withdraws still need scoping, but the partner choice is locked.
7. **Multi-jurisdictional regulatory review (bundled).** LOOPUSD/LOOPEUR vault curation + GBPLOOP issuance + Privy custody (ADR 030). 4–6 weeks of crypto-fintech counsel.
8. **Performance fee cap setting in vault contract.** 75% proposed; verify regulators / DeFindex template caps allow.
9. **Past-30-day APY computation source.** On-chain share-price history for vaults (compute from `share_price(now) / share_price(30d_ago) − 1` annualised). For GBPLOOP: on-chain mint history (per §rate-setting above; the `gbploop_interest_payments` table mirrors it for fast reads). Frontend reads via API endpoint exposing both.
10. **Hot-float sizing per currency.** 5–10% target — pin once historical withdraw volume data exists.
11. **Partial-withdraw × nightly-mint interaction (GBPLOOP).** Under v7 there is no accrued-interest ledger — a withdraw just redeems GBPLOOP at face (any interest already landed on-chain via prior nightly mints). Residual check: confirm the nightly cron reads post-withdraw on-chain balances so an intra-day withdraw doesn't earn that night's interest on the withdrawn amount.

## Gate for Accepted

This ADR stays **Proposed** — and no implementation work (vault contract, mint cron, payout-builder changes) starts — until every blocking condition below has a **recorded** answer:

1. **Privy Soroban custody DD passes** (Open questions 1–2; shared critical-path blocker with ADR 030). Privy must custody the LOOPUSD/LOOPEUR vault-share tokens, display their balances, and policy-gate programmatic `vault.deposit` / `vault.redeem` signing without per-tx prompts. If Privy fails, the gate re-runs against the dfns fallback (ADR 030) or this design reverts to the v5-style classic-asset wrapper noted in Open question 1.
2. **DeFindex template / fork lineage chosen** (Open question 3). Audited template fork vs from-scratch determines the audit scope below.
3. **Vault contract audit scheduled** (§Negative). $30–80k budget, 4–8 weeks lead time, applied once for both vaults. Accepted requires the audit slot to be **booked** (the lead time is uncompressible); mainnet (Tranche 3) requires it complete.
4. **Blend strategy DD recorded** (Open questions 4–5). Depth, audit posture, and historical worst-case redemption for the Blend USDC and EURC pools.
5. **Counsel sign-off scheduled** (Open question 7; bundled with ADR 030's custody review and GBPLOOP EMI framing). 4–6 weeks of crypto-fintech counsel; Accepted requires the engagement booked, mainnet requires the review complete.
6. **Performance-fee cap validated** (Open question 8). The proposed 75% contract cap is allowed by the DeFindex template and survives the counsel review.

As of 2026-06-11 none of these is scheduled; the Privy DD call (the cheapest unblock in the chain) is the first move.

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
