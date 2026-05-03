# Phase 02 - Architecture and ADR Truth

Status: complete
Owner: lead (Claude)

## Files reviewed

- AGENTS.md (root + apps/_/AGENTS.md + packages/_/AGENTS.md)
- docs/{architecture,deployment,development,testing,standards,roadmap,api-compat,error-codes,log-policy,oncall,alerting,slo,mobile-native-ux,third-party-licenses,admin-csv-conventions}.md
- docs/adr/001-029 (all 29 ADRs)
- docs/runbooks/\* (sampled per phase 19)
- packages/shared/src/index.ts (28 modules)

## Findings filed

- A4-061 High — ADR-020 references nonexistent `/api/public/stats`
- A4-062 High — ADR-026 quarterly tax CSV emitter never shipped
- A4-063 Medium — ADR-028 step-up auth designed but unimplemented
- A4-064 Low — ADR-015 LOOP issuers all `optional`; no boot warning on partial config

## ADR-to-code matrix

See `evidence/phase-24-planned-features/notes.md` for the full per-ADR status. 21 of 29 ADRs are IMPLEMENTED, 4 PARTIAL, 2 DEFERRED-correctly, 2 PROMISED-NOT-DELIVERED (ADR-020 stats endpoint, ADR-026 quarterly emitter), 1 IMPLEMENTATION-DEFERRED (ADR-028 step-up).

## Cross-references

- Phase 21 inherits doc drift findings A4-066, A4-067, A4-068.
- Phase 24 owns the planned-vs-current matrix.
