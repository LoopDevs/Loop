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

- [ ] **AUDIT-1 · Regression-verify the GBPLOOP unbacked-mint P0** (it was **fixed** 2026-07-01/02 via `ONCHAIN_MINT_ELIGIBLE_ASSETS` allowlist + DB CHECK — confirm no regression, read-only). 💰
- [ ] **T0-1b** dup deposit vs paid order · **R3-2** wrong-asset refund · **R3-9** process-local redeem fence · **R3-10** idempotency default-on · **R3-5** pay-CTX upper-band · **T0-1c** sub-dust deposits · **R3-1** float reconciliation · **R3-4** redemption-null-exhaustion refund (+policy) · **R3-6** drift-channel paging. 💰
- [ ] **R3-12** step-up CTX fail-open · **R3-7** pin native auth · **R3-8** step-up OTP lockout · **R3-13** WebView postMessage origin-check. 🔐
- [ ] **T0-3 · Money-invariant DB layer as a required merge check.** 💰 + 👤

## T1-C · Operator / legal / vendor 👤 — _longest lead; start in parallel now_

- [ ] **L1-1** Sanctions / OFAC / geo-eligibility screening (vendor). · [ ] **L1-2** ToS + age-gate capture. · [ ] **L1-3** Legal review of `/privacy` + `/terms` + provision `privacy@`/`legal@`/`hello@` mailboxes.
- [ ] **L1-9** Apex DNS `loopfinance.io` / `www` → web (web app already live at `beta.loopfinance.io`). · [ ] **L1-10** Set Sentry DSNs (`SENTRY_DSN` Fly secret + `VITE_SENTRY_DSN` web build-arg). · [ ] **L1-11** Verify prod secret set before deploy (`scripts/preflight-tranche-1.sh`; `LOOP_ADMIN_STEP_UP_SIGNING_KEY` now a prod boot requirement).
- [ ] **TLS** certificates (auto via Fly). · [ ] **USDC-issuer secret re-set** (`LOOP_STELLAR_USDC_ISSUER`, from the 2026-06-11 audit).

## T1-D · Mobile release 👤 + code

- [ ] **L1-4** Apple Developer enrollment + bundle id `io.loopfinance.app` → TestFlight. · [ ] **L1-5** Android keystore **+ offline-escrow procedure** (operator doesn't use 1Password — document a non-1Password escrow). · [ ] **L1-6** Google Play Console (`io.loopfinance.app`).
- [ ] **L1-7** App Store + Play screenshots & metadata + **submit to review** (metadata draft `docs/app-store-connect-metadata.md`). · [ ] **L1-8** Demo video (script `docs/phase-1-demo-script.md`).
- [ ] **M-1** Device/simulator testing on physical iOS + Android (headline mobile risk). 👤+🟢 · [ ] **M-2** Push notifications: wire or remove. 🟢 · [ ] **M-3** Deep linking (absent). 🟢 · [ ] **M-4** CI guard for operator-once native-overlay steps. 🟢 · [ ] **M-5** `@capacitor/app` lifecycle handling. 🟢
- ✅ App icons + splash (iOS + Android native overlays) · ✅ Android signed-APK wiring · ✅ web app deployed (`beta.loopfinance.io` v9).

## T1-E · Launch-blocker code

- [ ] **C2-1 · Redemption-null re-validation** (the 2026-05-14 fulfilled-but-`redeemUrl/Code/Pin`-false bug + `Body already read` polling fallback; add to Tranche-1 acceptance checks). 💰
- [ ] **C2-2 · Apple Sign-In native rework (CF-27).** 🧭 operator decision → 🔐

## T1-F · Product polish + geo

- [ ] **U-1 · Full customer-journey UX / visual pass** (in progress). 🟢
- [ ] **ADR 040 · Cloudflare edge** — the real geo fix (`CF-IPCountry`, code already prefers it) + EU latency + WAF/DDoS. 👤 setup; **security prereq: lock origin to CF before trusting its headers.** Closes the GeoLite2 item below if it lands.
- [ ] **GeoLite2 refresh cadence / staleness signal** (mooted if Cloudflare lands). 🟢+👤
- [ ] `.gitleaksignore` fingerprint for the audit doc (advisory gitleaks noise). 🟢

## T1 exit criteria

- [ ] Web live at `loopfinance.io` · [ ] API live at `api.loopfinance.io` (already) · [ ] iOS approved (App Store) · [ ] Android approved (Play) · [ ] Users can: email sign-up → browse → buy with XLM → view code/barcode · [ ] Map+clustering · [ ] CI green on `main` (✅) · [ ] Monitoring operational.

---

# §T1-H · BEFORE REAL-MONEY VOLUME (T1 hardening, concurrent with / just after launch)

- [ ] **Reliability (R3 tail):** R3-3 warm-start catalog from Postgres 🟢 · R3-11 legacy-order-path ownership gap 🟢/doc.
- [ ] **Scale/fleet (S4):** ✅ S4-7 catalog fetch trim (done). S4-1 payout throughput ceiling (L, architectural) 💰 · S4-2 wallet-provisioning fleet-lock 💰 · S4-3 single-flight interest-mint reads 💰 · S4-4 rate-limiter shared store 🟢 · S4-5 raise DB pool / plan PgBouncer 👤+🟢 · S4-6 bound admin ledger-drift scan 💰 · S4-8 dedupe per-machine watchers/alerts 🟢.
- [ ] **Admin/support tooling (A5):** A5-1 order re-drive (biggest hole) · A5-4 order-bound refund UI+policy · A5-6 stuck-orders/payouts visibility · A5-7 per-subject audit view · A5-8 fleet-wide ledger browser · A5-9 bulk + drift-correction · A5-2 session-revocation UI 🔐 · A5-3 login/OTP support tooling 🔐 · A5-5 operator-mediated DSR. (all 💰 unless tagged)
- [ ] **Test & E2E coverage (Q6):** Q6-1 ctx-settlements · Q6-2 money/auth workers · Q6-3 web money-write · Q6-4 loop-native purchase E2E · Q6-5 admin/support UI E2E · Q6-6 wallet-spend + interest-mint · Q6-7 promote real-chain run off manual · Q6-8 ratchet web floors. 💰
- [ ] **Fraud/abuse (B-3):** velocity limits, dup-account detection, chargeback handling (absent today). 💰 + design/ADR.

## §T1-BS · Hardening / blind-spots (before real growth)

- [ ] **B-1** load/stress/soak testing (absent) 🟢 · [ ] **B-2** accessibility / WCAG 2.1 AA audit (EU exposure; a11y-contract tests started this session) 🟢 · [ ] **B-4** DR: PITR + offsite backup 👤+🟢 · [ ] **B-5** observability depth (Prometheus scraping tier/dashboards/alerts — endpoint exists) 🟢+👤 · [ ] **B-6** i18n (English-only scaffold, hardcoded copy, no RTL — large) 🟢.

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
- [ ] **Flip `LOOP_PHASE_1_ONLY=false`** (launch cashback) — server-side, once the above + T1 are solid. 🧭
- [ ] **Mobile enhancements:** push notifications (order/cashback) · Capacitor Live Update (OTA web assets) · deep linking (= M-3).
- Retired by ADR 030 (no action): external wallet-linking, on-device key gen, 2-of-3 multisig, recovery-key escrow, SEP-24 withdrawal UX.

---

# §T3 · MAINNET, OPEN BANKING, CARDS (Tranche 3 — contract deliverables)

- [ ] **Plaid SDK integration** 🧭💰 — open-banking USD/GBP/EUR/CAD rails so users buy via **bank transfer** (not just crypto — the mainstream-funding unlock). Backend accepts Plaid Auth + ACH/SEPA/FPS settlement; web/mobile SDK for account linking. **Needs an ADR + money-transmitter/KYC posture per jurisdiction first.** Rough scope 2–3 months. _(Decision: pull earlier as a T1 fiat on-ramp, or hold for T3? See §Decisions.)_
- [ ] **Virtual cashback Visa/Mastercard** 👤💰 — card issuance for cashback spend; BIN-sponsor partnership (Marqeta/Stripe Issuing/Galileo) + KYC + compliance program. Rough scope 4–6 months.
- [ ] **Mainnet launch** 👤💰 — flip testnet→mainnet across stablecoins/vaults/wallet; requires custody + vault + GBPLOOP-issuance audits, **regulatory authorisations (UK FCA EMI for GBPLOOP + US/EU/CA posture)**, testnet-balance migration.
- [ ] **Four-country launch (US/UK/EU/CA)** 👤 — verify CTX catalog coverage per country; jurisdictional reg posture; localise strings + currency display.

---

# §P3 · GROWTH & POLISH (post-contract, not a tranche)

- [ ] **Server-side merchant search** (replace the client-side full-catalog fetch — the S4-7 §3 tail). 🟢
- [ ] **MapLibre GL JS** swap for Leaflet (WebGL, better mobile marker perf). 🟢
- [ ] **Referral program.** 🟢/💰
- [ ] **Analytics** (privacy-respecting, no PII) + **Core Web Vitals / API-latency perf monitoring.** 🟢+👤
- [ ] **Thin-currency promotion process** — ADR 035 leaves ~20 catalogue-only currencies below the ≥15-merchant bar; define a review cadence (one-line `countries.ts` add each). 🟢+🧭
- [ ] **Extended-market order path tail** — currency CHECKs + `convertMinorUnits` for AED/INR/SAR/AUD/MXN (comprehensive-audit Part IV Phase 3; partly wired via CF-19). 🟢
- [ ] Scripts-pile disposition + audit quality tail (comprehensive-audit Part IV phases 9–10). 🟢

---

# §Decisions I need from you

- [ ] 🧭 **Plaid timing** — T3 as contracted, or pull forward as a T1 **fiat on-ramp** (crypto-only funding is a mainstream conversion barrier)? Determines whether I spin up a Plaid ADR now.
- [ ] 🧭 **Launch audience** — mainstream vs crypto-native (upstream of the Plaid call and the whole sequence).
- [ ] 🧭 **Money/auth go-ahead** — OK to start drafting §T1-B / §T1-H items as review-ready PRs (I open, you review, never self-merge)?
- [ ] 🔑 **Creds** — CTX_TOKEN + read-only supplier keys → I finish merchant data end-to-end.
- [ ] 🧭 **Cashback flip** — target date for `LOOP_PHASE_1_ONLY=false` (T2 go-live) relative to T1.

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
