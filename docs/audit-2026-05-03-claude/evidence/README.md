# Evidence

Evidence is organized by phase. Each phase directory contains:

- `notes.md`: phase narrative, commands, file dispositions, reasoning, findings.
- `artifacts/`: command outputs, generated maps, logs, JSON, screenshots, or other large evidence.

Rules:

- Record commit SHA and worktree state in every phase note.
- Keep raw outputs in `artifacts/` when they are large.
- Do not include secrets, tokens, private keys, cookies, or real customer PII.
- Label inference clearly.
- Do not rewrite closed evidence. Add correction notes instead.

Phase directories:

- `phase-00-inventory`
- `phase-01-governance`
- `phase-02-architecture`
- `phase-03-build-release`
- `phase-04-dependencies`
- `phase-05-backend-lifecycle`
- `phase-06-auth-identity`
- `phase-07-admin`
- `phase-08-public-api`
- `phase-09-orders`
- `phase-10-payments-payouts`
- `phase-11-data-migrations`
- `phase-12-financial-invariants`
- `phase-13-workers`
- `phase-14-web-runtime`
- `phase-15-mobile-native`
- `phase-16-shared-contracts`
- `phase-17-security-privacy`
- `phase-18-testing`
- `phase-19-observability`
- `phase-20-cicd`
- `phase-21-docs`
- `phase-22-file-pass`
- `phase-23-journey-pass`
- `phase-24-planned-features`
- `phase-25-synthesis`
