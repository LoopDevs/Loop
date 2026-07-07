# Loop — Go-Live Plan (master task list)

> **The single top-level view of everything needed to launch and grow.** Organized
> by launch phase, ownership-tagged, checkbox-tracked. This is the roadmap-level
> index; the two detailed trackers hold per-item detail:
>
> - [`readiness-backlog-2026-07-03.md`](./readiness-backlog-2026-07-03.md) — full **Why / Do / Done-when** for every `Txx`/`Rxx`/`Sxx`/`Axx`/`Qxx`/`Lxx`/`Mxx`/`Bxx`/`Uxx` ID.
> - [`money-auth-worklist.md`](./money-auth-worklist.md) — the money/auth items sequenced by risk.
>
> Tick here for the roadmap; tick the backlog for item state. Snapshot: **2026-07-07.**

## Legend — ownership

| Tag | Meaning                                                                    |
| --- | -------------------------------------------------------------------------- |
| 🔑  | Needs your **creds / secrets** (agent blocked without them)                |
| 👤  | **Operator / legal / vendor** — only you can do it                         |
| 💰  | **Money-review** — agent drafts a review-ready PR, you review before merge |
| 🔐  | **Auth-review** — same, auth path                                          |
| 🟢  | **Safe self-merge** — agent can do end-to-end                              |
| 🧭  | **Decision needed** from you                                               |

---

# 1 · GO-LIVE BLOCKERS (must ship before public launch)

## 1a · Merchant data 🔑 — _built + hardened this session; needs creds to finish_

- [ ] **T0-2 · Apply the recovered merchant catalog.** 🔑 CTX_TOKEN → apply 1,150 logos + info (content coverage 3.2% → ~33%). Closes "brand images not rendering on beta". Pipeline is built + self-tested + CI-guarded; work-lists documented in [`tools/ctx-catalog/PIPELINE.md`](../tools/ctx-catalog/PIPELINE.md).
- [ ] **Supplier ingestion.** 🔑 Read-only Tillo/SVS/EzPin creds → ingest ground-truth to fix wrong-brand/wrong-URL + push coverage toward 100% (adapters are the only unbuilt pipeline stage).
- [ ] **Clear the audit work-lists** (117 bad-source logos, ~155 missing terms, wrong domains CVS/Foot Locker/Hulu/Sam's Club). Runs automatically once the above creds land.

## 1b · Money correctness 💰 / 🔐 — _see [`money-auth-worklist.md`](./money-auth-worklist.md) Phases 0–2_

- [ ] **AUDIT-1 · Verify the GBPLOOP unbacked-mint P0 landed** (read-only findings first). 💰
- [ ] **T0-1b** dup deposit vs paid order · **R3-2** wrong-asset refund · **R3-9** process-local redeem fence · **R3-10** idempotency default-on · **R3-5** pay-CTX upper-band · **T0-1c** sub-dust deposits. 💰
- [ ] **R3-12** step-up CTX fail-open · **R3-7** pin native auth · **R3-8** step-up OTP lockout · **R3-13** WebView postMessage origin-check. 🔐
- [ ] **T0-3 · Money-invariant DB layer as a required merge check.** 💰 + 👤

## 1c · Operator / legal / vendor 👤 — _longest lead; start now, in parallel_

- [ ] **L1-1 · Sanctions / OFAC / geo-eligibility screening** (vendor + code). 👤
- [ ] **L1-2 · Terms of Service + age-gate capture** (legal + code). 👤
- [ ] **L1-3 · Legal review of `/privacy` + `/terms` + provision mailboxes.** 👤
- [ ] **L1-9 · Apex DNS `loopfinance.io` / `www` → web.** 👤
- [ ] **L1-10 · Set Sentry DSNs** (backend secret + web build-arg). 👤
- [ ] **L1-11 · Verify prod secret set before next deploy** (`scripts/preflight-tranche-1.sh`; `LOOP_ADMIN_STEP_UP_SIGNING_KEY` is now a prod boot requirement). 👤

## 1d · Mobile release 👤 + code — _store + device work_

- [ ] **L1-4 · Apple Developer enrollment → TestFlight.** 👤
- [ ] **L1-5 · Android release keystore + offline-escrow procedure.** 👤
- [ ] **L1-6 · Google Play Console setup.** 👤
- [ ] **L1-7 · App Store + Play screenshots & metadata + submit** (metadata drafted in `docs/app-store-connect-metadata.md`). 👤
- [ ] **L1-8 · Demo video** (script at `docs/phase-1-demo-script.md`). 👤
- [ ] **M-1 · Device / simulator testing** (headline mobile risk). 👤 + 🟢
- [ ] **M-2 · Push notifications: wire or remove** (no dead channels). 🟢
- [ ] **M-3 · Deep linking** (entirely absent — `https://loopfinance.io/...` should open the app). 🟢
- [ ] **M-4 · CI guard for operator-once native-overlay steps** (fail loudly if a regen drops an overlay). 🟢
- [ ] **M-5 · `@capacitor/app` lifecycle handling** (foreground/background). 🟢

## 1e · Launch-blocker code

- [ ] **C2-1 · Redemption-null re-validation.** 💰 (relates to the Phase-1 redemption-fetch follow-up)
- [ ] **C2-2 · Apple Sign-In native rework (CF-27).** 🧭 operator decision → 🔐

## 1f · Product polish

- [ ] **U-1 · Full customer-journey UX / visual pass** (in progress — T0-2 brand imagery was the first finding). 🟢

---

# 2 · BEFORE REAL-MONEY VOLUME (immediately after / concurrent with launch)

## 2a · Reliability on the money path 💰 — _[worklist](./money-auth-worklist.md) Phase 1 tail_

- [ ] **R3-1** operator float reconciliation · **R3-3** warm-start catalog from Postgres (🟢 non-money-ledger) · **R3-4** auto-refund on redemption-null exhaustion (+ policy) · **R3-6** page drift channel on contract drift · **R3-11** note/accelerate legacy-order-path ownership gap.

## 2b · Scale / fleet-safety 💰 (mostly)

- [x] **S4-7 · Trim the client-side catalog fetch** ✅ (`?fields=lite` + debounced search — done this session).
- [ ] **S4-1** Stellar payout throughput ceiling (architectural, L) · **S4-2** wallet-provisioning fleet-lock · **S4-3** single-flight interest-mint reads · **S4-4** rate-limiter shared store 🟢 · **S4-5** raise DB pool / plan PgBouncer 👤+🟢 · **S4-6** bound admin ledger-drift scan · **S4-8** dedupe per-machine watchers/alerts 🟢.

## 2c · Admin / support money tooling 💰

- [ ] **A5-1** order re-drive lever (biggest hole) · **A5-4** order-bound refund UI + policy · **A5-6** stuck-orders/payouts visibility · **A5-7** per-subject audit view · **A5-8** fleet-wide ledger browser · **A5-9** bulk actions + drift-correction · **A5-2** session-revocation UI 🔐 · **A5-3** login/OTP support tooling 🔐 · **A5-5** operator-mediated DSR (privacy).

## 2d · Test & E2E coverage 💰 (safe, additive)

- [ ] **Q6-1** ctx-settlements test · **Q6-2** money/auth worker coverage · **Q6-3** web money-write client tests · **Q6-4** loop-native purchase E2E · **Q6-5** admin/support UI E2E smoke · **Q6-6** wallet-spend + interest-mint coverage · **Q6-7** promote real-chain run off manual · **Q6-8** ratchet web coverage floors.

## 2e · Fraud / abuse controls

- [ ] **B-3 · User-level fraud/abuse controls** (velocity limits, dup-account detection, chargeback handling — absent). 💰 + design/ADR.

---

# 3 · HARDENING / BLIND-SPOTS (before real growth)

- [ ] **B-1 · Load / stress / soak testing** (absent). 🟢
- [ ] **B-2 · Accessibility** (EU legal exposure). 🟢 — _partial: a11y-contract tests added this session; needs a full audit._
- [ ] **B-4 · DR: PITR + offsite backup.** 👤 + 🟢
- [ ] **B-5 · Observability depth.** 🟢 + 👤
- [ ] **B-6 · i18n** (English-only behind a good scaffold — `SUPPORTED_LANGS=['en']`, hardcoded copy, no RTL). 🟢 (large)

---

# 4 · STRATEGIC / PHASE 2 (post-launch direction)

- [ ] **Plaid — fiat funding rail.** 🧭 **Decision needed: launch blocker or Phase 2?** Greenfield today; the only current funding rail is crypto (XLM/USDC vs a Stellar deposit address, ADR 015), a hard conversion barrier for mainstream users. A bank-link/ACH rail likely raises money-transmitter/KYC questions → **needs an ADR before code.** See the go-live conversation for the full framing.
- [ ] **Wallet Phase 2** (ADR 030 Privy embedded wallet + ADR 031 per-currency yield). Gated behind `LOOP_PHASE_1_ONLY`. The cashback/wallet surface — built through Phase D this session, flip-on is a launch-timing call.
- [ ] **ADR 040 · Cloudflare edge** (proposed) — real geo fix (`CF-IPCountry`) + EU latency + WAF/DDoS. Load-bearing gotcha recorded: lock the origin to Cloudflare first or geo + rate-limits become spoofable.
- [ ] **Media pipeline v2 tail** — directory virtualization + server-side search (S4-7 part 3, deferred); the supplier-pull adapters (1a) are the main remaining build.

---

# 5 · Decisions I need from you

- [ ] 🧭 **Plaid:** launch blocker (mainstream fiat funding) or Phase 2? Determines whether I spin up a Plaid ADR now.
- [ ] 🧭 **Money/auth go-ahead:** OK to start drafting the [worklist](./money-auth-worklist.md) items as review-ready PRs (I open, you review, I never self-merge)?
- [ ] 🔑 **Creds:** CTX_TOKEN + read-only supplier keys → I finish merchant data end-to-end.
- [ ] 🧭 **Launch audience** (mainstream vs crypto-native) — this is upstream of the Plaid decision and the whole sequence.

---

## Suggested critical path

```
NOW (parallel):
  ├─ You:   L1 operator/legal + mobile enrollment (longest lead) ── 1c, 1d
  ├─ You:   creds → agent finishes merchant data ───────────────── 1a
  └─ Agent: Phase 0 de-risk (verify P0 + characterization tests) ─ 1b Phase 0
THEN:
  └─ Agent (review-first): money correctness + auth ───────────── 1b Phase 1–2
  └─ C2-1 / C2-2 launch-blocker code ──────────────────────────── 1e
BEFORE VOLUME:
  └─ Reliability + scale + admin tooling + coverage ───────────── §2
DECISION GATE:
  └─ Plaid launch-blocker? → if yes, ADR + build slots into §1 ── §4
```

**Cross-references:** [`readiness-backlog`](./readiness-backlog-2026-07-03.md) · [`money-auth-worklist`](./money-auth-worklist.md) · [`invariants`](./invariants.md) · [`threat-model`](./threat-model.md) · [`roadmap`](./roadmap.md) · [`adr/`](./adr/).
