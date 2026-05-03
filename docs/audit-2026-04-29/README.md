# Loop — Cold Adversarial Audit (2026-04-29)

This folder is the planning and execution home for the fresh cold audit requested on 2026-04-29.

## Status

Audit completed on 2026-04-29 against commit `761107214e436613a7fbbe4e91e82d197c521f71`.

Headline result:

- 34 findings total
- 1 critical
- 9 high
- 20 medium
- 4 low

See [tracker.md](./tracker.md) for the live register, [admin-handoff.md](./admin-handoff.md) for operator-only actions, and [remediation-plan.md](./remediation-plan.md) for the first repair batches.

## Cold-audit rules

- Treat the codebase as untrusted.
- Re-derive conclusions from primary evidence.
- Use legacy audit docs only as seed material and reconciliation targets, not as proof.
- Do not fix findings during evidence gathering.
- Record explicit exclusions; silence does not count as coverage.
- No secrets, tokens, or PII in committed evidence.

## Folder contents

- [plan.md](./plan.md): audit phases, methodology, worker model, sequencing
- [checklist.md](./checklist.md): refreshed checklist for current repo scope
- [tracker.md](./tracker.md): phase status + findings register template
- [admin-handoff.md](./admin-handoff.md): operator-only actions and verification loop
- [remediation-plan.md](./remediation-plan.md): post-audit remediation queue placeholder
- [inventory/README.md](./inventory/README.md): inventory artifacts convention
- [evidence/README.md](./evidence/README.md): evidence artifacts convention

## Why a new scaffold

`docs/audit-checklist.md` is explicitly superseded and materially stale for the current codebase. The repo now includes dual-path auth, admin write surfaces, LOOP-native money movement, background workers, public API guarantees, and operational/runbook expectations that need first-class audit coverage.
