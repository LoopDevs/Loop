# Phase 20 - CI/CD and Release Controls

Status: complete
Owner: lead (Claude)

## Files reviewed

- .github/workflows/{ci,codeql,e2e-real,pr-automation,pr-review}.yml
- scripts/{verify,lint-docs,check-bundle-budget,check-admin-bundle-split,check-audit-policy,ci-watch,e2e-real,postgres-init}.sh|.mjs
- AGENTS.md / CLAUDE.md branch-protection claims

## Findings filed

- A4-036 Medium — notify job marks PASSED when test-e2e is skipped on push
- A4-037 Medium — branch-protection required-checks set excludes scanners that already run
- A4-043 Medium — no mobile release/signing CI workflow
- A4-044 Medium — SBOM provenance subject is the SBOM file, not deploy artifacts
- A4-045 Medium — e2e-real workflow rotates secret via PAT without scope validation

## No-finding-but-reviewed

- npm audit + check-audit-policy + secret-scan + container-cve + sbom + cosign + codeql all wired.
- pr-review.yml (ADR-025) uses `pull_request:` not `pull_request_target:` — secret-bearing trigger correctly avoided.
- Action versions pinned (mostly to SHA via dependabot updates).
