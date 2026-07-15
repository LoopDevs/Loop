# Loop — Audit Recipe

**Status:** Living · **Derived against commit:** `83010533` · **Last reviewed:** 2026-07-11 · **Derived by:** cold multi-lens recon (Claude Fable 5)

> Project-specific overlay for a cold audit of this monorepo. The generic 28-dimension audit taxonomy knows what _kinds_ of bug exist; this file knows where _Loop_ keeps them — its money invariants and their _verified_ enforcement tiers, trust boundaries, which dimensions apply, tech traps, and recurring failure classes. Derived cold from code; `docs/{invariants,threat-model,money-auth-worklist}.md` were treated as **claims to verify** (and mostly held — this is a well-synced, heavily-audited repo; drift is noted inline). Sibling to `docs/invariants.md` (the money invariants as a contributor gate) and `scripts/check-money-invariants.mjs` (the CI presence check).

## 1. Architecture at a glance

- **Monorepo (npm workspaces):** `apps/backend` (Hono + Drizzle + postgres.js; the money/Stellar/ledger core, 774 ts), `apps/web` (React Router v7, dual SSR-web + SPA-mobile build, 511 ts/tsx), `apps/mobile` (Capacitor v8 over the SPA bundle), `packages/shared` (zod schemas/regex, the parity source of truth).
- **Deploy:** two Fly.io apps (`loopfinance-api`, `loopfinance-web`), **elastic multi-machine** (`min=1, auto_start, hard_limit=250`) — the fleet scales 1..N under load. Container hardening is **strong** (base image SHA-digest-pinned, non-root `node`, `npm ci --ignore-scripts`, healthcheck). Postgres = Fly Postgres.
- **Money is `bigint` minor units end-to-end** (off-chain); on-chain `amount_stroops` (7-decimal); percentages are `numeric(5,2)` exact-decimal precomputed to minor-unit splits. **No floats on any money path** (one non-money `doublePrecision` metric aside). postgres.js pinned to BigInt so balances round-trip without truncation.
- **No Stripe/card rail, no promo/referral/signup-grant.** Value ingress is **Stellar-only + admin + internal emission/interest**. No inbound webhooks exist (a generic HMAC verifier is dead code awaiting future Privy wiring).
- **Config is fail-closed at boot** — one zod `EnvSchema`, `parseEnv` at module load throws on any invalid var; keys checked for length + Shannon entropy; extensive production boot-fails (issuer pin, step-up key, rate-limit-disable, image allowlist, etc.).

## 2. Entry points (flow-unit seeds)

- **Backend HTTP (Hono):** public API (`src/public`, `/api/*`), admin API (`src/admin`, 214 files, mounted `requireAuth → requireStaff('support') → read-audit` then per-mount `requireStaff('admin')` + per-route `requireAdminStepUp`), `/well-known`, `/api/image` (public unauth proxy), `/api/public/rum` (unauth metrics), OpenAPI (`src/openapi`).
- **Money ingest = the Stellar deposit watcher** (`payments/watcher.ts`, a _pull_ from Horizon; gated `LOOP_WORKERS_ENABLED`) — the only value-in path besides admin.
- **Workers (advisory-locked, fleet-wide):** payout worker, procurement worker, interest-mint (nightly), the reconciliation/drift **watchers** (ledger-invariant, asset-drift, vault-solvency, float, stuck-payout, cursor-watchdog), sweep-stuck-procurement.
- **Web (React Router v7):** ~20 admin routes + client routes; **all authz is backend-enforced — client gates are UX only** (spoofable by design; spoofing yields empty/erroring UI, not data). Admin routes compile into the mobile bundle too (client-gated).
- **Mobile:** Capacitor static bundle (no live server URL); Keychain/Keystore token storage; validated deep-links; social login posts `id_token` directly (no redirect leg).
- **CLI/scripts:** `src/scripts`, `tools/ctx-catalog/*` (offline, human-gated, the only LLM use).

## 3. Money flows

- **Ingress:** Stellar deposit → order paid (XLM/USDC, no ledger) or LOOP-asset deposit = redemption/spend (ledger `spend(-)` + burn); admin adjustment/emission.
- **Internal:** cashback emission on fulfillment; fee split (wholesale/user/margin, `numeric(5,2)` → bigint, CHECK pct≤100); nightly interest accrue+mint; vault cashback/redemption (gated `LOOP_VAULTS_ENABLED`); DeFindex vault interest/share accounting.
- **Egress:** payout worker → Stellar (cashback/interest/emission/burn); CTX gift-card procurement/fulfilment; refunds (credit path = ledger row; on-chain xlm/usdc path = **no ledger row**, serialized on the order lock); payout-compensation; treasury hot-float/vault-operator movements.
- **The exhaustive ledger-writer set** (measure every tier claim against these 10): `orders/{repo-credit-order,transitions,fulfillment}.ts`, `credits/{adjustments,refunds,payout-compensation,accrue-interest,interest-mint}.ts`, `credits/vaults/{vault-emissions,vault-redemptions}.ts`.

## 4. Trust boundaries & adversary matrix (verified)

| Adversary                                | Capability today                                                                                                              | Posture                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Unauth internet                          | CORS-bounded, rate-limited (**spoofable — see traps**), never-500 public API                                                  | Strong except the rate-limit IP key                                              |
| Authenticated low-priv user              | own JWT; **cannot IDOR** (every op pins `userId = auth.sub`), forge tokens (alg-pinned), or replay OTP (per-email DB lockout) | Strong                                                                           |
| Compromised admin **bearer only**        | read money/PII; **cannot move money** (step-up needs a fresh email OTP, not the bearer)                                       | Strong — this is the load-bearing control                                        |
| Compromised admin bearer **+ email OTP** | emit to arbitrary address, adjust/refund, grant admin — within daily caps, all audited                                        | Bounded ~$1M/currency/day/bucket; but flat admin tier + wildcard step-up (traps) |
| Compromised support token                | broad fleet-wide PII read (emails, balances, ledger); ~zero write                                                             | Bounded by a (fail-open) bulk-read Discord tripwire                              |
| Compromised issuer secret                | mint unbacked LOOP                                                                                                            | Highest-value asset; boot-pinned; mint isolated to emission/interest_mint kinds  |
| Compromised operator secret              | drain operator wallet / move vault funds                                                                                      | Rotation-only mitigation                                                         |
| Compromised upstream (Horizon/CTX/Privy) | forge deposits if Horizon MITM'd; hostile CTX/Privy responses                                                                 | Zod-validated + circuit breakers; issuer-pinned deposits                         |
| Device adversary (mobile)                | refresh token from Keychain (not access); user wallet key on-device                                                           | Backend never holds the user key                                                 |

## 5. Invariants (with VERIFIED enforcement tiers)

> Tier = the **weakest** enforcement across ALL 10 ledger writers. The structural fact: **money-table constraints are exhaustive (CHECK/unique/FK) but there is NO DB-tier append-only immutability on `credit_transactions`/`user_credits`, NO row-level security, and the mirror==Σledger equality has no DB fence.** So the ledger's correctness rests on runtime discipline + one real DB conservation trigger + out-of-band watchers.

### INV-1 — mirror `balance_minor == Σ amount_minor` per (user,currency)

- **Enforced by:** each of the 10 writers pairs the CT insert with the UC upsert in one Drizzle txn under `.for('update')` (runtime); an integration `afterEach` asserts zero drift (test); `ledger-invariant-watcher.ts` daily drift page (watcher, **gated `LOOP_WORKERS_ENABLED`**). **The equality itself has NO DB enforcement** — the CHECKs (`user_credits_non_negative`, `credit_transactions_amount_sign`) guard shape/sign only.
- **Tier = watcher (weakest); convention for a new writer.** _Doc drift:_ `invariants.md` labels INV-1 partly DB; the named DB objects don't enforce the equality.

### INV-2 — every balance mutation atomic + row-serialized

- **Runtime only** (`.for('update')` in all writers). **Sharp edge:** two coexisting patterns — the SQL-increment `balance = balance + x` is lock-independent-safe; the JS-absolute write `set balanceMinor: newBalance` (`adjustments.ts:195`, `refunds.ts:474`) is safe **only** because of the preceding lock. A new writer copying the absolute pattern without the lock is a silent lost-update. **Tier = convention** (no DB fence forces the lock). The #1 weakest link.

### INV-3 — no unbacked LOOP (on-chain minted ≤ mirror liability)

- **DB (strong for its scope):** trigger `assert_emission_conservation()` (migration 0044/0061) — BEFORE INSERT `kind='emission'` and BEFORE UPDATE out of `failed` for mint kinds, takes `FOR UPDATE`, rejects over-mint. **GAP:** a _fresh INSERT_ of `kind='order_cashback'` or `kind='interest_mint'` passes **no** conservation trigger — trusted "by construction" (legit writers credit the mirror in the same txn). A new writer enqueuing those payouts without the paired mirror credit mints unbacked LOOP, caught only post-hoc by INV-4's watcher. **Tier = DB for emission/reentry; convention (watcher-backed) for cashback/interest fresh-insert.**

### INV-13 — deposit asset is issuer-pinned (self-issued-token fraud) ✅ STRONG

- **Runtime + boot-guard:** `isMatchingIncomingPayment` returns false when issuer unset (never "any"); `configuredLoopPayableAssets` omits unpinned codes; prod boot-fails if `LOOP_STELLAR_USDC_ISSUER` unset (unless `DISABLE_USDC_ISSUER_ENFORCEMENT=1`) and warns if ≠ Circle canonical. **Tier = runtime + boot. Well-defended.**

### INV-8/9 — at-most-once refund/cashback/payout ✅ mostly DB

- **DB:** partial unique `credit_transactions_reference_unique` (type ∈ cashback/refund/spend/withdrawal); `pending_payouts_{order,burn_order,active_emission}_unique`; interest-mint fenced by two same-txn uniques. **Cross-rail refund pair** (on-chain refund writes no CT row) serializes on the **order lock (runtime)**. **Adjustment double-issue** has no CT uniqueness → **runtime + 24h idempotency-key TTL only.**

### INV-7 — CTX paid at most once per order ✅ DB (`ctx_settlements_order_unique` + tx_hash-before-submit).

### Other verified-strong: money-as-bigint (DB column types); idempotency stored atomically with effect (admin savepoint-in-txn; order `(user_id, key)` unique; deposit state-CAS); crash-safety via CF-18 (tx_hash persisted before network submit).

### Weakest links (ranked)

1. **Watcher-tier silence (cross-cutting, NOT in the docs):** `discord/shared.ts:76 sendWebhook` returns `true` when the URL is unset, and `DISCORD_WEBHOOK_MONITORING` is **not boot-required** → every watcher-tier invariant (INV-1 drift, INV-4 asset drift, vault/float/stuck-payout) pages into the void if that env var is unset, and fire-once/latching watchers can mark `alert_active` on a _phantom_ delivery, permanently silencing the incident. **This makes the effective strength of the entire watcher tier conditional on one unenforced env var.**
2. **INV-2 lock is convention** — aggravated by the lock-dependent absolute-write pattern.
3. **INV-1 equality has no DB fence** — watcher/runtime/test only (doc overstates as DB).
4. **INV-3 fresh-insert gap** for cashback/interest kinds.
5. **Ledger immutability is convention-only** — no trigger/REVOKE on `credit_transactions`/`user_credits`; a compromised `loop_app` role or admin SQL rewrites the authoritative record, caught only post-hoc.
6. **Adjustment double-issue = runtime + 24h TTL** (no CT unique).
7. **Multi-machine advisory lock silently degrades to no-lock under a transaction-pooler `DATABASE_URL`** (`client.ts:117-125`, warn-only) — one misconfig reintroduces double-run windows.

## 6. Checklist deltas by dimension

25 of 28 dimensions in scope; 3 N/A. Heaviest: **MNY, SEC, DAT, CON, DOM, INF**.

| Dimension                           | Scope             | Focus                                                                                                                                                                                                                                     |
| ----------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MNY                                 | **Elevated**      | The 10 ledger writers, conservation, issuer pinning, at-most-once, on-chain (sequence/finality/memo), vault/DeFindex accounting, treasury. Mature — hunt the _newer_ vault/interest code and any new writer vs the invariant tiers above. |
| SEC                                 | **Elevated**      | Admin surface (214 files) + flat admin tier + wildcard step-up; the TRUST_PROXY XFF spoof; image-proxy SSRF (disableable allowlist); IDOR (verify the R3-11 accepted path + any new handler); token non-revocation.                       |
| DAT                                 | **Elevated**      | Ledger immutability (convention), migrations (forward-only, add-then-backfill), RLS absent, backup/DR not drilled.                                                                                                                        |
| CON                                 | **Elevated**      | Multi-machine (fleet-size divisor, advisory lock + SKIP LOCKED + state-CAS + CF-18); the pooler-degrades-the-lock trap; watcher single-flight.                                                                                            |
| DOM                                 | **Elevated**      | Cashback split math, interest/APY, vault share accounting, fee strategy, CTX contract fidelity, currency rules.                                                                                                                           |
| INF                                 | **Elevated**      | Fly multi-machine, DR (no PITR/offsite/drill), secrets, image.                                                                                                                                                                            |
| CID                                 | In scope          | CI is thorough but **gitleaks/real-DB-money-invariant/CVE/CodeQL not branch-protection-required; CODEOWNERS inert (team missing) → no required reviewers on money paths**; no CI deploy job.                                              |
| NTF                                 | In scope (narrow) | OTP email (staging-emails-real-inboxes gap), Discord outbound (silent-delivery, url-scheme allowlist), no consent for future non-transactional mail.                                                                                      |
| MBL                                 | In scope          | Capacitor; strong storage/deep-links/backup-scoping; **no TLS pinning / integrity attestation (ADR-027 deferred)** + sideloaded APK — the top mobile risk; version-skew is telemetry-only.                                                |
| ACC / UXP                           | In scope          | Large user-facing web (507 ts/tsx); money/PII/code+PIN rendering; CSV bulk exports; purchase/onboarding state machines; admin dominates the UI. Accessibility across the web app is the least-audited dimension.                          |
| I18N                                | In scope          | Multi-currency (USD/GBP/EUR/AED/INR/SAR/AUD/MXN); currency/number formatting, locale.                                                                                                                                                     |
| PRV                                 | In scope          | Unredacted admin PII + CSV exports (bulk-read tripwire is fail-open); email/OTP; GDPR/DSR path; retention.                                                                                                                                |
| DEP                                 | In scope          | Strong (exact pins, SHA-pinned actions, SBOM/provenance/cosign, Trivy, gitleaks) — verify no drift.                                                                                                                                       |
| COR/INT/REL/PRF/API/OBS/TST/HLT/DOC | In scope          | Per-file correctness across backend+web; interaction/flow bugs at the money seams; DOC drift is a _known pattern_ (docs lag hardening — treat every doc claim as a hypothesis).                                                           |
| **LLM**                             | **N/A (runtime)** | No LLM in backend/web/shared. AI only in offline, human-gated catalog tooling (`tools/ctx-catalog`) + a CI PR-review bot — no live prompt-injection surface. (Supply-chain of the tooling is a marginal DEP/CID note.)                    |
| **MDL**                             | **N/A**           | No trained/predictive model; Tesseract OCR is offline devDependency, ESLint-banned from shipped code.                                                                                                                                     |
| **TNS**                             | **N/A**           | No user-to-user interaction; single-operator; no UGC/social/marketplace between users.                                                                                                                                                    |

## 7. Tech-specific traps

- **`TRUST_PROXY=true` + leftmost-XFF** (`rate-limit.ts:68`, `fly.toml:29`): spoofable on Fly's _appending_ edge; the spoof-proof `Fly-Client-IP` is never read. Rate limits (except per-email OTP) are bypassable.
- **`discord/shared.ts:76` returns `true` when the webhook URL is unset** — the whole alerting/watcher tier can be silently dark; no boot guard on `DISCORD_WEBHOOK_MONITORING`.
- **Advisory lock degrades to no-lock under a transaction-pooler `DATABASE_URL`** (warn-only). Prod must use the direct port.
- **In-memory per-machine state** (rate-limit map, caches) × N machines — mitigated by the fleet-size DNS divisor, but the divisor's no-signal fallback is `1`.
- **JS-absolute-write ledger pattern is silently lock-dependent** — a new writer must copy the SQL-increment pattern or hold `.for('update')`.
- **INV-3 conservation trigger does not cover fresh cashback/interest payout inserts.**
- **Image-proxy allowlist is disableable** via `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT=1` → full anonymous SSRF.
- **Kill switches are fail-open by design** (`LOOP_KILL_*` default false); network passphrase accepts any non-empty string.
- **Vault network passphrase** derived from a registry row, not global env (`vault-client.ts:140`) — divergence risk (vaults off by default).
- **Staging with `EMAIL_PROVIDER=resend` emails real inboxes** (boot-guard only checks prod-vs-nonprod).
- **CODEOWNERS routes to `@LoopDevs/engineering` which doesn't exist** → GitHub silently drops the required-reviewer rule on ledger/migration/auth paths.

## 8. Recurring failure classes (the project's memory)

- **RFC-1 — Convention/watcher-tier money invariant, no DB fence.** (INV-1, INV-2, INV-3-fresh-insert, ledger immutability, adjustment double-issue.) The dominant class; hunt every new ledger writer against the tier table in §5.
- **RFC-2 — Guard/alert that silently no-ops when unconfigured.** (`sendWebhook` returns true when URL unset; advisory lock degrades under a pooler; image allowlist disableable; staging email guard.) A control that reads as present but is off/bypassed under a config the boot check doesn't fence.
- **RFC-3 — Admin-write missing a rail.** (`deposit-refund-handler.ts` has no idempotency/audit envelope though it moves real money — see the findings doc.) Hunt every admin money-write against the ADR-017 contract (Idempotency-Key + reason + `withIdempotencyGuard` + audit envelope + `notifyAdminAudit` + cap).
- **RFC-4 — Docs lag hardening.** Treat every doc/comment claim as a hypothesis to verify (README omits admin; mobile "prevent screenshots" overclaim; oncall broadcast-email that doesn't exist; Privy "not implemented" but substantially built; A-023 "done" but residual live).
- **RFC-5 — Accepted-risk that may have drifted.** Re-verify every threat-model accepted-risk against current code (R3-11 IDOR, order-velocity TOCTOU, channel-key blast radius, XFF).

## 9. Hot spots (audit first, hardest)

- The **newer vault/DeFindex** code (`credits/vaults/*`, `treasury/*`) — least-audited money surface; vault passphrase divergence (`vault-client.ts:140`); hot-float CF-18 gap; ADR-049 hand-rolled Soroban calls (not a vendor SDK).
- The **214-file admin surface** — per-handler ADR-017 rail coverage (RFC-3), flat-tier blast radius, the `deposit-refund-handler.ts` audit gap (no idempotency/reason/audit-envelope though it moves real Stellar value — verify against every other admin money-write).
- **Legacy `credits/interest-scheduler.ts`** — the X-2/CF-14 finding (per-process boolean lock across machines) never got the fleet-lock remediation its sibling `interest-mint.ts` got (S4-3); likely inert (ADR-036 forces `INTEREST_APY_BASIS_POINTS=0`) but a live double-run footgun if an operator flips it on.
- **`payments/watcher.ts` + claimable-balance/path-payment/`account_merge`** inbound (strand risk; not a credit bypass, but enumerate).
- **`wallet/user-signer.ts` call sites** — every caller must verify the raw signature against the known pubkey before attaching it; the interface doc says so — confirm each site actually does.
- **`packages/shared/src/order-state.ts` drift** — single source of truth for BOTH the Postgres CHECK literal and the UI state machine; Drizzle `check()` takes raw SQL so TS can't catch drift. Verify the CHECK literal still matches the TS tuple (ADR-019).
- **The web app's accessibility/UX** across ~500 files (never audited for ACC/UXP) and **I18N** (multi-currency formatting).
- Anything touching the **watcher/alerting tier** (RFC-2), any **new ledger writer** (RFC-1), and the mutating scripts (`wallet-testnet-walk.ts` — no `DATABASE_URL` guard; `e2e-real.mjs` — drives real mainnet).

## 10. Scope & exclusions

- **In scope:** `apps/backend`, `apps/web`, `apps/mobile`, `packages/shared`, `migrations`, `.github`, `fly.toml`/Docker.
- **Excluded:** `tools/ctx-catalog/*` (offline curation — audited as tooling only), `eng.traineddata` (OCR blob), generated native artifacts, `node_modules`. The catalog _content_ accuracy (CTX/merchant data) is a DOM/DAT concern, not code.
- **Outputs land in:** `docs/<type>-audit-YYYY-MM-DD.md` (matching the existing convention).

---

_Update whenever a new ledger writer, money flow, worker, or admin money-write lands — and re-verify the §5 tiers and §8 RFC classes each audit. The money core is mature; the recipe's value is keeping the newer surfaces (vaults, admin sub-handlers, web/mobile) and the RFC classes under the same discipline._
