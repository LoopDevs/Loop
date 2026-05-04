# Phase 20 - CI/CD and Release Controls

Status: in-progress

Required evidence:

- workflow inventory: started; `.github/workflows/*.yml`, templates, CODEOWNERS, Dependabot, labeler, and gitleaks config reviewed
- permissions, triggers, cache, secret, artifact review: started; CI, CodeQL, manual real-wallet e2e, PR automation, and AI review workflows inspected
- required checks and branch protection review: covered by A4-001 and A4-005, with continued CI pass review here
- scanner/SBOM/provenance review: covered by A4-006 and workflow inventory
- deploy and release gate review: started; manual real-wallet e2e env was reproduced against backend env parser

Evidence captured:

- [e2e-real-workflow-env-fails.txt](./artifacts/e2e-real-workflow-env-fails.txt)

Findings:

- A4-034: Manual real CTX + wallet workflow fails backend env validation because it omits `DATABASE_URL`.
