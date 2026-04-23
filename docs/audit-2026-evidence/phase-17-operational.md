# Phase 17 — Operational Readiness (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Audit branch:** `main` (dirty working tree unrelated to this file:
mobile UX and onboarding routes)
**Date captured:** 2026-04-23
**Auditor:** cold-reviewer (Phase 17)
**Scope:** operational readiness per plan §Phase 17 + pass-4 G4-07
..G4-11 / G4-14 / G4-19 / G4-20; pass-5 G5-112..G5-117; pass-6 G6-05
..G6-12. Specifically: runbook inventory, on-call, incident response,
status page / public comms, backup-restore rehearsal, DSR/GDPR flow,
financial reconciliation procedure, kill switches, rate-limit tuning
docs, autoscaling & headroom, legal (privacy + terms), CTX contract-
drift detection, third-party quota/cost awareness, secret-rotation
cadence & rehearsal, staging parity, log retention & access,
deployed-state spot-check procedure, DR / RPO / RTO, capacity plan,
error-budget tracking, cost governance, signing-cert expiry, tax /
regulatory reporting primitives, content moderation of upstream
merchant names, and Stellar fee strategy under congestion.

**Cross-refs (not re-derived here):** Phase 1 (governance: branch
protection, secret-scanning, CODEOWNERS — A2-101..A2-127); Phase 4
(build/release: SBOM, signing, rollback posture — A2-407, A2-408);
Phase 6 (DB: backup posture, replica absence — A2-722, A2-723, etc.);
Phase 13 (observability: Sentry release/env, log retention, SLO
absence, Discord PII — A2-1305..A2-1327); Phase 16 (CI/CD: rollback
runbook, GitHub Environments, preview envs, canary — A2-1403..A2-1416).
This file concentrates on the _operational_ dimension: if an alert
fires at 03:00 on launch night, does a new on-call have a documented
path?

---

## 1. Runbook inventory

Primary evidence: `find docs -name '*.md' -type f` and keyword grep.

| Runbook expected                         | File exists? | Location                                                           | State                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------- | :----------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| On-call roster / rotation                |    **No**    | —                                                                  | Never documented. Single maintainer (AshFrancis) per Phase 1 §9 / §10; no rotation, no secondary, no escalation policy, no handoff doc.                                                                                                                                                                                                                      |
| Incident response SLA + template         |    **No**    | —                                                                  | No `docs/incidents/` folder, no template, no severity ladder, no post-mortem template. Plan §Phase 17 mentions the need; nothing in-repo.                                                                                                                                                                                                                    |
| Post-mortem repository                   |    **No**    | —                                                                  | No `docs/post-mortems/` folder. No past incident log. Pre-launch, so the gap is prospective — but the _template_ to use when the first prod incident fires does not exist either.                                                                                                                                                                            |
| `monitoring` channel alert runbook       |    **No**    | —                                                                  | Phase 13 §3 enumerated the 15 notifiers (A2-1313..A2-1327). No file says "when `notifyPayoutFailed` fires, do X".                                                                                                                                                                                                                                            |
| `orders` channel runbook                 |    **No**    | —                                                                  | Same; no runbook for `notifyOrderCreated` volume burst, `notifyFirstCashbackRecycled` PII review.                                                                                                                                                                                                                                                            |
| `admin-audit` runbook                    |    **No**    | —                                                                  | No guidance for "actor that shouldn't have been admin is now in an audit line".                                                                                                                                                                                                                                                                              |
| Backup / restore runbook                 |    **No**    | —                                                                  | `grep -rn 'backup\|restore' docs/deployment.md` → two matches, both for the Android `backup_rules.xml` overlay, not DB. No `fly postgres backup` / `pg_restore` procedure. No rehearsal log. Phase 6 §Findings §A2-723 flagged this with "deferred to Phase 17"; Phase 17 re-confirms: still absent.                                                         |
| Rollback runbook                         |    **No**    | —                                                                  | Phase 16 A2-1403 filed; re-confirmed. No `docs/runbooks/rollback.md`.                                                                                                                                                                                                                                                                                        |
| DB outage runbook                        |    **No**    | —                                                                  | ADR-012 §157 (`docs/adr/012-drizzle-orm-fly-postgres.md:157`) literally says "runbook for `postgres` outages" — but as a deferred to-do, not as a link. No runbook exists.                                                                                                                                                                                   |
| Native-overlay drift runbook             |    **No**    | —                                                                  | ADR-007 §127 (`docs/adr/007-native-projects-source-of-truth.md:127`) says "runbook for the overlay system" as a future item. Not present.                                                                                                                                                                                                                    |
| Treasury / asset-drift runbook           |    **No**    | —                                                                  | ADR-015 §49, §239, §326 (`docs/adr/015-stablecoin-topology-and-payment-rails.md`) reference "the treasury-runbook" three times as an external doc. Not present in-repo.                                                                                                                                                                                      |
| Stellar operator secret rotation runbook |    **No**    | —                                                                  | `env.ts:226-233` documents the mechanism (`LOOP_STELLAR_OPERATOR_SECRET_PREVIOUS`) but there is no step-by-step rehearsed procedure.                                                                                                                                                                                                                         |
| Loop JWT signing key rotation runbook    |    **No**    | —                                                                  | `env.ts:141-148` documents `LOOP_JWT_SIGNING_KEY_PREVIOUS`; no runbook that says "on day X, generate new key, set PREVIOUS=old, verify issued JWTs flip through the window, drop PREVIOUS on day X+access-token-TTL".                                                                                                                                        |
| CTX refresh-token rotation (e2e) runbook | **Partial**  | `scripts/e2e-real.mjs:124` + Phase 16 §8.2                         | The _automated_ rotation path inside `e2e-real.yml` is documented in code comments (Phase 16 §8.2 confirmed no finding). But there is no _operator_ runbook for "what if rotation fails mid-flight and the secret is stuck at a dead token".                                                                                                                 |
| Financial reconciliation procedure       |    **No**    | —                                                                  | `apps/backend/src/admin/reconciliation.ts` (ledger drift check, 30 lines) is a _handler_ — admin visits it and sees drift between `user_credits` snapshot vs `credit_transactions` replay. There is no monthly procedure doc ("first of the month, pull CTX invoice, export admin CSV, reconcile, document drift"). Plan §Phase 17 required this explicitly. |
| Status page / public comms plan          |    **No**    | —                                                                  | No `status.loopfinance.io` domain, no `statuspage.io`-style integration, no "here's how we communicate a customer-facing outage". The only Phase-17 signal on a customer-facing outage is Discord (private) + the backend's `/health` endpoint (not customer-readable).                                                                                      |
| Kill-switch reference                    |    **No**    | —                                                                  | See §3. Kill-switches exist in the env schema but no doc tells ops "to shed traffic X, flip env var Y, redeploy".                                                                                                                                                                                                                                            |
| Signing-cert expiry tracker              |    **No**    | —                                                                  | See §4. Apple / Google / TLS certs have no expiry calendar or renewal runbook.                                                                                                                                                                                                                                                                               |
| Privacy policy / terms                   | **Partial**  | `apps/web/app/routes/privacy.tsx`, `apps/web/app/routes/terms.tsx` | Structural shells only — both carry "placeholder pending legal review" yellow banners (`privacy.tsx:46-56`, `terms.tsx:47-50`). Referenced mailboxes `privacy@loopfinance.io` / `legal@loopfinance.io` / `hello@loopfinance.io` **are not provisioned** per roadmap §Phase 1 mobile-submission.                                                              |
| Jurisdictional hosting note              |    **No**    | —                                                                  | No mention anywhere of "data is hosted in IAD (Virginia US) + LHR (London UK), which means GDPR + EU/UK data-residency considerations apply". `privacy.tsx` does not disclose the processor chain (Fly.io, CTX, Anthropic via PR-review, etc.).                                                                                                              |
| Tax / regulatory reporting runbook       |    **No**    | —                                                                  | No 1099-K / VAT / HMRC handling. See §7.                                                                                                                                                                                                                                                                                                                     |
| Content-moderation procedure             |    **No**    | —                                                                  | Merchant catalog is imported from CTX with no filter path. See §10.                                                                                                                                                                                                                                                                                          |
| CTX contract-drift detector              |    **No**    | —                                                                  | See §8.                                                                                                                                                                                                                                                                                                                                                      |
| Deployed-state spot-check                |    **No**    | —                                                                  | See §12.                                                                                                                                                                                                                                                                                                                                                     |

**Verdict:** The entire `docs/runbooks/` directory does not exist. Zero runbooks. Every "…-runbook" reference in the ADR tree (ADR-012, ADR-015 ×3, ADR-007) is a dangling pointer to a doc that was never written.

---

## 2. Alert-channel response inventory

Phase 13 §3 catalogued the 15 Discord notifiers. Phase 17 maps each
to a documented response:

| Notifier                        | Channel     | Documented response? | If it fires at 03:00, what does on-call do?                                                                                                                                                                                                                                                                           |
| ------------------------------- | ----------- | :------------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifyOrderCreated`            | orders      |          No          | Informational — but no doc says so                                                                                                                                                                                                                                                                                    |
| `notifyCashbackRecycled`        | orders      |          No          | Informational — but no doc says so                                                                                                                                                                                                                                                                                    |
| `notifyFirstCashbackRecycled`   | orders      |          No          | Informational + PII review (A2-1313) — but no doc                                                                                                                                                                                                                                                                     |
| `notifyOrderFulfilled`          | orders      |          No          | Informational                                                                                                                                                                                                                                                                                                         |
| `notifyCashbackCredited`        | orders      |          No          | Informational                                                                                                                                                                                                                                                                                                         |
| `notifyHealthChange` (degraded) | monitoring  |          No          | **No runbook.** On-call would have to cold-read `apps/backend/src/app.ts:482-640` to understand flap-damping, then decide.                                                                                                                                                                                            |
| `notifyHealthChange` (healthy)  | monitoring  |          No          | Informational                                                                                                                                                                                                                                                                                                         |
| `notifyPayoutFailed`            | monitoring  |       Partial        | `docs/adr/016-stellar-sdk-payout-submit.md` §260 and the `PayoutSubmitError` kind classification give the _taxonomy_ ("`tx_bad_auth` = configuration bug; admin retry after key rotation"; "`op_no_trust` = user has no trustline, terminal"). But there is no procedural runbook mapping kind → action → escalation. |
| `notifyUsdcBelowFloor`          | monitoring  |       Partial        | ADR-015 documents the fallback (procurement switches to XLM). No operator-facing "top up X USDC at Y custodian within Z hours" action.                                                                                                                                                                                |
| `notifyAdminAudit`              | admin-audit |          No          | Informational but could be adversarial (admin-credential compromise). No "suspect a leaked admin token? rotate, revoke, forensics" playbook.                                                                                                                                                                          |
| `notifyCashbackConfigChanged`   | admin-audit |          No          | Informational                                                                                                                                                                                                                                                                                                         |
| `notifyAssetDrift` (over/under) | monitoring  |       Partial        | ADR-015 §326 defers to "the treasury-runbook", which does not exist.                                                                                                                                                                                                                                                  |
| `notifyAssetDriftRecovered`     | monitoring  |          No          | Informational                                                                                                                                                                                                                                                                                                         |
| `notifyOperatorPoolExhausted`   | monitoring  |          No          | No runbook — operator has to cold-read `apps/backend/src/ctx/operator-pool.ts`. The pool is one of the highest-stakes subsystems (procurement is dead while pool is dead) and has no operational doc beyond source-code comments.                                                                                     |
| `notifyCircuitBreaker`          | monitoring  |          No          | No runbook. Circuit flaps (Phase 13 A2-1326) produce up to 120 embeds/hour with no on-call guidance.                                                                                                                                                                                                                  |
| `notifyWebhookPing`             | any         |          No          | Admin-triggered; used to verify channels work. No doc.                                                                                                                                                                                                                                                                |

**Verdict:** The plan §Phase 17 exit criterion — "a new on-call could reasonably respond to the top-10 alerts using only what's in-repo" — is **not met** for any of the 15 notifiers. The closest to a runbook is ADR-016 §Error-kind table which at least classifies payout-failure kinds as transient / terminal / config — useful but not a response procedure.

---

## 3. Kill-switch inventory

Primary evidence: `grep -rn 'ENABLED\|DISABLE_' apps/backend/src/env.ts` + `apps/backend/src/index.ts` + `apps/backend/src/orders/loop-handler.ts` + `apps/backend/src/auth/native.ts`.

| Concern                                     |     Independent kill-switch?      | Mechanism                                                                                                                                                                                                                                                                     |             Requires redeploy?             | Documented where?                        |
| ------------------------------------------- | :-------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------: | ---------------------------------------- |
| Loop-native auth                            |              **Yes**              | `LOOP_AUTH_NATIVE_ENABLED=false` env                                                                                                                                                                                                                                          | **Yes** (env change → Fly machine restart) | `env.ts:151-154`; no operational runbook |
| Loop-native workers (watcher + procurement) |              **Yes**              | `LOOP_WORKERS_ENABLED=false` env                                                                                                                                                                                                                                              |                  **Yes**                   | `env.ts:256-259`; no operational runbook |
| Payout worker (standalone)                  |            **Partial**            | Implicit — clear `LOOP_STELLAR_OPERATOR_SECRET` → worker logs error + stays inert (`auth/native.ts:151, 194`). Payment watcher + procurement continue. Not a clean toggle — setting the secret to empty violates the Zod regex and would fail schema validation unless unset. |                  **Yes**                   | `env.ts:219-229`, `index.ts:42-65`       |
| Payment watcher (standalone)                |            **Partial**            | Same pattern — clear `LOOP_STELLAR_DEPOSIT_ADDRESS`; watcher logs error + inert. Not an explicit boolean.                                                                                                                                                                     |                  **Yes**                   | `env.ts:169-178`, `index.ts:45`          |
| Procurement worker                          |     **No standalone switch**      | Coupled to `LOOP_WORKERS_ENABLED`. No way to pause procurement while keeping watcher alive, or vice versa.                                                                                                                                                                    |                  **Yes**                   | —                                        |
| Authentication (all)                        |              **No**               | There is no `AUTH_READ_ONLY` / `AUTH_DISABLED` flag. To block all new logins, operator would have to either scale machines to zero or hand-patch the handler + redeploy.                                                                                                      |                    n/a                     | —                                        |
| Orders (all)                                |              **No**               | No `ORDERS_READ_ONLY` / `ORDERS_DISABLED`. A customer-facing "orders temporarily unavailable" would require either a backend code change or an edge-level (Fly) block.                                                                                                        |                    n/a                     | —                                        |
| Loop-native order endpoints (standalone)    |            **Partial**            | Coupled to `LOOP_AUTH_NATIVE_ENABLED` (`loop-handler.ts:122, 458, 492` return 404 when off). But this disables orders AND auth together — not a granular order-only switch.                                                                                                   |                  **Yes**                   | `orders/loop-handler.ts:11-12`           |
| Rate limiting                               |   **Yes** — but wrong direction   | `DISABLE_RATE_LIMITING=true` turns rate limits OFF. Useful for e2e tests, dangerous for operator use. No flag to tighten rate limits without a redeploy.                                                                                                                      |                  **Yes**                   | `env.ts:92-98`                           |
| Image proxy allowlist enforcement           |   **Yes** (emergency override)    | `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1` — only intended for emergency push when allowlist is misconfigured. Loosens security.                                                                                                                                           |                  **Yes**                   | `env.ts:351-362`                         |
| Discord notifications                       |            **Partial**            | Unset any of `DISCORD_WEBHOOK_ORDERS` / `DISCORD_WEBHOOK_MONITORING` / `DISCORD_WEBHOOK_ADMIN_AUDIT` → that channel is silenced. No _per-notifier_ switch (can't silence `notifyCircuitBreaker` alone during a known flap).                                                   |                  **Yes**                   | `env.ts:100-107`                         |
| Sentry                                      |              **Yes**              | Unset `SENTRY_DSN` → backend skips `sentry()` middleware; unset `VITE_SENTRY_DSN` at build → web ships without Sentry. Web toggle is build-time only (VITE env baked in).                                                                                                     |               **Yes** (both)               | `env.ts:110`, `root.tsx:37-45`           |
| Admin panel                                 |              **No**               | No kill-switch. Compromise of `LOOP_JWT_SIGNING_KEY` requires manual rotation + revocation of issued tokens (and the revocation list doesn't exist — admin sessions are bearer tokens with TTL).                                                                              |
| Asset-drift watcher                         | Coupled to `LOOP_WORKERS_ENABLED` | Same coupling as procurement.                                                                                                                                                                                                                                                 |                  **Yes**                   | —                                        |

**Key gaps:**

1. **No "read-only" / "maintenance mode" middleware.** `grep -rn 'maintenance\|read.?only\|RO_MODE' apps/backend/src/app.ts` → 1 hit and that's just a comment on webhook-config endpoint being a read-only companion. There is no code path that says "when `MAINTENANCE_MODE=true`, reject POST/PUT/DELETE with 503 + JSON body". The only way to stop writes is to scale to zero, which stops reads too.
2. **No admin-only emergency stop.** There is no `/api/admin/emergency/pause-payouts` endpoint, no `/api/admin/emergency/lock-new-orders`. Ops has to touch Fly secrets + redeploy.
3. **All kill-switches require a deploy.** None of them are runtime-toggleable from the admin panel. On-call at 03:00 has to `fly secrets set LOOP_WORKERS_ENABLED=false && fly deploy` which triggers the full rolling-deploy window (plus Phase 16 A2-1405 says the strategy is un-pinned).
4. **The only runtime toggle that goes the right direction — `DISABLE_RATE_LIMITING` — loosens security.** There is no runtime-tightening counterpart.
5. **No kill-switch doc.** `grep -rn 'kill.?switch\|feature.?flag' docs/` → only hits in audit planning files (the plan itself). No operational reference of the form "to shed traffic from `/api/image`, do X".

---

## 4. Signing / cert expiry inventory

| Cert / signing material                                                         | Expires when?                                                                                              | Tracked where?                                                                                                                                                                                                                                                                                                                                      | Renewal runbook?                                                                                                                                                                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Apple Developer signing cert                                                    | ~1 year from issue (Apple default)                                                                         | **Not tracked.** `docs/deployment.md:179-186` only says "Xcode → Archive → App Store Connect". `apps/mobile/ios/App/App.xcodeproj/project.pbxproj` has `CODE_SIGN_STYLE = Automatic` (Phase 9 evidence L120), `DEVELOPMENT_TEAM` empty. Each maintainer signs with their personal Xcode account — expiry is per-developer, invisible from the repo. | **No.** G6-06 explicitly called out; no file exists.                                                                                                                                                     |
| Apple distribution cert                                                         | ~1 year                                                                                                    | Not tracked                                                                                                                                                                                                                                                                                                                                         | No                                                                                                                                                                                                       |
| Apple provisioning profile                                                      | ~1 year                                                                                                    | Not tracked                                                                                                                                                                                                                                                                                                                                         | No                                                                                                                                                                                                       |
| Apple App Store Connect API key                                                 | Configurable                                                                                               | Not tracked (not provisioned per roadmap)                                                                                                                                                                                                                                                                                                           | No                                                                                                                                                                                                       |
| Google Play upload signing key                                                  | Per keystore policy                                                                                        | Not tracked. `docs/deployment.md:188-197` says "Android Studio → Build → Generate Signed Bundle". Keystore lives on a maintainer's laptop, not in the repo.                                                                                                                                                                                         | **No.**                                                                                                                                                                                                  |
| Google Play app-signing key (Google-managed)                                    | Permanent (Google holds it)                                                                                | n/a                                                                                                                                                                                                                                                                                                                                                 | n/a                                                                                                                                                                                                      |
| Fly.io TLS certs (`api.loopfinance.io`, `loopfinance.io`, `www.loopfinance.io`) | 90 days, auto-renewed via Let's Encrypt (`docs/deployment.md:141-155`)                                     | **Not monitored.** No alert on renewal failure; `fly certs check` is not wired into any workflow. A failed renewal produces a customer-facing TLS-expired error with no paging path.                                                                                                                                                                | **No explicit renewal runbook**, but the auto-renew reduces the risk — still, no "if auto-renew fails, do X" procedure.                                                                                  |
| CTX client credentials (`GIFT_CARD_API_KEY`, `GIFT_CARD_API_SECRET`)            | Vendor-controlled                                                                                          | Not tracked                                                                                                                                                                                                                                                                                                                                         | No rotation cadence documented                                                                                                                                                                           |
| CTX client IDs (`CTX_CLIENT_ID_*`)                                              | No expiry but needs rebuild of web bundle when changed (audit A-018; `env.ts:310-344` warns on divergence) | Tracked implicitly by the boot warn                                                                                                                                                                                                                                                                                                                 | No                                                                                                                                                                                                       |
| `LOOP_JWT_SIGNING_KEY`                                                          | No fixed expiry — operator-driven rotation                                                                 | `env.ts:141-148` documents the mechanism (`_PREVIOUS` slot for overlap window)                                                                                                                                                                                                                                                                      | **No runbook.** The code supports rotation; the _schedule_ and _rehearsal_ are undocumented. G4-09 / G5-21 explicitly called for "rotation scheduled + rehearsed". Neither.                              |
| `LOOP_STELLAR_OPERATOR_SECRET`                                                  | No fixed expiry — operator-driven                                                                          | `env.ts:226-233` documents `_PREVIOUS` pattern                                                                                                                                                                                                                                                                                                      | **No runbook.** Same gap as the JWT key. Operator rotation of this secret is the highest-stakes action in the system (owns outbound payouts) and has no procedure.                                       |
| GitHub `ANTHROPIC_API_KEY`                                                      | No expiry                                                                                                  | Not tracked                                                                                                                                                                                                                                                                                                                                         | No rotation cadence                                                                                                                                                                                      |
| GitHub `GH_SECRETS_PAT`                                                         | Fine-grained PAT, TTL-bounded (operator-chosen, typically 90d..1y)                                         | **Not tracked in-repo**                                                                                                                                                                                                                                                                                                                             | **No renewal runbook.** Expiry = e2e-real workflow silently 401s on `PUT /secrets` — `e2e-real.yml` `if: always()` rotation step would fail and `CTX_TEST_REFRESH_TOKEN` would be stuck at a dead token. |
| CI `CTX_TEST_REFRESH_TOKEN`                                                     | CTX rotates on every use (memory `project_ctx_refresh_rotation.md`)                                        | Rotated by workflow itself (Phase 16 §8.2)                                                                                                                                                                                                                                                                                                          | Partially — if workflow fails, there's no doc on how to re-seed.                                                                                                                                         |
| `STELLAR_TEST_SECRET_KEY`                                                       | No expiry (mainnet hot wallet seed)                                                                        | Not tracked; rotation = generate new seed, fund it, swap secret                                                                                                                                                                                                                                                                                     | No rotation cadence, no renewal runbook                                                                                                                                                                  |

**Verdict:** Zero cert-expiry calendar. No "90 days before Apple dev cert expires, here's what to do" doc. No "every 90 days, rotate `LOOP_JWT_SIGNING_KEY`" schedule. Pre-launch the exposure is bounded because the cert lifecycle has not yet started for real; post-launch, first cert expiry would be the first time ops sees the procedure.

---

## 5. Staging / deploy-parity posture (G4-10)

| Question                                     | Answer                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does a staging environment exist?            | **No**                                       | Phase 16 §1.4: `gh api repos/LoopDevs/Loop/environments` → `{"total_count": 0}`. `docs/standards.md:554` explicitly: "No long-lived branches. There is no `develop` or `staging` branch. Environment differences are handled by configuration, not branching." Neither is there a staging _Fly app_. `fly apps list` (out of repo) would need to be consulted, but no `fly.toml` references a staging app name, and no doc mentions one. |
| Is there a preview / ephemeral per-PR env?   | **No**                                       | Phase 16 A2-1404.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Is prod data representative?                 | **N/A** (no staging to be representative of) | —                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Synthetic vs scrubbed prod?                  | **N/A**                                      | No scrub script exists — Phase 6 data retention findings noted no scrub path for `admin_idempotency_keys.response_body` (A2-722).                                                                                                                                                                                                                                                                                                        |
| Synced on a schedule?                        | **N/A**                                      | —                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Is there a staging Stellar wallet / network? | **Partial**                                  | `env.ts:236-241` documents that `LOOP_STELLAR_NETWORK_PASSPHRASE` accepts the Testnet string. But there is no documented staging deployment actually using Testnet.                                                                                                                                                                                                                                                                      |

**Verdict:** Pre-launch there is one environment. Every config gets tested in dev (local docker) or prod. This is a common pattern for solo-founder stage but is explicitly on the plan's pre-launch blocker list (G4-10 + G4-19 needs "staging log captured" to exit Phase 13).

---

## 6. Log retention / access (G4-11)

Cross-ref Phase 13 A2-1320. Re-confirmed in the operational lens:

- **Where:** Fly.io platform log buffer only. No Axiom / Datadog / Loki / Papertrail transport.
- **How long:** Fly platform defaults (~7 days free tier, ~30 days paid). Unbounded as written in-repo because `fly.toml` has no retention block and no ADR commits to a number.
- **Who can read:** any Fly org member with deploy access on `loopfinance-api` / `loop-web`. No RBAC inside Fly's log view.
- **PII in logs:** Phase 13 §3 + §1.6 confirmed — user emails in `notifyFirstCashbackRecycled`-adjacent error paths, admin emails in `notifyAdminAudit` stanzas, admin idempotency keys truncated to 32 chars, 500-char-capped upstream response bodies (A2-1306 = no redact pass on body). `apps/backend/src/logger.ts:83-87` REDACT_PATHS covers a narrow keyword set.
- **Incident replay window:** ~7–30 days. A post-incident analysis more than 30 days after the event cannot reconstruct access-log or upstream-body state.

**Verdict:** As an operational concern — **no runbook for log access**, **no retention commitment**, **no egress target**, **no PII redaction pass on logged bodies**. A compliance audit would fail on "how long do you retain these logs, who has access, and what's the deletion trigger". Pre-launch blocker.

---

## 7. DSR / GDPR flow trace

Plan §Phase 17 called out two flows explicitly: **delete-my-account** and **export-my-data**.

### 7.1 "Delete my account"

- `grep -rn 'delete.?account\|deleteAccount\|closeAccount' apps/backend/src apps/web/app` → no hits.
- No `DELETE /api/users/me` endpoint. `apps/backend/src/users/handler.ts` has GET handlers only (per Phase 13 §1.2: 11 `"Failed to resolve calling user"` lines, all GET paths).
- No UI control. `apps/web/app/routes/` has no "Delete account" page; the `/settings/*` tree has `wallet`, `cashback` per roadmap §Phase 2 but no account-deletion page.
- `privacy.tsx:94-102` claims "Account identifiers are deleted within 30 days of account closure unless retention is mandated by law" — but there is **no mechanism to close an account**. The clause is aspirational.
- Data flow on a hypothetical deletion would touch: `users`, `user_identities`, `refresh_tokens`, `otps` (already expired), `orders`, `credit_transactions`, `user_credits`, `pending_payouts`, `admin_idempotency_keys` (if the user was an admin target), plus Discord history (`notifyAdminAudit`, `notifyFirstCashbackRecycled`), Sentry events, Fly logs. No code handles any of these.

**Finding:** DSR/GDPR erasure is unimplemented and undocumented. The privacy policy promises 30-day erasure the code cannot deliver.

### 7.2 "Export my data"

- `grep -rn 'export.?my.?data\|dataExport\|exportData' apps/backend/src apps/web/app` → no hits (admin CSV endpoints exist but those are admin-→-other-user, not self-export).
- No `GET /api/users/me/export` endpoint.
- No UI control.
- `privacy.tsx:104-117` lists "portability" as a user right subject to the applicable regime, with mailto: link only. **Mailbox `privacy@loopfinance.io` is not provisioned** (roadmap §Phase 1 explicit blocker: "provision `privacy@` / `legal@` / `hello@loopfinance.io` mailboxes").

**Finding:** DSR/GDPR portability is unimplemented, undocumented, _and_ the fallback contact channel is not provisioned.

### 7.3 Rectification / restriction / objection

All handled implicitly by the absence of (1) and (2). No automated flow, no operator runbook, no SLA commitment.

---

## 8. CTX contract-drift detection (G4-07)

Plan item: "canary or contract-test CI?" to catch CTX upstream schema changes.

- `grep -rn 'contract.?test\|schema.?drift\|contractCheck' .github apps/backend/src` → no hits in workflows or source.
- Defense posture: every upstream response is Zod-validated (`apps/backend/src/auth/handler.ts`, `orders/handler.ts`, etc. — confirmed Phase 2 L190-193 and ADR/roadmap "Validate upstream responses with Zod" = done). So a CTX change produces a 500 at request time rather than silent data corruption.
- **But:** detection is reactive (user gets a 500, Sentry captures it, ops investigates). There is no _proactive_ canary that runs, say, hourly against CTX's live API to confirm the schema hasn't drifted. `e2e-real.yml` runs on `workflow_dispatch` only (Phase 16 §1.1) — manual, not scheduled.
- `test-e2e-mocked` in `ci.yml` tests the Loop backend against a mocked CTX, which by definition cannot detect drift.
- `test-e2e` (real CTX on PR) runs per PR but against a single recorded flow; it does not exercise every upstream endpoint.
- No cron-scheduled canary job.

**Finding:** CTX contract drift is caught at first-impacted-customer time, not proactively.

---

## 9. Third-party quota / cost awareness (G4-08 / G5-112)

| Third party                            | Limit type                                                              | Tracked? |                                                                                                  Alert on approach?                                                                                                   |
| -------------------------------------- | ----------------------------------------------------------------------- | :------: | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| Sentry (backend + web)                 | Event quota — sample rate 0.1 prod, error-sample 1.0 (Phase 13 A2-1311) |  **No**  |                                                  **No.** No `Sentry.captureException` counter in-process. A single noisy error can burn the monthly quota silently.                                                   |
| Discord webhooks                       | ~30 requests/min per webhook (Discord-side)                             |  **No**  | **No.** `discord.ts:56-67` logs warn on 429; no counter (Phase 13 A2-1319). Phase 13 §10 catalogued realistic alert-volume → circuit-flap can emit 120 embeds/hour into one channel, well above Discord's 30/min cap. |
| Horizon (Stellar)                      | ~3,600 requests/hour for public servers                                 |  **No**  |                    **No.** `grep -rn 'Horizon.*quota\|horizon.*limit' apps/backend/src` → no hits. Phase 5c A2-606 flagged two workers racing Horizon lookups (doubled rate); no rate-governance.                     |
| CTX (upstream)                         | Vendor-confidential per-token limits                                    |  **No**  |                               **No.** Circuit breaker trips on _failure count_, not _rate_. A steady stream of 200s under a quota cap would silently approach the cap with no warning.                                |
| Anthropic (PR review)                  | Token quota per `ANTHROPIC_API_KEY`                                     |  **No**  |                                         **No.** Phase 16 A2-1414 filed: no concurrency / rate-cap on `pr-review.yml` — a storm of `synchronize` events burns tokens uncapped.                                         |
| Fly.io (machines, bandwidth, Postgres) | Operator billing                                                        |  **No**  |                                                                                         **No.** No budget alerts documented.                                                                                          |
| Let's Encrypt (TLS renewal)            | Rate-limit on failed issues                                             |  **No**  |                                                                                                   **No.** §4 above.                                                                                                   |

**Verdict:** Zero documented third-party quota awareness. G5-112 (cost governance / spend alerts) returns empty across the board.

---

## 10. Content-moderation (G6-09)

- Merchant catalog is sourced from CTX upstream via `merchants/sync.ts` with no filter (Phase 5d confirms).
- `grep -rn 'profanity\|blocklist\|block.?list\|filter.?merchant' apps/backend/src` → no hits.
- Merchant _names_ are whatever CTX returns and are rendered directly in the web UI, in Discord `notifyOrderCreated` / `notifyOrderFulfilled` / etc. embeds, and in admin panels.
- If CTX inadvertently publishes a merchant with an offensive name (rare but possible — user-submitted business names in their catalog), Loop has no filter / escalation path. The only lever is the operator-in-the-admin-panel eviction pattern (ADR-021), which is manual + reactive.
- Discord embed escaping (`discord.ts:591` `escapeMarkdown`) prevents `@everyone` / markdown-link injection via merchant name (filed as Phase 18 explicit attack item, not re-audited here). But escape ≠ moderation.

**Finding:** No content-moderation pipeline. Manual admin-panel eviction is the only control.

---

## 11. Stellar fee strategy under congestion (G4-20)

- `apps/backend/src/payments/payout-submit.ts:22, 45, 113` — fee is `args.feeStroops ?? BASE_FEE` where `BASE_FEE` is the Stellar SDK constant (100 stroops = 0.00001 XLM).
- No fee-bump envelope (`TransactionBuilder.buildFeeBumpTransaction`) anywhere. `grep -rn 'fee.?bump\|buildFeeBump' apps/backend/src` → no hits.
- Under Stellar network surge, the current code submits at `BASE_FEE` and takes the Horizon `insufficient_fee` / `tx_insufficient_fee` error. ADR-016 §Error-kind table classifies this as a transient retryable error and the payout worker retries with `LOOP_PAYOUT_MAX_ATTEMPTS = 5` before terminal `failed`.
- **But:** re-submitting at the same `BASE_FEE` during a sustained surge produces 5 consecutive failures and marks the row terminal. No adaptive fee-bump strategy, no per-tick fee-oracle lookup, no fee-source account for bumps.

**Finding:** Payouts become terminal during a Stellar network surge instead of fee-bumping. Retry loop does not help because the fee does not adapt.

---

## 12. Deployed-state spot-check procedure (G4-14)

Plan item: "documented procedure for reading prod read-only — any stuck orders older than SLO? drift rows? pending_payouts past 24h?"

- **Admin panel surfaces exist:**
  - `apps/web/app/routes/admin.stuck-orders.tsx` → backend `apps/backend/src/admin/stuck-orders.ts` (threshold is a UI slider, Phase 13 A2-1325 — no committed SLO).
  - `apps/web/app/routes/admin.payouts.tsx` / `admin.payouts.$id.tsx` → `admin/payouts.ts` + `admin/stuck-payouts.ts` + `admin/payouts-activity.ts`.
  - `admin.treasury.tsx` → `admin/treasury.ts` + drift watcher state via `admin/asset-drift-state.ts`.
  - `admin.audit.tsx` → `admin/audit-tail.ts`.
- **But no documented procedure exists.** No `docs/runbooks/operational-check.md` of the form "every day at 10:00 UTC: (1) visit /admin/stuck-orders with threshold=60m; (2) visit /admin/stuck-payouts with same; (3) if non-zero count, escalate by X". Ops knowledge of "what good looks like" is implicit in the absent SLO.
- **No read-only spot-check CLI.** Nothing like `npm run ops:health-check` that exits non-zero on stuck/drift/pending conditions.

**Verdict:** The admin panel has every surface needed to perform a spot-check, but the operational procedure wrapping those surfaces does not exist.

---

## 13. DR / RPO / RTO (G5-113)

- `grep -rn 'RPO\|RTO\|disaster.?recovery\|DR plan' docs/` → 0 hits (outside audit files).
- Fly Postgres is single-region by default; `docs/deployment.md:5-22` shows a two-region topology for app machines but the Postgres instance is implied single-region (no explicit mention). No DR plan.
- No documented backup → restore SLA. No "last 90 days saw at least one full restore rehearsal" log (Phase 6 §517 confirmed: **rehearsal deferred to Phase 17; Phase 17 confirms: not done**).
- No failover region. No runbook of the form "if IAD goes down: (1) flip CNAME; (2) promote LHR replica; (3) expected RTO X, RPO Y".

**Verdict:** Zero DR posture.

---

## 14. Capacity plan (G5-114) and autoscaling (plan §Phase 17)

- Backend `fly.toml:49-52`: single `shared-cpu` × 512MB. `min_machines_running = 1`. `hard_limit = 250` concurrent requests. Web `fly.toml:38-41`: 256MB, same concurrency.
- `docs/deployment.md:88-93` documents `fly scale count` and `fly scale vm` as CLI commands, **not as a plan**. No "at N RPS, scale to M machines; at X, escalate to shared-cpu-2x" doc.
- No load-testing artefact in-repo. `grep -rn 'k6\|artillery\|locust\|autocannon' .` → zero hits.
- Phase 6 §A2-723 flagged: `DATABASE_POOL_MAX=10` × N instances may collide with Fly Postgres connection cap if autoscaling hits 10+ replicas. No doc.
- No headroom calc. No spike plan ("marketing runs a campaign, expect 10× baseline, prewarm M machines"). Phase 13 §10 flagged the alert-volume corollary — campaign = `orders` Discord channel floods — with no mitigation.

**Verdict:** Capacity plan absent. Scaling is reactive-by-CLI, untested.

---

## 15. Error budget tracking (G5-115)

Cross-ref Phase 13 A2-1325 — "SLO" terminology appears but no SLO is defined. Error-budget tracking requires an SLO; an absent SLO means error-budget tracking is trivially absent.

- No burn-rate alert.
- No monthly error-budget review.
- No remediation gating ("if burn > 2x for week N, freeze feature work").

---

## 16. Rate-limit tuning: documented vs measured (plan §Phase 17)

- Rate limits are documented in `AGENTS.md` middleware section and `apps/backend/src/app.ts:646, 749, 835` (comments reference "plenty of headroom").
- None of the "plenty of headroom" numbers are derived from measurement — they are intuition-based. Pre-launch this is unavoidable (no prod volume), but the _review trigger_ is missing: no commit-after-launch action item that says "within 30 days, review rate-limit tuning against measured p99 / 429 rate".
- Phase 13 §6 confirmed: no metrics scraper in Fly, so the counters that would inform tuning (`loop_requests_total`, `loop_rate_limit_hits_total`) are lost on every restart and uncollected.

**Finding:** Rate-limit values are untested against reality; no review cadence.

---

## 17. Legal: privacy + terms + jurisdictional posture

- `apps/web/app/routes/privacy.tsx` + `apps/web/app/routes/terms.tsx` — structural shells with yellow "pending legal review" banners. Referenced mailboxes not provisioned (roadmap §Phase 1 blocker).
- `apps/web/app/components/features/Footer.tsx` links both (confirmed Phase 8a §322 sitemap).
- **Jurisdictional note absent.** The pages do not disclose: (1) backend lives in IAD+LHR (US+UK data residency); (2) Loop is merchant of record (ADR-010) — crucial for tax + refund rules; (3) sub-processor list (CTX upstream, Fly.io, Sentry, Anthropic via PR review, Discord via webhooks).
- **No cookie banner.** `grep -rn 'cookie.?banner\|cookieconsent\|consent' apps/web/app` → no hits. EU users hitting loopfinance.io have no consent UX. Given the auth flow sets session-only storage (memory + sessionStorage per secure-storage rules), this may be defensible under "strictly necessary" — but the defensibility is undocumented.

**Finding:** Legal surface is a placeholder. Jurisdictional hosting disclosure missing. No cookie banner; no documented consent posture.

---

## 18. Tax / regulatory reporting (G6-10)

- `grep -rn '1099\|W-9\|VAT\|HMRC\|IR35\|tax.?report' apps/backend/src` → zero hits in source.
- No schema support for tax withholding on cashback. `users` has `home_currency`; no `tax_residency` column, no `tin` / `ssn_last4` / `w9_on_file` / `backup_withholding` flags.
- ADR-010 (Loop as merchant of record) implies tax-reporting obligations on Loop for the gift-card sale leg. ADR-015 (cashback in LOOP-branded stablecoins) implies either ordinary income or crypto-asset reporting obligations, jurisdiction-dependent. Neither is called out in any ADR as "here's how we'll handle 1099-K at year end".
- No data model for annual statements. No `tax_year_summary` table, no admin endpoint to emit 1099-K CSV.

**Finding:** Tax / regulatory reporting is absent at the data-model layer. Any US $600+ cashback would trigger 1099-K reporting that Loop cannot currently produce. UK VAT on gift-card sales depends on the B2B/B2C treatment of the underlying vouchers (multi-purpose vs single-purpose — Phase 6.5 financial audit flagged this tangentially); no ADR addresses it.

---

## 19. Findings

IDs A2-1900 – A2-1930 (31 used; 69 slots remain — range per brief A2-1900..A2-1999). Severities per plan §3.4. Pre-launch context: missing runbooks / DR plans / cert expiry tracking = **High** because they are pre-launch blockers per the brief.

### Severity totals

| Severity  | Count  |
| --------- | ------ |
| Critical  | 0      |
| High      | 14     |
| Medium    | 12     |
| Low       | 4      |
| Info      | 1      |
| **Total** | **31** |

### A2-1900 — High — No runbook directory exists; zero alert-response docs

**Files:** `docs/` (no `docs/runbooks/` folder); all 15 Discord notifiers in Phase 13 §3.
**Evidence:** §1 inventory above — every expected runbook is absent. `grep -rn 'runbook' docs/adr/` returns four dangling pointers (ADR-007, ADR-012, ADR-015 ×3) to runbooks that were never written. Plan §Phase 17 exit criterion ("a new on-call could reasonably respond to the top-10 alerts using only what's in-repo") fails at step 1.
**Impact:** Pre-launch blocker. The first prod incident is also the first time ops learns the shape of the system. MTTR is bounded by "how fast the single maintainer can cold-read source".
**Remediation:** Create `docs/runbooks/` with minimum 8 files: `alert-monitoring.md`, `alert-orders.md`, `alert-admin-audit.md`, `rollback.md`, `db-outage.md`, `stellar-operator-rotation.md`, `loop-jwt-rotation.md`, `treasury.md`. Each maps a specific trigger to a specific action.

### A2-1901 — High — No on-call roster, rotation, or escalation policy

**Files:** Repo-wide. `grep -rn 'on.?call\|rotation\|pager' docs/` → only code-level references (JWT key rotation, etc.). No `docs/oncall.md` or equivalent.
**Evidence:** Phase 1 §9 / §10 confirmed single-maintainer project (AshFrancis). No secondary. No `CODEOWNERS` team (A2-103 — team doesn't exist). No PagerDuty / OpsGenie integration (Phase 13 A2-1327). Discord is the sole channel (also A2-1327).
**Impact:** If the single maintainer is unreachable (sleep, travel, illness, account-lock), there is no alternate path for a prod incident. Discord-only paging means if Discord itself is down — no signal at all.
**Remediation:** Document the current single-person-on-call state explicitly in an ADR (`024-operational-on-call-posture.md`), name the backup path (one trusted contact with `fly` + DNS access), add a second paging tier (PagerDuty / SMS) per A2-1327.

### A2-1902 — High — No incident response SLA / template / post-mortem policy

**Files:** `docs/incidents/` — does not exist. `docs/standards.md` — no incident-response section.
**Evidence:** Plan §Phase 17 required incident SLAs, templates, post-mortem policy. `grep -rn 'incident\|post-mortem\|post.mortem' docs/` → zero matches outside the audit plan.
**Impact:** First production incident is handled ad-hoc. No template → post-mortem inconsistency → learning never captured. No SLA → customer comms impossible to time correctly.
**Remediation:** Add `docs/runbooks/incident-response.md` with severity ladder (SEV1..4), comms template per severity, and `docs/post-mortems/TEMPLATE.md`.

### A2-1903 — High — No status page / customer-facing comms plan

**Files:** No `status.loopfinance.io` DNS (inferred from `docs/deployment.md` DNS block). No statuspage-style integration. `apps/web/app/routes/` has no `status.tsx`.
**Evidence:** §1 above.
**Impact:** During an outage, customers have no way to distinguish "my issue" from "platform issue". Support inbox floods. App Store reviewers during a submission window see an outage without context.
**Remediation:** Stand up a minimal status surface — either Statuspage, or a self-hosted `/status` page that reads from `/health` + cached degraded-since timestamps. Wire `notifyHealthChange` to post to the status page as well as Discord.

### A2-1904 — High — No backup / restore rehearsal in the last 90 days (ever)

**Files:** No log, no rehearsal script, no `docs/runbooks/backup-restore.md`.
**Evidence:** Phase 6 §517-518 filed rehearsal as deferred to Phase 17; Phase 17 re-confirms it has not happened. `docs/deployment.md` `grep 'backup\|restore'` returns only Android `backup_rules.xml` hits.
**Impact:** The first time a restore is exercised would be under incident pressure. Fly Postgres daily snapshots exist by default but the _procedure_ to restore (point-in-time, fork-from-snapshot, cross-region) is untested. Data-loss RPO is unknown.
**Remediation:** Schedule a rehearsal: spin up a staging Postgres, take a snapshot of prod, restore into staging, document timing, verify ledger invariants post-restore (Phase 6.5 invariants). Repeat quarterly.

### A2-1905 — High — DSR/GDPR "delete my account" is unimplemented while privacy policy promises it

**Files:** `apps/web/app/routes/privacy.tsx:94-102` ("Account identifiers are deleted within 30 days of account closure"), `apps/backend/src/users/handler.ts` (no DELETE endpoint), `apps/web/app/routes/settings.*` (no delete-account page).
**Evidence:** §7.1 above. Zero code, docs, or UI surface.
**Impact:** Non-compliance with GDPR Article 17 (right to erasure) the moment a single EU/UK user signs up. The privacy policy's promise creates legal exposure Loop cannot fulfill.
**Remediation:** Either (a) implement erasure — `DELETE /api/users/me` with cascading deletes, idempotent, with an admin-audit row, plus a settings-page button — or (b) rewrite the privacy policy before launch to promise only what the code delivers, with counsel review.

### A2-1906 — High — DSR/GDPR "export my data" is unimplemented; fallback mailbox unprovisioned

**Files:** No `GET /api/users/me/export`, no UI. `privacy.tsx:104-117` promises portability via `privacy@loopfinance.io` which is not provisioned per roadmap §Phase 1.
**Evidence:** §7.2.
**Impact:** Same as A2-1905 — privacy policy promise the system cannot fulfill.
**Remediation:** Implement `/api/users/me/export` returning JSON (users, user_credits, credit_transactions, orders, pending_payouts scoped to caller); provision the mailbox; document the SLA in the privacy policy.

### A2-1907 — High — No kill-switch for orders, auth, or payouts at runtime

**Files:** `apps/backend/src/env.ts` — env flags gate entire _feature bundles_ (workers, native auth) but require redeploy. `apps/backend/src/app.ts` — no maintenance-mode middleware.
**Evidence:** §3 above. `grep -rn 'maintenance.?mode\|read.?only\|ORDERS_DISABLED\|AUTH_DISABLED' apps/backend/src` returns nothing except a webhook-config comment.
**Impact:** To pause orders during an incident (e.g. procurement pricing bug discovered live), ops must either (a) scale the backend to zero (kills reads too) or (b) ship a code change. Both take minutes-to-hours. During that window, revenue-impacting actions continue.
**Remediation:** Add an `OPS_MAINTENANCE_MODE` env or admin-panel-toggled DB flag that causes `POST /api/orders`, `POST /api/auth/request-otp`, payout-worker tick, and admin writes to return 503. Allow GETs. Allow admin toggle. Document in `docs/runbooks/maintenance-mode.md`.

### A2-1908 — High — No Apple / Google signing-cert expiry calendar or renewal runbook (G6-06)

**Files:** `docs/deployment.md:177-197`, `apps/mobile/ios/App/App.xcodeproj/project.pbxproj` (CODE_SIGN_STYLE=Automatic, empty team).
**Evidence:** §4 above. G6-06 explicitly called for both; both absent.
**Impact:** An expired Apple cert silently stops TestFlight builds. An expired Android upload key is recoverable but requires a Play Console intervention. Neither is tracked; the first warning is a failed build during a release window.
**Remediation:** Create `docs/runbooks/signing-cert-expiry.md` listing each cert, expiry date, renewal steps. Add a calendar reminder 30 days before expiry. Consider rotating to App Store Connect API key for automated signing.

### A2-1909 — High — No `LOOP_JWT_SIGNING_KEY` or `LOOP_STELLAR_OPERATOR_SECRET` rotation schedule / rehearsal (G4-09 / G5-21)

**Files:** `apps/backend/src/env.ts:141-148, 226-233` — the mechanism exists (`_PREVIOUS` slots).
**Evidence:** §4 above. Code supports rotation; no schedule, no runbook, no rehearsal log.
**Impact:** Rotation is the one control that recovers from a key compromise. Untested rotation = incident-time discovery of a bug in the rotation path. For `LOOP_STELLAR_OPERATOR_SECRET` specifically, a botched rotation on the live operator account can strand in-flight payouts.
**Remediation:** Document the rotation procedure step-by-step for each key. Rehearse on a staging account (when staging exists per A2-1913). Schedule a quarterly cadence.

### A2-1910 — High — No DR plan; RPO and RTO undefined (G5-113)

**Files:** `docs/` — no DR section. `docs/deployment.md:5-22` shows two regions for app machines only.
**Evidence:** §13 above.
**Impact:** A single-region Postgres outage has no documented failover. RPO / RTO commitments to the App Store / merchant partners cannot be made honestly.
**Remediation:** Decide single-region-with-backups vs multi-region-with-replica posture; document it in ADR-024 (or similar); set explicit RPO / RTO numbers.

### A2-1911 — High — No log retention commitment, PII redaction policy, or access RBAC (G4-11)

**Cross-ref:** Phase 13 A2-1320 — re-filed here in the operational lens.
**Files:** `apps/backend/fly.toml` — no `[log_shipping]`. `apps/backend/src/logger.ts:83-87` — narrow REDACT_PATHS. Phase 13 §1.6 — 500-char upstream-body slices unredacted.
**Evidence:** §6 above.
**Impact:** Compliance-audit fail. GDPR Article 5(1)(e) storage-limitation has no defensible answer. A customer-dispute replay older than ~30 days has no logs.
**Remediation:** Pick a log-shipping target (Axiom, Datadog), commit a retention window in ADR-024 alongside RPO/RTO, document who can read logs.

### A2-1912 — High — Privacy policy + terms are placeholders; mailboxes unprovisioned; jurisdictional hosting undisclosed

**Files:** `apps/web/app/routes/privacy.tsx`, `apps/web/app/routes/terms.tsx`.
**Evidence:** §17 above plus roadmap §Phase 1 explicit "remaining" item.
**Impact:** App Store / Play Store submission gates on a real privacy policy and ToS. Submitting the placeholder would fail review. EU/UK users have no basis for consent. Sub-processor list absent — CTX, Fly.io, Sentry, Discord, Anthropic (PR review) are all undisclosed.
**Remediation:** Legal copy drop-in before launch; add sub-processor list; add jurisdictional hosting disclosure; provision mailboxes.

### A2-1913 — High — No staging environment (G4-10)

**Cross-ref:** Phase 16 A2-1406 (no GitHub Environments). Extended here to cover the Fly-app layer.
**Files:** `docs/standards.md:554` — explicitly says "no develop or staging branch; handled by configuration". No staging Fly app referenced anywhere.
**Evidence:** §5 above.
**Impact:** Every operational rehearsal suggested in this phase (DR rehearsal, key rotation rehearsal, staging Stellar wallet, flap-damping verification per plan G4-19) has nowhere to happen. Every migration runs first in prod.
**Remediation:** Stand up `loopfinance-api-staging` on Fly with its own Postgres and a scrub-script-loaded dataset; wire to Testnet Stellar; use for all future rehearsals.

### A2-1914 — Medium — No financial reconciliation runbook (monthly CTX invoice vs ledger)

**Files:** `apps/backend/src/admin/reconciliation.ts` exists as a drift-check handler. No procedural doc.
**Evidence:** §1 table above. Plan §Phase 17 required it.
**Impact:** The reconciliation handler would detect drift between `user_credits` snapshot and `credit_transactions` replay. But no one knows when to run it, what to do if it finds drift, or how to reconcile against CTX's monthly invoice (which is outside the system).
**Remediation:** Add `docs/runbooks/monthly-reconciliation.md` with dates, procedure, drift-triage tree, escalation to finance.

### A2-1915 — Medium — No CTX contract-drift canary; detection is at first-impacted-request time (G4-07)

**Files:** `.github/workflows/` — `e2e-real.yml` is manual-only.
**Evidence:** §8 above. Defense is Zod validation at request time.
**Impact:** CTX schema change produces 500s until detected via Sentry. Window is "time between drift and next real user request + Sentry ingestion". For low-traffic endpoints (e.g. /locations), window can be hours.
**Remediation:** Either add a scheduled (hourly) `workflow_dispatch:schedule` version of `e2e-real.yml` that exercises every upstream endpoint, or stand up a lightweight cron job inside the backend that pings each upstream and compares Zod-validation outcome.

### A2-1916 — Medium — No third-party quota / cost alerts (G4-08 / G5-112)

**Files:** None; nothing configured.
**Evidence:** §9 above.
**Impact:** Sentry/Discord/Horizon/CTX/Anthropic/Fly billing breaches are discovered either at invoice time or at hard-failure time (quota-exhausted). No graduated warning.
**Remediation:** Document per-vendor quota in a single table; set billing alerts in each vendor dashboard; add webhook-failure counter (Phase 13 A2-1319); cap `pr-review.yml` concurrency (Phase 16 A2-1414).

### A2-1917 — Medium — No runbook for `notifyPayoutFailed` / `notifyAssetDrift` / `notifyOperatorPoolExhausted`

**Files:** ADR-015 / ADR-016 provide partial taxonomy; no procedural runbook.
**Evidence:** §2 table above.
**Impact:** These three notifiers fire on the highest-stakes subsystems (Stellar payouts, treasury drift, procurement). Without runbooks, ops reads ADRs during the incident. MTTR bloat.
**Remediation:** One runbook per notifier, keyed on the `kind` field where applicable, with explicit escalation thresholds.

### A2-1918 — Medium — Rate-limit values are intuition-derived; no review-after-measurement cadence

**Files:** `apps/backend/src/app.ts:646, 749, 835` — "plenty of headroom" comments, no measurement reference.
**Evidence:** §16 above.
**Impact:** Values could be too loose (a bot saturates an endpoint before 429ing) or too tight (legit app retries hit 429 under normal load). Phase 13 §6 says the metrics that would inform tuning are scraped-only-on-demand and lost on restart.
**Remediation:** Add a post-launch action item: within 30 days of GA, review `/metrics` scraped counters against rate-limit settings; adjust + commit an ADR-025 or similar recording the measured baseline.

### A2-1919 — Medium — No capacity / headroom / spike plan (G5-114)

**Files:** `apps/backend/fly.toml`, `apps/web/fly.toml`, `docs/deployment.md:88-93`.
**Evidence:** §14 above.
**Impact:** A campaign-driven spike scales reactively via `fly scale count` under operator control; no pre-planned response. Phase 6 A2-723 flagged pool-connection exhaustion at 10+ replicas; no doc acknowledges the ceiling.
**Remediation:** Load-test baseline (k6 / artillery) against a staging-or-single-deploy; document break points; pre-plan spike-response ladder.

### A2-1920 — Medium — No error-budget tracking (G5-115)

**Cross-ref:** Phase 13 A2-1325.
**Files:** —
**Evidence:** §15 above. Preconditional on A2-1325 being resolved.
**Impact:** Without budgets, operational decisions ("do we ship this risky change this week?") rest on gut feel.
**Remediation:** After SLO definition lands, wire burn-rate alerts.

### A2-1921 — Medium — No Stellar fee-bump strategy under congestion (G4-20)

**Files:** `apps/backend/src/payments/payout-submit.ts:22, 45, 113` — `BASE_FEE` constant, no fee-bump code path.
**Evidence:** §11 above.
**Impact:** Sustained Stellar congestion → payouts exhaust `LOOP_PAYOUT_MAX_ATTEMPTS` at static `BASE_FEE` and go terminal. Admin must manually reset + retry. Cashback SLAs slip.
**Remediation:** Either (a) add an adaptive fee oracle (read Horizon recent-ledger fee stats, multiply 2x) inside the retry loop, or (b) add a fee-bump envelope path on any `*_insufficient_fee` classification before incrementing `attempts`.

### A2-1922 — Medium — No content-moderation pipeline for merchant names (G6-09)

**Files:** `apps/backend/src/merchants/sync.ts` — imports unfiltered.
**Evidence:** §10 above.
**Impact:** Offensive / off-brand CTX merchant names render in-app, in Discord embeds, and in App Store screenshots without filter. Reputational + App Store risk.
**Remediation:** Add a keyword blocklist + manual-escalation path; document the admin eviction flow (ADR-021) as the moderation-of-last-resort.

### A2-1923 — Medium — Tax / regulatory reporting data model absent (G6-10)

**Files:** `apps/backend/src/db/schema.ts` — no tax residency, no TIN, no annual-summary tables.
**Evidence:** §18 above.
**Impact:** US $600+ cashback recipient triggers 1099-K obligation Loop cannot produce. UK VAT on gift-card sales obligations are jurisdiction-dependent; no ADR addresses MPV vs SPV distinction.
**Remediation:** Pre-launch — write ADR-026-tax-reporting defining Loop's position; add schema columns required for the likely-minimum reporting path.

### A2-1924 — Medium — No deployed-state spot-check procedure (G4-14)

**Files:** Admin panel surfaces exist at `apps/web/app/routes/admin.{stuck-orders, payouts, treasury, audit}.tsx`. No procedural doc.
**Evidence:** §12 above.
**Impact:** Manual checks are ad-hoc. A stuck order or drift row can sit for days until someone notices the count on a dashboard.
**Remediation:** Add `docs/runbooks/daily-ops-check.md` + an in-process cron that posts a daily digest to `monitoring` Discord ("today: 0 stuck orders; 1 drift row at $X; 0 pending_payouts > 24h").

### A2-1925 — Medium — No jurisdictional hosting disclosure on privacy policy

**Files:** `apps/web/app/routes/privacy.tsx` (placeholder).
**Evidence:** §17 above.
**Impact:** EU/UK users cannot assess data-residency without the disclosure; part of A2-1912 but called out separately because it is a specific disclosure item required by Art. 13/14.
**Remediation:** Add a "Where we process your data" section naming IAD (US) + LHR (UK) + sub-processor locations.

### A2-1926 — Low — Discord is the only paging channel; goes down = ops goes blind

**Cross-ref:** Phase 13 A2-1327 — re-filed here at Low because the operational-tier framing has Phase 13's Medium implied pre-launch blocker.
**Evidence:** §2 + §3 above.

### A2-1927 — Low — No cookie / consent banner on `loopfinance.io`

**Files:** `apps/web/app/root.tsx` — no consent UX.
**Evidence:** §17 above.
**Impact:** EU users have no consent gate. Defensibility under "strictly necessary" depends on exact tracking posture which is undocumented.
**Remediation:** Either add a consent banner, or document (in an ADR) why none is required — enumerating every cookie / storage item and classifying each.

### A2-1928 — Low — Admin-panel kill-switches (per-notifier Discord silence, per-endpoint rate-limit tightening) do not exist

**Files:** `apps/backend/src/admin/discord-config.ts` — exists as read-only status; no per-notifier toggle. No rate-limit admin handler.
**Evidence:** §3 above.
**Impact:** During a known-flap incident, ops cannot silence a single notifier — has to null out the whole webhook. During a suspected bot attack, ops cannot tighten one endpoint's rate limit — has to redeploy with a new env.
**Remediation:** Low priority pre-launch — note for Phase 2 ops hardening.

### A2-1929 — Low — "Treasury-runbook" and "postgres-outage runbook" and "overlay-system runbook" are referenced in ADRs as existing documents but do not exist

**Files:** `docs/adr/007-native-projects-source-of-truth.md:127`, `docs/adr/012-drizzle-orm-fly-postgres.md:157`, `docs/adr/015-stablecoin-topology-and-payment-rails.md:49, 239, 326`.
**Evidence:** §1 above.
**Impact:** Doc-drift. ADRs promise references that materialise as dead links / dangling references when a future reader chases them.
**Remediation:** Either write the runbooks, or update the ADRs to remove the forward reference.

### A2-1930 — Info — Pre-launch single-maintainer posture dominates Phase 17 gaps

**Files:** Repo-wide.
**Evidence:** Many findings above (A2-1901, A2-1902, A2-1913, etc.) collapse to the same root: one person, no staging, no rehearsed procedures. This is acceptable for a pre-launch founder-stage project; it stops being acceptable the moment the first customer money flows.
**Remediation:** Track as a programmatic remediation: gate GA on a subset of High findings resolving (pick a remediation bundle per the plan §9 Sign-off criteria). No code action; process action.

---

## 20. Evidence artefacts (re-runnable)

All citations from SHA `450011ded294b638703a9ba59f4274a3ca5b7187`.

- Runbook absence: `find docs -type d -name runbooks` → empty. `find docs -type d -name incidents` → empty. `find docs -type d -name post-mortems` → empty. `find docs -type d -name oncall` → empty.
- Kill-switch inventory: `grep -nE 'ENABLED|DISABLE_' apps/backend/src/env.ts apps/backend/src/index.ts apps/backend/src/orders/loop-handler.ts apps/backend/src/auth/native.ts`.
- Maintenance-mode absence: `grep -rn 'maintenance.?mode\|read.?only\|RO_MODE' apps/backend/src` → 1 match, webhook-config comment only.
- DSR absence: `grep -rn 'delete.?account\|deleteAccount\|closeAccount\|data.?export\|exportData' apps/backend/src apps/web/app` → 0 hits.
- Kill-switch requires redeploy: confirmed by reading `apps/backend/src/env.ts` (Zod-parsed at boot, no runtime re-read path).
- Backup rehearsal absence: `grep -rn 'backup\|restore' docs/deployment.md` → 2 matches, both Android-overlay rules.
- Privacy placeholder: `apps/web/app/routes/privacy.tsx:46-56` (yellow banner), `apps/web/app/routes/terms.tsx:47-50` (yellow banner).
- ADR dangling runbook refs: `grep -rn 'runbook' docs/adr/` → 4 files, 5 matches, all forward references to docs that don't exist.
- Staging absence: `gh api repos/LoopDevs/Loop/environments` (from Phase 16) → `{"total_count":0}`. `docs/standards.md:554` (explicit no-staging-branch statement).
- Fee-bump absence: `grep -rn 'fee.?bump\|buildFeeBump\|FeeBumpTransaction' apps/backend/src` → 0 hits.
- Content-moderation absence: `grep -rn 'profanity\|blocklist\|moderation\|filter.?merchant' apps/backend/src` → 0 hits.
- Tax-reporting absence: `grep -rn '1099\|W-9\|VAT\|HMRC\|tax.?report\|tax.?residency' apps/backend/src apps/backend/src/db/schema.ts` → 0 hits.
- CTX contract-drift canary absence: `.github/workflows/e2e-real.yml` — `on: workflow_dispatch` only; no `schedule:` trigger.
- Cert-expiry absence: no `docs/runbooks/signing-cert-expiry.md`; `grep -rn 'expir\|renewal' docs/deployment.md` → zero non-OTP hits.

No primary source file was modified. No tracker edits. No commits.

---

## Exit

Phase 17 complete. 31 findings filed in range A2-1900..A2-1930 (14 High, 12 Medium, 4 Low, 1 Info, 0 Critical). The dominant pre-launch blocker is the **complete absence of the `docs/runbooks/` directory** (A2-1900) — every downstream operational finding (alert response, rotation, DR, DSR, reconciliation, cert expiry) either compounds this gap or is its symptom. The second-largest cluster is **legal / compliance unreadiness** (A2-1905 / A2-1906 / A2-1912 / A2-1923 / A2-1925 / A2-1927) — the privacy policy promises what the code cannot deliver and the regulatory data model is absent. The third-largest cluster is **runtime operational levers missing** (A2-1907 kill-switches, A2-1909 rotation rehearsal, A2-1910 DR, A2-1913 staging) — ops cannot rehearse, cannot toggle, cannot failover. None of the findings require a code fix to _capture_; the remediation of every one of them is a document, an ADR, or a procedure — with a subset of items (A2-1905, A2-1906, A2-1907, A2-1921, A2-1923) gated on code work that follows the doc decision. Plan §Phase 17 exit criterion ("a new on-call could reasonably respond to the top-10 alerts using only what's in-repo") is **not met**; needs A2-1900 + A2-1917 as the minimum floor.
