# Cold Audit 2026-06-15 — Proposal / ADR Coverage Matrix

Full per-ADR table (decision / invariant-enforced / tested / status-accurate / notes) is in `raw/x-adr.md`. Summary: **24 of 37 ADRs fully covered, 13 gapped.**

## Fully covered (24)

001, 002, 003, 004, 006, 008, 009, 010, 011, 012, 013, 014, 015, 018, 019, 020, 022, 023, 025, 026, 029, 032, 033, 034

## Gapped (13) — what's missing

| ADR                        | Gap                                                                              | Severity | Canonical |
| -------------------------- | -------------------------------------------------------------------------------- | -------- | --------- |
| 005 Known limitations      | Some "deferred" triggers now stale/met                                           | P3       | —         |
| 007 Native overlays        | Revisit trigger (sideload) active, not recorded                                  | P3       | CF-36     |
| 016 Payout submit          | LOOP payout worker lacks the memo+amount+asset idempotency hardening pay-ctx got | P2       | (F-ADR-4) |
| 017 Admin write invariants | refund + compensate not step-up-gated; refund no validation                      | P1       | CF-06/07  |
| 021 Eviction               | admin-fallback rule only partially surfaced                                      | P3       | —         |
| 024 Withdrawal writer      | no auto-compensation on failed withdrawal; kill-switch gap                       | P1       | CF-21/15  |
| 027 Mobile security        | binary-tamper trigger MET (sideload), status says unmet, no dated decision       | P1       | CF-36     |
| 028 Admin step-up          | second factor = login OTP (no purpose binding); mint handler untested            | P1       | CF-08/11  |
| 030 Privy wallet           | branch-only, `Proposed` gate violated; raw_sign auth-key missing; webhook absent | P1       | CF-32     |
| 031 Per-currency yield     | branch-only; DeFindex vault unbuilt; mints unbacked assets; retired codes        | P0/P1    | CF-05/32  |
| 035 Extended markets       | display live but order-path 400s; status inaccurate                              | P1       | CF-19     |
| 036 Cashback lifecycle     | emission/redemption/burn/interest on-chain only on branch, not main              | P0/P1    | CF-01     |
| 037 Staff roles            | no ADR file on main; `requireStaff` branch-only (backend→web SAFE TO MERGE)      | P2       | —         |

## Status-accuracy corrections needed

- **ADR 035** claims "ordering via XLM rail, no backend change" — false; order path rejects the currencies. Update or implement (task #8).
- **ADR 027** + **ADR 007**: record a dated decision on the now-active sideload trigger.
- **ADR 030 / 031 / 036 / 037**: `Proposed` is accurate _on main_ (code is branch-only) — but the branches were built before the DD/Accepted gate the ADRs require; reconcile on merge.
- **ADR 033** correctly superseded by 034 (geo now feeds only the `/` redirect).

## Tranche / roadmap reconciliation

- **Tranche-1 acceptance:** the redemption-null backfill blocker has an implemented sweeper now (#1419) but is **not** in any exit-criteria checklist; add it. Web deploy + DNS confirmed done (closes an orphaned-work item). Remaining tranche-1 gates map to CF-19/25/26/27/35/36 + the launch-ops list (Sentry secrets, app-store accounts, legal copy, keystore escrow).
- **Orphaned-work register:** GeoLite2 refresh cadence (still no scheduled refresh — x-infra P2), thin-currency promotion process, ADR-027 trigger decision — all still open.
- **comprehensive-audit-2026-06-11 Part IV:** the watcher/redemption criticals are **fixed on main** (#1410/#1419); the ADR-035 order-path and ADR-036 lifecycle items remain open (= CF-19, CF-01).
