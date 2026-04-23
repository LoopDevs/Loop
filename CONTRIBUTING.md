# Contributing to Loop

## Quick start

```bash
git clone git@github.com:LoopDevs/Loop.git loop-app
cd loop-app
npm install
cp apps/backend/.env.example apps/backend/.env  # fill real values
cp apps/web/.env.local.example apps/web/.env.local
npm run dev  # backend on :8080, web on :5173
```

## Development workflow

1. **Create a branch** from `main`:

   ```bash
   git checkout -b feat/my-feature
   ```

   Branch names must match: `feat/`, `fix/`, `chore/`, `docs/`, `test/`, `refactor/`, `perf/`, `ci/`, `build/` (enforced by `.husky/pre-push`).

2. **Make your changes.** Read the relevant `AGENTS.md` first:
   - Backend: `apps/backend/AGENTS.md`
   - Web: `apps/web/AGENTS.md`
   - Shared types: `packages/shared/AGENTS.md`

3. **Verify before pushing:**

   ```bash
   npm run verify  # typecheck + lint + test + docs
   ```

4. **Push and open a PR.** CI runs 7 jobs — `quality`, `test-unit`, `audit`, `build`, `test-e2e-mocked`, `test-e2e` (PR-only), and `notify`. Discord `#loop-deployments` notifies on results.

5. **Get review.** Auth, payment, and storage code requires human review (see `.github/CODEOWNERS`).

6. **Merge.** Squash merge to `main`. Branch auto-deletes.

## Commit format

Conventional Commits enforced by commitlint:

```
feat(web): add merchant search filter
fix(backend): correct cluster centroid calculation
chore(deps): bump react-router to 7.7.1
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `chore`, `ci`, `build`, `revert`
Scopes: `web`, `mobile`, `backend`, `shared`, `infra`, `deps`

## Architecture decisions

Significant changes (new dependency, new service, data model change) require an ADR (Architecture Decision Record) in `docs/adr/`. Use the template:

```markdown
# NNN — Title

## Status

Proposed / Accepted / Deprecated

## Context

Why this decision is needed.

## Decision

What we decided.

## Consequences

Benefits and trade-offs.
```

## What to read

| Before changing... | Read...                     |
| ------------------ | --------------------------- |
| Anything           | Root `AGENTS.md`            |
| Backend code       | `apps/backend/AGENTS.md`    |
| Web code           | `apps/web/AGENTS.md`        |
| Shared types       | `packages/shared/AGENTS.md` |
| Deployment         | `docs/deployment.md`        |
| Standards          | `docs/standards.md`         |

## Key rules

- **Never push directly to `main`** — all changes via PR
- **Never import Capacitor plugins outside `app/native/`**
- **Never fetch data in server-side loaders** — pure API client
- **Never forward upstream responses without Zod validation**
- **Never commit `.env` files or secrets**
- **Always update docs** in the same commit as code changes (enforced by CI)
