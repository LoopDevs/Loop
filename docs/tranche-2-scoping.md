# Tranche 2 implementation scoping

Sequenced task list for ADR 030 (Privy wallet) + ADR 031 (per-currency
yield architecture). Both ADRs are currently `Status: Proposed`;
items marked **(blocked: ADR Accept)** can't start until the open
questions in those ADRs are resolved. Items in **Track A** are
vendor-agnostic and can start now.

This doc is the canonical "what needs to happen, in what order" for
Tranche 2 backend + web work. Operator-side regulatory + treasury
work tracks separately (Track J) and runs in parallel.

## TL;DR

- **Critical path**: Privy Soroban DD → ADR 030/031 Accepted → vault audit → regulatory review → testnet build → Tranche 2 acceptance.
- **~11 work tracks, ~40 discrete tasks**, dominated by external dependencies (Privy DD, vault audit, counsel review, Revolut API).
- **Realistic timeline**: ~4 months engineering FTE, ~6 months end-to-end including audit + counsel review.
- **Can start today without waiting on anything**: Track A (vendor-agnostic foundations) and the operator-side parts of Track J (regulatory engagement).

## Acceptance criteria mapping

Tranche 2 acceptance is "install testnet build, purchase mock gift card, verify cashback to Stellar testnet wallet, verify yield from held funds." Mapped to tracks:

| Acceptance criterion                      | Track(s)                                       |
| ----------------------------------------- | ---------------------------------------------- |
| Install testnet build                     | I (Testnet build)                              |
| Purchase mock gift card                   | I.3 + F (Cashback flow)                        |
| Verify cashback to Stellar testnet wallet | B (Privy) + F                                  |
| Verify yield from held funds              | C (Vault contract) + D (GBPLOOP mint) + G (UX) |

## Critical-path blockers

These five items gate everything downstream. Resolve them in order or in parallel where possible:

1. **Privy Soroban DD** — verify Privy can custody, display, and programmatically transfer Soroban tokens (DeFindex vault shares). 1–3 hours per ADR 030 §"Open questions". If Privy fails, fall back to dfns; integration shape is identical, ~1–2 wk migration.
2. **DeFindex curator template selection** — fork an audited template OR write fresh. Determines vault audit scope.
3. **DeFindex vault audit** — $30–80k, 4–8 weeks lead time. Gates mainnet (testnet OK without).
4. **Multi-jurisdictional regulatory review** — 4–6 weeks crypto-fintech counsel. Gates mainnet (testnet OK without). Bundles vault curation + GBPLOOP issuance + Privy custody (ADR 030).
5. **Revolut Business API integration scoping** — for GBPLOOP withdraw via Faster Payments. Resolved at the partner level (Revolut chosen 2026-05-05); API integration is engineering work in Track E.

ADR 030 + 031 promotion to `Accepted` requires #1 and #2 resolved.

## Track A — Vendor-agnostic foundations (can start now)

These don't bake in any vendor decision and survive a Privy → dfns pivot or any vault-template choice. Real engineering, ~1 week FTE.

| ID  | Task                                                                                                                                                                                                          | File / surface                                                                             | Size | Notes                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| A.1 | RS256 JWT signer abstraction — pluggable signer interface; HS256 stays default, RS256 path stubbed against existing JWKS verifier (`apps/backend/src/auth/id-token.ts` already does RS256 verify for inbound) | `apps/backend/src/auth/tokens.ts` (refactor), new `apps/backend/src/auth/signer.ts`        | M    | Existing inbound JWKS verifier in id-token.ts is the model                                                                                            |
| A.2 | JWKS publish endpoint at `/.well-known/jwks.json` — gated on a future `LOOP_JWT_PRIVATE_KEY` env, returns standard JWK shape with `kid` for rotation                                                          | `apps/backend/src/auth/jwks-publish.ts` (new), route mount in `apps/backend/src/app.ts`    | S    | Schema-only when no private key set; publish only when key present                                                                                    |
| A.3 | Generic webhook-handler scaffolding — HMAC signature verify primitive, idempotent ingest pattern, no vendor-specific logic                                                                                    | `apps/backend/src/webhooks/` (new dir)                                                     | S    | Privy-specific handler in B.3 plugs into this                                                                                                         |
| A.4 | Past-30-day APY computation primitive — pure function over `(share_price_now, share_price_30d_ago, time_basis)`. Vendor-agnostic; vault-agnostic                                                              | `apps/backend/src/credits/apy-snapshot.ts` (new), unit tests                               | S    | Used by GBPLOOP mint history AND vault share-price history                                                                                            |
| A.5 | Schema design for `gbploop_interest_payments` — write the migration but DON'T apply yet (waits on ADR 031 Accept)                                                                                             | Draft in `apps/backend/src/db/migrations/0033_gbploop_interest_payments.sql` (don't apply) | S    | Per ADR 031 §"GBPLOOP nightly mint operator runbook" — `(user_id, payment_date, amount_minor, tx_hash)`; idempotency key on `(user_id, payment_date)` |
| A.6 | Phase-1 → Phase-2 toggle test hardening — extend PR #1330's coverage of `LOOP_PHASE_1_ONLY=true → false` flip across cashback / order / payout paths                                                          | `apps/backend/src/__tests__/phase-toggle.test.ts` (extend)                                 | M    | Validates the flag flip in production is bulletproof                                                                                                  |

## Track B — Privy integration (blocked: Privy DD)

~4–5 days FTE per ADR 030 §"Consequences". Mostly client-side; backend is small (webhook + signature verify).

| ID  | Task                                                                                                                                                         | File / surface                                                                | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- | ---- |
| B.1 | Install `@privy-io/react-auth` (web), Privy universal SDK or `@privy-io/expo` adapter for Capacitor (mobile)                                                 | `apps/web/package.json`, `apps/mobile/package.json` (Capacitor plugin parity) | S    |
| B.2 | Privy provider wrap with Custom Auth Provider config pointing at Loop's JWKS endpoint                                                                        | `apps/web/app/root.tsx`                                                       | S    |
| B.3 | Webhook handler — `POST /api/webhooks/privy` with HMAC verification, idempotent ingest                                                                       | `apps/backend/src/webhooks/privy.ts` (new)                                    | S    |
| B.4 | `wallet.created` handler → write to `users.stellar_address` via existing `setStellarAddressHandler` (`apps/backend/src/users/stellar-address-handler.ts:44`) | `apps/backend/src/webhooks/privy.ts`                                          | S    |
| B.5 | Belt-and-braces client POST of address on first login if webhook hasn't landed yet (idempotent)                                                              | `apps/web/app/services/privy.ts` (new)                                        | S    |
| B.6 | Privy server-signing primitives for vault `deposit(amount)` and `redeem(amount)` calls (Tranche-2 wallet → vault → wallet flow)                              | `apps/web/app/services/privy.ts`                                              | M    |
| B.7 | Wallet-balance + withdraw UX surfaces wired to Privy                                                                                                         | `apps/web/app/routes/settings.wallet.tsx` (rewrite)                           | M    |

## Track C — Vault contract (blocked: ADR 031 Accept + DeFindex template choice)

The single biggest uncertainty. Audit alone is 4–8 weeks + $30–80k. ~3–4 wk engineering before audit, parallel with A + B.

| ID  | Task                                                                                  | File / surface                                   | Size |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| C.1 | Fork DeFindex curator template (or write fresh — open question)                       | `contracts/loop-vault/` (new Soroban project)    | M    |
| C.2 | Parameterise per currency for LOOPUSD (Blend USDC pool) and LOOPEUR (Blend EURC pool) | `contracts/loop-vault/src/lib.rs` etc.           | M    |
| C.3 | Fee schedule on-chain — 0% mgmt + 50% perf, caps 5%/75%, 7-day timelock for changes   | `contracts/loop-vault/src/fee.rs`                | M    |
| C.4 | Deploy to Stellar testnet                                                             | Operator-side via `stellar CLI`                  | S    |
| C.5 | Vault admin tooling — propose/apply fee changes, emergency pause                      | `apps/backend/src/treasury/vault-admin.ts` (new) | M    |
| C.6 | External audit                                                                        | External vendor (4–8 wk, $30–80k)                | XL   |
| C.7 | Mainnet deploy (post-audit)                                                           | Operator-side                                    | S    |

## Track D — GBPLOOP nightly mint (blocked: ADR 031 Accept)

GBP path is independent of Privy Soroban DD — uses classic Stellar assets. Could ship before C if the team wants partial Tranche 2 ahead of the vault audit landing.

| ID  | Task                                                                                                                                            | File / surface                                            | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ---- |
| D.1 | Apply `gbploop_interest_payments` migration (drafted in A.5)                                                                                    | `apps/backend/src/db/migrations/0033_*.sql`               | S    |
| D.2 | Nightly cron implementation — fires at 00:30 UTC, reads on-chain GBPLOOP balance per holder, computes `balance × (3% / 365)`, mints + transfers | `apps/backend/src/credits/gbploop-interest-cron.ts` (new) | M    |
| D.3 | Per-user mint with retry (3 attempts exponential backoff) + Discord alert on permanent failure                                                  | Within D.2 + `apps/backend/src/discord.ts`                | S    |
| D.4 | Monthly reconciliation — total minted on-chain matches sum of `gbploop_interest_payments.amount_minor`                                          | `apps/backend/src/admin/gbploop-reconciliation.ts` (new)  | S    |
| D.5 | Rate-setting governance — admin UI + multisig approval flow + 30-day user notice on rate decrease                                               | `apps/web/app/routes/admin.gbploop-rate.tsx` (new)        | M    |
| D.6 | Operator runbook                                                                                                                                | `docs/runbooks/gbploop-nightly-mint.md` (new)             | S    |

## Track E — Treasury management (operator-side)

Bridges Loop's banking + custody to the on-chain assets. Most of this is Revolut Business operations + integration.

| ID  | Task                                                                                                                                   | File / surface                                 | Size |
| --- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---- |
| E.1 | Revolut Business API integration — auth, balance read, Faster Payments out for GBP withdraws                                           | `apps/backend/src/treasury/revolut.ts` (new)   | M    |
| E.2 | Treasury yield product selection for GBP backing — Flexible Cash Funds vs gilts vs other                                               | Operator decision + ops doc                    | S    |
| E.3 | Hot float bookkeeping per currency — track operator USDC/EURC float against vault TVL, GBP float against backing AUM, low-water alerts | `apps/backend/src/treasury/hot-float.ts` (new) | M    |
| E.4 | Operator runbook                                                                                                                       | `docs/runbooks/loop-asset-operations.md` (new) | M    |

## Track F — Cashback flow extension (blocked: B + C + D)

Wires the existing `pending_payouts` worker (ADR 016) to the new vault deposit / classic emit paths.

| ID  | Task                                                                                                                                  | File / surface                                              | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ---- |
| F.1 | Cashback emission via vault deposit (USD/EUR) — operator deposits canonical asset, mints vault shares directly to user's Privy wallet | `apps/backend/src/credits/payout-builder.ts` (extend)       | M    |
| F.2 | Cashback emission via classic transfer (GBP) — operator account mints + transfers GBPLOOP to user's Privy wallet                      | `apps/backend/src/credits/payout-builder.ts` (extend)       | S    |
| F.3 | Withdraw flow — vault redeem (USD/EUR) or classic transfer (GBP)                                                                      | `apps/backend/src/credits/withdraw-handler.ts` (new)        | M    |
| F.4 | Privy-signed share transfer for vault deposit/redeem — server-side signing via Privy API                                              | `apps/backend/src/treasury/privy-signer.ts` (new)           | M    |
| F.5 | Asset-drift watcher extension — add LOOPUSD + LOOPEUR vault-share + GBPLOOP balances                                                  | `apps/backend/src/payments/asset-drift-watcher.ts` (extend) | S    |

## Track G — User-facing UX (blocked: B + C + D)

Cosmetic + display layer. Fast iteration once the underlying flows work.

| ID  | Task                                                                                                                                | File / surface                                                      | Size |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ---- |
| G.1 | CashbackBalanceCard with principal × share-price (USD/EUR) or principal + accrued (GBP), past-30-day APY + disclaimer               | `apps/web/app/components/features/cashback/CashbackBalanceCard.tsx` | M    |
| G.2 | Wallet settings rewrite — read-only display, address + balance + withdraw button                                                    | `apps/web/app/routes/settings.wallet.tsx` (rewrite)                 | S    |
| G.3 | Onboarding step 7 rewrite — "Your wallet is ready" with address + one-line explainer                                                | `apps/web/app/components/onboarding/screen-wallet-intro.tsx`        | S    |
| G.4 | Withdraw flow UX — destination input, amount, confirmation                                                                          | `apps/web/app/routes/settings.wallet.withdraw.tsx` (new)            | M    |
| G.5 | Yield disclosure surfaces — `/settings/cashback` past-30-day APY + range over 90d + "no guarantee of future performance" disclaimer | `apps/web/app/routes/settings.cashback.tsx`                         | S    |

## Track H — Asset rename / cleanup (blocked: ADR 031 Accept)

USDLOOP + EURLOOP retired per ADR 031 §"Migration from ADR 015". 120 source-file references.

| ID  | Task                                                                                                                                                                  | File / surface                                                                           | Size |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---- |
| H.1 | Retire USDLOOP and EURLOOP code references — replace with LOOPUSD / LOOPEUR (vault share) where conceptually replaced, delete where the concept doesn't carry forward | grep `USDLOOP\|EURLOOP` across `apps/backend`, `apps/web`, `packages/shared` (~120 hits) | L    |
| H.2 | Remove `LinkWalletNudge` component (Privy auto-provisions; no link UX needed)                                                                                         | delete `apps/web/app/components/features/cashback/LinkWalletNudge.tsx`                   | S    |
| H.3 | Remove `TrustlineSetupCard` (Privy establishes trustlines programmatically pre-emission)                                                                              | delete `apps/web/app/components/features/cashback/TrustlineSetupCard.tsx`                | S    |
| H.4 | Web copy review — `/cashback`, `/trustlines`, `/settings/wallet` placeholder copy refresh per Tranche 2 product framing                                               | various                                                                                  | M    |

## Track I — Testnet build (Tranche 2 acceptance gate)

The Tranche 2 deliverable is a TESTNET build. This track produces the actual artefact.

| ID  | Task                                                                                                                                                               | File / surface                                                                                          | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---- |
| I.1 | Testnet horizon + network passphrase config switching — env-flag-gated, defaults remain mainnet                                                                    | `apps/backend/src/env.ts` (existing `LOOP_STELLAR_HORIZON_URL` + `LOOP_STELLAR_NETWORK_PASSPHRASE`)     | S    |
| I.2 | Testnet USDC issuer (Centre's testnet USDC: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH37Y2QA3K`) baked into testnet config                                  | env-driven                                                                                              | S    |
| I.3 | Mock CTX backend for testnet — Tranche 2 says "purchase mock gift card", so the upstream CTX dependency is mock-able for testnet acceptance                        | `apps/backend/src/ctx/mock-testnet.ts` (new) OR reuse existing `tests/e2e-mocked/fixtures/mock-ctx.mjs` | M    |
| I.4 | Testnet TestFlight + APK build pipeline — separate fly app `loop-api-testnet`, separate iOS bundle ID `io.loopfinance.app.testnet`, separate Android applicationId | mobile config + fly config                                                                              | M    |
| I.5 | End-to-end testnet acceptance test — install → purchase mock gift card → verify cashback to testnet wallet → verify yield accrues over time                        | extend `scripts/e2e-real.mjs` for testnet OR new `scripts/e2e-testnet.mjs`                              | M    |

## Track J — Regulatory + counsel (operator-side, 4–6 wk parallel)

Bundled multi-jurisdictional review per ADR 031 §"Open questions". Critical path for mainnet, NOT for testnet — Track I can ship without J complete.

| ID  | Task                                                                           | Size        |
| --- | ------------------------------------------------------------------------------ | ----------- |
| J.1 | Counsel selection (crypto-fintech specialist covering UK/EU/US/CA)             | S           |
| J.2 | Multi-jurisdictional review: vault curation + GBPLOOP issuance + Privy custody | XL (4–6 wk) |
| J.3 | UK FCA EMI authorisation OR partnership for GBPLOOP issuance                   | XL          |
| J.4 | EU MiCA framing (CASP authorisation timing)                                    | M           |
| J.5 | US state-by-state custody framing                                              | M           |
| J.6 | CA jurisdiction posture                                                        | S           |

## Track K — ADR housekeeping

Mechanical follow-ups once the open questions are resolved.

| ID  | Task                                                                         | File                                                    | Size |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------- | ---- |
| K.1 | Promote ADR 030 from Proposed → Accepted (after open questions 1–4 resolved) | `docs/adr/030-integrated-wallet-via-privy.md`           | XS   |
| K.2 | Promote ADR 031 from Proposed → Accepted (after open questions 1–8 resolved) | `docs/adr/031-per-currency-yield-architecture.md`       | XS   |
| K.3 | ADR 015 marked Amended pointing at ADR 031                                   | `docs/adr/015-stablecoin-topology-and-payment-rails.md` | XS   |

## Sequencing — most-aggressive parallel path

```
Day 0–7
  ├─ J.1 counsel selection starts (operator-side)
  ├─ Privy DD scheduled (open question #1, ADR 030)
  ├─ DeFindex template DD (open question #3, ADR 031)
  └─ Track A (vendor-agnostic foundations) starts in parallel

Day 7–14
  ├─ Privy DD complete OR fallback to dfns chosen
  ├─ ADR 030 → Accepted
  ├─ ADR 031 → Accepted (if DeFindex template chosen)
  ├─ Track A complete
  └─ Track B (Privy integration) starts

Day 14–30
  ├─ Track B in flight
  ├─ Track C (vault contract) starts
  ├─ Track D (GBPLOOP nightly mint) starts in parallel — independent of Soroban
  └─ Track J.2 review in flight

Day 30–60
  ├─ Track B complete (~4–5 days)
  ├─ Track D complete (~2 wk)
  ├─ Track C testnet deploy (C.1–C.5 complete)
  ├─ Track F starts (cashback flow wiring)
  ├─ Track E (treasury) ramps
  └─ Track J.2 review concludes

Day 60–90
  ├─ Track F complete
  ├─ Track G (UX) complete
  ├─ Track H (rename) complete
  ├─ Track I (testnet build) starts
  └─ Track C audit in progress

Day 90–120
  ├─ Track I testnet acceptance test passes (Tranche 2 deliverable!)
  ├─ Track C audit findings remediation
  └─ Track J regulatory authorisations in flight

Day 120+
  └─ Mainnet deploy (gated on Track C audit complete + Track J authorisations)
```

This assumes Privy passes DD on day 7. If Privy fails:

- Day 7–21 → migrate to dfns (~1–2 wk, contained per ADR 030 §"Vendor lock-in")
- Day 21+ → resume from "Day 14–30" line above

## Risks

| Risk                                                                           | Probability | Impact                                                               | Mitigation                                                     |
| ------------------------------------------------------------------------------ | ----------- | -------------------------------------------------------------------- | -------------------------------------------------------------- |
| Privy Soroban DD failure                                                       | Medium      | 1–2 wk pivot to dfns                                                 | ADR 030 §"Fallback path" — integration shape identical         |
| DeFindex template unavailable / unaudited                                      | Medium      | +4–6 wk + audit cost increase                                        | Write-from-scratch fallback ($60–80k audit instead of $30–40k) |
| Vault audit findings non-trivial                                               | Medium      | Days–weeks of fixes                                                  | Allocate buffer; testnet build can ship without audit landing  |
| Regulatory review surprises in one jurisdiction                                | Medium      | Could rule out US state-by-state, force vendor change                | Bundle review early, run parallel to engineering               |
| Revolut Business API rate-limited or insufficient for at-scale Faster Payments | Low         | Treasury op slowdown                                                 | Pre-flight at scoping; alternate UK custodian backup           |
| GBPLOOP per-tx cost at scale                                                   | Low         | $3.6k/yr at 100k holders (per ADR 031 §"Why nightly on-chain mint…") | Affordable; revisit at million holders                         |

## What I can do RIGHT NOW (no ADR Accept needed)

1. **Track A.1 — RS256 signer abstraction.** Pluggable signer; HS256 stays default. Clean refactor that survives Privy/dfns/anyone choice. ~1 day.
2. **Track A.2 — JWKS publish endpoint.** Schema/route only; only emits when private key env is set. Vendor-agnostic. ~½ day.
3. **Track A.3 — webhook scaffolding.** HMAC verify primitive + idempotent ingest. Privy-specific handler plugs into it later. ~½ day.
4. **Track A.4 — past-30-day APY pure function.** Vault-agnostic; vendor-agnostic. ~½ day.
5. **Track A.5 — `gbploop_interest_payments` schema design.** Draft the migration but don't apply (waits on ADR 031 Accept). ~½ day.
6. **Track A.6 — phase-toggle test hardening.** Extends PR #1330 coverage. ~1 day.

That's ~5 days FTE of pure prep that doesn't bake any decision in. Beyond that, work is gated on ADR Accept.

## Open questions for the team

1. Are we ready to schedule the Privy DD call? (1–3 hr per ADR 030 OQ #1)
2. Has anyone surveyed audited DeFindex curator templates? (ADR 031 OQ #3)
3. When should counsel review start? (4–6 wk lead time means earlier is better)
4. Do we want to ship Track D (GBPLOOP) ahead of Track C (vaults)? Independent paths; partial Tranche 2 launch is possible.
5. Is testnet acceptance the actual deliverable, or do we want mainnet readiness as part of Tranche 2 scope?
