# Remediation Plan

The cold audit is closed. This file now groups findings into practical repair batches.

## Batch 0 — Immediate containment

- `A3-015` Remove the legacy-CTX admin-bypass path. `requireAdmin` must not derive admin privilege from an unverified bearer.
- `A3-006` and `A3-031` Rework payout retry semantics so compensation and payout-submit are both at-most-once under Horizon degradation and retry races. Closed in working tree on 2026-04-29.
- `A3-001` Align live branch protection with checked-in policy so weakened merge gates stop compounding risk while remediation is in flight.

## Batch 1 — Financial and admin write correctness

- `A3-007` Strengthen admin withdrawal idempotency to a real semantic uniqueness boundary. Closed in working tree on 2026-04-29.
- `A3-008` Serialize or otherwise harden the daily admin-adjustment cap. Closed in working tree on 2026-04-29.
- `A3-032` Make idempotency TTL semantics consistent across guarded and manual replay paths. Closed in working tree on 2026-04-29.

## Batch 2 — Contract and documentation truth

- `A3-003`, `A3-026` Closed in working tree on 2026-04-29.
- `A3-012`, `A3-013`, `A3-014`, `A3-023` Closed in working tree on 2026-04-29.

## Batch 3 — Release and supply-chain hardening

- `A3-020`, `A3-028`, `A3-030` Closed in working tree on 2026-04-29.
- `A3-029` Closed in working tree on 2026-04-29.

## Batch 4 — Runtime, privacy, and operational gaps

- `A3-021`, `A3-022`, `A3-024`, `A3-025` Closed in working tree on 2026-04-29.
- `A3-034`, `A3-035`, `A3-027` Closed in working tree on 2026-04-29.

## Batch 5 — Backend surface cleanup

- `A3-016`, `A3-033` Closed in working tree on 2026-04-29.

## Batch 6 — Mobile hardening and honesty

- `A3-009`, `A3-010`, `A3-011` Closed in working tree on 2026-04-29.

## Batch 7 — Web runtime policy cleanup

- `A3-004`, `A3-005` Closed in working tree on 2026-04-29.

## Batch 8 — Testing realism

- `A3-018`, `A3-019` Closed in working tree on 2026-04-29.
