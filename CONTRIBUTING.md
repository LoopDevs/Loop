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

5. **Get review.** `.github/CODEOWNERS` lists reviewer expectations for auth, ledger, admin, Stellar, CTX-operator, DB schema, and shared-type code. Note: the `@LoopDevs/engineering` team referenced there hasn't been created yet (audit A2-103), so GitHub silently skips the required-reviews rule today — branch protection allows an admin squash-merge without approval. Treat a reviewer as mandatory on those paths anyway; enforcement flips on once the team lands.

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

Status: Proposed
Date: YYYY-MM-DD

## Context

Why this decision is needed.

## Decision

What we decided.

## Consequences

Benefits and trade-offs.
```

### ADR lifecycle

An ADR moves through three states (A2-1817). One state at a time — ADR status is a single value, not a history.

- **Proposed** — written but not merged into the codebase yet. A PR implementing the ADR is either open or about to be.
- **Accepted** — the decision has shipped. Every ADR currently in `docs/adr/` that describes code running on `main` is `Accepted`.
- **Deprecated** — the decision no longer applies. Keep the file; update the status; add a top-level `> **Superseded YYYY-MM by ADR-NNN**` blockquote pointing at whatever replaced it. Never delete an ADR — we link to them from commits, and a broken link is worse than a visible deprecation.

### Amending an existing ADR

Code evolves; ADRs follow. Three shapes of change:

1. **Implementation note** — the ADR was accepted; a subsequent PR added a detail worth pinning. Append an `## Implementation` section at the bottom of the ADR with the date + one paragraph + a link to the PR. Do **not** rewrite Context / Decision / Consequences to match; those are the original decision. ADR 015 / 016 have Implementation sections for this reason.
2. **Scope correction** — the original Decision missed a case the live code needed to handle. Add `## Amendment YYYY-MM — <summary>` block under Consequences. Explain what the original said, what the live code now does, and why. Do not edit the original Decision prose; the file is append-only after Accepted. ADR 013's social-login carve-out is an example.
3. **Full replacement** — the decision is wrong enough that a new ADR is warranted. Create `docs/adr/NNN-new-title.md`, set its header to `Supersedes: ADR-MMM`, and flip the old ADR to `Deprecated` with a `Superseded by: ADR-NNN` line. ADRs 005 → 008 chain uses this.

The PR body must say which shape applies and link the related PR(s).

### When to amend vs create a new ADR

Amend if:

- The Context stays the same and the Decision is still correct in spirit.
- Implementation details want pinning for future readers.
- A small carve-out emerged (a third auth path, a new asset code, an exception).

Create a new ADR if:

- The Decision itself has changed direction (e.g., ADR 010 proxy-pass → ADR 013 Loop-native).
- A new dependency is being added that the original ADR did not contemplate.
- Consequences have shifted materially enough that future-you would misread the old Decision as current.

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
