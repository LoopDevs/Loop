# Cold Audit 2026-06-30 — Plan

## Why a new audit, 15 days after the last one

`docs/audit-2026-06-15-cold/` (baseline commit `04c3fae0`) found 5 P0 + 31 P1 +
~110 P2 + ~120 P3 findings. 22 PRs have landed since (`04c3fae0..56926e74`,
214 files, +10,884/-1,615 lines) closing nearly every Tranche-1 finding:
CF-02,03,06,07,08,09,10,12,13,15,16,18,19,20,21,22,23,24,25,26,27,28,29,
30,31,33,34,35,36. Only four remain, all explicitly gated/branch-only
(not live on `main` in default Phase-1 config):

- **CF-01** (burn never wired — `fix/adr036-emission-burn` branch)
- **CF-05** (interest mint unbacked-asset bug — `feat/wallet-phase-d-interest` branch)
- **CF-17** (drift-watcher equation gap — depends on CF-01)
- **CF-32** (Privy wallet branch blockers — blocked on Privy Soroban DD)

That remediation wave is itself **fresh, fast-shipped, security/money/auth-
sensitive code that has never been independently audited** — exactly the
profile most likely to carry new regressions. A cold audit now is the right
call, not redundant.

## Principles (inherited from `docs/audit-2026-04-29/plan.md`, restated)

- **Cold**: no trust in earlier audit conclusions, including this repo's own
  06-15 audit. Every finding here is independently re-derived from current
  code, not copied forward. Prior raw reports may be consulted only _after_
  forming an independent view, to check whether known P2/P3 tail items still
  apply.
- **Comprehensive**: every tracked file gets a disposition.
- **Granular**: findings cite concrete file:line evidence.
- **Adversarial**: probe abuse cases, not just happy paths.
- **Not checklist-bound** (new this round — see
  `feedback_audit_independent_thinking` operator guidance): the inherited
  checklist (`checklist.md` Parts 1-5, carried over near-verbatim from the
  06-15 audit because it is genuinely comprehensive and proven) is a **floor**,
  not a ceiling. `checklist.md` Part 6 adds dimensions the prior two audits
  plausibly under-covered — per-machine rate-limit math on multi-machine Fly
  deploys, AI-tooling supply-chain/prompt-injection risk in
  `tools/ctx-catalog`, third-party Soroban/DeFindex contract risk, dangling
  DNS, email deliverability, CSP, WCAG 2.2 (not just 2.1), Actions pinning,
  JWT key entropy, npm dependency-confusion exposure, and more. Every
  vertical/sweep agent is briefed to actively hunt beyond both Part 1-5 and
  Part 6 — those are a starting point, not the limit of what may be reported.
  When proposing fixes, propose the best current-practice solution, not just
  the smallest patch that closes the hole.

## Scope

In scope: `apps/backend/**`, `apps/web/**`, `apps/mobile/**`,
`packages/shared/**`, `tools/ctx-catalog/**`, `.github/**`, `docs/**`,
`scripts/**`, root configs/policy files, all 38 migrations, all 35 ADRs.

Out of scope: CTX internals, Stellar consensus/Horizon internals, Fly.io
platform internals beyond our own config, DeFindex contract source (not in
this repo) — but its _integration risk_ from our side is in scope.

Branch-only code (wallet phases A-D, ADR-036 burn, staff roles) is inspected
read-only via `git show`/`git log --all` where it bears on a live finding
(CF-01/05/32 reconciliation), but is not subject to full file-by-file
coverage — it isn't merged, so it isn't live risk yet.

## Baseline

- HEAD at audit start: `56926e74` (2026-06-30)
- Prior audit baseline: `04c3fae0` (2026-06-15)
- Delta: 22 commits, 214 files, +10,884/-1,615 — see `delta-manifest.md`

## Execution waves

1. **Wave 1 — vertical deep-dives** (17 verticals, file-by-file, fresh read +
   regression focus on delta files within scope)
2. **Wave 2 — cross-cutting tree-wide sweeps** (security, correctness smells,
   concurrency/financial, quality/dead-code, privacy, infra/CI/deps, docs,
   tests, flows+completeness, performance, a11y/i18n, fresh-eyes/Part-6)
3. **Phase 3 — ADR-by-ADR reconciliation** (001-037, all statuses re-verified)
4. **Phase 4 — synthesis**: dedupe, severity-rank, tag LIVE/GATED/BRANCH/
   LAUNCH-GATE, write `findings.md` + `remediation-plan.md`
5. **Phase 5 — adversarial verification**: skeptic pass on every P0/P1 before
   it's canonical
6. **Phase 6 — completeness/negative-space pass**: missing tests, runbooks,
   OpenAPI registrations, orphans, half-built features; final watertight
   check against the completeness gates below; executive summary

## Completeness gates (audit isn't done until all hold)

- Every in-scope tracked file has a disposition (read + checked or
  explicitly excluded with a reason)
- Every vertical and sweep has a raw report with a file-coverage count
- Every ADR (001-037) has a reconciliation line
- Every public and authenticated route is mapped to a vertical owner
- Every admin write path has explicit authz/idempotency/audit review
- Every money-moving path has invariant + concurrency review
- Every one of the 22 delta-wave PRs has its CF-fix re-verified closed
- At least one full adversarial-skeptic pass ran on P0/P1 findings before
  they're reported as canonical
- A dedicated negative-space pass ran (not just affirmative checklist ticks)
- Findings include fixes that meet current best practice, not just patches
