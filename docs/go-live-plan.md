# Loop — Go-Live Plan (the comprehensive task list)

> **The single, comprehensive, forward-looking view of everything to build and
> ship — every tranche, phase, feature, and task.** Organized by contract tranche,
> ownership-tagged, checkbox-tracked. This supersedes the scattered views:
>
> - [`readiness-backlog-2026-07-03.md`](./readiness-backlog-2026-07-03.md) — full **Why / Do / Done-when** per item ID (the detail this indexes).
> - [`money-auth-worklist.md`](./money-auth-worklist.md) — the money/auth items sequenced by risk (a lens on §T1-B / §T1-H).
> - [`roadmap.md`](./roadmap.md) — the phase-level map + **history of shipped work** (done items live there; this doc is what's left).
>
> Snapshot: **2026-07-07.** Tick here for the master view.

## Contract tranches (the north star)

| Tranche          | ≈ Phase      | Scope                                                                                     | This doc                  |
| ---------------- | ------------ | ----------------------------------------------------------------------------------------- | ------------------------- |
| **T1 — MVP**     | Phase 1      | Cross-platform app, **crypto** gift-card purchases (XLM), **discount** model, US/EU/CA/UK | **§T1 — this is GO-LIVE** |
| **T2 — Testnet** | Phase 2      | Integrated Stellar/Privy wallet, **cashback** (replaces discount), DeFindex testnet yield | **§T2**                   |
| **T3 — Mainnet** | ext. P2 + P3 | **Plaid** open banking, virtual cashback Visa/MC, mainnet, FCA EMI, 4-country             | **§T3**                   |

Phase-2 surfaces ship dark behind `LOOP_PHASE_1_ONLY=true`, so T1 launches without a T2 bleed (flip is server-side, no app-store resubmit).

## Legend — ownership

| Tag | Meaning                                  | Tag | Meaning                                                    |
| --- | ---------------------------------------- | --- | ---------------------------------------------------------- |
| 🔑  | Needs your **creds / secrets**           | 💰  | **Money-review** (agent drafts, you review, no self-merge) |
| 👤  | **Operator / legal / vendor** (only you) | 🔐  | **Auth-review** (same)                                     |
| 🟢  | **Safe self-merge** (agent end-to-end)   | 🧭  | **Decision needed** from you                               |

---

# §T1 · GO-LIVE (Tranche 1 — public launch)

## T1-A · Merchant data 🔑 — _built + hardened this session; needs creds to finish_

- [ ] **T0-2 · Apply the recovered catalog.** 🔑 CTX_TOKEN → apply 1,150 logos + info (coverage 3.2% → ~33%). Closes "brand images not rendering on beta". Pipeline built + CI-guarded; work-lists in [`tools/ctx-catalog/PIPELINE.md`](../tools/ctx-catalog/PIPELINE.md).
- [ ] **Supplier ingestion** 🔑 — read-only Tillo/SVS/EzPin creds → ground-truth to fix wrong-brand/URL + push toward 100% (adapters are the only unbuilt pipeline stage).
- [ ] **Clear audit work-lists** — 117 bad-source logos, ~155 missing terms, wrong domains (CVS/Foot Locker/Hulu/Sam's Club). Auto once creds land.

## T1-B · Money correctness 💰 / 🔐 — _sequenced in [`money-auth-worklist.md`](./money-auth-worklist.md)_

- [x] **AUDIT-1 · Regression-verify the GBPLOOP unbacked-mint P0** (it was **fixed** 2026-07-01/02 via `ONCHAIN_MINT_ELIGIBLE_ASSETS` allowlist + DB CHECK — confirm no regression, read-only). 💰 **Done 2026-07-07:** read-only verification passed; see [`audit-2026-07-07-gbploop-regression.md`](./audit-2026-07-07-gbploop-regression.md).
- [ ] **R3-2** wrong-asset refund _(partial: XLM/USDC refund-to-sender done; loop_asset re-mint/re-credit still open)_ · **R3-1** float reconciliation _(code-complete: schema/indexer/classifier/worker/Treasury read surface, audited baseline/manual writes, DB-enforced cold-start cursor safety, `needs_baseline` paging, threshold config+docs, and the operator runbook all done; 👤 remaining: operator sets the real production baseline + money-review sign-off)_ · **R3-4** redemption-null-exhaustion refund (+policy). 💰
- [x] **T0-1b** dup deposit vs paid order. 💰
- [x] **R3-9** durable redeem in-flight fence. 💰
- [x] **R3-10** idempotency default-on · **T0-1c** sub-dust deposits. 💰
- [x] **R3-5** pay-CTX upper-band · **R3-6** drift-channel paging. 💰
- [x] **R3-12** step-up CTX fail-open · **R3-7** pin native auth · **R3-8** step-up OTP lockout · **R3-13** WebView postMessage origin-check. 🔐
- [ ] **T0-3 · Money-invariant DB layer as a required merge check.** 💰 + 👤

## T1-C · Operator / legal / vendor 👤 — _longest lead; start in parallel now_

- [ ] **L1-1** Sanctions / OFAC / geo-eligibility screening (vendor). · [ ] **L1-2** ToS + age-gate capture. · [ ] **L1-3** Legal review of `/privacy` + `/terms` + provision `privacy@`/`legal@`/`hello@` mailboxes.
- [ ] **L1-9** Apex DNS `loopfinance.io` / `www` → web (web app already live at `beta.loopfinance.io`). · [ ] **L1-10** Set Sentry DSNs (`SENTRY_DSN` Fly secret + `VITE_SENTRY_DSN` web build-arg). · [ ] **L1-11** Verify prod secret set before deploy (`scripts/preflight-tranche-1.sh`; `LOOP_ADMIN_STEP_UP_SIGNING_KEY` now a prod boot requirement).
- [ ] **TLS** certificates (auto via Fly). · [ ] **USDC-issuer secret re-set** (`LOOP_STELLAR_USDC_ISSUER`, from the 2026-06-11 audit).

## T1-D · Mobile release 👤 + code

- [ ] **L1-4** Apple Developer enrollment + bundle id `io.loopfinance.app` → TestFlight. · [ ] **L1-5** Android keystore **+ offline-escrow procedure** (operator doesn't use 1Password — document a non-1Password escrow). · [ ] **L1-6** Google Play Console (`io.loopfinance.app`).
- [ ] **L1-7** App Store + Play screenshots & metadata + **submit to review** (metadata draft `docs/app-store-connect-metadata.md`). · [ ] **L1-8** Demo video (script `docs/phase-1-demo-script.md`).
- [ ] **M-1** Device/simulator testing on physical iOS + Android (headline mobile risk). 👤+🟢 · ✅ **M-2** Push notifications: wire or remove — resolved: removed (push is T2). 🟢 · ✅ **M-3** Deep linking — resolved: `appUrlOpen` + universal-links/App-Links wired, backend `.well-known/*` verification files served; code-side complete, on-device verification blocked on L1-4/L1-5 creds (APPLE_TEAM_ID / ANDROID_CERT_SHA256). 🟢 · ✅ **M-4** CI guard for operator-once native-overlay steps — resolved: overlay script now patches + verifies the iOS pbxproj wiring itself; `mobile-overlay-guard` CI job proves it on a scratch regeneration. 🟢 · ✅ **M-5** `@capacitor/app` lifecycle handling — resolved: `appStateChange` wired to TanStack Query's `focusManager` so queries refetch on resume. 🟢
- ✅ App icons + splash (iOS + Android native overlays) · ✅ Android signed-APK wiring · ✅ web app deployed (`beta.loopfinance.io` v9).

## T1-E · Launch-blocker code

- [ ] **C2-1 · Redemption-null re-validation** _(partial: characterized 2026-07-09 — the `Body already read` polling-fallback bug was already fixed as a test-fixture-only defect by PR #1419 (2026-06-11), and no double-body-read exists anywhere in current backend source (audited every `.json()`/`.text()`/`.arrayBuffer()` call site); the fulfilled-with-null-redemption path is a deliberate design (fulfil on `ctxOrderId`, not on redemption data) already backstopped by the `redemption-backfill` sweeper (60s cadence, 10-attempt backoff, Discord page on exhaustion). Closed the actual gap — no regression coverage existed — with a real-postgres flywheel assertion + a hard `scripts/e2e-real.mjs` assertion (with backfill-grace retry). Still open: a live real-order smoke test re-run to confirm in production — operator action, needs `E2E_REFRESH_TOKEN`/`STELLAR_TEST_SECRET_KEY`)_. 💰
- [ ] **C2-2 · Apple Sign-In native rework (CF-27).** 🧭 operator decision → 🔐

## T1-F · Product polish + geo

- [x] **U-1 · Full customer-journey UX / visual pass** — ✅ **done 2026-07-09:** findings doc `docs/ux-pass-2026-07-09.md` (9 findings — 0 P0 / 2 P1 / 7 P2); P1s filed as `readiness-backlog-2026-07-03.md` U-2/U-3, **both also done 2026-07-09** (PR #1595 — onboarding Phase-1 copy gate + `/calculator` Phase2Gate). 🟢
- [ ] **ADR 040 · Cloudflare edge** — the real geo fix (`CF-IPCountry`, code already prefers it) + EU latency + WAF/DDoS. 👤 setup; **security prereq: lock origin to CF before trusting its headers.** Closes the GeoLite2 item below if it lands.
- [ ] **GeoLite2 refresh cadence / staleness signal** (mooted if Cloudflare lands). 🟢 **done 2026-07-09:** `/health` reports `geoDbStale`/`geoDbBuildEpoch`, soft-degrades with `geo_db_stale`, pages `DISCORD_WEBHOOK_MONITORING` weekly, boot warn — `docs/deployment.md` §GeoLite2. · 👤 the remembered-cadence half (an operator actually redeploying with the `--build-secret` flags on a schedule) is still open.
- [x] `.gitleaksignore` fingerprint for the audit doc (advisory gitleaks noise). 🟢 **✅ done 2026-07-08:** verified with gitleaks v8.30.1 (both the local binary and CI's pinned Docker image, same `detect --config=.gitleaks.toml` invocation as `.github/workflows/ci.yml`) over full history (1496 commits) — exit 0, "no leaks found." The two finding classes the audit doc (`docs/audit-2026-06-30-cold/raw/x-security.md`) called out as noise were already resolved via `.gitleaks.toml` allowlist entries (the `-chars-min` stopword for the flywheel test-fixture JWT key, and the `__tests__/` path allowlist covering the now-removed Stellar test seeds) in #1534, not a `.gitleaksignore` fingerprint. No live finding remains to suppress, so no `.gitleaksignore` file was added — one would have nothing valid to reference.

## T1 exit criteria

- [ ] Web live at `loopfinance.io` · [ ] API live at `api.loopfinance.io` (already) · [ ] iOS approved (App Store) · [ ] Android approved (Play) · [ ] Users can: email sign-up → browse → buy with XLM → view code/barcode · [ ] Map+clustering · [ ] CI green on `main` (✅) · [ ] Monitoring operational.

---

# §T1-H · BEFORE REAL-MONEY VOLUME (T1 hardening, concurrent with / just after launch)

- [ ] **Reliability (R3 tail):** ✅ R3-3 warm-start catalog from Postgres (done 2026-07-07) · ✅ R3-11 legacy-order-path ownership gap documented (done 2026-07-08) 🟢/doc.
- [ ] **Scale/fleet (S4):** ✅ S4-7 catalog fetch trim (done) · ✅ S4-6 bound admin ledger-drift scan (done) · ✅ S4-2 wallet-provisioning fleet-lock (done) · ✅ S4-3 single-flight interest-mint reads (done) · ✅ S4-8 dedupe per-machine watchers/alerts (done 2026-07-09) · ✅ S4-4 rate-limiter dynamic fleet-size estimate (implemented 2026-07-09 — dynamic `.internal`-DNS estimator, not the shared-store option, which was deliberately rejected as hot-path-costly; PR open, 🔐 auth-review pending merge — rate limiting is an auth-review surface, not 🟢 self-merge). S4-1 payout throughput ceiling (L, architectural) 💰 · S4-5 raise DB pool / plan PgBouncer 👤+🟢 **2026-07-09: docs half done** — `docs/deployment.md` §"Database pool sizing & PgBouncer" has the verified pool-vs-concurrency gap, the sizing formula, a PROPOSED ~25/machine starting point, and the full ⚠️ PgBouncer/session-advisory-lock writeup (every `withAdvisoryLock` call site vs. the unaffected transaction-scoped locks; readiness-backlog S4-5). **Still open (👤):** operator reads the live Postgres `max_connections` and sets `DATABASE_POOL_MAX` against it.
- [ ] **Admin/support tooling (A5):** ✅ A5-1 order re-drive (biggest hole) — shipped 2026-07-09 **paid-only** after money-review, review-first PR #1609 open (not yet merged): `POST /api/admin/orders/:orderId/redrive`, admin + step-up (`order-redrive` scope), reuses `procureOne`/`ctx_settlements` idempotency, no new money logic; `procuring` refused (`ORDER_REDRIVE_IN_PROGRESS` — double-pay/stranding risk, the recovery sweep owns those); cancel-and-refund deferred to A5-4 · A5-4 order-bound refund UI+policy · ✅ A5-6 stuck-orders/payouts support-visibility — shipped 2026-07-10, review-first PR open (not yet merged): the backend read was already support-tier (ADR 037 blanket rider, since PR #1430); fixed the web-side mismatch (`admin.stuck-orders.tsx` was `RequireAdmin`, dashboard card was `isAdminRole`-gated) plus a regression pin that the triage default fires before the procurement-sweep terminal cutoff · ✅ A5-7 per-subject audit view — shipped 2026-07-10, review-first PR #1622 open (not yet merged): `GET /api/admin/users/:userId/audit` merges admin actions targeting the user + credit_transactions + orders + payouts + refresh_tokens revocations + an OTP-lock snapshot into one newest-first timeline; support-tier, read-only, per-source bounded (`?limit` default 8/[1,20], default response 41 events — under CF-10's 50-row bulk-read threshold); `UserAuditTimeline.tsx` on `/admin/users/:userId` drill-links each row; also closed a tracked A5-8 P2 (ledger's default 50-row page equalled the CF-10 threshold and tripped it every load — fixed via a per-path override) · ✅ A5-8 fleet-wide ledger browser — shipped 2026-07-10, review-first PR #1620 open (not yet merged): `GET /api/admin/ledger`, support-tier, read-only, keyset-paginated (bounded, indexed — new `credit_transactions_created_at` index, migration 0058, mirrors S4-6/PERF-005), filterable by userId/type/reference/date-range; `/admin/ledger` web page + drill-links both ways with `/admin/users/:userId` · A5-9 bulk + drift-correction · ✅ A5-2 session-revocation UI 🔐 — shipped 2026-07-10, review-first PR open (not yet merged): `RevokeSessionsPanel` on `/admin/users/:userId` wires the existing (previously orphaned) `POST /api/admin/users/:userId/revoke-sessions`; admin-gated, plain confirm dialog (the endpoint predates the ADR 017 envelope — no reason/idempotency/step-up on its own contract, so the UI matches that rather than inventing one) · A5-3 login/OTP support tooling 🔐 · A5-5 operator-mediated DSR. (all 💰 unless tagged)
- [ ] **Test & E2E coverage (Q6):** ✅ Q6-2 money/auth workers (done 2026-07-07) · Q6-3 web money-write · ✅ Q6-4 loop-native purchase-through-the-UI E2E (done 2026-07-10 — review-first PR open, not yet merged: touches a one-line product fix in `PurchaseContainer.tsx` alongside the new e2e suite; see `money-auth-worklist.md` Q6-4) · Q6-5 admin/support UI E2E · ✅ Q6-6 wallet-spend + interest-mint (done 2026-07-10 — real-postgres coverage; see `money-auth-worklist.md` Q6-6) · Q6-7 promote real-chain run off manual · Q6-8 ratchet web floors. 💰
- [x] **Q6-1** ctx-settlements direct counted coverage. 💰
- [ ] **Fraud/abuse (B-3):** velocity limits, dup-account detection, chargeback handling (absent today). 💰 + design/ADR.

## §T1-BS · Hardening / blind-spots (before real growth)

- [ ] **B-1** load/stress/soak testing (absent) 🟢 **2026-07-09: harness half done** — k6 suite (`tools/load-test/`: browse + auth→order scenarios, SLO-derived thresholds) + `run-local.sh` + `.github/workflows/load-test.yml` (`workflow_dispatch`-only, not a required check) landed; dev-machine + mock-CTX baselines recorded in `docs/load-testing.md`. **Still open (👤):** the real breaking-point run against staging/a scratch Fly deploy — needs operator-provisioned infra, see `docs/load-testing.md` "What this does NOT cover". · [ ] **B-2** accessibility / WCAG 2.1 AA audit (EU exposure; a11y-contract tests started this session; 2026-07-09: mechanical floor landed — `eslint-plugin-jsx-a11y` lint gate + 5 `jest-axe` route smokes, ADR 042 — manual keyboard/screen-reader pass + contrast checking still open, see readiness-backlog B-2) 🟢 · [ ] **B-4** DR: PITR + offsite backup 👤+🟢 **2026-07-09: docs/procedure half done** — `docs/runbooks/disaster-recovery.md` rewritten with an operator checklist, corrected Fly-docs-cited backup-posture facts, 3-layer target posture (retention → PITR → offsite `pg_dump`), restore-drill procedure, and PROPOSED RPO/RTO tables (readiness-backlog B-4). **Still open (👤):** actually enabling PITR, provisioning the offsite bucket, building the `pg_dump` workflow, and running a timed restore drill. · [ ] **B-5** observability depth (Prometheus scraping tier/dashboards/alerts — endpoint exists) 🟢+👤 **2026-07-09: 🟢 code/config half done** — `docs/observability.md` + committed `docs/observability/{prometheus.yml,grafana-dashboard.json}` (scrape-config-as-code + a dashboard with one row per `docs/slo.md` section); `/metrics` gained `loop_catalog_stale`/`loop_catalog_loaded_timestamp_ms` (Freshness SLO), `loop_worker_stale`/`loop_worker_last_lead_tick_timestamp_ms` (S4-8 wedged-fleet signal), `loop_geo_db_stale`/`loop_geo_db_build_age_days`, and `loop_rate_limit_fleet_estimate`/`_source` gauges (readiness-backlog B-5). **Still open (👤+`[code]`):** standing up a real Prometheus + Grafana instance (or Grafana Cloud), OpenTelemetry tracing across order→payment-watcher→procurement→payout, and a paging tier (PagerDuty/Twilio) for P0 signals — see `docs/observability.md` "Operator actions". · [ ] **B-6** i18n (English-only scaffold, hardcoded copy, no RTL — large) 🟢 **2026-07-10: framework + first extraction tranche done** — i18next/react-i18next chosen + wired (ADR 043), route-driven locale, SSR + static-export safe; first tranche extracted (home/auth/onboarding/footer/404), catalogs English-only at `apps/web/app/i18n/locales/en/`, see `docs/i18n.md`. Supersedes the old CF-22 scaffold. **Still open:** remaining tranches (MobileHome, other onboarding screens, gift-card/purchase/orders/settings) + actual translations, both gated on the 🧭 language-set decision; RTL still unverified against a real language.

---

# §T2 · WALLET, CASHBACK, YIELD (Tranche 2 — Phase 2)

_The cashback model replaces discounts. The ADR 015/016 surface + the ADR 030 Privy wallet (phases A–D) + the ADR 031/036 on-chain interest mint are **built** this cycle and sit dark behind `LOOP_PHASE_1_ONLY`. Remaining is vaults + treasury ops + regulatory sign-off + the flip-on decision._

- [x] **ADR 015/016 cashback surface** — home-currency model, FX-pin, LOOP-asset payout worker, procurement USDC-default, admin treasury + payouts drilldown, onboarding currency picker. ✅ shipped.
- [x] **ADR 030 Privy embedded wallet (phases A–D)** + **ADR 031/036 nightly on-chain GBPLOOP interest mint** + token-authoritative balance + one-tap pay-with-Loop-balance + staff dashboard. ✅ built 2026-07 (dark behind the flag).
- [ ] **LOOPUSD vault** (ADR 031) — Loop-curated DeFindex vault, USDC→Blend, 0% mgmt + 50% perf fee. **Contract audit is critical-path.** 👤+💰
- [ ] **LOOPEUR vault** (ADR 031) — same with EURC + Blend. 👤+💰
- [ ] **Treasury spread management** (ADR 031) — invest USDC/EURC backing into vaults + GBP fiat into UK custodian/MMF/gilts (Revolut Business, resolved); per-currency hot float for instant withdrawals. 👤
- [ ] **Past-30-day APY computation + display** (ADR 031) — on-chain share-price + mint history → "past 30d: X.XX%" + no-guarantee disclaimer. 🟢/💰
- [ ] **Privy/dfns Soroban custody DD** + **asset rename cleanup** (USDLOOP/EURLOOP retired). 👤/🟢
- [ ] **Multi-jurisdictional regulatory review** — vault curation + GBPLOOP issuance + Privy custody; 4–6 weeks crypto-fintech counsel. 👤
- [ ] **Flip `LOOP_PHASE_1_ONLY=false`** (launch cashback) — server-side, once the above + T1 are solid. 🧭 **Decision resolved 2026-07-09: gated on the operator demoing the Phase-1 discount version first; date TBD after that demo.**
- [ ] **Mobile enhancements:** push notifications (order/cashback) · Capacitor Live Update (OTA web assets) · deep linking (= M-3).
- Retired by ADR 030 (no action): external wallet-linking, on-device key gen, 2-of-3 multisig, recovery-key escrow, SEP-24 withdrawal UX.

---

# §T3 · MAINNET, OPEN BANKING, CARDS (Tranche 3 — contract deliverables)

- [ ] **Plaid SDK integration** 🧭💰 — open-banking USD/GBP/EUR/CAD rails so users buy via **bank transfer** (not just crypto — the mainstream-funding unlock). Backend accepts Plaid Auth + ACH/SEPA/FPS settlement; web/mobile SDK for account linking. **Needs an ADR + money-transmitter/KYC posture per jurisdiction first.** Rough scope 2–3 months. _(Decision resolved 2026-07-09: hold for T3 as contracted; no Plaid ADR now. See §Decisions.)_
- [ ] **Virtual cashback Visa/Mastercard** 👤💰 — card issuance for cashback spend; BIN-sponsor partnership (Marqeta/Stripe Issuing/Galileo) + KYC + compliance program. Rough scope 4–6 months.
- [ ] **Mainnet launch** 👤💰 — flip testnet→mainnet across stablecoins/vaults/wallet; requires custody + vault + GBPLOOP-issuance audits, **regulatory authorisations (UK FCA EMI for GBPLOOP + US/EU/CA posture)**, testnet-balance migration.
- [ ] **Four-country launch (US/UK/EU/CA)** 👤 — verify CTX catalog coverage per country; jurisdictional reg posture; localise strings + currency display.

---

# §P3 · GROWTH & POLISH (post-contract, not a tranche)

- [x] **Server-side merchant search** (replace the client-side full-catalog fetch — the S4-7 §3 tail). 🟢 **Done 2026-07-10:** `GET /api/merchants/search?q=&country=&limit=` (memory-backed, no migration — see readiness-backlog S4-7). Navbar + MobileHome search now call it (debounced) instead of filtering the full `/api/merchants/all` catalog; browse/directory grids still use the full catalog by design.
- [ ] **MapLibre GL JS** swap for Leaflet (WebGL, better mobile marker perf). 🟢
- [ ] **Referral program.** 🟢/💰
- [ ] **Analytics** (privacy-respecting, no PII) + **Core Web Vitals / API-latency perf monitoring.** 🟢+👤
- [ ] **Thin-currency promotion process** — ADR 035 leaves ~20 catalogue-only currencies below the ≥15-merchant bar; define a review cadence (one-line `countries.ts` add each). 🟢+🧭
- [ ] **Extended-market order path tail** — currency CHECKs + `convertMinorUnits` for AED/INR/SAR/AUD/MXN (comprehensive-audit Part IV Phase 3; partly wired via CF-19). 🟢
- [ ] Scripts-pile disposition + audit quality tail (comprehensive-audit Part IV phases 9–10). 🟢

---

# §Decisions I need from you

- [x] 🧭 **Plaid timing** — **resolved 2026-07-09: hold for T3; no Plaid ADR now.**
- [ ] 🧭 **Launch audience** — mainstream vs crypto-native (upstream of the Plaid call and the whole sequence).
- [x] 🧭 **Money/auth go-ahead** — **GRANTED 2026-07-09.** Agent drafts §T1-B / §T1-H money/auth items as review-ready PRs per `money-auth-worklist.md`'s review-first workflow (open, CI-green, reviewer-pass posted, never self-merged).
- [ ] 🔑 **Creds** — CTX_TOKEN + read-only supplier keys → I finish merchant data end-to-end.
- [x] 🧭 **Cashback flip** — **resolved 2026-07-09: flip gated on the Phase-1 discount demo happening first; date TBD after demo.**

---

## Suggested critical path

```
NOW (parallel):
  ├─ You:   §T1-C legal/operator + §T1-D mobile enrollment (longest lead)
  ├─ You:   creds → agent finishes §T1-A merchant data
  ├─ You:   §T2 vault audits + regulatory review (long lead — start if T2 is near)
  └─ Agent: §T1-B Phase 0 de-risk (regression-verify P0 + characterization tests)
THEN → LAUNCH T1:
  ├─ Agent (review-first): §T1-B money correctness + auth
  ├─ §T1-E launch-blocker code + §T1-F Cloudflare/geo
  └─ §T1-H hardening before real volume
DECISION GATE: Plaid → T1 fiat on-ramp or T3? · Cashback flip date?
THEN: §T2 (flip flag) → §T3 (Plaid/cards/mainnet/FCA) → §P3 polish
```

**Cross-refs:** [`readiness-backlog`](./readiness-backlog-2026-07-03.md) · [`money-auth-worklist`](./money-auth-worklist.md) · [`roadmap`](./roadmap.md) (shipped-work history) · [`invariants`](./invariants.md) · [`threat-model`](./threat-model.md) · [`adr/`](./adr/).
