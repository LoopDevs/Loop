# Cold Audit 2026-06-30 — Items requiring your involvement

This is the consolidated list of remediation-plan items that cannot be
closed autonomously — each one needs a decision, an external account/vendor
relationship, or content only you (or legal) can supply. Everything else in
`remediation-plan.md` that could be done without your involvement has been
implemented, tested, and merged (see "Autonomous work completed" at the
bottom for the full PR list). This doc is the "we will address those items
after you've addressed everything you can do" list from our 2026-07-01
conversation.

Nothing below is blocking CI or the merged work — these are independent
tracks you can pick up whenever.

---

## 1. Apple Sign-In native rework (CF-27 reopen) — needs an architecture decision

**What's broken:** Apple Sign-In is dead on native (iOS/Android) devices.
Root cause: Apple Service ID "Return URLs" require a verified,
internet-routable HTTPS domain. The native shell's
`redirectURI: window.location.origin` evaluates to
`capacitor://localhost` / `https://localhost`, which Apple can never
register or validate — the OAuth flow fails server-side before the app's
own popup-handling code even runs.

**Decision needed — pick one:**

- **(a) Backend-hosted callback** (likely less work): add a real HTTPS
  endpoint (e.g. `https://api.loopfinance.io/auth/apple/callback`)
  registered as the Apple Return URL. The native app opens the Apple auth
  flow via `@capgo/inappbrowser` (already installed — the redemption flow
  uses it for the identical native-WebView problem) pointed at that backend
  URL, and the backend bridges the redirect back into the app via a
  universal link / custom URL scheme once Apple completes the handshake.
  No new Capacitor dependency.
- **(b) Dedicated native plugin** (e.g. `@capacitor-community/apple-sign-in`)
  that drives the native `ASAuthorizationController` flow directly,
  bypassing the web SDK. New dependency → needs an ADR per repo policy
  (`AGENTS.md` "What NOT to do": a new dependency requires an ADR before
  `npm install`).

Once you pick a direction, I can implement it — this needs your call before
any code gets written, not just a review after the fact.

---

## 2. Launch-gate legal/product track

Two items block **public launch**, not CI — they can run in parallel with
everything else on their own timeline.

- **CF2-02 — Terms acceptance + age-gate UI.** The `termsAcceptedAt` schema
  column + UI wiring is mechanical; what's missing is the actual **legal
  copy** (terms of service text, age-gate language, jurisdiction-specific
  variants). I can build the feature the moment you (or your lawyer) have
  copy to put in it.
- **CF2-03 — Sanctions/OFAC/geo-eligibility screening.** Needs a
  **vendor/provider decision** — this is normally a third-party screening
  API (e.g. ComplyAdvantage, Chainalysis KYT, Trulioo), not something to
  hand-roll in-house. More urgent than the prior (06-15) audit rated it,
  given ADR-035's new AE/IN/SA extended markets. I can wire whichever
  vendor you choose once you've picked one and have API credentials.

---

## 3. Tranche-2 / cashback-mode track — gated on Privy due-diligence + a product decision

This is the wallet/cashback-mode work (ADR-030/031). Per those ADRs it's
**deliberately** "Proposed, no implementation until DD" — I'm not
overriding that gate. Four items, in dependency order:

1. **W-05** — rebase the 6 wallet branches + `fix/adr036-emission-burn`
   onto `main` post the concurrency hardening (CF-14/18) that's now merged
   — they currently predate that model.
2. **CF-05** — after rebase, fix `interest-mint.ts` to mint only GBPLOOP
   on-chain per ADR-031 v7 (retire the `USDLOOP`/`EURLOOP` mint codes).
3. **CF-32 cluster** — Privy `privy-authorization-signature` header
   (P-256 auth key/env), the Privy webhook handler, the APY-labeled-as-APR
   web copy fix + missing disclaimer, gate `WalletCard` behind
   `LOOP_PHASE_1_ONLY`. **Blocked on Privy Soroban due-diligence** — external
   to Loop's timeline, not something I can move forward.
4. **CF-01** — merge the burn fix from `fix/adr036-emission-burn`; verify it
   closes CF-17's drift-equation gap; resolve the deposit==operator
   co-location question (split accounts, or confirm the burn fix makes
   co-location safe) **before flipping any cashback-mode flag in
   production**.

   **⚠️ Live-risk note carried over from the audit:** this is not safely
   dormant behind a flag today. `loop_asset` is a fully-wired, unflagged
   payment method — only a client-side UI hardcode currently stops a direct
   API caller from triggering it. If any deployed environment has
   `LOOP_WORKERS_ENABLED=true` with real LOOP-asset balances already in
   circulation, treat this as immediately actionable rather than
   "whenever Tranche-2 starts" — worth a quick gut-check on your end even
   before the Privy DD lands.

---

## 4. Infra/DNS items needing account access I don't have

- **PLAT-30-08** — the Fly app name you planned to use for the web
  deploy (`loop-web`) is already squatted by an unrelated app on Fly.io.
  Needs you to pick a different app name (or investigate reclaiming the
  existing one) before the first `loop-web` deploy.
- **PLAT-30-09** — the OTP-sending domain has no SPF record and DMARC is
  `p=none`. Needs DNS changes at your registrar/DNS provider — I don't have
  access and wouldn't want to touch production DNS without you present
  regardless. Recommended: add an SPF record covering your email provider
  (Resend) and move DMARC to at least `p=quarantine` once SPF/DKIM are
  confirmed passing, to reduce OTP emails landing in spam / being spoofed.

---

## 5. Judgment calls I made autonomously that you may want to revisit

Not blocking, but flagging since they involved a design choice rather than
a mechanical fix:

- **ADMIN-02 (PII bulk-read tripwire)** — I shipped the remediation plan's
  documented **stopgap** (a per-path bulk-read threshold override for
  `admin/users/search`, pinned below its own 20-row cap). The plan's "real
  fix" — a cross-machine per-actor rolling-window row-count accumulator so
  the tripwire catches cumulative exfiltration regardless of any single
  endpoint's page size — is a genuine infra feature, not a decision I need
  your input on to build. I can pick this up as part of the Wave 9
  multi-machine shared-state work below if you'd like it prioritized.
- **PLAT-30-03 (DSR self-delete balance orphan)** — I shipped the
  **minimal** fix only (block self-delete with `BALANCE_NOT_ZERO` when the
  user has an outstanding balance). The plan's "better fix" is a genuine
  product decision: either require the user to spend/withdraw the balance
  first (current behavior) or build a real "re-link on re-signup" recovery
  path. I defaulted to the safer, already-shipped minimal fix rather than
  guessing which product direction you want; happy to build the recovery
  path if you decide that's the right UX.

---

## Autonomous work completed this session (for reference)

All of these are merged to `main`, tests included, `./scripts/verify.sh`
green on each:

- **Wave 0** — CF-04 audit-policy CI gate unblocked (hono bump + accepted-
  vuln allowlist), weekly audit-cron job added.
- **Wave 1** (8 disjoint PRs) — step-up-handler test coverage (CF-11
  reopen), OTP attempts-counter row-targeting fix (AUTH-01 reopen), web
  focus-trap selector fix (WUI-01), disaster-recovery runbook dead-var fix
  (CF-33 reopen), demo-seed destructive-op row-count backstop, proxy-URL
  log redaction, signing-key entropy validation (CF2-17), admin daily
  withdrawal cap (ADM-01).
- **Wave 2** — circuit-breaker self-heal (CF2-01), CTX Retry-After
  enforcement (CTX-02).
- **Wave 3** — payout-worker ambiguous-retry-exhaustion re-check before
  auto-compensating (CF2-07).
- **Wave 4** — procureOne transient-failure revert-and-retry (CF2-04),
  pre-pay-ctx auto-refund widening (CF2-05), price-feed sanity bounds
  (CF2-06).
- **Wave 5** — merchant-stats currency-grouping fix (ADMIN-01), bulk-read
  tripwire stopgap (ADMIN-02), supplier-spend CSV currency filter
  (PLAT-30-16), interest-mint-forecast fail-closed fix (PLAT-30-17).
- **Wave 6** — DSR self-delete balance precondition (PLAT-30-03, minimal
  fix), native DSR export via share sheet (W30-02), Sentry breadcrumb
  scrubbing parity (CF2-09).
- **Wave 7** — `?country=` scoping on both public catalog endpoints plus
  all three frontend catalog routes (CAT-02), brand-slug case-insensitivity
  (CAT-03).
- **Wave 8** — bigint money-formatting consolidation across 8 files
  (CF-23 reopen, incl. the admin treasury solvency figure), crash-guard on
  4 unguarded `BigInt()` parse sites (F-WEBADMIN-03), Phase-1 gating on
  `EarnedCashbackCard`/`OrderPayoutCard` (WUM-05/CF2-08).

**Still in progress / queued next** (autonomous, no operator input needed):
Wave 9 (multi-machine shared-state — rate-limiter/circuit-breaker/cache
per-machine drift, CF2-10 cluster), Wave 10 (operator-tooling fixes,
TOOL-01/02), and the P2/P3 quality tail (~80 findings — doc-index gaps,
OpenAPI contract-drift cleanup, test-vacuity fixes, shared-package DRY
cleanup).
