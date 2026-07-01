# Cold Audit 2026-06-30 — Executive Summary

Full detail: `findings.md` (122 findings), `remediation-plan.md` (sequenced
fixes), `coverage-matrix.md` (ADR-by-ADR), `tracker.md` (coverage proof).

## What this audit is

15 days after `docs/audit-2026-06-15-cold/` (5 P0 + 31 P1 + ~230 P2/P3), 22
PRs landed claiming to close nearly every Tranche-1 finding. That
remediation wave — fast-shipped, security/money/auth-sensitive, touching
214 files — had never been independently audited. This round re-audited the
**entire codebase cold** (not trusting either prior audit's conclusions),
with the unaudited delta getting extra adversarial scrutiny, and was
explicitly briefed to extend past both prior audits' checklists rather than
just re-run them (see `checklist.md` Part 6).

Method: 20 parallel vertical deep-dives (file-by-file) + 5 cross-cutting
tree-wide sweeps + full ADR reconciliation + a synthesis pass that
deduplicated ~330 raw findings into 122 unique ones + an adversarial
skeptic pass on the highest-stakes findings, which corrected 2 of the 12
it checked (one demoted after a real backstop was found, one strengthened
after a false refutation was caught).

## The single most important number

**18 of the prior round's ~30 claimed-closed findings did not fully close.**
Two are genuine regressions:

- **CF-04**: the required "Security audit" CI gate is **red on `main` right
  now** — confirmed via a live `npm run audit` run — blocking every PR,
  including the 19 Dependabot PRs that would fix it.
- **CF-13 → CF2-01**: the fix that made the operator circuit-breaker open
  faster (on a single 401, not 5 consecutive failures) inadvertently made a
  pre-existing "breaker never recovers" bug far easier to trigger — two bad
  CTX responses can now brick the entire purchase flow with no automatic
  recovery, invisible to `/health`.

The other 16 are partial closures — the fix addressed the named case but
missed siblings (CF-23's bigint-money rendering fix, independently found
incomplete by 5 different audit agents across 6+ files; CF-31's catalog
country-scoping fix patched one route, not the underlying API contract).

This is the headline lesson of the round: **a fast remediation wave under
pressure reliably under-closes and occasionally regresses**, even when each
individual PR is well-reviewed in isolation — the gaps live at the
boundaries between PRs and in siblings nobody re-checked.

## P0s (6) — all independently re-verified by a skeptic, not just reported

1. **Operator circuit breaker can never self-heal** (LIVE) — one bad CTX
   response can permanently strand an operator, two can brick the 2-operator
   pool, with no auto-recovery.
2. **Security-audit CI gate is red** (LIVE/operational) — blocks all merges.
3. **Redemption never burns inbound LOOP-asset tokens** — re-verified to be
   **more exposed than originally tagged**: not safely dormant behind a
   flag, reachable today by any direct API caller in a deployment with
   cashback issuance active.
4. **Wallet branch mints unbacked LOOPUSD/LOOPEUR** (branch-only, do not
   merge as-is).
5. **Zero terms-of-service/age-gate capture at signup** (launch-gate).
6. **Zero sanctions/OFAC/geo-eligibility screening** anywhere (launch-gate,
   more urgent now given the new AE/IN/SA order markets).

## What's genuinely solid

The discount-mode (Tranche-1) financial core — order state machine, ledger
double-entry, payment idempotency, the bulk of admin authz — held up well
under adversarial review. Several "P0/P1" defects from the prior round are
confirmed fully closed (CF-06/07/08/16/18/19/21/25/30), and three ADRs
(017, 027, 035) genuinely closed their gaps this round. Supply-chain posture
is strong: GitHub Actions are 100% SHA-pinned, SBOM/cosign signing works,
CSP is present, full git-history secrets sweep came back clean, and the
144-route inventory cross-checked clean against the OpenAPI-parity gate.

## Launch-readiness verdict

**Not honestly "Tranche-1 ready" as currently documented.** `roadmap.md`
and `tranche-1-launch.md` don't reflect the live P0/P1s in the critical
purchase path (operator-breaker fragility, pre-payment procurement failures
going unrefunded and unalerted, no sanity bound on price feeds). Separately,
`tranche-2-scoping.md` claims the Privy wallet work "not yet started" when
it's actually fully built across 6 branches, frozen 18 days, carrying 2 P0s
of its own.

**Recommended sequencing** (full detail + dependency graph in
`remediation-plan.md`): land the CI-gate fix alone first (nothing else can
merge until then), then the CTX/operator-pool resilience fix (highest blast
radius — bricks the whole purchase flow), then payout-worker and orders
resilience, then the admin-safety/DSR/privacy cluster (the daily-withdrawal-
cap fix must land before the DSR-auto-withdraw fix, to avoid a new drain
vector). The two LAUNCH-GATE legal items (terms/age-gate, sanctions
screening) should start now in parallel — they have long lead times and
don't block any code wave.

## What to do differently next time

- Re-run a cold audit after the **next** remediation wave too — this
  round's own pattern (claimed-closed ≠ actually-closed at a ~60% true-
  closure rate) is itself evidence this isn't a one-off, and the next
  wave's PRs are exactly the kind of fast, pressured, money/security-
  adjacent work this round showed is highest-risk.
- The adversarial-skeptic pass only covered 12 of 122 findings (all P0s +
  the highest-stakes P1s) — budget for a wider skeptic pass next time,
  especially on the ~33 unverified P1s, which are currently single-source.
- Watch for the specific failure mode this round's own skeptic process hit
  once: a "refutation" that leans on the implementation's own comments/
  self-description rather than independent reasoning (the CF-27 near-miss,
  where trusting a code comment claiming compatibility led to a wrong
  REFUTED verdict that a focused re-investigation reversed). Skeptics should
  be explicitly told not to take an implementation's self-assessment as
  evidence.
