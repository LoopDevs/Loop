# Phase 04 - Dependencies and Supply Chain

Status: in-progress

Execution timestamp: `2026-05-03T18:44:00Z`

Baseline commit: `13522bb4ee8279336fb143c5c0f33bbbf6ef205b`

Required evidence:

- dependency inventory: captured
- lockfile and audit output: captured
- license parity review: top-level license coverage captured; transitive license sweep pending
- native/plugin dependency review: package parity captured
- workflow-installed CLI review: captured

Artifacts:

- `artifacts/root-package-summary.json`
- `artifacts/package-json-files-source-only.txt`
- `artifacts/package-lock-package-keys.txt`
- `artifacts/npm-ls-workspaces-depth0.json`
- `artifacts/npm-ls-workspaces-depth0.stderr`
- `artifacts/npm-audit-json.json`
- `artifacts/npm-audit-json.stderr`
- `artifacts/all-package-script-keys.txt`
- `artifacts/runtime-tool-resolution-lines.txt`
- `artifacts/workflow-actions-all.txt`
- `artifacts/workflow-actions-sha-pinned.txt`
- `artifacts/workflow-actions-not-sha-pinned.txt`
- `artifacts/capacitor-plugin-parity.tsv`
- `artifacts/workflow-docker-image-lines.txt`
- `artifacts/audit-moderate-package-lines.txt`
- `artifacts/top-level-dependency-licenses.tsv`
- `artifacts/license-doc-coverage-lines.txt`
- `artifacts/license-gap-lines.txt`

Command results:

- Source package manifests: five source `package.json` files after excluding every `node_modules` tree and the isolated Claude audit workspace.
- `npm ls --workspaces --depth=0 --json`: failed in the local install due extraneous root `node_modules` packages and invalid workspace-local `vitest@4.1.4` installs. This is recorded as local environment drift, not yet treated as committed-source evidence.
- `npm audit --json`: raw npm exits non-zero with four moderate advisories and zero high/critical advisories.
- `npm run audit`: passed through the repository policy wrapper because the four moderate advisories are explicitly accepted.
- GitHub `uses:` actions: all current workflow `uses:` references are SHA-pinned.
- CI Docker scanner images: Trivy and gitleaks are tag-pinned but not digest-pinned; filed `A4-006`.
- Capacitor/native plugin parity: web and mobile package dependencies match for all shared Capacitor, Aparajita, and Capgo runtime plugins.
- License coverage: current top-level dependency licenses include `@capgo/inappbrowser` under MPL-2.0 and `@anthropic-ai/claude-code` under a non-standard commercial license reference; filed `A4-008` because the third-party license doc does not cover them.

Review dimensions:

- Logic correctness: dependency policy correctly detects unexpected moderate, high, and critical advisories, but it currently accepts four known moderate advisories.
- Code quality: package scripts and workflow commands are explicit; runtime tool resolution remains present through `npx` and Docker images.
- Security and privacy: mutable scanner images weaken the scanner trust boundary; npm audit accepted advisories remain open risk.
- Documentation accuracy: pending full docs pass; current evidence already supports `A4-006`, `A4-007`, and `A4-008`.
- Test coverage and accuracy: dependency audit policy covered; raw `npm audit` still non-zero.
- Planned-feature fit: pending Phase 24.

Findings:

- `A4-006`
- `A4-007`
- `A4-008`
