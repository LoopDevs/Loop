# Phase 21 - Documentation Truth and Supportability

Status: in-progress

Required evidence:

- docs inventory: started; 186 scoped Markdown docs identified, excluding the Claude audit workspace
- env var doc/code matrix: started across earlier phases; final matrix remains for Phase 22/24 closure
- old audit and archive truth disposition: captured
- command/path/owner/severity verification: started through testing, deployment, runbooks, and CI findings
- stale or misleading claims list: started

Evidence captured:

- [public-doc-current-feature-drift.txt](./artifacts/public-doc-current-feature-drift.txt)
- [observability-token-doc-drift.txt](./artifacts/observability-token-doc-drift.txt)
- [active-docs-runbooks-pass.txt](./artifacts/active-docs-runbooks-pass.txt)

Findings:

- A4-035: Root README says cashback-to-Stellar is not shipped even though the ADR 015/016 cashback/payout feature set is implemented.
- A4-036: Roadmap still marks the Prometheus metrics endpoint as incomplete even though `/metrics` is mounted and implemented.
- A4-039: Development guide misstates production exposure of `/metrics` and `/openapi.json` when bearer tokens are unset.

Current verified observations:

- `npm run lint:docs` passed during the active-docs pass, covering env/docs parity, route/docs references, stale deleted-file references, stale domains, shared exports, secret-key scans, OpenAPI drift guard, Fly config, and Capacitor plugin parity.
- Active docs and runbooks were reconciled against current code findings; historical audit documents were treated as archive/reference and not as truth for current A4 evidence.
