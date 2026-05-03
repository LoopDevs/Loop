# Phase 24 - Planned Features and Current Feature Set

Status: complete
Owner: lead (Claude)

## Outputs

- `inventory/planned-feature-matrix.tsv` (PF-001 through PF-020) extended with classification, current-code-source, and findings refs.
- ADR-by-ADR matrix in `evidence/phase-02-architecture/notes.md` and `evidence/phase-25-synthesis/notes.md`.

## Classification summary

| Class                          |                                                Count |
| ------------------------------ | ---------------------------------------------------: |
| implemented                    |                                                   12 |
| partial                        |                                                    4 |
| planned-not-started            |       2 (ADR-028 step-up, ADR-026 quarterly emitter) |
| deferred (correctly)           |                 1 (ADR-027 mobile platform security) |
| stale / contradictory          | 1 (ADR-020 references nonexistent /api/public/stats) |
| undocumented current behaviour |                 0 (no shipped behaviour without doc) |

## Findings filed

- A4-061 High — ADR-020 stats endpoint missing
- A4-062 High — ADR-026 emitter missing
- A4-063 Medium — ADR-028 step-up unimplemented; admin destructive endpoints unguarded
- A4-064 Low — ADR-015 partial issuer config silent

## Risk view

Highest gap is ADR-028 (admin step-up auth). The admin write surfaces (credit adjust, refund, withdrawal, payout retry, compensation) currently rely on `requireAdmin` plus app-level idempotency / actor binding / audit envelope. A compromised admin token can drain the daily cap (and bypass it through the compensation primitive — see A4-020). Step-up was the planned Phase-1 mitigation.
