# Remediation Queue

Severity-ordered status of every cold-audit finding. The register
itself is the immutable record of what was observed at baseline
commit `13522bb4`. This queue tracks how each finding has been
resolved, deferred, or accepted as a Tranche-2 concern.

## Tranche 1 (MVP launch) blockers

These directly affect "install from store / buy with XLM or USDC /
redeem at merchant" and were addressed in this remediation cycle.
"Already fixed" means a prior commit (often referencing the older
2026-04-29 audit numbering) had closed the same defect before the
2026-05-03 cold audit was filed.

| Finding | Severity | Resolution          | Where                                                                                                                                   |
| ------- | -------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A4-010  | High     | already fixed       | `routes/orders.ts` + `routes/admin-payouts.ts` register literals before `:id` (commit reference: `A4-075`).                             |
| A4-015  | High     | already fixed       | `procure-one.ts` reverts `procuring → paid` on `OperatorPoolUnavailableError` (commit reference: `A4-101`).                             |
| A4-017  | High     | resolved this cycle | Global $50,000 face-value cap + bigint-safe CTX `fiatAmount` formatter. Tests cover both.                                               |
| A4-020  | High     | already fixed       | `price-feed.ts` stores micro-cents (1e8 precision) and uses ceiling division (commit reference: `A4-106`).                              |
| A4-021  | High     | already fixed       | `watcher.ts` enforces `matchedAsset.kind === expectedKind` before size check (commit reference: `A4-107`).                              |
| A4-023  | High     | resolved this cycle | tsup `onSuccess` copies `src/db/migrations` → `dist/migrations`; CI asserts both are present and journal counts match.                  |
| A4-026  | Medium   | resolved this cycle | `LoopOrdersList` auto-expands `pending_payment` rows and renders address + memo + amount + asset for recovery on refresh.               |
| A4-027  | High     | resolved this cycle | Generated overlay already matches scoped source. CI quality job rejects future drift via grep against `<external-path>` and `path="."`. |
| A4-040  | High     | resolved this cycle | `PurchaseContainer` exposes USDC/XLM radio above `AmountSelection`; selection flows into `createLoopOrder`.                             |
| A4-041  | Medium   | already fixed       | `idempotencyKeyRef` minted at first attempt, reused across retries until success (commit reference: `A4-122`).                          |

## Operational findings — already fixed by prior commits

| Finding | Severity | Resolution                                                                                                                                     |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| A4-019  | Medium   | Watcher touches `cursor.updatedAt` on empty pages so watchdog doesn't false-positive during idle (commit reference: `A4-105`).                 |
| A4-025  | Medium   | Worker health uses `startedAtMs` as fallback staleness anchor so a hung first tick degrades (commit reference: `A4-111`).                      |
| A4-029  | Medium   | Cluster handler migrated to protobuf-es v2 `create/toBinary/fromBinary` API (commit reference: `A4-115`).                                      |
| A4-032  | High     | `/health` runs `SELECT 1` with timeout against the DB and exposes `databaseReachable` (commit reference: `A4-034`).                            |
| A4-033  | High     | Degraded `/health` returns HTTP 503; Dockerfile / Fly probes treat non-200 as unhealthy (commit reference: `A4-035`).                          |
| A4-037  | High     | Resend email provider wired in `auth/email.ts`; boot validation fails fast when `LOOP_AUTH_NATIVE_ENABLED=true` without a configured provider. |

## Tranche 2 / cashback subsystem — gated off in MVP

These all live in the on-chain payout / cashback emission subsystem
that `LOOP_PHASE_1_ONLY=true` disables (`userCashbackMinor=0` →
`pending_payouts` insert is skipped → drift watcher silent → no
on-chain LOOP-asset issuance). They will need real fixes before
Tranche 2 lands but cannot trigger in the Tranche 1 deployment.

| Finding | Severity | Status   | Reason for deferral                                                                                                                                                                 |
| ------- | -------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A4-018  | High     | resolved | Closed by Claude-audit `bf78677f fix: a4-070/071/104 cross-tab logout + redeem copy + payout op-account` — payout pre-check now keys on operator account, not issuer.               |
| A4-024  | Critical | resolved | Closed by Claude-audit `85f0b1c5 fix(backend): a4-110 close cashback double-spend` — `loop_asset` payments debit user_credits, `paymentMethod='credit'` rejected pending bucketing. |
| A4-038  | Medium   | resolved | Closed by `757a4b17 feat(backend): a4-062 quarterly-tax csv emitter (adr-026 phase-1)` — three CSVs per quarter via `npm run report:quarterly-tax`.                                 |
| A4-042  | Medium   | resolved | Closed by Claude-audit `faa737c3 fix: a4-088/117/120/122/123 + a4-069 docs + dsr to_address scrub` — DSR scrubs payout `to_address` on terminal rows.                               |

## Quality, governance, docs — not launch blocking

| Finding | Severity | Status | Note |
| ------- | -------- | ------ | ---- |

Codex audit findings A4-001..A4-042 substantially overlap with the parallel Claude audit (numbers ≥ A4-095 in that register). Most "open" entries in the original Codex queue have already been closed by Claude-numbered commits; this table is the cross-reference.

| Finding | Severity | Status        | Note                                                                                                                                                                             |
| ------- | -------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A4-001  | High     | accepted-risk | Branch protection ruleset mismatch; operator-owned, tracked separately in repo governance.                                                                                       |
| A4-002  | Medium   | accepted-risk | CODEOWNERS team missing — pre-team project; operator-owned.                                                                                                                      |
| A4-003  | Medium   | resolved      | Closed by Claude-audit `3e23279b fix: a4-041/059/060/096 doc refs + share purge + refresh log + arch` — architecture.md + ADR-027 updated to reflect the sponsored-wallet model. |
| A4-004  | Medium   | resolved      | Closed by Claude-audit batch 2 (`8c1559f8`) — `lint-docs.sh` §9 OpenAPI drift now scans every `routes/*.ts` mount.                                                               |
| A4-005  | High     | accepted-risk | Branch protection security/release jobs — operator-owned, repo governance.                                                                                                       |
| A4-006  | Medium   | resolved      | Closed by Claude-audit `e44789a7 fix: a4-024/042/047/078/087 hardening batch` — Trivy/gitleaks pinned by SHA digest.                                                             |
| A4-007  | Low      | accepted-risk | Four moderate npm advisories with no fix available; documented in `check-audit-policy.mjs:13`.                                                                                   |
| A4-008  | Low      | resolved      | Closed by Claude-audit `faa737c3 fix: a4-088/117/120/122/123 + a4-069 docs + dsr to_address scrub` — license docs add MPL-2.0 + claude-code attribution.                         |
| A4-009  | Medium   | resolved      | Per-route rate-limit key landed in Claude-audit batch 2.                                                                                                                         |
| A4-011  | Medium   | resolved      | Closed by Claude-audit batch 1 (`87930414`) — Prometheus metrics route normalisation (A4-076).                                                                                   |
| A4-012  | Medium   | resolved      | Closed by Claude-audit `b9a9c576 fix(backend): a4-098/106/107 refresh-race + xlm precision + asset/method` — refresh-token rotation atomic + reuse detection.                    |
| A4-013  | Medium   | resolved      | Closed by Claude-audit batch 3 (`65f97b54`) + payout-compensation (`A4-099`) — every admin write idempotency-guarded.                                                            |
| A4-014  | Low      | resolved      | Closed by Claude-audit `73b23828 fix(backend): a4-100/101/102/103 procurement + openapi + denomination` — image proxy 500 declared in OpenAPI.                                   |
| A4-016  | Medium   | resolved      | Same commit — Loop-native order OpenAPI emits `loop_asset` + 503.                                                                                                                |
| A4-022  | Medium   | resolved      | Closed by Claude-audit `22354311 fix(backend): a4-105/108/109/111` + Tranche 1 follow-up `482d03b1` — stuck-payouts uses state-specific cutoffs.                                 |
| A4-028  | Medium   | accepted-risk | Same as Claude A4-114 — every sliced web service file documents the team's "no other consumers, would just add indirection" decision; operator override needed to revisit.       |
| A4-030  | Low      | resolved      | Closed by `1ef6a77f fix: a4-094/116 public 4xx cache + dev env-perms preflight` — `.env*` permissions check.                                                                     |
| A4-031  | Medium   | resolved      | Closed by Claude-audit `faa737c3` — testing.md updated.                                                                                                                          |
| A4-034  | Low      | resolved      | Closed by Tranche 1 follow-up `1177699a fix(ci): provision postgres for e2e jobs so /health 200s` — real-CTX workflow now provisions postgres.                                   |
| A4-035  | Low      | resolved      | Closed by Claude-audit `65f97b54` — README cashback claim updated.                                                                                                               |
| A4-036  | Low      | resolved      | Same commit — roadmap.md updated to reflect `/metrics` ship.                                                                                                                     |
| A4-039  | Low      | resolved      | Closed by Claude-audit `faa737c3` — development.md `/metrics` policy corrected.                                                                                                  |
