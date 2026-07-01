# Cold Audit 2026-06-30 — Checklist

Parts 1-5 (universal dimensions, Loop-specific verticals, cross-vertical
interaction matrix, ADR coverage method, file-coverage method) are
**inherited near-verbatim** from `docs/audit-2026-06-15-cold/checklist.md` —
re-read that file in full before starting. It is genuinely comprehensive and
proven across two prior audits; there is no value in retyping it. Treat it as
**the floor**.

Updates to that inherited structure for this round:

- **Surface inventory** (current, 2026-06-30): backend 593 `.ts`, web 419
  `.ts/.tsx`, shared 38 `.ts`, migrations 38 `.sql` (was 35 — 0035/0036/0037
  added), CI workflows 5, ADRs 35, docs 295 `.md` (was 258), runbooks 28
  (was 24 — deposit-skip-recorded/dsr/interest-pool-low/peg-break-on-
  fulfillment added), `tools/ctx-catalog` 67 files, test files 378.
- **V18 (CSV/exports)** is now its own module — `apps/backend/src/csv/`
  (new, extracted from `admin/csv-escape.ts` per CF-26) — give it the same
  rigor as any vertical (RFC 4180 + formula-injection guard correctness).
- **V5 (Wallet/Privy)** branches have moved since 06-15; re-enumerate via
  `git branch -a` / `git log --all` rather than trusting the prior branch
  list.
- ADR 036 (cashback lifecycle) and ADR 037 (staff roles) still have **no ADR
  file on `main`** as of this audit — confirm that's still true; if a file
  now exists, audit it as a normal ADR.

**Part 6 below is new** — dimensions this audit independently adds because a
more capable/recent model should find more than the prior two passes did.
Do not treat Part 6 as exhaustive either: every agent on this audit is
explicitly briefed to look past both Part 1-5 and Part 6, not just tick
boxes. Propose the best current-practice fix when reporting a finding, not
just the smallest patch.

---

## PART 6 — 2026 fresh-eyes additions (not in the 06-15 or 04-29 audits)

### 33. Multi-machine / distributed-state correctness (beyond CF-14's fix)

- [ ] Every in-process rate limiter, breaker, cache, or dedup structure
      (`rateLimit`, circuit breakers, LRU caches, idempotency-key dedup maps)
      — is its state per-Fly-machine or shared? If per-machine, does N
      machines effectively multiply the configured limit by N? Quantify for
      every limiter in `middleware/rate-limit.ts` and friends.
- [ ] Now that CF-14 added `FOR UPDATE SKIP LOCKED` to the payout worker,
      re-derive: are there _other_ in-process workers/schedulers
      (merchant-sync, location-sync, interest-scheduler, auth-row-purge,
      drift-watcher, redemption-backfill) that still assume single-instance
      execution and would double-run or race across machines?
- [ ] Sticky-session assumptions anywhere (e.g. in-memory OTP throttling)
      that break once `min_machines_running` > 1.

### 34. AI/LLM tooling supply-chain & indirect prompt injection

- [ ] `tools/ctx-catalog/**` scripts that feed scraped/upstream content
      (merchant descriptions, web-search results, supplier `website_url`
      pages, vision-QC image analysis) into an LLM agent that has **write
      access to production CTX** (per `project_ctx_media_pipeline` memory:
      ctx-apply, ctx-create, source-images-tavily) — can adversarial content
      embedded in a merchant's public web page or supplier feed manipulate
      agent output (indirect prompt injection) to write malicious copy,
      wrong prices, malicious URLs, or XSS payloads into the live catalog?
      Is the human-review gate (localhost:7654) actually in the critical
      path for every write, or can any script bypass it?
- [ ] API keys for any LLM/search provider used by operator tooling — scope,
      rotation, rate-limit/cost ceiling, and whether they're reachable from
      anything internet-facing.
- [ ] ADR-025 (LLM PR review) — what repo content is sent to Anthropic on
      every PR; could a malicious PR description/diff prompt-inject the
      reviewer into approving something it shouldn't, or exfiltrating repo
      secrets into review comments?
- [ ] Runaway-cost guard on any per-PR/per-request LLM call (cost ceiling,
      timeout, max-tokens).

### 35. Third-party financial contract / protocol risk

- [ ] DeFindex vault (ADR 031) — even though the contract isn't in this
      repo, what's our integration-side blast radius if the vault is
      paused/exploited/depegs? Is there a circuit breaker on our side
      (withdrawal halt, max-exposure cap) independent of the vault's own
      safety?
- [ ] Price-feed FX source (`payments/price-feed-fx.ts`) — sanity bounds on
      rate jumps (a feed glitch or compromise shouldn't let an order clear
      at a 100x-wrong rate); staleness check before use; fallback behavior
      if the feed is down mid-order.
- [ ] Stellar claimable balances / path payments / account-merge operations
      — could any inbound payment to the deposit account arrive via a path
      that bypasses the watcher's expected payment-operation shape?

### 36. Network/DNS/email perimeter

- [ ] Dangling DNS / subdomain takeover: enumerate every historical host
      (apex/www on GitHub Pages, `beta.loopfinance.io` on Fly,
      `loopfinance-web` vs the not-yet-created `loop-web` Fly app per
      memory, any old Vercel/staging hosts referenced in docs) and check for
      orphaned CNAME/A records pointing at deprovisioned services.
- [ ] Email deliverability/spoofing: SPF/DKIM/DMARC posture for
      `loopfinance.io` (Resend sending domain) — missing records make OTP
      mail spoofable and hurt inbox placement, which is a real account-
      takeover-adjacent and support-load risk.
- [ ] CSP header — does one exist anywhere (web app, RedeemFlow WebView)?
      Given CF-02 already hardened script execution there, a CSP is the
      correct defense-in-depth layer on top, not a substitute.
- [ ] GitHub Actions: every third-party `uses:` pinned by commit SHA, not a
      mutable tag (`@v4` etc.) — tag-mutation supply-chain compromise class
      (e.g. the 2025 tj-actions incident). Repo-managed-CLI policy (ADR 029)
      covers npm-side; check the Actions-marketplace side too.
- [ ] npm dependency-confusion: are `@loop/*` package names actually
      unpublishable/reserved on the public registry, or could someone
      publish a malicious `@loop/shared` that a misconfigured install
      resolves to instead of the workspace-local one?

### 37. Auth UX / modern accessible-authentication

- [ ] OTP input: `autocomplete="one-time-code"`, numeric `inputmode`,
      paste-friendly (WCAG 2.2 SC 3.3.8 Accessible Authentication —
      no cognitive-function test without an alternative; OTP entry that
      blocks paste/autofill fails this).
- [ ] WCAG 2.2 deltas beyond 2.1 generally: 2.4.11 Focus Not Obscured
      (sticky headers/banners covering the focused element), 2.5.7 Dragging
      Movements (map/slider interactions need a non-drag alternative),
      3.3.7 Redundant Entry (don't make users re-enter data Loop already
      has in the same flow).
- [ ] JWT signing-key entropy — `env.ts` validates length (≥32 chars) but
      not entropy; a 32-char low-entropy or repeated-character key would
      pass validation and still be weak.

### 38. Fraud / abuse vectors specific to a gift-card cashback product

- [ ] Per-user / per-device / per-IP **velocity limits** on order creation
      beyond the flat per-route rate limit — gift cards are a classic
      money-laundering/stolen-payment cash-out vector; is there any spend-
      velocity or anomaly signal, or does the flat rate limit alone gate
      this?
- [ ] Multi-accounting for promo/cashback abuse — email-OTP-only signup
      with no device/IP correlation makes farming trivial once cashback
      mode is live; note as a Tranche-2 launch consideration even though
      cashback is gated today.
- [ ] Referral/promo-code abuse paths (if any exist in code or are planned
      per roadmap) — self-referral, code reuse, cap enforcement.

### 39. Mobile platform compliance currency

- [ ] iOS Privacy Manifest (`PrivacyInfo.xcprivacy` if present) — accurate
      declared data types/purposes and required-reason API usage vs what
      the app actually does (Apple enforces this at submission as of 2024+;
      an audit from before this requirement matured could have under-
      checked it).
- [ ] Android 14/15 permission model currency (foreground service types,
      notification permission, exact-alarm restrictions) if applicable.
- [ ] Google Play Data Safety form / App Store privacy "nutrition label"
      accuracy vs actual data collection (cross-check against
      `docs/log-policy.md` PII inventory).

### 40. Cost / FinOps guardrails

- [ ] Stellar fee-bump / retry loop cost ceiling — a stuck-payout retry
      storm could burn fees; is there a cap?
- [ ] CTX API, Sentry, Resend, MaxMind, LLM-provider usage — any quota/cost
      alerting before a runaway loop (bug, not just abuse) produces a
      surprise bill or service suspension that takes down the app
      mid-incident.

### 41. Better-fix bar

For every finding in this audit (not just Part 6), when proposing a
remediation: state the **minimal fix** (what would close the hole fastest)
and, where it differs, the **best current-practice fix** (e.g. "minimal:
raise the per-IP cap; better: move rate-limit state to a shared store so the
configured cap is accurate across N machines"). Both go in `findings.md` /
`remediation-plan.md` so the human reviewer can choose pace vs correctness.
