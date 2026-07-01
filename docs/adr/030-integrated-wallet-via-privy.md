# ADR 030: Integrated cross-platform wallet via Privy

Status: Proposed — technical DD answered 2026-06-11 (see Due-diligence outcome); awaiting business DD (ToS/pricing/counsel) for Accepted
Date: 2026-05-05
Supersedes: ADR 015 §"User wallet linking" + rollout checklist items #362 / #366; amends ADR 009 §"Earlier exploration looked at embedded wallets via Privy / dfns / Turnkey. All three were rejected"; amends ADR 027 §"the app does NOT generate or hold a Stellar private key" (still true on-device, but Privy now does provision a managed wallet keyed to the user)
Related: ADR 013 (Loop-owned auth), ADR 014 (social login), ADR 016 (operator-signed payouts), ADR 031 (per-currency yield architecture)

## Context

Tranche 2 deliverable promises an "integrated Stellar wallet" — the user signs in once and has a balance, on any device, with one tap to withdraw. ADR 015's "link external wallet" model satisfies neither the integration nor the cross-device promise.

Pre-implementation research (2026-03, since archived) initially proposed an on-device 2-of-3 multisig with Ed25519 keys in Keychain. ADR 009 (2026-04-21) considered and rejected embedded-wallet vendors (Privy / dfns / Turnkey) on the framing that "the product is store credit; a wallet would be a distraction." Both decisions are now revisited because:

1. **Tranche 2/3 acceptance is contractual**: "integrated Stellar passkey wallet" was promised; the team has accepted that it must ship.
2. **Cross-platform identity-bound balance is required**: a user signs in with email or social on any device and sees their balance immediately. No "register this device" ceremony.
3. **Single auth step**: one sign-in, no second factor required to access the wallet. The user must not see two login screens.

Constraints (2) and (3) together rule out:

- Pure passkey-only wallet (passkeys are device/ecosystem-keyed; cross-platform breaks)
- Guardian Soroban smart-wallet requiring device passkey enrolment (multi-step ceremony violates single-auth)
- Pure non-custodial schemes generally — single-auth + cross-platform forces _something_ server-side that can re-establish wallet access from identity alone, which is custodial-adjacent by definition

What remains: vendor MPC custody (Privy / Turnkey / dfns / Web3Auth) or Loop running its own MPC service. Building Loop's own MPC is 6–9 months of work and ends up structurally identical to a vendor. **Decision is to integrate Privy as the primary vendor, with dfns (or another MPC vendor) as a documented fallback if Privy fails any critical-path DD.**

The most likely Privy DD failure mode is **Soroban token custody**: ADR 031 puts users' yield-bearing balance in Soroban DeFindex vault shares (LOOPUSD, LOOPEUR). Privy's Stellar support has historically been classic-asset-focused; Soroban support is emerging. If Privy can't custody and authorise transfers of Soroban tokens, fall back to dfns — their Stellar SDK has explicit Soroban support and similar embedded-wallet UX. Other viable fallbacks: Turnkey, Web3Auth.

## Decision

### Privy is the primary wallet vendor; dfns is the documented fallback

Loop integrates `@privy-io/react-auth` (web) and `@privy-io/expo` or the universal SDK (Capacitor mobile). Privy provisions a Stellar Ed25519 embedded wallet for each user. Wallets are keyed on Loop's `user_id` and follow the user across web, iOS, and Android.

**Fallback path**: if Privy DD fails on Soroban custody or programmatic signing (the load-bearing risk for ADR 031's vault-share architecture), Loop migrates to dfns or another MPC vendor with mature Soroban support. The integration shape is identical — Custom Auth Provider verifying Loop's RS256 JWT, vendor provisions wallet keyed on `sub`, webhook back to Loop on wallet creation. Vendor-specific code is isolated to `apps/web/app/services/<vendor>.ts` and `apps/backend/src/webhooks/<vendor>.ts`. Migration cost between vendors is contained but real (~1–2 weeks); doing the DD before signing avoids it.

### Loop-owned auth flows into Privy via Custom Auth Provider

Loop remains the auth source of truth (ADR 013). The integration:

1. User signs in with email/OTP or Google/Apple social login → Loop backend mints an access JWT (existing flow).
2. Privy SDK is configured with a Custom Auth Provider pointing at Loop's JWKS endpoint.
3. Client-side, Privy reads Loop's access token via `customAuth.getCustomAccessToken()` and authenticates against Loop's JWT.
4. First time Privy sees a `sub` claim, it provisions an embedded wallet for that user. Subsequent logins (any device) return the same wallet.

The user sees one screen, taps once, and has a wallet. No Privy login UI is exposed.

### JWT signing migrates to RS256 with JWKS

Currently `apps/backend/src/auth/tokens.ts:106` signs with HS256 + a shared secret (`LOOP_JWT_SIGNING_KEY`). Sharing that secret with Privy is unacceptable. Migration:

- Generate an RSA keypair (or Ed25519 — both supported)
- Sign access tokens with the private key, including a `kid` claim for rotation
- Publish public key at `GET /.well-known/jwks.json` in standard JWK shape (mirroring the consumer-side fetch logic already in `apps/backend/src/auth/jwks.ts`)
- Refresh tokens stay opaque (server-held random) — only access tokens need to be Privy-verifiable

### Wallet address sync via Privy webhook

Privy fires `wallet.created` (and `wallet.recovered`) webhooks. Loop adds:

- `POST /api/webhooks/privy` handler with HMAC signature verification
- On `wallet.created`, write the Stellar address to `users.stellar_address` for the user matching `sub`
- The existing `setStellarAddressHandler` (`apps/backend/src/users/stellar-address-handler.ts:44`) provides the storage primitive

Belt + suspenders: client also POSTs the address to Loop on first login if the webhook hasn't landed yet. Idempotent.

### Existing UI surfaces collapse

- `LinkWalletNudge` (`apps/web/app/components/features/cashback/LinkWalletNudge.tsx`) is removed — there is nothing to link.
- `/settings/wallet` becomes a read-only display: "Your wallet" + address + balance + withdraw button.
- Onboarding step 7 (`screen-wallet-intro.tsx`) becomes "Your wallet is ready" with the address and a one-line explainer. Auto-skipped under `LOOP_PHASE_1_ONLY` as today.
- Trustline-setup flow (`TrustlineSetupCard.tsx`) is no longer needed pre-payout — Privy can establish trustlines programmatically before first emission.

### Operator-signed payouts (ADR 016) unchanged

The payout worker still emits LOOP-asset (post-ADR 031 reduction: just GBPLOOP) and forwards-mints USDC/EURC from the operator account → user's Stellar address. The fact that the destination came from Privy is invisible to the payout path.

## Consequences

### Positive

- **Single user-visible login covers both systems.** No "now register your wallet" friction.
- **Cross-platform binding for free.** Same `sub` → same wallet on any device.
- **~4–5 days engineering effort** vs 6–9 months for self-hosted MPC.
- **Privy absorbs custody complexity** (key recovery flow, multi-device sync, MPC sharding). Loop is not in the recovery business.
- **DeFindex auto-deposit becomes possible** (see ADR 031). Privy supports policy-gated programmatic signing for specific contract calls — the substrate for "easy withdraw" UX.

### Negative / acknowledged

- **Custodial-adjacent.** Privy's MPC means "user owns the wallet" is technically true (user can export keys) but operationally Privy + Loop have functional ability to authorise transactions. This is the price of single-auth + cross-platform; ADR 009's "non-custodial framing" is partially abandoned.
- **Vendor lock-in.** Migrating users off Privy later means key export + re-import per user. Mitigation: confirm Privy supports `S...`-format Ed25519 export to standard wallets (Lobstr, Freighter) before signing.
- **Per-MAU vendor cost.** Negligible at launch; material at 100k+ MAU. Re-evaluate at T3 mainnet.
- **Regulatory weight.** Loop's relationship to user funds shifts. UK FCA / EU MiCA / US state-by-state custody framing needs counsel review (covered alongside ADR 031).

## Alternatives considered

1. **Loop-run MPC service.** Same functional shape as Privy, 6–9 months to build + audit, no per-MAU cost. Defer until Privy economics force it.
2. **Soroban smart-wallet with Loop guardian.** Non-custodial in stricter sense, but device passkey enrolment violates single-auth. Could revisit at T3 if "true non-custody" becomes a marketing or regulatory requirement.
3. **WebAuthn passkey wallet (proposal's literal wording).** Cross-platform broken; technically requires Soroban smart-wallet anyway because secp256r1 isn't a Stellar classic curve.
4. **Server-held key (full custody).** Simplest to ship, maximal regulatory exposure. Avoid unless Privy fails DD.

## Open questions

1. **Privy's Stellar implementation completeness.** Does it cover SAC tokens (needed for DeFindex per ADR 031)? Does it support policy-gated programmatic signing of specific Soroban contract calls?
2. **Key export path.** Can a user export to standard `S...`-format Ed25519 secret? Determines lock-in severity.
3. **Privy ToS jurisdictional coverage.** US/EU/UK/CA all in T1 acceptance scope. Verify.
4. **Account merge / email change handling.** If `users.id` is stable across email change, Privy keeps the same wallet. Confirm Loop's identity de-dup matches this expectation.

These are 1–3 hours each to resolve and gate moving from Proposed → Accepted on this ADR.

## Gate for Accepted

This ADR stays **Proposed** — and no implementation work (RS256 migration, Privy SDK wiring, webhook handler, UI collapse) starts — until every blocking condition below has a **recorded** answer. Flipping the status line is the deliverable of the DD cycle:

1. **Privy Soroban custody DD** (Open questions 1–2; shared critical-path blocker with ADR 031). Written confirmation via a Privy dev account that Privy can (a) custody Soroban tokens — the LOOPUSD/LOOPEUR DeFindex vault shares ADR 031 puts in user wallets, (b) display their balances, and (c) policy-gate programmatic signing of the specific `vault.deposit` / `vault.redeem` contract calls without per-tx user prompts. A "no" on any of these does **not** unblock Accepted — it triggers the documented dfns fallback (~1–2 weeks migration cost) and a re-run of this gate against dfns.
2. **Key-export path verified** (Open question 2). Privy supports `S...`-format Ed25519 secret export to standard wallets (Lobstr, Freighter). Determines lock-in severity; must be known before contracts are signed.
3. **ToS jurisdictional coverage confirmed** (Open question 3). Privy's terms cover US / EU / UK / CA — the full T1 acceptance scope.
4. **Account-merge semantics confirmed** (Open question 4). Loop's identity de-dup keeps `users.id` stable across email change so Privy keeps the same wallet.
5. **Counsel sign-off scheduled** (bundled with ADR 031 Open question 7). The custody-framing review (UK FCA / EU MiCA / US state-by-state) is engaged — 4–6 weeks of crypto-fintech counsel; Accepted requires the engagement to be booked, mainnet (Tranche 3) requires it complete.

As of 2026-06-11 none of these has a recorded answer — the DD call is unscheduled. That, not engineering capacity, is what is holding this ADR (and the Tranche-2 dependency chain behind it) at Proposed.

## File map

| Change                      | File                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------- |
| RS256 signer + JWKS publish | `apps/backend/src/auth/tokens.ts` (rewrite), `apps/backend/src/auth/jwks-publish.ts` (new)            |
| Privy webhook handler       | `apps/backend/src/webhooks/privy.ts` (new)                                                            |
| New env vars                | `LOOP_JWT_PRIVATE_KEY`, `LOOP_JWT_PUBLIC_KEY`, `LOOP_JWT_KID`, `PRIVY_APP_ID`, `PRIVY_WEBHOOK_SECRET` |
| Privy provider wrap         | `apps/web/app/root.tsx`                                                                               |
| Privy custom auth bridge    | `apps/web/app/services/privy.ts` (new)                                                                |
| Remove link-wallet UX       | delete `LinkWalletNudge.tsx`; rewrite `routes/settings.wallet.tsx`                                    |
| Onboarding step 7 rewrite   | `screen-wallet-intro.tsx`                                                                             |

## Due-diligence outcome (2026-06-11, public-docs research)

The technical gate questions are answered from Privy's published documentation; the remaining
items are business-side only.

| Gate question                                              | Outcome                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stellar custody                                            | ✅ **Tier 2 chain**: embedded EOA wallets on ed25519 (TEE + Shamir model), chain address derivation, server-side creation via `privy.wallets().create({ chain_type: 'stellar' })`. Production precedent: Kulipa runs user assets on Stellar via Privy.                                                 |
| Programmatic signing                                       | ✅ `rawSign(walletId, { hash })` returns the ed25519 signature over a transaction hash — Loop attaches it as a decorated signature with `@stellar/stellar-sdk` and submits through the existing ADR 016 machinery. Tier 2's missing "transaction building/submission" is capability Loop already owns. |
| Soroban (ADR 031 vault shares)                             | ✅ at the signing layer — `rawSign` signs any hash, Soroban invocations included. Operational complexity tracked in ADR 031, not a custody blocker.                                                                                                                                                    |
| Key export                                                 | ✅ private-key export is included in Tier 2 support (the "users can leave" requirement).                                                                                                                                                                                                               |
| Custom auth                                                | ✅ JWT-based auth with a JWKS endpoint (RS256/ES256, `sub` claim) — requires Loop's JWT migration from HS256 to RS256 + a public JWKS endpoint (Phase A below).                                                                                                                                        |
| ToS jurisdictions (US/EU/UK/CA), pricing, counsel sign-off | ⏳ **business DD — operator** (the only remaining gate items).                                                                                                                                                                                                                                         |

## Implementation plan (phases; each its own reviewed PR)

- **Phase A — RS256 + JWKS** (provider-agnostic prerequisite): Loop-native JWTs signed RS256
  with `kid`; `/.well-known/jwks.json`; dual-verify window (HS256 legacy tokens keep verifying
  until expiry); rotation via `_PREVIOUS` key, mirroring the HS256 convention.
- **Phase B — wallet provider layer**: `wallet/provider.ts` interface (create, rawSign,
  export-support) with a Privy REST adapter (plain `fetch` + Zod — no SDK dependency);
  `wallet/user-signer.ts` bridges rawSign into the existing build→sign→submit pipeline;
  `users.wallet_provider` / `wallet_id` columns; `LOOP_WALLET_PROVIDER` flag + `PRIVY_APP_ID` /
  `PRIVY_APP_SECRET`.
- **Phase C — flows**: (C1) provisioning on signup + backfill — operator-sponsored account
  creation + rawSign-signed trustline (the "sponsored wallet" from the roadmap); (C2) cashback
  payouts default to the embedded address; (C3) one-tap "pay with Loop balance" — server builds
  the redemption payment from the user wallet (memo-matched), rawSigns, submits; the deposit
  watcher + skip-table + burn machinery handle the rest unchanged. Balance display reads
  on-chain via the backend.
- **Phase D — nightly interest mints** (ADR 031 slice / ADR 036 §3): midnight-UTC worker mints
  APR/365 from the issuer to each holder, mirror-credited in the same operation,
  period-cursor idempotent; replaces the disabled off-chain accrual.

Fallback remains dfns if business DD fails; everything except the Phase B adapter is
provider-agnostic by construction.
