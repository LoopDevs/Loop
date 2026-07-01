# Cold Audit 2026-06-30 — Execution Tracker

Baseline HEAD: `56926e74`. See `plan.md` for principles/scope, `checklist.md`
for dimensions, `delta-manifest.md` for the unaudited 22-PR delta.

**Status: COMPLETE.** All 6 phases done. Final deliverables: `findings.md`
(122 unique findings), `remediation-plan.md` (dependency-sequenced),
`coverage-matrix.md` (35 ADRs reconciled), this tracker.

## Wave 1 — vertical deep-dives (20/20 done)

Original plan had 17 verticals; V7 (Admin) and V9 (Web UI) were each split
into 3 and 2 sub-verticals respectively given their size (112+ and 124+
files), bringing the actual count to 20.

| #   | Vertical                                         | Status | Raw report             | Files examined                     |
| --- | ------------------------------------------------ | ------ | ---------------------- | ---------------------------------- |
| V1  | Auth                                             | done   | raw/v-auth.md          | 46/46                              |
| V2  | Orders/procurement                               | done   | raw/v-orders.md        | 27 src + 19 test + 5 other         |
| V3  | Stellar/payments                                 | done   | raw/v-payments.md      | 21/21 + tests                      |
| V4  | Credits/ledger                                   | done   | raw/v-credits.md       | 16/16 + tests                      |
| V5  | Wallet/Privy (branch-only)                       | done   | raw/v-wallet.md        | 6 branches via git show            |
| V6  | Merchants/catalog                                | done   | raw/v-catalog.md       | full scope                         |
| V7a | Admin money-writes                               | done   | raw/v-admin-writes.md  | full scope                         |
| V7b | Admin reads/CSV/drills                           | done   | raw/v-admin-reads.md   | 90/90                              |
| V7c | Web admin panel UI                               | done   | raw/v-admin-web-ui.md  | 138/138                            |
| V8  | Web routes/locale/SSR                            | done   | raw/v-web-routes.md    | 40 routes + 49 services + i18n     |
| V9a | Web UI money/purchase                            | done   | raw/v-web-ui-money.md  | 26 src + 24 test                   |
| V9b | Web UI browse/discovery + hooks/stores/utils     | done   | raw/v-web-ui-browse.md | 76/76                              |
| V10 | Mobile/native                                    | done   | raw/v-mobile.md        | 67/67                              |
| V11 | CTX integration                                  | done   | raw/v-ctx.md           | full scope                         |
| V12 | Shared + type parity                             | done   | raw/v-shared.md        | 36/36                              |
| V13 | DB/schema/migrations                             | done   | raw/v-db.md            | 38/38 migrations + live PG repro   |
| V14 | Platform (mw/config/images/webhooks/openapi/csv) | done   | raw/v-platform.md      | 90/90 (incl. live flyctl/dig/curl) |
| V15 | Observability                                    | done   | raw/v-observability.md | 49/49 (incl. all 28 runbooks)      |
| V16 | Catalog operator tooling                         | done   | raw/v-tooling.md       | 32/32                              |
| V17 | Public API                                       | done   | raw/v-public.md        | full scope                         |

Plus an unsolicited but verified supplementary report from a peer Claude
session: `raw/x-tests-credits-vacuity-external.md` (test-vacuity sample of
`credits/__tests__`), folded into synthesis as PLAUSIBLE pending Phase 5.

## Wave 2 — cross-cutting sweeps (5/5 done)

Original plan enumerated 12 sweeps; consolidated to 5 broader ones since
correctness-smells, concurrency, code-quality, performance, and a11y/i18n
were already given explicit per-vertical coverage in every Wave-1 brief
(each vertical agent was instructed to check those dimensions within its
scope) — the 5 sweeps below cover the genuinely tree-wide-only ground no
single vertical could see.

| #            | Sweep                                                                                                                     | Status | Raw report                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- | ------ | --------------------------- |
| X-security   | Security — full 144-route inventory, authz/idempotency/rate-limit consistency, secrets sweep (gitleaks, full git history) | done   | raw/x-security.md           |
| X-privacy    | Privacy/compliance + Part-6 fraud-abuse vectors, DSR completeness                                                         | done   | raw/x-privacy.md            |
| X-infra      | Infra/CI/deps/supply-chain, Actions pinning, npm audit, dependency confusion                                              | done   | raw/x-infra.md              |
| X-flows      | 10 end-to-end cross-vertical flows + completeness/orphan/TODO sweep                                                       | done   | raw/x-flows-completeness.md |
| X-docs-tests | Docs/env-var parity, dead-links, AGENTS.md drift, test-vacuity sample (100 files)                                         | done   | raw/x-docs-tests.md         |

## Phase 3 — ADR reconciliation (done)

Output: `coverage-matrix.md`. 15/37 ADRs strictly clean, 27/37 functionally
covered (P3 cosmetic doc-drift only) under the 06-15 audit's looser bar, 8
with a real P0–P2 gap (004, 005, 007, 010, 024, 028, 030, 031), 2 with no
file on `main` (036, 037). Net since 06-15: ADR 017/027/035 confirmed
closed; 016/028 improved but still gapped; 007 upgraded in severity
(tracked-but-incompletely-executed remediation); new P2 found in ADR 010
(no on-chain refund path) and ADR 024 (stale compensation-policy text).
Tranche reconciliation included in the same file — verdict: Tranche-1 is
not honestly "ready" as currently documented.

## Phase 4 — synthesis (done)

Output: `findings.md` (122 unique findings from ~330 raw, deduplicated and
cross-referenced — 18 of the prior round's ~30 claimed-closed CF items found
still open/incomplete/regressed) and `remediation-plan.md` (dependency-
sequenced waves, not just severity-bucketed).

## Phase 5 — adversarial verification (done)

12 findings independently skeptic-checked (all 6 P0s, the CF-14 cross-agent
conflict, and the 5 highest-stakes P1s). 10 held up fully or were
strengthened; 2 corrected (CF-14 demoted P1→P3 after a real backstop was
found; CF-27 had a false-refutation caught and reversed via a tie-breaker
re-investigation). Full verdict table in `findings.md`'s "Adversarial
verification" section. Remaining ~33 P1s and all P2/P3s are PLAUSIBLE
(single-source) not CONFIRMED — flagged as a standing item for the next
cold audit.

## Phase 6 — completeness / negative-space / executive summary (done)

Output: `executive-summary.md`. Negative-space ground (missing tests,
runbooks, OpenAPI registrations, orphaned files, half-built features) was
substantially covered by `x-flows-completeness.md`'s explicit completeness
sweep and `x-docs-tests.md`'s env-parity/dead-link sweep; this phase's own
contribution is the completeness-gate self-check (below) and the launch-
readiness synthesis.

### Completeness gates (from plan.md) — final status

- Every in-scope tracked file has a disposition — **yes**, 20 verticals
  collectively partition backend (593 .ts) / web (419 .ts/tsx) / shared (38
  .ts) / mobile (67 tracked) / tooling (32) / docs (295 .md) / migrations
  (38) / runbooks (28); each vertical's own coverage-confirmation section is
  the evidence.
- Every vertical and sweep has a raw report with a file-coverage count —
  **yes**, 25 raw reports (20 + 5) each end with an explicit count.
- Every ADR has a reconciliation line — **yes**, `coverage-matrix.md`, all 35
  files + confirmation 036/037 still absent from `main`.
- Every public and authenticated route mapped to a vertical owner — **yes**,
  `x-security.md`'s from-scratch 144-route inventory.
- Every admin write path has explicit authz/idempotency/audit review —
  **yes**, V7a + x-security's write-surface inventory table.
- Every money-moving path has invariant + concurrency review — **yes**,
  V2/V3/V4/V13 + x-flows-completeness's end-to-end flow traces + Phase 5
  skeptic pass on the financial P0s/P1s.
- Every one of the 22 delta-wave PRs has its CF-fix re-verified closed —
  **yes**, every vertical's "Delta re-verification" section; consolidated in
  `findings.md`'s headline (18 of ~30 found still open/incomplete/regressed).
- At least one full adversarial-skeptic pass ran on P0/P1 before being
  canonical — **partially**: all 6 P0s + 6 of ~38 P1s (the highest-stakes
  ones). Documented as a limitation, not silently assumed complete.
- A dedicated negative-space pass ran — **yes**, `x-flows-completeness.md`'s
  completeness-sweep section (TODO/stub/orphan/dead-env-var inventory).
- Findings include fixes meeting current best practice, not just patches —
  **yes**, every finding in every raw report and in `findings.md` carries a
  minimal-fix + better-fix pair per the Part-6 §41 instruction.

## Coverage assertion (final)

- Source files: ~1,050 backend+web+shared / ~1,050 in scope — full coverage
  via 20 vertical partitions (each confirmed its own N/N)
- Migrations: 38 / 38
- ADRs: 35 / 35 on `main` reconciled (+ 2 confirmed absent: 036, 037)
- Docs: 295 .md swept for env-parity/dead-links (0/856 links broken)
- Runbooks: 28 / 28
- Routes: 144 / 144 (built from scratch, cross-checked against the
  openapi-parity gate — 0 violations)
- Test files: 378 total; 100 sampled for vacuity (x-docs-tests) + 16 read in
  full (V4 + peer report) on the highest-risk (credits/ledger) suite
- Raw reports synthesized into `findings.md`: 26 (20 vertical + 5 sweep + 1
  peer) + `coverage-matrix.md`
- Unique findings: 122 (P0 ×6, P1 ×38 [2 since corrected by Phase 5], P2
  ×46, P3 ×32+1 reclassified)
