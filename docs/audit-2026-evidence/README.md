# Audit 2026 — Evidence

Evidence artifacts produced while executing [`../audit-2026-adversarial-plan.md`](../audit-2026-adversarial-plan.md).

## Convention

- One file per phase: `phase-N-<slug>.md` where `N` is the phase number (`0`, `1`, …, `19`, plus `6.5`).
- Large dumps (full file lists, SQL schema dumps, grep results) live in sibling `.txt` / `.log` / `.json` files referenced from the phase's `.md`.
- Evidence is append-only during a phase's active window. Once the phase closes in the tracker, its evidence files are immutable; later corrections go into the tracker as new findings pointing back at the original evidence line.

## Commit-SHA baseline

Every phase-level evidence file records the commit SHA the audit was taken against at the top. If the codebase changes during the phase's window, that's disclosed too — the evidence reflects the state at capture time, not an aggregate over a moving window.

## PII / secrets

Evidence files are in-repo and therefore carry the repo's visibility. No PII, no secrets, no full tokens. Redact before committing. If a probe surfaced a real secret during gathering, file a Critical finding, do not paste the secret.

## Not in here

- The tracker (that's [`../audit-2026-tracker.md`](../audit-2026-tracker.md))
- The plan (that's [`../audit-2026-adversarial-plan.md`](../audit-2026-adversarial-plan.md))
- Test output that duplicates what CI captures (link to the CI run URL instead)
