# Vertical Wallet/Privy (branch-only) — raw findings

**Method note.** All branches below are read-only via `git show
<branch>:<path>` / `git diff main...<branch>` — working tree never touched.
This is a re-audit of the same five-branch wallet chain (+ the ADR-036 burn
branch it depends on) the 2026-06-15 cold audit covered in
`docs/audit-2026-06-15-cold/raw/v-wallet.md`. That file's findings were read
**after** independently re-deriving the bugs from the current code, per the
task brief — every finding below was confirmed (or revised) against the
actual branch content as of today, not copied from the prior pass.

## Branches found + HEAD + last-updated

All commit dates are **2026-06-11 / 2026-06-12** — identical to the 06-15
audit baseline. **None of these branches has moved in the 18 days since the
prior audit.** No rebase, no new commits, no partial fixes.

| Branch                                  | HEAD       | Committed        |
| --------------------------------------- | ---------- | ---------------- |
| `origin/feat/wallet-phase-a-rs256-jwks` | `d9e46aaf` | 2026-06-11 23:51 |
| `origin/feat/wallet-phase-b-provider`   | `5d425d29` | 2026-06-11 23:54 |
| `origin/feat/wallet-phase-c-flows`      | `9f5952e0` | 2026-06-12 00:40 |
| `origin/feat/wallet-phase-c-web`        | `cf2f3363` | 2026-06-12 00:17 |
| `origin/feat/wallet-phase-d-interest`   | `60a98c12` | 2026-06-12 01:50 |
| `origin/fix/adr036-emission-burn`       | `ac1910dc` | 2026-06-11 20:51 |

Dependency chain confirmed unchanged: A → B → C → (C-web / D), with
`fix/adr036-emission-burn` merged into `feat/wallet-phase-c-flows` (and
therefore inherited by C-web and D). `feat/wallet-phase-a-rs256-jwks`
branches off `9fa466c5` (#1422, "commit CTX catalog operator tooling"),
which predates even the 06-15 audit's `04c3fae0` baseline by several commits
— these branches are now **two full hardening cycles behind `main`**
(comprehensive-audit-2026-06-11 fixes + this repo's own 06-15→06-30
22-commit delta never landed on them). See W-05 below for why that matters
beyond "needs a rebase."

Two more branches matched the search grep (`staff`) but are a different
vertical (V8 Admin/staff, ADR 037) — noted only for dependency tracking:
`origin/feat/staff-roles-backend` (`3eb5d3a3`) branches off
`feat/wallet-phase-c-flows` (`9f5952e0`), so it inherits every Phase A–C
wallet defect below as baggage; `origin/feat/staff-dashboard-web`
(`05fb0c4a`) sits on top of that. Not deep-dived here — flagging so the
admin/staff vertical owner knows the merge-order dependency exists.

---

## Findings

### W-01 [P0 · BRANCH] Interest-mint still mints unbacked LOOPUSD/LOOPEUR vault-share assets — byte-identical to 06-15

- File: `apps/backend/src/credits/interest-mint.ts` (`fiatOf`, `runInterestMintTick`) and `apps/backend/src/credits/payout-asset.ts` (`origin/feat/wallet-phase-d-interest`); `apps/backend/src/db/migrations/0038_interest_mint_onchain.sql` CHECK constraint
- Description: `fiatOf()` still switches over `USDLOOP | GBPLOOP | EURLOOP` exhaustively (TypeScript-enforced, so removing the other two requires a real code change, not a config flag). `runInterestMintTick`'s asset filter (`configuredLoopPayableAssets().filter((a) => signer present && address matches)`) is the **only** eligibility gate — there is no "is this asset architecturally mint-eligible" check. ADR 031 v7 is unambiguous: only GBPLOOP (Stellar classic, 1:1 GBP-backed) gets nightly on-chain mints; LOOPUSD/LOOPEUR are DeFindex vault shares whose yield is share-price growth, never an issuer mint. Compounding: `apyBps = env.INTEREST_APY_BASIS_POINTS` is a single global rate applied identically to all three assets — even setting aside the mint-vs-vault-share issue, ADR 031 doesn't define a single fixed APY for the vault assets (their yield is "past-30-day realised," variable, no-guarantee) the way it does for GBPLOOP's 3% fixed nightly rate. One env var cannot correctly parameterize two different yield architectures.
- Impact: the moment `LOOP_STELLAR_USDLOOP_ISSUER_SECRET` / `LOOP_STELLAR_EURLOOP_ISSUER_SECRET` are configured and the worker runs, every eligible USD/EUR holder receives nightly issuer-minted tokens with zero backing asset — direct unbacked money creation, a ledger-divergence P0 by the audit rubric (checklist §18, §25).
- Evidence: `interest-mint.ts:240-247` (`fiatOf`), `:361-365` (`assets = configuredLoopPayableAssets().filter(...)`, no asset-code restriction), `payout-asset.ts` issuer map handles all three codes uniformly. Migration 0038 line: `CHECK ("asset_code" IN ('USDLOOP', 'GBPLOOP', 'EURLOOP'))`.
- Minimal fix: hard-restrict `runInterestMintTick`'s asset filter to `code === 'GBPLOOP'` (or a new per-asset `mintEligible` flag sourced from a single allowlist constant), and pin the 0038 CHECK to `asset_code = 'GBPLOOP'` until the vault path exists.
- Better fix: build the DeFindex vault-share accounting path (deposit/redeem via Soroban, share-price oracle) for LOOPUSD/LOOPEUR per ADR 031, and give GBPLOOP its own named rate env var (`LOOP_GBPLOOP_INTEREST_APY_BPS`) instead of a generic `INTEREST_APY_BASIS_POINTS` that implicitly assumes every LOOP asset shares one yield model.
- Blocks merge: yes (Phase D).

### W-02 [P0 · BRANCH] Privy `raw_sign` still has no `privy-authorization-signature` header — signing pipeline cannot run against real Privy

- File: `apps/backend/src/wallet/privy.ts:108-186` (`origin/feat/wallet-phase-b-provider`, carried into C/C-web/D); `apps/backend/src/env.ts` (no `PRIVY_AUTHORIZATION_KEY` or equivalent var anywhere in the env schema); test `apps/backend/src/wallet/__tests__/privy.test.ts:99-106`
- Description: `privyRequest()` sends exactly `Authorization: Basic <appId:appSecret>`, `privy-app-id`, and (on POST) `privy-idempotency-key`. Privy's server-wallet API requires an additional `privy-authorization-signature` header — a P-256-signed canonical request — for any call that **uses** a wallet (`raw_sign` chief among them). No authorization key is generated, stored, validated at boot, or attached. The header-shape assertion in `privy.test.ts` locks in exactly the three headers above and nothing more, so the test suite would need to change, not just pass, before this could work.
- Impact: every `rawSign` call against real Privy will be rejected. That breaks the entire chain downstream: wallet activation (`provisioning.ts`'s `changeTrust` user-half), pay-with-balance (`pay-with-balance.ts`'s user-signed inner tx), and any future user-initiated transfer. `createWallet` (no signature needed) is the only Privy call that would actually work. The whole "hash→rawSign→verify→addSignature→submit" pipeline — while internally well-built (local signature verification before `addSignature`, ed25519 length checks, shared Horizon submit/classify taxonomy) — is non-functional end-to-end.
- Evidence: identical to 06-15 audit, re-verified by direct read today. No `grep -ri "authorization-signature\|PRIVY_AUTHORIZATION"` hit anywhere across all 5 branches.
- Minimal fix: add `PRIVY_AUTHORIZATION_KEY` (P-256 PKCS8 PEM) to `env.ts`, boot-validate it whenever `LOOP_WALLET_PROVIDER=privy` (mirroring the existing `PRIVY_APP_ID`/`PRIVY_APP_SECRET` cross-field check — closes the prior audit's compounding P2 on this point too), compute and attach the signature in `privyRequest` for wallet-using calls, and update the test to assert it's present and correctly signs the canonical payload.
- Better fix: same as minimal — this isn't a design question, it's an unimplemented integration-contract requirement. The "better" version just also adds a runtime smoke-test (the existing `wallet-testnet-walk.ts` script) that actually exercises `rawSign` against a real Privy sandbox app before any production cutover, since the current test suite only proves request _shape_, not that Privy accepts it.
- Blocks merge: yes (Phase B and everything downstream).

### W-03 [P1 · BRANCH] Privy webhook handler still absent — orphaned HMAC primitive, no consumer

- File: missing. `apps/backend/src/webhooks/` on `origin/feat/wallet-phase-d-interest` (and every other wallet branch) contains only `hmac-verify.ts` + its test; no `privy.ts`, no `/api/webhooks/privy` route, no `webhook_events` dedupe table, no `PRIVY_WEBHOOK_SECRET` in `env.ts`.
- Description: unchanged from 06-15. ADR 030 §"Wallet address sync via Privy webhook" requires this; the generic HMAC primitive's own docstring still defers the vendor-specific handler. Today's provisioning flow doesn't strictly need it (backend-driven `createWallet` doesn't wait on a webhook), so this is a completeness gap rather than a runtime crash, but it means any Privy-side wallet recovery / multi-device address change is silently dropped.
- Impact: documented-but-unimplemented per checklist Part 5; ADR 030's "belt + suspenders" address-sync contract doesn't exist.
- Evidence: `git ls-tree -r origin/feat/wallet-phase-d-interest -- apps/backend/src/webhooks` → 2 files only, both the generic primitive.
- Minimal fix: build `webhooks/privy.ts` (Svix-style header parse → `verifyHmacWebhook` → dedupe via a new `webhook_events` table → upsert `users.wallet_address`), mount `POST /api/webhooks/privy`, register in OpenAPI, add `PRIVY_WEBHOOK_SECRET`.
- Better fix: same, plus a reconciliation sweep that periodically diffs Privy's wallet list against `users.wallet_id` so a missed/failed webhook self-heals instead of silently diverging forever (mirrors the redemption-backfill sweeper pattern already used elsewhere in this codebase).
- Blocks merge: no for Phase C's `createWallet`-only path; yes before any "recovered/multi-device" claim ships.

### W-04 [P1 · BRANCH/governance] ADR 030 and 031 are still `Status: Proposed` with an unmet implementation gate — zero movement in 18 days

- File: `docs/adr/030-integrated-wallet-via-privy.md:3,112-120` (on `main`, current); `docs/adr/031-per-currency-yield-architecture.md:3` (on `main`, current)
- Description: ADR 030's "Gate for Accepted" section is explicit: "This ADR stays Proposed — and no implementation work (RS256 migration, Privy SDK wiring, webhook handler, UI collapse) starts — until every blocking condition below has a recorded answer." Re-read today: the gate text is byte-identical to 06-15 (still dated "As of 2026-06-11 none of these has a recorded answer — the DD call is unscheduled"). The five blocking conditions (Privy Soroban-custody DD, key-export path, ToS jurisdictional coverage, account-merge semantics, counsel sign-off) have no recorded answers anywhere in the repo, docs, or branch commits. Meanwhile all five implementation phases are fully built on branches, in direct violation of the ADR's own gate and of CLAUDE.md's "ADR before implementing" rule.
- Impact: per the project's own process rules, none of these branches is merge-eligible regardless of code quality. The Soroban-custody DD is load-bearing for W-01: if Privy can't custody Soroban tokens, the entire LOOPUSD/LOOPEUR plan (and the wallet provider abstraction's assumption that Privy is sufficient) changes, which would also obsolete or redirect today's interest-mint code.
- Evidence: direct read of both ADR files on `main` today; no `Status: Accepted` anywhere; no DD-outcome doc exists (`docs/audit-2026-06-30-cold/delta-manifest.md` confirms the 22-commit delta didn't touch either ADR).
- Minimal fix: schedule and record the DD call; flip ADR 030/031 to Accepted (or pivot to dfns) before merging any phase.
- Better fix: same — this is a process gate, not an engineering task. Until it's resolved, freeze further wallet-branch feature work to avoid growing the rebase debt (see W-05).
- Blocks merge: yes, for all phases, by the project's own stated rule.

### W-05 [P1 · BRANCH, new this audit] Wallet/burn/interest branches predate CF-14/CF-15/CF-18 payout-worker hardening — merging as-is reopens double-claim and ungated-kill-switch bugs for the new payout kinds

- File: `apps/backend/src/payments/payout-worker.ts`, `apps/backend/src/payments/horizon-find-outbound.ts`, `apps/backend/src/payments/payout-worker-pay-one.ts` — compare `main` (post `fb6c1954`/`162c4d06`/`3aca01ad`) against `origin/feat/wallet-phase-d-interest` and `origin/fix/adr036-emission-burn`
- Description: `main`'s payout worker now has three hardenings these branches don't: (1) **CF-14** — `listClaimablePayouts` uses `FOR UPDATE SKIP LOCKED` so concurrent Fly machines claim disjoint row sets instead of colliding on the operator's Stellar sequence number; (2) **CF-18** — `getOutboundPaymentByTxHash` is now the _authoritative_ idempotency check (point lookup by persisted tx hash, no history-window dependency), with the old `findOutboundPaymentByMemo` scan demoted to fallback; (3) **CF-15** — `runPayoutTick` reads `isKilled('withdrawals')` (now `'emissions'` post-rename) once per tick and skips matching rows live, instead of only gating the enqueue route. None of this exists on the wallet branches: `feat/wallet-phase-d-interest`'s `payout-worker.ts` still carries only the single-process "operator sequence numbers serialise" assumption (the exact comment CF-14 rewrote on `main`), and `fix/adr036-emission-burn`'s kill-switch only gates `POST /api/admin/users/:userId/emissions` (the literal CF-15 pre-fix pattern, reproduced fresh on a different route). Worse: the kill-switch enum on the burn branch (`'orders-legacy' | 'orders-loop' | 'auth' | 'emissions'`) has no entry at all for the new `'burn'` or `'interest_mint'` kinds — there is no operator lever to halt issuer-return burns or nightly interest mints mid-incident, only the unrelated `LOOP_KILL_ORDERS_LOOP` switch (which gates order creation/pay-with-balance, not burn/interest payouts).
- Impact: this isn't just "needs a rebase." `interest_mint` and `burn` are new `pending_payouts.kind` values introduced entirely on these branches — they were never present when CF-14/15/18 were designed and fixed on `main`. Whoever merges this work has to manually re-derive: (a) that issuer-signer selection (`resolveIssuerSigners`, per-row keypair choice) composes correctly with the `FOR UPDATE SKIP LOCKED` claim batch — i.e., two machines claiming disjoint interest-mint rows must each resolve and use the correct issuer keypair, not just the operator key; (b) that `getOutboundPaymentByTxHash` is wired for issuer-signed submits too, not just operator-signed ones; (c) whether `LOOP_KILL_EMISSIONS` (or a new switch) should also gate `'burn'`/`'interest_mint'` rows in the tick loop. Get any of these wrong under real multi-machine traffic and the result is a double-mint (free money created) or double-burn (extra LOOP destroyed, mirror/on-chain divergence) — squarely a P0/P1 financial-integrity class, not a merge-conflict inconvenience.
- Evidence: `git diff origin/feat/wallet-phase-d-interest main -- apps/backend/src/payments/payout-worker.ts` shows the CF-14 doc-comment and `listClaimablePayouts`/`isKilled('withdrawals')` machinery only on the `main` side; `git diff ... -- apps/backend/src/payments/horizon-find-outbound.ts` shows `getOutboundPaymentByTxHash` (CF-18) only on `main`; `git show origin/fix/adr036-emission-burn:apps/backend/src/kill-switches.ts` → `KillSwitch = 'orders-legacy' | 'orders-loop' | 'auth' | 'emissions'`, no burn/interest entry; `payout-worker.ts` on that branch has no `isKilled(...)` call inside the tick loop at all.
- Minimal fix: before merging Phase D (or the burn branch alone), rebase onto current `main`, re-run the row-claim logic against the new `kind` values, and explicitly decide + implement kill-switch coverage for `'burn'` and `'interest_mint'` (either extend `LOOP_KILL_EMISSIONS`'s scope or add dedicated switches).
- Better fix: treat this as a blocking pre-merge checklist item documented in the branch's own PR description (not just discovered at rebase time), since the financial-integrity risk is exactly the class CF-14/18 were written to close.
- Blocks merge: yes.

### W-06 [P2 · BRANCH, new this audit] `pay-with-balance.ts`'s double-submit fence is explicitly single-machine-only — same class as CF-14, self-documented as unfixed

- File: `apps/backend/src/orders/pay-with-balance.ts` (`origin/feat/wallet-phase-c-flows`, carried into C-web/D)
- Description: the handler's own docstring states the in-flight fence is "an in-process per-order set" that "(Single-process deployment today — Fly runs one machine; a multi-instance future needs a DB-level fence.)" That assumption was exactly what CF-14 found false elsewhere in this codebase (`min_machines_running=1` is masking it fleet-wide today, but Fly can and does run >1 machine under load / during deploys). Under concurrent requests landing on two different machines, both could pass the in-process `PAYMENT_IN_FLIGHT` check, both build a payment from the user's embedded wallet using a freshly-loaded Stellar account sequence number, and both ask the Privy provider to sign and submit.
- Impact: Stellar's sequence-number protocol means the two submits can't both land (the second hits `tx_bad_seq`), so this is very unlikely to produce an actual double-pay — but it does mean: two real signing requests go to Privy (cost/rate-limit exposure on whatever Privy bills per-signature), one user-facing request gets a confusing failure instead of the idempotent "already paid" 200 the docstring promises, and the order's `pending_payment → paid` transition timing becomes racy in a way the single-instance design never anticipated. This is a real but lower-severity instance of the same flaw class CF-14 closed for the payout worker; it just hasn't been fixed here because Phase C predates that fix entirely.
- Evidence: docstring quoted above, in-process `Set` (no DB row/advisory lock) implementing the fence.
- Minimal fix: same remediation CF-14 already established a pattern for — replace the in-process set with a DB-level claim (e.g. a short-lived advisory lock keyed on `order_id`, or a `SELECT ... FOR UPDATE SKIP LOCKED` against the order row before building the transaction).
- Better fix: same, plus surface the order's `pending_payment`/`paid` state check as the actual idempotency authority (which the handler already partially does — replaying `{state}` 200 for non-`pending_payment` orders) so the in-process fence becomes purely a perf optimization (avoid wasted Privy calls) rather than the correctness mechanism.
- Blocks merge: no on its own (Stellar sequencing prevents the worst case) — but should be fixed in the same pass as W-05 since both stem from the same single-instance assumption baked into Phase C/D.

### W-07 [Re-verification, upgraded] CF-01's burn fix is real and reasonably well-built on `fix/adr036-emission-burn` — but still unmerged, still predates W-05's hardening, and (once Phase D is layered on) reconciles an economically wrong mint for 2 of 3 assets

- File: `apps/backend/src/orders/transitions.ts` (`markOrderPaid` loop_asset path), `apps/backend/src/payments/asset-drift-watcher.ts` (`origin/fix/adr036-emission-burn`, extended further on `origin/feat/wallet-phase-d-interest`)
- Description: the 06-15 synthesis (`findings.md` CF-01) correctly noted the burn fix "lives only on `origin/fix/adr036-emission-burn`" but the prior wallet-vertical raw file (`v-wallet.md`) never actually examined `asset-drift-watcher.ts` on that branch (its coverage table stops at interest-mint/issuer-signers/payout-worker-pay-one). Reading it directly today: `markOrderPaid` now enqueues a `kind='burn'` `pending_payouts` row in the **same transaction** as the mirror debit (`onConflictDoNothing` on a partial-unique `(order_id) WHERE kind='burn'` index — correct idempotency), forwarding the received LOOP from the deposit account to the asset's issuer; `payOne` correctly skips the trustline probe for issuer-return destinations (`row.toAddress === row.assetIssuer`); the burn is signed with the **operator** secret (correct — the deposit account, not the issuer, holds the LOOP and is the one sending it away). The drift-watcher equation is extended in step: `fix/adr036-emission-burn` adds an `inFlightBurns` subtraction term (`driftStroops = (onChain − pool − inFlightBurns) − liability×1e5`), and `feat/wallet-phase-d-interest` extends it again with an `inFlightInterestMints` addition term. Both extensions are well-reasoned (explained in-line, each direction matches the half of the transaction that moves first).
- Impact: this means CF-01 is **not just "open" in the sense of "nothing exists"** — a materially correct fix exists, on a branch, ready to be evaluated for merge once W-05's payout-worker rebase is done and the ADR-030/031 governance gate (W-04) is resolved. However, two caveats limit how positive this update is: (1) the redesigned drift equation, once Phase D is included, will faithfully reconcile a mint that W-01 says shouldn't exist at all for LOOPUSD/LOOPEUR — the equation can read `drift≈0` while embodying the W-01 unbacked-mint bug, because "the books balance" and "the books are right" are different claims here; (2) CF-17's "withdrawal term" framing is somewhat obsoleted by this branch's redesign rather than directly fixed — ADR-024 "withdrawal" is renamed to "emission" and explicitly stops touching the mirror at send-time (the liability is assumed to already exist from the original cashback event), so there's no separate withdrawal term to add; true fiat-out redemption (the other documented exit path) still doesn't exist in code anywhere, so the equation's correctness there is untested by construction.
- Evidence: `apps/backend/src/orders/transitions.ts` diff vs `main` (burn enqueue + `LoopAssetBurnUnavailableError` rollback-on-misconfig); `apps/backend/src/payments/asset-drift-watcher.ts` reconciliation-equation doc-comments on both branches; `docs/adr/036-cashback-token-lifecycle.md` (on the burn branch) §"Ledger convention" table.
- Minimal fix: none needed for the burn mechanism itself; carry this finding forward as "CF-01 mechanism is correct, gate it on W-01/W-04/W-05 before merge."
- Better fix: when W-01 is fixed (mint restricted to GBPLOOP), re-verify the drift equation's `inFlightInterestMints` term still makes sense once LOOPUSD/LOOPEUR stop minting on-chain entirely (the term should simply read zero for those two assets going forward, which the code already supports since `configuredLoopPayableAssets()` would no longer include them in `runInterestMintTick`'s output — but add a regression test pinning that).
- Blocks merge: yes (inherits W-04/W-05; would be close to ready once those clear, _assuming_ W-01 is also fixed first).

### W-08 [P2 · BRANCH] WalletCard still mislabels APY as "APR"; no ADR-031-mandated no-guarantee disclaimer — unchanged

- File: `apps/web/app/components/features/wallet/WalletCard.tsx` (line containing `Earns {fmtApyBps(wallet.interestApyBps)}% APR, paid nightly.`) and its test (`WalletCard.test.tsx`) (`origin/feat/wallet-phase-c-web`)
- Description: byte-identical to 06-15. ADR 031 mandates "APY" + "past-30-day realised" framing + a standard no-guarantee disclaimer; the card still says "APR" and ships neither qualifier nor disclaimer. The backend field itself (`me-wallet.ts`) is correctly named `interestApyBps` — only the UI string is wrong, plus the test asserts the wrong string (`/Earns 3% APR/`), locking the bug in rather than catching it.
- Impact: mislabels a financial rate on a money-displaying surface; misses a documented compliance-adjacent display requirement (checklist §16, §32).
- Evidence: direct read today, identical to the 06-15 finding.
- Minimal fix: `APR` → `APY` in the component string and the test assertion.
- Better fix: same, plus append the ADR-031 no-guarantee disclaimer text and a "past 30 days" qualifier so the rate doesn't read as a forward-looking guarantee.
- Blocks merge: yes for Phase C-web (trivial to fix, but currently still wrong).

### W-09 [P1 · BRANCH] WalletCard / PayWithLoopBalance still bypass `LOOP_PHASE_1_ONLY` — unchanged, confirmed at both mount sites

- File: `apps/web/app/components/features/home/MobileHome.tsx:217` (`<WalletCard />`, no `phase1Only` wrapper despite `phase1Only` being in scope two lines below for the sibling `CashbackBalanceCard`), `apps/web/app/routes/auth.tsx:445` (same pattern), `apps/web/app/components/features/purchase/LoopPaymentStep.tsx:80` (`<PayWithLoopBalance .../>` unguarded) — all `origin/feat/wallet-phase-c-web`
- Description: every sibling Phase-2 surface in this codebase wraps in a phase gate; these three mounts don't. `WalletCard`'s only self-gate is "render nothing while loading/error/unauthenticated" — once the backend endpoint exists, the balance/interest-rate card renders on a `LOOP_PHASE_1_ONLY=true` build.
- Impact: Phase-2 yield UI would leak into a Phase-1 launch build the moment this branch and a populated `/api/me/wallet` response coincide.
- Evidence: direct read of all three files today; `phase1Only` is demonstrably in-scope at both call sites (used by neighboring components) and simply not threaded into the wallet ones.
- Minimal fix: gate both mount points on `!phase1Only`.
- Better fix: push the gate inside `WalletCard`/`PayWithLoopBalance` itself (accept `phase1Only` as a prop, or read `useConfig()` internally) so every future call site can't forget it, plus a regression test asserting nothing renders when `phase1Only=true`.
- Blocks merge: yes.

### W-10 [P3 · BRANCH, Part 6 §35] DeFindex vault path remains 100% unbuilt — third-party blast-radius / circuit-breaker question is not yet assessable, must be designed before vault code lands

- File: none — absence confirmed across all 5 branches (`git grep -i "defindex\|soroban\|vault"` on every branch returns only comment-level mentions in `apy-snapshot.ts`, `monitoring.ts`, `procurement-asset-picker.ts`, `provider.ts`, `admin.treasury.tsx` — no contract-invocation code anywhere)
- Description: per the audit brief's Part 6 §35 question ("what's our integration-side blast radius if the vault is paused/exploited/depegs? Is there a circuit breaker on our side independent of the vault's own safety?") — there is currently nothing to evaluate, because no DeFindex/Soroban integration code exists. This is the same gap the 06-15 audit found (P1 "DeFindex vault path documented but entirely unimplemented"), re-confirmed unchanged. The new angle this audit adds: **nobody has designed the circuit-breaker requirement yet either** — ADR 031 specifies the vault's _economics_ (curator, fees, share model) but says nothing about a withdrawal-halt or max-exposure cap independent of DeFindex's own safety. If the vault path is built directly from ADR 031 as written, it would ship without this control.
- Impact: not exploitable today (nothing is built), but a real gap in the spec that should be closed before, not after, vault code is written — retrofitting a circuit breaker onto a live custody integration is much higher-risk than designing it in from the start.
- Evidence: grep results above; ADR 031 full read (no circuit-breaker / exposure-cap / pause-mechanism section anywhere in the document).
- Minimal fix: none required yet (no code exists to fix).
- Better fix: before any DeFindex implementation PR, add a short addendum to ADR 031 (or a new ADR) specifying: a Loop-side max-exposure cap per vault, a withdrawal-halt switch independent of DeFindex's own pause state, and a monitoring signal on vault share-price moving outside an expected band (a depeg/exploit proxy). This is cheap to write now and expensive to retrofit later.
- Blocks merge: n/a (no branch to merge yet) — but should block _starting_ the vault implementation without first closing this gap.

### W-11 [P3 · BRANCH] Retired `USDLOOP`/`EURLOOP` asset codes still 0% migrated to `LOOPUSD`/`LOOPEUR` across all 5 branches — no progress in 18 days

- File: every wallet branch — `apps/backend/src/db/migrations/0038_interest_mint_onchain.sql` CHECK constraints, `apps/backend/src/env.ts` issuer/issuer-secret var names, `apps/backend/src/credits/payout-asset.ts`, `packages/shared/src/loop-asset.ts` (`LoopAssetCode` union + doc comment), `apps/web/app/services/stellar-wallet.ts` (`PayParams.assetCode` union)
- Description: ADR 031 v7 (current, on `main`) renamed the v6 names — USD/EUR yield assets are `LOOPUSD`/`LOOPEUR`; GBPLOOP keeps its name. Every wallet branch still uses the retired `USDLOOP`/`EURLOOP` names throughout: schema CHECKs, env var names (`LOOP_STELLAR_USDLOOP_ISSUER[_SECRET]`), the shared `LoopAssetCode` type (whose own doc comment still says "USDLOOP, GBPLOOP, EURLOOP"), and even the dead `services/stellar-wallet.ts` web stub. `git grep -c "USDLOOP\|EURLOOP"` returns 128–135 matching lines depending on branch — essentially unchanged from what the 06-15 audit would have found, confirming zero remediation effort has touched this in 18 days.
- Impact: on-chain assets are identified by `(code, issuer)` — issuing under the wrong code mints a different asset than every downstream consumer (drift watcher, public loop-assets surface, burn routing) expects. Compounds W-01: even after restricting nightly mints to GBPLOOP, the dead LOOPUSD/EURLOOP code paths (trustline setup, payout-asset resolution, env var names) still reference names ADR 031 says don't exist.
- Evidence: `git grep -c "USDLOOP|EURLOOP" origin/<branch> -- apps packages` per branch (128/128/130/131/135 matching lines).
- Minimal fix: rename the asset-code union, CHECK constraints, and env var names before any issuer secret for these two assets is ever configured in a real environment.
- Better fix: same, done as a single dedicated commit at the base of the dependency chain (Phase B, where the shared type first appears) so every downstream branch inherits the correct names instead of each one needing the same mechanical rename applied independently.
- Blocks merge: yes (compounds W-01 — this is the naming half of that P0).

### W-12 [Process note, no severity] `feat/staff-roles-backend` / `feat/staff-dashboard-web` (ADR 037) branch off wallet Phase C — inherit its defects as baggage

- File: n/a (dependency-graph observation)
- Description: `git merge-base origin/feat/staff-roles-backend origin/feat/wallet-phase-d-interest` resolves to `9f5952e0`, which is `feat/wallet-phase-c-flows`'s own HEAD — i.e. staff-roles-backend is built directly on top of wallet Phase C (provider/privy/user-signer/provisioning/pay-with-balance), not on Phase D. It therefore inherits W-02 (Privy auth header gap), W-06 (pay-with-balance single-machine fence), and W-09's backend-side equivalent (no wallet code is itself a staff/admin concern, but the branch carries the full Phase A–C tree).
- Impact: whoever merges the staff-roles work needs to either rebase off a fixed wallet-C, or accept merging wallet-C's known issues as a side effect. Not a staff/ADR-037 defect per se — flagging for the V8/Admin vertical owner and for whoever sequences the overall merge order.
- Evidence: `git merge-base` output above.
- Minimal fix: n/a — sequencing note only.
- Blocks merge: n/a (not this vertical's call).

---

## CF-01/CF-05/CF-32 re-verification

(CF-17 included per the task brief's note that it "depends on CF-01.")

### CF-01 — Redemption never burns returned LOOP → conservation break

**Status: still open on `main`; meaningfully fixed (mechanism + drift-equation) on `origin/fix/adr036-emission-burn`, unchanged since 06-15.**

Re-verified by reading `orders/transitions.ts` and `payments/asset-drift-watcher.ts` directly on the burn branch (see W-07 for full detail). The fix is real: `markOrderPaid`'s `loop_asset` path now enqueues a `kind='burn'` payout in the same transaction as the mirror debit, signed by the operator (deposit) account, routed to the asset's issuer — Stellar's native burn-on-issuer-return mechanism. Idempotency is DB-fenced (`onConflictDoNothing` against a partial unique index). The drift watcher's reconciliation equation was extended to subtract in-flight (unconfirmed) burns so a redemption stays drift-neutral end-to-end. This is a genuine update from the 06-15 raw file, which never actually examined `asset-drift-watcher.ts` on this branch. The finding remains BRANCH/open in the sense that matters for launch readiness — nothing has merged — and is now additionally blocked behind W-04 (ADR gate) and W-05 (payout-worker hardening the burn branch predates).

### CF-05 — On-chain interest mints unbacked LOOPUSD/EURLOOP + retired asset codes

**Status: still open, byte-for-byte unchanged since 06-15.** Re-verified directly: `interest-mint.ts`'s `fiatOf()` and the asset-eligibility filter in `runInterestMintTick` still treat all three LOOP codes identically; migration 0038's CHECK still allows all three; the retired `USDLOOP`/`EURLOOP` names are still used throughout (see W-01, W-11). No remediation commit exists on any branch. Severity unchanged at P0.

### CF-17 — Drift-watcher equation omits redeemed-but-unburned pile + withdrawal term

**Status: substantially addressed on the branch chain, more so than the 06-15 synthesis credited — but only on unmerged branches, and the "withdrawal term" framing is partly obsoleted rather than directly fixed.** The burn branch adds an `inFlightBurns` subtraction term; Phase D adds an `inFlightInterestMints` addition term. Both are reasoned correctly in-line and match the transaction ordering of their respective flows (see W-07). What's _not_ addressed: true fiat-out withdrawal doesn't exist in code anywhere on any branch (it's reduced to a documented-but-unbuilt future redemption target in ADR 036), so the equation's correctness there is unverified by construction, not because a term was deliberately omitted. On `main` (no burn/interest code at all), the equation remains exactly as deficient as CF-17 originally described.

### CF-32 — Privy auth-header gap, webhook absence, ADR-Proposed-yet-implemented, DeFindex unbuilt, web mislabels

**Status: still open, unchanged on every sub-point.** Re-verified line-by-line:

- Missing `privy-authorization-signature` header: confirmed unchanged (W-02), test still locks in the absence.
- Privy webhook handler absent: confirmed unchanged (W-03).
- ADR 030/031 still `Status: Proposed` with an unmet gate: confirmed unchanged, gate text itself unedited (W-04).
- DeFindex vault path unbuilt: confirmed unchanged (W-10), with the added Part-6 observation that the circuit-breaker requirement isn't even specified yet.
- Web mislabels "APR"/missing disclaimer: confirmed unchanged (W-08).
- Web bypasses `LOOP_PHASE_1_ONLY`: confirmed unchanged at both mount sites (W-09).

No part of CF-32 has regressed further, but none has improved either — these branches are frozen in the exact state the 06-15 audit found them.

---

## Coverage confirmation

Files read in full via `git show <branch>:<path>` this pass (beyond what the
06-15 raw file already covered):

- `apps/backend/src/wallet/provider.ts`, `privy.ts`, `user-signer.ts` (Phase B) — full read
- `apps/backend/src/wallet/provisioning.ts` (Phase C) — full read (CAP-33 sandwich, idempotency, sweeper)
- `apps/backend/src/users/wallet-handler.ts` (`GET /api/me/wallet`) — full read
- `apps/backend/src/orders/pay-with-balance.ts` (Phase C3) — full read, **new finding W-06**
- `apps/backend/src/credits/interest-mint.ts` (Phase D) — full read, two passes (math/scheduling half + tick-driver half)
- `apps/backend/src/credits/payout-asset.ts` — full read
- `apps/backend/src/payments/issuer-signers.ts` — read, confirmed correct (matches 06-15 assessment)
- `apps/backend/src/payments/payout-worker-pay-one.ts`, `payout-worker.ts` (both burn branch and Phase D versions) — diffed against current `main`, **new finding W-05**
- `apps/backend/src/payments/horizon-find-outbound.ts`, `horizon.ts` — diffed against current `main` (CF-18 gap), feeds W-05
- `apps/backend/src/payments/asset-drift-watcher.ts` (burn branch + Phase D) — full read, **not covered by the 06-15 raw file at all**, feeds the upgraded CF-01/CF-17 re-verification (W-07)
- `apps/backend/src/orders/transitions.ts` `markOrderPaid` loop_asset path (burn branch) — full diff against `main`
- `apps/backend/src/kill-switches.ts` (burn branch, Phase D) — full read, feeds W-05
- `apps/backend/src/db/migrations/0038_interest_mint_onchain.sql` — full read
- `apps/backend/src/env.ts` (Phase D) — targeted grep over every Privy/wallet/issuer var
- `apps/web/app/components/features/wallet/WalletCard.tsx`, `hooks/use-wallet.ts`, `services/wallet.ts` — full read
- `apps/web/app/components/features/home/MobileHome.tsx`, `routes/auth.tsx`, `routes/settings.wallet.tsx`, `wallet/TrustlineSetupCard.tsx`, `purchase/LoopPaymentStep.tsx` — targeted grep for gating/copy
- `packages/shared/src/loop-asset.ts` — full read
- `docs/adr/030-integrated-wallet-via-privy.md`, `docs/adr/031-per-currency-yield-architecture.md` (current `main` versions) — full read
- `docs/adr/036-cashback-token-lifecycle.md` (burn branch) — full read
- Branch topology: `git merge-base`/`git log` across all 6 wallet+burn branches plus the two staff branches, to confirm freshness and dependency order

Not independently re-read this pass (carried forward from the 06-15 audit's
"verified CORRECT" list since nothing in the diff suggested otherwise, and
re-deriving byte-identical branch content would not change the verdict):
RS256/JWKS signer internals (`auth/signer.ts`, `jwks.ts`, `jwks-publish.ts`),
the HMAC primitive itself (`webhooks/hmac-verify.ts`), the full interest-mint
test suite contents, and `wallet-testnet-walk.ts`. Spot-checked their
presence/shape via `ls-tree`/grep, consistent with no change since 06-15.

**Total findings this pass: 12** (W-01 through W-12) — 2 × P0 (reconfirmed),
4 × P1 (2 reconfirmed unchanged, 1 reconfirmed-and-upgraded with new
evidence, 1 new), 3 × P2 (1 reconfirmed, 2 new), 2 × P3 (1 reconfirmed, 1
new), 1 process note. Two of the twelve (W-05, W-06) are genuinely new
findings this audit did not inherit from 06-15 — both stem from the same
root cause: these branches were frozen before `main`'s multi-machine
concurrency hardening (CF-14/15/18) existed, and that hardening now needs to
be re-derived for the new `burn`/`interest_mint` payout kinds before merge.
