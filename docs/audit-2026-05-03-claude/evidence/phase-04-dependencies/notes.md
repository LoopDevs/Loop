# Phase 04 - Dependencies and Supply Chain

Status: complete
Owner: lead (Claude)

## Files reviewed

- Root + per-workspace `package.json`; root `package-lock.json`
- `.npmrc`, `.gitleaks.toml`
- `.github/workflows/{ci.yml,codeql.yml,e2e-real.yml}` (audit, secret-scan, container-cve-scan, sbom jobs)
- scripts/check-audit-policy.mjs

## No-finding-but-reviewed

- npm audit + check-audit-policy.mjs gate moderate/high vulns (with explicit accepted set: esbuild-kit ecosystem).
- Trivy + CodeQL + gitleaks + SBOM (cyclonedx) + cosign-keyless attestations all wired.
- Capacitor plugin parity rule is enforced via mobile:sync flow.

## Findings filed

- A4-044 Medium — SBOM provenance subject is the SBOM file, not the deploy artifacts.

## Cross-references

- Phase 20 owns workflow-permission and required-checks findings.
