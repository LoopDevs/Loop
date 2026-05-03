# ADR 029: Repo-managed CI CLIs for secret-bearing workflows

Status: Accepted
Date: 2026-04-29
Resolves: A3-030

## Context

Two GitHub Actions workflows were invoking npm-hosted CLIs outside the
repository lockfile:

- `.github/workflows/pr-review.yml` installed
  `@anthropic-ai/claude-code` globally with `npm install -g`.
- `.github/workflows/ci.yml` invoked `@sentry/cli` via
  `npx @sentry/cli@<version>` immediately before using the
  `SENTRY_AUTH_TOKEN` secret.

Both versions were pinned in YAML, but the package trees were still
resolved live from npm at workflow runtime. That bypassed:

- `package-lock.json` integrity coverage
- Dependabot visibility
- the repository's usual review path for dependency changes

For ordinary CI this is already undesirable. For workflows that touch
real secrets or third-party write credentials, it is worse: a
compromised transitive dependency can run in a privileged context before
the repo has any chance to review the change.

## Decision

Move these CLIs under normal repo dependency governance.

Concretely:

- add `@anthropic-ai/claude-code` and `@sentry/cli` to the root
  `devDependencies`
- let `package-lock.json` pin their full dependency trees
- execute them from the checked-in install using
  `npm exec --no-install ...`, never `npm install -g` or versioned
  `npx <pkg>@...` inside the workflow

Where a CLI needs its own install hook to materialize a platform binary,
the workflow may re-enable only that package explicitly with
`npm rebuild <package>` after `npm ci --ignore-scripts`. That keeps the
hook surface narrow and repo-reviewed.

## Consequences

Positive:

- Dependabot can see and propose updates for the pinned CLI versions.
- Secret-bearing workflows stop resolving fresh package trees from npm at
  runtime.
- CLI version changes now land as ordinary PRs with lockfile diffs.

Trade-offs:

- The repo's dev dependency set grows slightly.
- The PR-review workflow now performs a normal repo install rather than a
  one-package global install, which is slower but reproducible.
- `@sentry/cli` still uses a targeted package install hook when the
  binary is needed; the difference is that the package and transitive
  tree are now governed by the lockfile and review process.

## Alternatives considered

1. Keep the current approach and just pin versions harder.
   Rejected: the problem is not only top-level version drift; it is live
   resolution outside the lockfile and Dependabot path.

2. Replace npm CLIs with ad-hoc curl/install scripts.
   Rejected: that would move trust to unaudited download URLs and custom
   shell glue, not reduce it.

3. Move both tools behind external container images or actions.
   Rejected for now: it still shifts trust to external artifacts, and
   the repo already has a strong lockfile-based governance path.

## References

- `.github/workflows/pr-review.yml`
- `.github/workflows/ci.yml`
- `docs/adr/025-llm-pr-review.md`
