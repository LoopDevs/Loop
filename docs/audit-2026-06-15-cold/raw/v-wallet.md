# Cold Audit — V5 Wallet (Privy) + On-chain Interest — raw findings

> **Every item in this file is BRANCH-ONLY.** None of the audited code is on
> `main`. The wallet/interest work lives on a five-branch dependency chain
> (A → B → C → C-web → D) that must merge in order. Each finding is tagged with
> the branch the file came from and a per-phase merge-readiness note.

## Coverage (which branch each file came from)

| File                                                                                                                                          | Branch examined                                       | Vertical           |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------ |
| `apps/backend/src/auth/signer.ts`                                                                                                             | `origin/feat/wallet-phase-a-rs256-jwks`               | A — RS256/JWKS     |
| `apps/backend/src/auth/jwks.ts` (consumer)                                                                                                    | `origin/feat/wallet-phase-a-rs256-jwks`               | A                  |
| `apps/backend/src/auth/jwks-publish.ts`                                                                                                       | `origin/feat/wallet-phase-a-rs256-jwks`               | A                  |
| `apps/backend/src/routes/well-known.ts`                                                                                                       | `origin/feat/wallet-phase-a-rs256-jwks`               | A                  |
| `apps/backend/src/openapi/well-known.ts`                                                                                                      | `origin/feat/wallet-phase-a-rs256-jwks`               | A                  |
| `apps/backend/src/webhooks/hmac-verify.ts`                                                                                                    | `origin/feat/wallet-phase-a-rs256-jwks`               | A (primitive only) |
| `apps/backend/src/wallet/provider.ts`                                                                                                         | `origin/feat/wallet-phase-b-provider`                 | B — provider       |
| `apps/backend/src/wallet/privy.ts`                                                                                                            | `origin/feat/wallet-phase-b-provider`                 | B                  |
| `apps/backend/src/wallet/user-signer.ts`                                                                                                      | `origin/feat/wallet-phase-b-provider`                 | B                  |
| `apps/backend/src/db/migrations/0036_users_wallet_provider.sql`                                                                               | `origin/feat/wallet-phase-b-provider`                 | B                  |
| `apps/backend/src/wallet/provisioning.ts`                                                                                                     | `origin/feat/wallet-phase-c-flows`                    | C — flows          |
| `apps/backend/src/users/wallet-handler.ts`                                                                                                    | `origin/feat/wallet-phase-c-flows`                    | C                  |
| `apps/backend/src/openapi/users-wallet.ts`                                                                                                    | `origin/feat/wallet-phase-c-flows`                    | C                  |
| `apps/backend/src/db/migrations/0037_users_wallet_provisioning.sql`                                                                           | `origin/feat/wallet-phase-c-flows`                    | C                  |
| `packages/shared/src/users-wallet.ts`                                                                                                         | `origin/feat/wallet-phase-c-flows`                    | C                  |
| `docs/runbooks/wallet-provisioning-stuck.md`                                                                                                  | `origin/feat/wallet-phase-c-flows`                    | C                  |
| `apps/web/.../wallet/WalletCard.tsx`, `hooks/use-wallet.ts`, `services/wallet.ts`, `packages/shared/src/me-wallet.ts`                         | `origin/feat/wallet-phase-c-web`                      | C-web              |
| `apps/web/app/routes/settings.wallet.tsx`, `wallet/TrustlineSetupCard.tsx`, `wallet/StellarTrustlineStatus.tsx`, `services/stellar-wallet.ts` | `origin/feat/wallet-phase-a-rs256-jwks` (carried fwd) | C-web              |
| `apps/backend/src/credits/interest-mint.ts`                                                                                                   | `origin/feat/wallet-phase-d-interest`                 | D — interest       |
| `apps/backend/src/payments/issuer-signers.ts`                                                                                                 | `origin/feat/wallet-phase-d-interest`                 | D                  |
| `apps/backend/src/payments/payout-worker-pay-one.ts` (interest-mint signing)                                                                  | `origin/feat/wallet-phase-d-interest`                 | D                  |
| `apps/backend/src/credits/interest-scheduler.ts` (coexistence gate)                                                                           | `origin/feat/wallet-phase-d-interest`                 | D                  |
| `apps/backend/src/db/migrations/0038_interest_mint_onchain.sql`                                                                               | `origin/feat/wallet-phase-d-interest`                 | D                  |
| `apps/backend/src/scripts/wallet-testnet-walk.ts`                                                                                             | `origin/feat/wallet-phase-d-interest`                 | D                  |
| `apps/backend/src/env.ts` (Privy/RSA/issuer validation)                                                                                       | `origin/feat/wallet-phase-d-interest`                 | A–D config         |
| `apps/backend/src/logger.ts` (redaction paths)                                                                                                | `origin/feat/wallet-phase-d-interest`                 | A–D config         |
| `docs/adr/030-integrated-wallet-via-privy.md`, `docs/adr/031-per-currency-yield-architecture.md`                                              | `origin/feat/wallet-phase-d-interest`                 | ADR                |

**Overall quality:** This is exceptionally mature, well-commented, heavily-tested
code (A2-/A4- fix tags throughout, faithful mock-fetch tests asserting request
shapes + Zod drift, idempotency fences at multiple layers, CAS guards, fail-closed
defaults). The hash→rawSign→verify→submit pipeline, sponsored CAP-33 activation,
sub-minor carry accounting, and on-chain/off-chain conservation constraints are
all correct in isolation. The findings below are dominated by **two things the
code cannot fix on its own**: (1) the Privy _authorization-key_ runtime contract
is missing, and (2) the implementation diverges from — and outruns the gate on —
its own governing ADRs (030 is `Proposed` with a hard no-implementation gate; 031
v7 retired the asset names and yield model this code mints under).

---

### [P0] On-chain interest minting contradicts ADR 031 for LOOPUSD/LOOPEUR — minting vault-share assets creates unbacked tokens

- severity: **P0**
- branch: `origin/feat/wallet-phase-d-interest` (branch-only)
- file: `apps/backend/src/credits/interest-mint.ts:1-100` (mints all 3 codes); `apps/backend/src/db/migrations/0038_interest_mint_onchain.sql:38-41` (`asset_code IN ('USDLOOP','GBPLOOP','EURLOOP')`); `apps/backend/src/payments/issuer-signers.ts:80-105`
- description: The Phase-D interest-mint worker mints **all three** LOOP assets (`USDLOOP`, `GBPLOOP`, `EURLOOP`) nightly by issuing a payment from the asset's issuer account (a native Stellar mint). ADR 031 v7 (the _current_ decision) says only **GBPLOOP** — a Stellar classic asset, 1:1 GBP-backed in Loop's Revolut treasury — pays nightly on-chain interest mints (ADR 031 §"Nightly payout mechanism", lines 76-94). **LOOPUSD and LOOPEUR are Soroban DeFindex curator-vault SHARES** (ADR 031 §"LOOPUSD and LOOPEUR — Loop-curated DeFindex vaults", lines 47-54): their yield comes from **share-price growth** ("non-rebasing… User's LOOPUSD count is fixed; share price grows"), NOT from minting new shares. Minting LOOPUSD/LOOPEUR directly from an issuer account fabricates vault-share tokens that have no corresponding USDC/EURC deposit in the vault — i.e. unbacked tokens, breaking the 1:1 vault-share invariant and the asset-drift/liability reconciliation.
- impact: If `LOOP_STELLAR_USDLOOP_ISSUER_SECRET` / `LOOP_STELLAR_EURLOOP_ISSUER_SECRET` are ever configured and the worker enabled, every night the system mints unbacked vault-share tokens to users. Direct money-creation / ledger-divergence (a P0 class per the rubric). The conservation CHECK in 0038 keeps the _mirror_ internally consistent but is blind to the fact that minting a vault share is not the same as growing its price.
- evidence: `interest-mint.ts` `fiatOf()` handles all three codes; `runInterestMintTick` filters assets only on "issuer signer configured", not on "is this asset mint-eligible per ADR 031". `configuredLoopPayableAssets()` returns all configured LOOP assets. Migration CHECK allows all three asset codes. ADR 031:41-43 table: LOOPUSD/LOOPEUR = "DeFindex vault share", "Past 30-day realised"; only GBPLOOP = "paid nightly as on-chain GBPLOOP mint to holders".
- fix: Restrict on-chain nightly minting to GBPLOOP only (the classic 1:1-backed asset). For LOOPUSD/LOOPEUR, yield must accrue via vault share-price, not issuer mint — that is a different code path (DeFindex vault accounting) and is NOT YET BUILT (see [P1] DeFindex-absent below). At minimum the worker must hard-exclude non-classic assets; the 0038 CHECK should pin `asset_code = 'GBPLOOP'` (or the per-asset mint-eligibility flag) until the vault path exists.
- ref: ADR 031 v7 §LOOPUSD/LOOPEUR vaults + §GBPLOOP nightly; checklist §18 (asset issuance/mint), §25 (no money created), Part 4 ADR-031 invariants

---

### [P0] Asset-name divergence from ADR 031 v7 — code uses retired USDLOOP/EURLOOP; v7 renamed to LOOPUSD/LOOPEUR

- severity: **P0** (financial-asset identity; spoofing/reconciliation surface)
- branch: `origin/feat/wallet-phase-d-interest` (also B/C schema)
- file: `apps/backend/src/db/migrations/0038_interest_mint_onchain.sql:54-57` (`asset_code IN ('USDLOOP','GBPLOOP','EURLOOP')`); `interest-mint.ts` `fiatOf`/`STROOPS_PER_MINOR` paths; `issuer-signers.ts` (`LOOP_STELLAR_USDLOOP_ISSUER_SECRET`, `_EURLOOP_`); `packages/shared` `LoopAssetCode`
- description: ADR 031 v7 (lines 5-6, 41-45) is explicit: USD/EUR yield assets are now **LOOPUSD** and **LOOPEUR** (LOOP-prefix = "Loop is the vault curator"); the v6 names were `USDLOOP`/`EURLOOP`. The Phase-D code, the 0038 migration CHECK constraints, the issuer-secret env var names, and the shared `LoopAssetCode` union all still use the **retired** `USDLOOP`/`EURLOOP` codes. (GBPLOOP correctly retains its name per v7.) MEMORY also notes `USDLOOP/EURLOOP retired` in the v2 wallet topology.
- impact: On-chain assets are identified by `(code, issuer)`. Issuing under the wrong asset code mints the wrong asset; trustlines opened at provisioning (`buildActivationTransaction`) would be for the wrong asset code; the public loop-assets surface, drift watcher, and burn paths would all reference a code that ADR 031 says does not exist. This is an asset-identity/spoofing and reconciliation P0 — every downstream consumer keyed on the code is wrong.
- evidence: `grep USDLOOP|EURLOOP` across migration 0038, `issuer-signers.ts`, `interest-mint.ts`, env.ts (`LOOP_STELLAR_USDLOOP_ISSUER`/`_SECRET`). ADR 031:41-42 table names LOOPUSD/LOOPEUR; ADR 031:5 "replaced by Loop-curated DeFindex vaults backing LOOPUSD/LOOPEUR".
- fix: Decide the canonical names (ADR 031 v7 says LOOPUSD/LOOPEUR) and align the asset-code union, CHECK constraints, env var names, and all string literals before any issuer secret is configured. If the team intends to keep USDLOOP/EURLOOP, ADR 031 must be re-amended — but the code and ADR currently disagree, which is itself the defect.
- ref: ADR 031 v7 §Amends; checklist §25 (FX/asset identity), §22 (type-contract integrity), §9 (CHECK constraints vs ADR), Part 4

---

### [P1] Privy `raw_sign` is missing the required `privy-authorization-signature` header — the entire signing pipeline cannot run

- severity: **P1** (becomes P0 the moment the wallet layer is enabled in prod — nothing user-signed can submit)
- branch: `origin/feat/wallet-phase-b-provider` (consumed by C provisioning + D mint targeting)
- file: `apps/backend/src/wallet/privy.ts:115-135` (`privyRequest` headers — only `Authorization: Basic` + `privy-app-id`); `apps/backend/src/env.ts:632-640` (no authorization-key var); whole-tree grep finds no `privy-authorization-signature` / `PRIVY_AUTHORIZATION_KEY` / P-256 signing
- description: Privy's server-side wallet API requires, **in addition to HTTP Basic + `privy-app-id`**, a `privy-authorization-signature` header for any action that _uses_ a wallet — including `POST /v1/wallets/:id/raw_sign`. The app must register a P-256 authorization key with Privy and sign each request body with the corresponding private key. The adapter sends only Basic auth + app-id. There is no authorization-key env var, no P-256 signing code, and the privy.test.ts header assertion (`privy.test.ts:100-106`) confirms the absence is baked in (it asserts exactly `Authorization`, `privy-app-id`, `privy-idempotency-key`).
- impact: `rawSign` requests for server-controlled wallets will be rejected by Privy (4xx → classified `terminal_provider`). That means: wallet _activation_ (`changeTrust` user-half in `provisioning.ts`) can never be signed → no user ever reaches `activated`; and interest-mint payouts target wallets that were never activated. `createWallet` (no signature required) works, but the chain stalls at `wallet_created`. The whole Phase-B "hash→rawSign→verify→submit" promise is non-functional against real Privy.
- evidence: WebSearch of Privy docs (Authorization signatures | Privy Docs; Signing on the server): "your app must include an authorization signature in the `privy-authorization-signature` header… create an app authorization key… sign API requests with this key to authorize sending transactions from user wallets." ADR 030:128 itself lists `PRIVY_WEBHOOK_SECRET` but no authorization key — the env design also missed it.
- fix: Add a `PRIVY_AUTHORIZATION_KEY` (P-256 PKCS8 PEM) env var, boot-validate it, and have `privyRequest` compute and attach `privy-authorization-signature` for wallet-using calls (raw_sign, and any future transfer). Add a test asserting the header is present + correctly signs the canonical request payload. This is a Phase-B merge blocker — the layer is non-functional without it.
- ref: Privy server-wallets authorization docs; checklist §2 (crypto/key custody), §5 wallet completeness, §19 documented-but-unimplemented

---

### [P1] Privy webhook handler (`wallet.created` / `wallet.recovered`) is entirely absent — only the generic HMAC primitive ships

- severity: **P1** (completeness / merge-readiness)
- branch: not present on any branch (gap)
- file: missing — `apps/backend/src/webhooks/privy.ts` does not exist; `apps/backend/src/webhooks/hmac-verify.ts` (phase-a) is the _generic_ primitive only; no `/api/webhooks/privy` route; no `webhook_events` dedupe table; no `PRIVY_WEBHOOK_SECRET` env var
- description: ADR 030 §"Wallet address sync via Privy webhook" (lines 56-64) and the impl table (line 127-128) require a `POST /api/webhooks/privy` HMAC-verified handler that records wallet addresses on `wallet.created`/`wallet.recovered`, plus the "belt + suspenders" client-POST fallback. The hmac-verify module's own docstring states the per-vendor handler + event-id dedupe table are "out of scope for Track A.3" and happen "in `webhooks/<vendor>.ts`" — which was never written. The route is not mounted (grep finds no `webhook` route registration), there is no replay/idempotency `webhook_events` table, and `PRIVY_WEBHOOK_SECRET` is not in env.ts.
- impact: Provisioning currently relies solely on the backend-driven `createWallet` (no webhook needed for that path), so this is not a runtime crash — but ADR 030's documented address-sync + the dfns-fallback "webhook back to Loop on wallet creation" contract is unimplemented. Any recovery/multi-device wallet-address change Privy fires will be silently dropped. Marked as the canonical "documented-but-unimplemented" item from the checklist.
- evidence: `git ls-tree` of phase-d webhooks dir → only `hmac-verify.ts` + its test. ADR 030:60 "`POST /api/webhooks/privy` handler with HMAC signature verification". hmac-verify.ts docstring lines 20-26 explicitly defer the handler + dedupe table.
- fix: Build `webhooks/privy.ts` (parse Svix-style headers → `verifyHmacWebhook` → dedupe by event id against a new `webhook_events` table → upsert `users.wallet_address`/`wallet_id`), mount `POST /api/webhooks/privy` (raw-body capture before JSON parse, rate-limited, OpenAPI-registered), add `PRIVY_WEBHOOK_SECRET` to env.ts + redaction. Not a blocker for the createWallet path but is a Phase-C completeness gap.
- ref: ADR 030 §webhook + impl table; checklist §29 (webhooks — Privy handler exists?), Part 5 completeness sweep

---

### [P1] ADR 030 is `Status: Proposed` with an explicit no-implementation gate — yet all five phases are built

- severity: **P1** (governance / merge-readiness; not a code defect but blocks merge by the project's own rules)
- branch: all five (process finding)
- file: `docs/adr/030-integrated-wallet-via-privy.md:3` (`Status: Proposed`), `:110-120` (Gate for Accepted); ADR 031:3 (`Status: Proposed`)
- description: ADR 030 §"Gate for Accepted" (line 112): "This ADR stays **Proposed** — and **no implementation work (RS256 migration, Privy SDK wiring, webhook handler, UI collapse) starts** — until every blocking condition below has a **recorded** answer." Line 120: "As of 2026-06-11 none of these has a recorded answer — the DD call is unscheduled." The blocking conditions include the **Privy Soroban-custody DD** (line 114, shared critical-path blocker with ADR 031) and counsel sign-off (line 118). The implementation (RS256, Privy adapter, provisioning, web UI, interest mint) exists in full across the five branches in violation of this gate. The CLAUDE.md doc-update rules also require "Add/update `docs/adr/NNN-title.md` before implementing" and ADR status should move Proposed→Accepted.
- impact: Per the project's own rules, none of these branches is merge-eligible until ADR 030/031 flip to Accepted with recorded DD answers. The Soroban-custody DD is load-bearing: if Privy cannot custody/sign Soroban tokens, LOOPUSD/LOOPEUR move to dfns and the entire provider adapter changes (the [P0] vault-mint issue is downstream of this unresolved DD).
- evidence: ADR 030:3,110-120; ADR 031:3. Branches contain the implementation regardless.
- fix: Resolve and record the DD answers; flip ADR 030/031 to Accepted (or pivot to dfns); only then merge. If the team has decided to proceed, the ADRs must be updated to reflect that decision before merge — the ADR and the code currently disagree on whether this work is even sanctioned.
- ref: ADR 030 Gate; CLAUDE.md doc-update rules ("ADR before implementing"); checklist §5, Part 4

---

### [P1] DeFindex vault path (LOOPUSD/LOOPEUR yield) is documented but entirely unimplemented

- severity: **P1** (completeness)
- branch: not present on any branch (gap)
- file: missing — no DeFindex / vault / Soroban deposit-redeem code anywhere in the branches
- description: ADR 031 §"LOOPUSD and LOOPEUR — Loop-curated DeFindex vaults" (lines 47-72) requires `LOOP_USD_VAULT`/`LOOP_EUR_VAULT` Soroban vaults, share-price reads, `vault.deposit`/`vault.redeem` Soroban contract calls via Privy server-signing, and a float-management layer. None of this exists. Phase D instead mints LOOPUSD/LOOPEUR as classic issuer payments (the [P0] above), which is the wrong mechanism entirely.
- impact: USD/EUR yield is either non-functional (no vault) or actively wrong (issuer-mints unbacked shares). The whole DeFindex half of ADR 031 is a stub-by-omission.
- evidence: `grep -i defindex|vault|soroban|deposit|redeem` across the wallet/credits/payments dirs → no contract-invocation code. ADR 031:49-72 specifies the vault flow in detail.
- fix: Either build the vault path (Soroban contract calls, share-price oracle, float) or descope LOOPUSD/LOOPEUR from Phase 2 and ship GBPLOOP-only nightly interest. The current "mint vault shares as classic assets" shortcut must not ship.
- ref: ADR 031 §vaults; checklist §19/Part 5 documented-but-unimplemented, §18 asset issuance

---

### [P1] Web: WalletCard + PayWithLoopBalance bypass `LOOP_PHASE_1_ONLY` gating (sub-agent finding)

- severity: **P1**
- branch: `origin/feat/wallet-phase-c-web`
- file: `apps/web/app/components/features/wallet/WalletCard.tsx:52` (self-hides only on backend-endpoint absence, no phase gate); mounted unguarded at `components/features/home/MobileHome.tsx:217` and `routes/auth.tsx:445`; `PayWithLoopBalance` mounted unguarded at `LoopPaymentStep.tsx:80`
- description: Every sibling Phase-2 surface (`settings.wallet`, `cashback`, `settings.cashback`, `trustlines`) wraps in `Phase2Gate`; WalletCard and PayWithLoopBalance do not. The card's only gate is "hide until `/api/me/wallet` exists." Once that endpoint deploys, the on-chain balance + interest-rate line render on home/account screens even with `LOOP_PHASE_1_ONLY=true`. `auth.tsx` already has `config.phase1Only` in scope (it's passed to `CashbackBalanceCard` at line 449) — WalletCard is the lone unguarded consumer.
- impact: Phase-2 yield UI leaks into a Phase-1 build, contradicting ADR 031 launch gating and the "Coming soon" posture.
- fix: Gate both mounts on `!phase1Only` (or wrap WalletCard internally), add a phase-gated test.
- ref: checklist §27 feature flags, §23/§32 UX; ADR 031 launch gating

---

### [P1] Web: "APR" mislabels an APY rate; ADR 031 mandates "APY" + a no-guarantee disclaimer (sub-agent finding)

- severity: **P1** (financial-rate copy accuracy / compliance)
- branch: `origin/feat/wallet-phase-c-web`
- file: `WalletCard.tsx:62` ("Earns {…}% **APR**, paid nightly."); test `WalletCard.test.tsx:90` asserts `/Earns 3% APR/` (locks in the bug); shared field is `interestApyBps` ("nightly-interest **APY**", `me-wallet.ts:41`)
- description: ADR 031 says "3% **APY** fixed, paid nightly" and (lines 28-30, 94) mandates "past-30-day realised APY with standard 'no guarantee' disclaimer." The card renders "APR" (APR ≠ APY) and ships no disclaimer and no past-30-day/variable qualifier.
- impact: Mislabels a financial rate on a user-facing balance card; misses a documented regulatory display requirement.
- fix: Change "APR"→"APY" in component + test; append the standard no-guarantee disclaimer.
- ref: ADR 031 §display constraints; checklist §32 copy accuracy, §16 compliance

---

### [P2] `enqueueWalletProvisioning` failure path bumps attempts; success-deferred path neither resets nor records — backoff bookkeeping asymmetry

- severity: **P2**
- branch: `origin/feat/wallet-phase-c-flows`
- file: `apps/backend/src/wallet/provisioning.ts` (`enqueueWalletProvisioning` then-branch logs "deferred to sweeper" without touching `last_attempt_at`; catch-branch calls `recordFailedAttempt`)
- description: When the signup-time fire-and-forget drive _partially_ succeeds (e.g. `createWallet` lands but activation defers because operator unconfigured → returns a config outcome, not a throw), the then-branch only logs. The sweeper then re-drives immediately (no `last_attempt_at` set), which is fine for config outcomes (they abort the tick without bumping). But a drive that _throws after_ `createWallet` persisted goes to catch → `recordFailedAttempt` bumps attempts even though forward progress was made. Minor: the backoff counter conflates "no progress" with "partial progress," so a flaky activation can burn the 10-attempt budget faster than intended.
- impact: Low — at worst a user hits the cap and pages ops slightly early; the sweeper backfill still re-drives. No money/security impact.
- fix: Reset `walletProvisioningAttempts` to 0 on any state advance (`none→wallet_created`, `→activated`), so the cap measures consecutive failures at the _current_ stage rather than lifetime drives.
- ref: checklist §4 retries/backoff, §11 concurrency

---

### [P2] Interest-mint cursor advances on `errors===0` but a partial Horizon outage mid-sweep can leave a fully-missed-day false negative

- severity: **P2**
- branch: `origin/feat/wallet-phase-d-interest`
- file: `apps/backend/src/credits/interest-mint.ts` (`runInterestMintTick`: cursor advanced only when `result.errors===0`; the `daysBehind>1` warn relies on the cursor)
- description: The design is sound (errors hold the cursor; re-run is idempotent via the two fences). But the "fully-missed UTC day → log loudly, do not retro-mint" logic keys off `cursor < period`. If a multi-day Horizon outage causes every per-user drive to throw, `errors>0` holds the cursor at the last good day, and the _first_ fully-successful tick days later will compute interest using _today's_ balance for the gap days that did snapshot, while genuinely-missed days are correctly skipped — but the warn fires only once per tick and ops has no structured alert (it's a `log.warn`, not a Discord notifier). The redemption-backfill and payout watchdogs page; this one doesn't.
- impact: Missed interest nights are a customer-money under-payment that surfaces only in logs. No over-payment (the snapshot fence prevents that), but the gap is not actionably alerted.
- fix: Promote the `daysBehind>1` warn to a Discord monitoring notifier with a runbook (mirror `notifyWalletProvisioningStuck`); add a worker-staleness alert on `interest_mint` cursor age.
- ref: checklist §6 alerting, §26 scheduling/missed-run, §30 resilience

---

### [P2] No `LOOP_WALLET_PROVIDER=privy` enabled without Privy authorization-key boot-check (compound with the [P1] header gap)

- severity: **P2**
- branch: `origin/feat/wallet-phase-b-provider` / env.ts
- file: `apps/backend/src/env.ts:787-805` (cross-field check requires only `PRIVY_APP_ID`+`PRIVY_APP_SECRET` when provider=privy)
- description: The boot validator enforces app-id/secret presence but not the authorization key (which doesn't exist as a var — see [P1]). So a prod deploy can set `LOOP_WALLET_PROVIDER=privy` + workers enabled, pass boot, provision wallets, and silently fail every `rawSign` at runtime with `terminal_provider` — the failure is deferred to the sweeper's retry budget rather than caught at boot.
- impact: Fail-deferred rather than fail-closed-at-boot for a guaranteed-broken config. Wasted retry budget, delayed ops paging.
- fix: Once the authorization key is added ([P1]), make it required-at-boot whenever `LOOP_WALLET_PROVIDER=privy` (same cross-field pattern as app-id/secret).
- ref: checklist §7 env boot validation, §4 fail-closed

---

### [P3] CAP-33 `beginSponsoringFutureReserves` source comment is slightly imprecise (behavior correct)

- severity: **P3**
- branch: `origin/feat/wallet-phase-c-flows`
- file: `apps/backend/src/wallet/provisioning.ts` `buildActivationTransaction` (begin has no explicit `source` → defaults to tx source = operator; end has `source: userAddress`)
- description: The op ordering (begin[operator] → createAccount[operator] → changeTrust[user] → end[user]) is correct CAP-33: the operator opens sponsorship, creates the user account with 0 XLM, the user authorizes their own trustlines and closes the sandwich. The comment correctly notes end must be the sponsored account. Behavior is right; this is a nit that the begin-source defaulting is implicit (relies on tx source = operator). A reviewer could misread it. No defect.
- fix: Optional: add an explicit comment that begin's source defaults to the transaction source (operator). No code change needed.
- ref: checklist §18 CAP-33 sponsorship

---

### [P3] `stellar-wallet.ts` web stub ships to bundle + lists retired asset codes (sub-agent finding)

- severity: **P3**
- branch: `origin/feat/wallet-phase-c-web`
- file: `apps/web/app/services/stellar-wallet.ts` (every export throws "stellar-wallets-kit not yet installed"; `PayParams.assetCode` union still lists `USDLOOP`/`EURLOOP`)
- description: Intentional ADR-gated scaffolding (self-documented), but it is dead code in the bundle and references the retired asset codes (compounds the [P0] naming divergence on the web side).
- fix: Keep behind the ADR but trim retired codes from the union, or delete until the kit lands.
- ref: checklist §14 dead code, §22 type parity

---

### [P3] Web a11y + display nits (sub-agent findings)

- severity: **P3**
- branch: `origin/feat/wallet-phase-c-web` / `-a`
- files/items: `WalletCard.tsx:18` `fmtLoopBalance` uses `Number()` and renders em-dash on overflow indistinguishable from empty state (safe today, backend-controlled); Copy button `aria-live="polite"` is on the button itself rather than a dedicated `sr-only` live region (may not announce reliably); currency picker uses `<button role="radio">` without arrow-key cycling.
- fix: Prefer a stroops-based display formatter matching `services/wallet.ts`'s bigint discipline; move the polite text to a sibling sr-only span; add roving-tabindex/arrow handling to the radiogroup.
- ref: checklist §15 accessibility, §1 correctness

---

## Things verified CORRECT (no finding — recorded so the next reviewer doesn't re-litigate)

- **RS256/JWKS (Phase A)** — `signer.ts`: RFC 7638 kid thumbprint computed correctly (lexicographic `{e,kty,n}`, base64url), public-only JWK export (never `d`/`p`/`q`), alg-dispatch verify with current→previous rotation per algorithm, HS256 retained verify-only during cutover, RSASSA-PKCS1-v1_5 SHA-256. JWKS publish serves `{"keys":[]}` (not 404) when RS256 unconfigured. OpenAPI registers 200+429. Per-PEM signer memo cache is bounded (≤2). Clean.
- **Privy adapter request hygiene** — 10s AbortSignal timeout on every call; transient/terminal taxonomy mirrors payout-submit (5xx/429/network = transient, other 4xx/Zod-drift/non-JSON-2xx = terminal); Zod non-strict so additive upstream changes don't break; `external_id` regex-pinned (URL-safe ≤64); two-layer createWallet idempotency (query-before-create + deterministic idempotency key + DB partial-unique backstop on `wallet_id`).
- **user-signer pipeline** — verifies provider signature locally with `Keypair.fromPublicKey(address).verify(hash, sig)` BEFORE `addSignature`; 128-hex-char ed25519 length check at both adapter and bridge; reuses ADR-016 `submitPreSignedTransaction` for one shared Horizon taxonomy. No private key ever on backend. Uses `@stellar/stellar-sdk` (not Web Crypto). Clean.
- **payout-worker interest-mint signing** — correctly selects the issuer keypair for `kind='interest_mint'` (a payment from issuer = native mint), leaves rows pending when issuer signer absent/mismatched (never signs a mint with the operator key), and the idempotency pre-check scans the **signer's** account history (A4-104) so the operator≠issuer topology doesn't open a double-pay path. Burn rows (`toAddress===assetIssuer`) correctly skip the trustline probe.
- **interest math + carry** — all-bigint, floored 7-decimal accrual, sub-minor carry accumulator with a DB conservation CHECK (`carry_before + accrual = minted_minor*1e5 + carry_after`), bounded carry CHECK (`< 100000`), drift-neutral per night. Both mirror + on-chain halves move by exactly `minted_minor`.
- **interest idempotency / crash-consistency** — snapshot unique index + pre-existing credit_transactions period-cursor partial unique (migration 0012) are the two money-level fences; unique-violation caught and classified `skipped_already`; cursor held on any error; one DB txn writes snapshot + ledger + mirror + payout atomically. UTC period cursor.
- **legacy↔on-chain interest coexistence** — `startInterestScheduler` boot-throws when `LOOP_INTEREST_ONCHAIN_ENABLED=true` ("two interest writers must never coexist"). Clean fail-closed.
- **issuer-signers key custody** — derives public key from secret and asserts equality with configured `LOOP_STELLAR_<ASSET>_ISSUER` (defence-in-depth over env.ts's boot check); secret never logged.
- **secrets handling** — logger `REDACT_PATHS` covers `PRIVY_APP_SECRET`/`appSecret`, `LOOP_STELLAR_*_ISSUER_SECRET`/`issuerSecret`, `operatorSecret`, `DATABASE_URL`, RSA via generic `secret`/`secretKey` globs. env.ts boot-validates RSA PEM (parse + asymmetricKeyType=rsa), issuer-secret↔address derivation match, Privy app-id/secret cross-field presence. `wallet-testnet-walk.ts` uses env-only secrets, no hardcoded `S...` keys.
- **provisioning idempotency** — `persistWalletCreated` guarded on `wallet_id IS NULL` (no clobber); `markActivated` guarded `!= 'activated'`; Horizon pre-check detect-and-mark for crash-after-submit window; `recordFailedAttempt` CAS on attempts counter (no double-page); config outcomes don't burn retry budget; fresh sequence per drive; `unref()` timer; worker liveness markers.
- **schema/migrations** — 0036/0037/0038 well-constrained: partial-unique on `wallet_id`/`wallet_address`, CHECK-pinned enum sets, partial index for sweeper scan, FK `ON DELETE restrict`, `char(3)` currency CHECK, issuer-format regex CHECK, non-negative + conservation CHECKs on snapshots. (Asset-code CHECK values are wrong per [P0] naming, but the _structure_ is correct.)
- **wallet-handler (`GET /api/me/wallet`)** — authed never-500 (last-known-good on Horizon error, `stale:true`), serves on-chain balance as authoritative (mirror not exposed per ADR 036), route mounted with no-store + requireAuth + 60/min rate limit, OpenAPI 200/401/429/503 registered.
- **HMAC primitive** — timestamp-before-HMAC, constant-time compare, v1-only with explicit reject on v2, multi-candidate rotation, raw-body-verbatim contract documented, ≤600s tolerance cap. (Correct primitive; it's just never wired to a handler — see [P1] webhook.)
- **tests** — faithful (mock fetch + assert exact request shapes/headers/bodies, Zod-drift cases, idempotency races, error taxonomy); not vacuous. Counts: privy 16, user-signer 7, provisioning 16, interest-mint 19, issuer-signers 5, plus web suites.

---

## Merge-readiness per phase

| Phase / branch                                                                           | Merge-ready?                                   | Blockers                                                                                                                             |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **A** `feat/wallet-phase-a-rs256-jwks` (RS256/JWKS, HMAC primitive, web trustline cards) | **Closest** — code is clean and self-contained | ADR 030 still `Proposed` ([P1 governance]); HMAC primitive has no consumer (acceptable to land as a primitive)                       |
| **B** `feat/wallet-phase-b-provider` (provider/privy/user-signer, 0036)                  | **No**                                         | [P1] missing Privy authorization-signature header → `rawSign` non-functional; asset-name [P0] surfaces in shared union; depends on A |
| **C** `feat/wallet-phase-c-flows` (provisioning, wallet-handler, 0037)                   | **No**                                         | inherits B blockers; [P1] Privy webhook handler absent; [P2] attempts-reset; depends on A+B                                          |
| **C-web** `feat/wallet-phase-c-web` (WalletCard/use-wallet/services/me-wallet)           | **No**                                         | [P1] phase-1 gating bypass; [P1] APR/APY + disclaimer; depends on C                                                                  |
| **D** `feat/wallet-phase-d-interest` (interest-mint, issuer-signers, 0038)               | **No**                                         | [P0] mints unbacked LOOPUSD/LOOPEUR vault shares; [P0] retired asset names; [P1] DeFindex path unbuilt; depends on A+B+C             |

**Dependency chain integrity:** A → B → C → C-web / D. Confirmed each branch is a superset of the prior (file listings cumulative). Phase-A files are carried forward into all later branches; `loop-asset.ts`/`Phase2Gate.tsx` exist as independent copies on A vs C-web (currently identical — verify at merge). Branches must merge in order; merging D without B's authorization-key fix ships a non-functional + money-unsafe minting worker.

---

## Summary

- **Branches inspected:** all 5 — `origin/feat/wallet-phase-a-rs256-jwks`, `-b-provider`, `-c-flows`, `-c-web`, `-d-interest`.
- **Files examined:** 27 source/migration/ADR files in scope (+ tests for each, env.ts, logger.ts, route/openapi wiring, payout-worker-pay-one.ts).
- **Severity counts:** **P0 × 2**, **P1 × 7**, **P2 × 4**, **P3 × 4**.
- **Verdict:** The engineering is high-quality and the security-critical signing/idempotency/conservation machinery is correct in isolation. But the suite is **NOT merge-ready**. Two P0s are money-correctness/ADR-divergence (minting unbacked vault-share assets; retired asset codes). The headline P1 is that **Privy `raw_sign` cannot run without the authorization-signature header**, which makes the entire signing pipeline non-functional against real Privy — so even setting the P0s aside, no wallet would ever activate. Governance: ADR 030/031 are still `Proposed` with an explicit no-implementation gate, and the Privy webhook + DeFindex vault paths are documented-but-unbuilt. Recommended order to unblock: (1) resolve ADR 030 Soroban-custody DD + flip status, (2) add the Privy authorization key, (3) fix asset names + restrict on-chain minting to GBPLOOP (or build the vault path), (4) Privy webhook handler, (5) web phase-gating + APY copy.
