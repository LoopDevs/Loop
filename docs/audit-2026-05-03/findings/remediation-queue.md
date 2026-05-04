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

| Finding | Severity | Status           | Reason for deferral                                                                                                |
| ------- | -------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| A4-018  | High     | deferred         | Payout idempotency wrong-account scan only matters once outbound payouts run.                                      |
| A4-024  | Critical | deferred (gated) | Double-credit requires both ledger row + on-chain payout for a non-zero cashback amount; T1 emits neither.         |
| A4-038  | Medium   | deferred         | Tax/reporting CSV ADR claim — no quarterly export endpoint shipped; ADR will be amended when implementation lands. |
| A4-042  | Medium   | deferred         | DSR retains payout `to_address`; surface only exists for users with realised on-chain payouts (T2).                |

## Quality, governance, docs — not launch blocking

| Finding | Severity | Status        | Note                                                                                              |
| ------- | -------- | ------------- | ------------------------------------------------------------------------------------------------- |
| A4-001  | High     | accepted-risk | Branch protection ruleset mismatch; tracked separately in repo governance, not a runtime defect.  |
| A4-002  | Medium   | accepted-risk | CODEOWNERS team missing — pre-team project.                                                       |
| A4-003  | Medium   | open          | Architecture/mobile docs reference superseded on-device wallet model — needs doc edit.            |
| A4-004  | Medium   | open          | `lint-docs` OpenAPI drift check doesn't span route-module endpoints — quality-only.               |
| A4-005  | High     | accepted-risk | Branch protection security/release jobs — repo governance.                                        |
| A4-006  | Medium   | open          | Trivy/gitleaks images use mutable tags — supply-chain hardening, follow-up.                       |
| A4-007  | Low      | accepted-risk | Four moderate npm advisories with no fix available.                                               |
| A4-008  | Low      | open          | Third-party license document drift — quality-only.                                                |
| A4-009  | Medium   | already fixed | Per-route key fix landed (commit reference: `A4-001` in earlier audit).                           |
| A4-011  | Medium   | open          | Prometheus label corruption on `:id` routes — observability hygiene.                              |
| A4-012  | Medium   | open          | Refresh-token rotation not concurrency-safe — race window narrow; documented as known limitation. |
| A4-013  | Medium   | open          | Some admin writes bypass advisory-lock idempotency guard — admin-only surface.                    |
| A4-014  | Low      | open          | `/api/image` 500 not in OpenAPI — contract docs gap.                                              |
| A4-016  | Medium   | open          | Loop-native order OpenAPI stale for `loop_asset` and create-side errors.                          |
| A4-022  | Medium   | open          | Stuck-payout cutoff mismatch — Tranche 2 alert noise.                                             |
| A4-028  | Medium   | open          | Admin response shapes duplicated outside `@loop/shared` — internal contract drift risk.           |
| A4-030  | Low      | open          | Local `.env*` permissions — workstation hygiene, not deployment.                                  |
| A4-031  | Medium   | open          | Testing guide stale — docs update.                                                                |
| A4-034  | Low      | open          | Manual real-CTX workflow lacks `DATABASE_URL` — CI workflow fix.                                  |
| A4-035  | Low      | open          | README cashback claim — docs update.                                                              |
| A4-036  | Low      | open          | Roadmap marks `/metrics` as incomplete — docs update.                                             |
| A4-039  | Low      | open          | Dev guide misstates production exposure — docs update.                                            |
