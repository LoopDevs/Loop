# Full-Taxonomy Cold Audit — Phase 1 (backend + shared) — 2026-07-11

**Status:** Findings delivered (read-only); remediation NOT started · **Owner:** Ash (sponsor), Claude Fable 5 (execution) · **Audited commit:** `83010533` · **Governed by:** [audit-recipe.md](audit-recipe.md)

A **comprehensive** cold audit of `apps/backend` + `packages/shared` — every file and every money/security flow, across the 25 in-scope dimensions (3 justified N/A: LLM/MDL/TNS). Findings only; **no code changed**; every finding independently skeptic-verified. This is **Phase 1** of a comprehensive audit; `apps/web` + `apps/mobile` are Phase 2 (deferred — see Caveats).

## How comprehensive (coverage proof)

- **34 work units** — 26 file-areas partitioning the whole backend + shared, + 8 end-to-end money/security flows (deposit→redeem, order-purchase, payout, interest-mint, vault, admin-money-write, auth-session, refund).
- **25 mechanical sweeps** including loop-specific ones (money-as-float, ledger-writer-tier, on-chain-identity, multi-machine-state, guard-unset-noop).
- **476 agents; coverage ledger 1,492 rows; 130 unique verified findings** after de-duplication: skeptic-adjusted **1 critical, 21 high, 54 medium, 47 low, 7 info** across **~90 LIVE**. 4 double-finds.
- **The context:** loop-app is an exceptionally hardened, heavily pre-audited codebase (49 ADRs, prior cold audits, a live accepted-risk register, a CI money-invariant gate). The money/auth/on-chain _core_ is genuinely well-defended — so this audit's yield is **new money-movement edge cases, concurrency/config traps, the observability/watcher tier, and doc drift**, not fresh core criticals. That it still produced 22 high-or-above findings on a repo this mature is the signal.

> **Completeness:** the workflow hit a weekly usage limit during wave 2, so its built-in negative-space pass and wave-2 depth didn't run in-band — both were **subsequently completed standalone after the limit reset**: the negative-space pass (NS-01..16 below) and a 3-cluster convergence pass (the CONV findings, "Convergence pass" section). Wave 1 (the main per-unit finder pass) completed for all 34 units (130 findings); convergence returned DRY/near-dry; both previously-UNVERIFIED findings are now resolved. **Phase 1 backend coverage is complete with no material gaps.** **Phase 2 (web/mobile) is the separate sibling doc.**

---

## Corroboration & one correction

This pass independently re-found the recon's live findings (now double-confirmed): the **watcher-tier Discord silence**, the **TRUST_PROXY/XFF rate-limit spoof**, **inert CODEOWNERS**, the **deposit-refund ADR-017 gap**, **flat admin tier + wildcard step-up**, **pooler-degrades-the-lock**, **image-proxy SSRF disableable**, **ledger immutability convention-only**, and the **INV-3 fresh-insert gap**. It then went well beyond them.

No recon verdict was overturned; the money-core "strong" assessment held (issuer pinning, alg pinning, IDOR pinning, boot fail-closed all re-confirmed).

---

## CRITICAL / HIGH — by theme (22; de-duplicated)

### Money movement (the highest-value new findings)

- **FT-01 Payout double-pay on confirm-failure.** `high · LIVE · MNY` · `payments/payout-worker-pay-one.ts:322-333`. `markPayoutConfirmed`'s throw is misclassified as a _payout_ failure and auto-compensated → the emission is paid twice. Real double-spend of minted value.
- **FT-02 CF-18 dedup double-mints on aged-out Soroban txs.** `high · GATED(vaults) · MNY` · `credits/vaults/soroban-submit.ts:183-207`. `getTransaction`→NOT_FOUND on an aged-out tx is treated as "never landed," so the delayed retry double-submits the deposit/withdraw → double-mint / operator USDC loss.
- **FT-03 Terminal CTX-payment failure strands a paid order.** `high · LIVE · REL` · `orders/procure-one.ts:413-417`. A terminal CTX failure fails the _paid_ order without refunding the user or paging ops — silently stranded funds.
- **FT-04 Regulatory report double-counts burns as crypto payouts.** `high · LIVE · DAT` · `scripts/quarterly-tax.ts:187-216`. The `crypto-payouts` tax report counts redemption _burns_ as crypto paid to the user — wrong regulatory numbers.
- **FT-05 Watchdog re-pick can double-spend across channel accounts** if `LOOP_PAYOUT_WATCHDOG_STALE_SECONDS` is set below the 60s tx timebound. `high(med-adj) · GATED · MNY` · `payout-worker-pay-one.ts:222-253`.

### Observability / the watcher tier (compounds the money invariants)

- **FT-06 Watcher-tier alerting silently disables when `DISCORD_WEBHOOK_MONITORING` is unset** (the recipe's #1 weak link, double-confirmed across 5 sweeps + units). `high · LIVE · INF/OBS` · `discord/shared.ts:76` (returns `true` when URL unset) + no boot guard (`env.ts`). Every drift/solvency/stuck-payout watcher pages into the void; delivery-tracked watchers (asset-drift, interest-pool) _latch_ on the phantom "delivery" and fail to re-page after the URL is later set. (The ledger watcher re-pages each tick, so its harm is recoverable — the skeptics split on that nuance; net severity high.)
- **FT-07 Money-integrity breaches have no detection path independent of Discord.** `high · LIVE · OBS` · `observability-handlers.ts:112`. Ledger/asset drift is not a `/metrics` gauge and never degrades `/health` — so if FT-06's webhook is dark, a breach is _undetectable_.

### Security / auth / access-control

- **FT-08 Rate-limit IP key is spoofable behind Fly's appending edge** (double-find). `high · LIVE · SEC` · `middleware/rate-limit.ts:68-84`. `TRUST_PROXY=true` + leftmost-XFF; the spoof-proof `Fly-Client-IP` is never read → per-IP limits + the 600/min global backstop are defeated (OTP is separately protected by per-email DB caps).
- **FT-09 `RESEND_API_KEY` has no boot check → a missing key is a silent total OTP/login outage** swallowed into a fake 200. `high · GATED · CFG/AGT` · `index.ts:64-79`.
- **FT-10 CODEOWNERS required-reviewer rule is inert** — `@LoopDevs/engineering` doesn't exist, so GitHub drops the rule on ledger/migration/auth paths. `high · LIVE · CID` · `.github/CODEOWNERS`.

### Concurrency / data-integrity

- **FT-11 `addFavoriteHandler` cap/idempotency txn is not concurrency-safe under READ COMMITTED.** `high · LIVE · CON` · `users/favorites-handler.ts:134-173`.
- **FT-12 Pool under-provisioned for lock-using workers → saturation/deadlock.** `high · GATED · CON` · `db/client.ts:126-143`. `DATABASE_POOL_MAX=10` vs ~15 advisory-lock workers each needing ≥2 connections.
- **FT-13 Ledger immutability is convention-only** (double-find). `high(med-adj) · GATE · DAT` · `db/schema/credits.ts:82-193` — no trigger/RULE/REVOKE on `credit_transactions`/`user_credits`.

### Privacy

- **FT-14 All-null redemption diagnostic logs the raw CTX body → can leak a live gift-card code/PIN** on field-name drift. `high · LIVE · PRV` · `orders/procurement-redemption.ts:121-128`.

### Correctness / upstream defense

- **FT-15 Upstream sync size-cap defense has real gaps** — the documented "size caps stop a compromised/buggy upstream" isn't fully realized. `high · GATED · PRF` · `clustering/data-store.ts:15-26`.

---

## MEDIUM (54) — grouped highlights

- **Admin / access-control:** deposit-refund ADR-017 audit-envelope gap (double-find, `admin/deposit-refund-handler.ts`); **staff-role revoke is silently reverted on next login for any env-allowlisted admin** (`ADMIN_EMAILS`/`ADMIN_CTX_USER_IDS`) — incident-response revocation fails open (`db/staff-roles.ts:195-213`); clear-otp-lockout velocity cap bypassable by a concurrent distinct-idempotency-key burst; flat admin tier + wildcard 5-min step-up (double-find); admin emission destination unconstrained (not pinned to the target user's wallet); daily-cap circuit-breaker trips are **silent** (the comment claims a page fires — it doesn't).
- **Money edges:** auto-refunds share the fleet-wide admin refund daily cap → a burst strands debited users; on-chain refund rail bypasses that cap entirely; CTX settlement sanity band is denominated in XLM but validates the USDC amount (no-ops on the USDC rail); vault redemption over-collects a 0.5% buffer while debiting only `value_minor` → per-user backing drifts below the mirror; operator-float reconciliation mis-attributes rows across a re-baseline via wall-clock `observed_at`; interest-mint holds the advisory lock across an unbounded O(users) sequential Horizon read (violates the withAdvisoryLock caller contract its sibling honors); disabling vaults strands user-owed cashback in `pending` with no alert.
- **Price feed:** cold-start accepts an unbounded first rate and has no absolute floor/staleness (`payments/rate-sanity.ts`) → a hostile/glitched upstream can clear a deposit at an arbitrarily wrong rate; a legitimate >maxRatio move across a refresh gap permanently wedges settlement.
- **Config traps:** **kill-switch "fail-closed on unrecognized value" is dead in prod** — `envBoolean` rejects those values at boot, so a mistyped mid-incident kill _crashes boot_ instead of engaging (`env/sections/infra.ts:192`); admin daily money caps silently disable at value 0 with no production floor (unlike `DISABLE_RATE_LIMITING` which is prod-fatal); staging is structurally forced onto the real Resend send path (`fly.toml:55`).
- **Data / migrations:** INV-1 mirror-equality has no DB fence; plain (non-CONCURRENT) `CREATE INDEX` on the two largest growing tables blocks writes during the release-command rollout window (`0036`).
- **Observability leaks:** **Sentry secret-scrubber has drifted from the logger REDACT_PATHS** → `appSecret`/`PRIVY_APP_SECRET` and the OTP `code` leak to Sentry (`sentry-scrubber.ts:34`).
- **DoS:** an unauthenticated attacker can lock any email (incl. admins) out of OTP login _and_ admin step-up via the per-email failed-attempt counter.
- **Auth:** `social_id_token_uses` replay table has no retention sweep (docstring claims one); OTP embedded in the email subject (lock-screen/push preview leak); DSR delete precondition TOCTOU.
- **Contracts:** ADR-019 "single source of truth" is unenforced for 4 of 5 order/money enums — a CHECK-literal-vs-TS-tuple drift passes typecheck + tests + CI and 500s a live order (`packages/shared/src/order-state.ts`); OpenAPI omits 401/500 on systemic endpoints incl. live money/auth paths.
- **Scripts:** `wallet-testnet-walk.ts` has no `DATABASE_URL` guard (writes real ledger rows if misdirected); `check-migration-parity.ts` runs unconditional `DROP/CREATE DATABASE` with no target-safety.
- **SSRF:** image-proxy fully open under DNS rebinding when the allowlist is unset (dev, or a prod emergency override).

## LOW (47) & INFO (7) — categories

- **Concurrency long tail:** advisory lock degrades under a pooler (double-find); **OTP single-use isn't atomic — concurrent verify-otp with the same code both succeed and mint independent sessions** (`auth/native.ts:104-133`); provisioning driven outside the fleet lock (duplicate activation / sequence collision); provisioning sweeper head-of-line blocking; per-process circuit-breaker/alert dedup multiplies pages across the fleet.
- **Money tail:** INV-3 conservation trigger skips fresh cashback/interest inserts (double-find); on-chain refund bypasses the daily cap; stroops→minor truncation under-credits the float; emission trusts caller `amountMinor` for the cap while minting `amountStroops` (cap-bypass); `orders.*_pct` columns lack non-negative CHECKs.
- **On-chain:** vault Soroban txs signed with a hardcoded passphrase, ignoring env (`vault-client.ts:140`); network passphrase accepts any non-empty string, never cross-checked vs Horizon URL.
- **Dead/orphan code:** `hasSufficientCredit` exported dead code (comments claim a pre-write balance check that doesn't exist); `hmac-verify` fully dead (and its NaN-`toleranceSeconds` silently disables the replay check if ever wired); `eng.traineddata` orphaned.
- **SSRF tail:** IPv6 NAT64/6to4-embedded IPv4 not decoded by the private-range check.
- **Detection gaps:** bulk-read tripwire blind to nested list shapes; ledger-invariant check truncates drift at 1000 rows silently; config-history endpoints trip the CF-10 tripwire on every routine open (page size = threshold).
- **INFO:** ledger-drift check false-positives on zero-sum orphan groups → spurious drop-everything page; refresh logout destroys the rotation-chain audit lineage; `bodyLimit` mounted before `globalRateLimit` (oversized bodies bypass the volumetric backstop); `statement_timeout` would kill a future long migration mid-deploy; one unescaped Discord notifier field.

---

## Structural absences (negative-space pass — the detection/operability tier)

The affirmative pass finds wrong code; this pass finds _missing_ controls. The through-line: **the money core is well-defended at the point of mutation, but a breach is computed and then invisible everywhere an operator looks except one Discord webhook.**

### Critical / High

- **NS-01 `/metrics` carries no money-integrity gauge at all.** `critical · LIVE` · `metrics.ts`, `observability-handlers.ts`. The Prometheus surface emits request/latency/worker/circuit/CWV metrics and **not one** of `ledger_drift`, `asset_drift`, `vault_solvency_breach`, `operator_float_delta`, `pending_payouts_backlog`, `failed_payouts_total`, or `alert_active`. The natural detection path independent of Discord carries no money signal — a live ledger/solvency breach is a green dashboard.
- **NS-02 No standing-breach health signal — watchers report success when they find a breach.** `critical · LIVE` · `credits/ledger-invariant-watcher.ts:145` (calls `markWorkerTickSuccess` unconditionally _after_ returning a non-empty drift set), same in `vault-drift-watcher.ts:444`, `asset-drift-watcher.ts:646`, `operator-float-reconciliation.ts:821`. So `/health` and the worker gauges read healthy precisely when the invariant is violated. (The vault watcher's own header concedes this is a "deferred systemic follow-up.")
- **NS-03 Durable admin audit trail self-deletes after 24h.** `high · LIVE` · there is no append-only `admin_audit` table; the only durable record of who emitted LOOP / adjusted a balance / granted admin is the `admin_idempotency_keys` snapshot — a **24h-TTL, hourly-swept idempotency cache**. After 24h the sole surviving trace is the ephemeral (webhook-swallowed) Discord post. An AML/forensics/regulator-request gap for a money-transmitter.
- **NS-04 No live kill/halt for the deposit, payout, vault, or refund rails.** `high · LIVE` · `kill-switches.ts` covers only `orders-legacy/orders-loop/auth/emissions`. Value-in (deposit watcher), value-out (payout worker), vault, and refunds gate only on the **boot-frozen** `LOOP_WORKERS_ENABLED`/`LOOP_VAULTS_ENABLED` — halting a forged-deposit MITM, a bleeding payout worker, or a discovered vault exploit requires a **redeploy**, and there's no admin API to flip a kill.
- **NS-05 Admin retry/redrive/float paths have no value cap.** `high · LIVE(gated on step-up)` · the daily value cap guards adjustments/refunds/emissions/compensation/order-refund but **not** `payouts-retry`, `order-redrive`, `vault-emission/redemption-redrive`, or `operator-float` manual-movement — each moves real on-chain value, so the adversary-matrix "~$1M/day bound on a compromised admin" does **not** hold there.
- **NS-06 `vault_hot_float.balance_minor` has no reconciler, yet solvency trusts it as backing.** `high · GATED` · `treasury/hot-float-reconciliation.ts` checks shares only; nothing reconciles the fiat-minor float counter against on-chain USDC, so an over-count (failed fast-path draw, replenish double-withdraw residual) is a positive phantom that numerically masks a real solvency shortfall.
- **NS-07 Backup/DR: no PITR/offsite/drilled restore** (confirms recon) — the entire durable money record + the (24h) audit trail sit on a Fly Postgres with no drilled restore.

### Medium

- **NS-08** No capability to freeze/suspend a single account (only the global kill switch) — no AML-hold / compromised-account containment without a fleet-wide outage.
- **NS-09** Access tokens + admin bearers are non-revocable until expiry (no token-version bump / "revoke all admin sessions") — a leaked bearer stays live.
- **NS-10** Redeem code/PIN encryption is opt-in (`LOOP_REDEEM_ENCRYPTION_KEY`, boot-warn-only) — unset ⇒ spendable bearer instruments stored plaintext.
- **NS-11** Vault stuck-watchdogs skip the `pending` state on both emission and redemption FSMs (the `pending_payouts` watchdog covers `pending` — inconsistent); a pending-wedged redemption silently wedges the user's gift-card order.
- **NS-12** No detector for a `failed`-payout backlog (only a one-shot inline page at failure) — a lost page = owed cashback/interest invisible forever.
- **NS-13** `ctx_settlements` has no confirmation/stuck watcher and no fulfilled-order-vs-settlement reconciliation; also no `destination` format CHECK.
- **NS-14** `adminRevokeUserSessions` mutates auth state with no audit row; `deposit-refund-handler` unaudited (= FT/CA — reconfirmed here as a negative-space item too).
- **NS-15** No deposit-side velocity / AML-structuring cap (deposits are 1:1 backed, so recordkeeping not solvency); LOOPEUR/EURC operator float has no R3-1 conservation coverage if a EUR vault ships; `pending_payouts kind='interest_mint'` has no unique in its own table (RFC-1 fresh-insert class).
- **NS-16** Low: `orders` amount CHECKs are `>= 0` not `> 0` (zero-value order passes); no comms consent/opt-out infrastructure.

**Remediation priority for the absences:** NS-01+NS-02 (coupled — give the money-integrity tier a non-Discord signal: a `/metrics` gauge per invariant delta + a `/health` standing-breach flag driven by the watchers' own findings), then NS-03 (durable admin audit table), NS-04 (live rail kills), NS-05/NS-06 (cap the redrive paths; reconcile the float).

## Convergence pass (closes the deferred wave-2 depth)

The wave-2 re-queue depth and full convergence that the weekly limit skipped were run afterward as **3 focused convergence agents** over the densest wave-1 clusters — money/ledger, auth/admin, concurrency/watcher — each briefed with the full digest to hunt _neighbors_ of known findings (not re-finds) and adversarially self-verify. **Verdict across all three clusters: DRY / near-dry** — the outcome that proves wave-1 was comprehensive. Between them they read the 10 ledger writers + both vault FSMs + the conservation trigger, the entire auth/step-up/staff-role surface, and the full detection layer, and **killed ~18 constructed candidates on verification** (stroops-ratio drift, interest-mint carry races, payout-compensation double-benefit, daily-cap TOCTOU, JWT alg-confusion, convention-only guards, refresh-rotation race, last-admin race, gauge-only tick-success, and more — each refuted by a real lock/CAS/CHECK/trigger). New surviving findings, all verified:

- **CONV-AUTH-01 — Targeted OTP-lockout DoS is durably unrecoverable in-product.** `medium · LIVE · SEC` · `admin/clear-otp-lockout.ts:82,181` + `auth/otp-attempt-counter.ts:83` + the gate at `auth/native.ts:97` / `admin/step-up-handler.ts:102`. **Emergent from three known findings** (#69 unauth lockout DoS + #37 clear-cap + FT-08 XFF spoof): an attacker re-locks a victim admin for free at the top of every 15-min window, while recovery is hard-capped at **5 clears/day _per target_** (more admins don't raise it). Once spent, the admin is locked out of both login and step-up with no self-serve recovery — only direct SQL. During a live money incident this neutralizes the responding admin's ability to mint the step-up tokens that gate refunds/emissions. _Fix:_ decouple the recovery budget from the anti-loop budget, or read `Fly-Client-IP` on the verify-otp limiter (kills the free re-lock — folds into FT-08).
- **CONV-MNY-01 — Admin-emission conservation _pre-check_ scopes by bare `asset_code`, diverging from the mirror-currency-scoped DB trigger (post-0061).** `low · latent/GATED · MNY` · `credits/emissions.ts:188`. Inert until `LOOP_VAULTS_ENABLED` creates a LOOPUSD/LOOPEUR emission sharing a USD/EUR mirror with classic USDLOOP/EURLOOP; then the app pre-check can pass where the DB trigger correctly rejects. **No money loss** (the trigger is strictly tighter and backstops it) — the only effect is an opaque 500 instead of the intended 409 `EMISSION_EXCEEDS_UNEMITTED_BALANCE`. _Fix:_ scope the query by `loop_asset_mirror_currency(asset_code)` to match the trigger.
- **CONV-WATCH-01 — Vault watchdog dedup (`applyBinaryWatchdogAlert`) is the one fire-once gate with no row-fence/lease.** `low · GATED · CON/NTF` · `credits/vaults/vault-watchdog-alert.ts:46`. Its lock-free read-decide-send-persist relies entirely on the caller's session lock; under the pooler misconfig (the known `client.ts:117` degrade) it over-pages/flaps on a standing vault breach — unlike its siblings, which use `pg_try_advisory_xact_lock` or `.for('update')`. Over-paging, not silence; vaults off by default. _Fix:_ wrap in a txn with `SELECT … FOR UPDATE` on the state row.
- **CONV-WATCH-02 — Per-process health-change Discord notify pages once per machine on a shared-dependency outage.** `low · LIVE · NTF` · `health.ts:54,289`. Semi-intended and bounded (1/machine/30min; fresh-cycled machines bootstrap silently), but a real per-process notifier NTF-04 didn't enumerate. _Fix:_ route health transitions through the fleet-wide `watchdog_alert_state` fire-once gate if fleet-deduped health paging is wanted.
- **CONV-INFO-01 — `adminRevokeUserSessionsHandler` has no step-up / idempotency / audit envelope.** `info · LIVE` · a bearer-only admin can force-logout any user fleet-wide with only a warn-log trail, unlike its sibling `clear-otp-lockout`. Deliberately kept lean by the authors; recorded, not elevated. (Overlaps NS-14.)

**Residual now closed:** the 2 previously-UNVERIFIED findings were definitively resolved, and **#114 / the wave-3 "OTP single-use isn't atomic" item was CONFIRMED** by reading the path (`findLiveOtp` SELECT → `markOtpConsumed` unconditional UPDATE, no CAS) — this is the same bug the Phase-2 client-flows finder independently re-found at the DB layer (`otps.ts:87`), a cross-phase double-confirm.

## Coverage ledger (honest)

- **Examined this pass:** all 26 backend file-areas + 8 flows (1,492 coverage rows) + a dedicated backend negative-space pass (the NS findings above) + a 3-cluster convergence pass over the densest wave-1 areas (the CONV findings above).
- **Convergence status:** **complete** — all three high-density clusters returned DRY / near-dry; the deferred wave-2 depth is closed and both previously-UNVERIFIED findings are resolved.
- **NOT-EXAMINED / gaps:** none material at the backend/shared layer. **`apps/web` + `apps/mobile` — Phase 2 — audited separately (see the Phase 2 doc).** The 3 N/A dimensions (LLM/MDL/TNS) are justified in the recipe.

## Remediation (extends; execute in a loop-app session against the CI gates)

**Wave 0 — money-movement correctness (do first):** FT-01 (payout confirm-failure double-pay), FT-02 (Soroban CF-18 double-mint), FT-03 (CTX terminal-failure strands funds), FT-05 (watchdog re-pick), FT-04 (tax report).
**Wave 1 — detectability (a money bug you can't see is the real risk here):** FT-06 (boot-require `DISCORD_WEBHOOK_MONITORING`; make `sendWebhook` return false when unset; fail-closed watchers), FT-07 (add a `/metrics` money-integrity gauge + `/health` degrade independent of Discord), the silent daily-cap trips, the drifted Sentry scrubber.
**Wave 2 — security/config:** FT-08 (use `Fly-Client-IP`), FT-09 (boot-check Resend), FT-10 (fix CODEOWNERS team), staff-role-revoke fail-open, kill-switch dead-in-prod, admin-cap zero-floor, image-proxy SSRF, staging-email path.
**Wave 3 — concurrency/data:** FT-11/FT-12 (favorites txn, pool sizing), OTP single-use atomicity, provisioning lock, ledger immutability DB fence + INV-1 fence + INV-3 trigger extension, ADR-019 CHECK-literal enforcement, non-CONCURRENT index.
**Wave 4 — hygiene & the rest:** dead code, script guards, OpenAPI 401/500, the low/info tail.

---

_Phase 2 (web/mobile/shared-UI) and the Phase-1 negative-space pass are pending the weekly-limit reset. Raw per-finding digest (130 findings, file:line + skeptic verdicts) is retained in the audit working files._
