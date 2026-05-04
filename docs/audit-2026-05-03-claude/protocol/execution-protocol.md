# Execution Protocol

## Phase Start

At phase start:

- Record date, baseline commit, worktree state, owner, reviewer, and scope.
- List primary files from `inventory/file-disposition.tsv`.
- List secondary files and cross-file interactions expected.
- List commands, static searches, runtime checks, and journey checks planned.

## During Phase Work

- Read from top down first: entry points, route registries, package manifests, config, docs claims.
- Read from bottom up second: every primary file assigned to the phase.
- Trace interactions third: imports, exports, route calls, DB writes, env vars, workflow calls, docs references, tests.
- Capture artifacts for large command output.
- Update file dispositions as files are reviewed.
- File findings as soon as evidence is strong enough.

## Phase Close

A phase can close only after:

- all primary files have disposition
- evidence notes list commands and manual review results
- route/workflow/table/export inventories are complete where applicable
- cross-phase dependencies are linked
- second-pass questions are answered
- open blockers are moved to `tracker.md`

## Commands and Safety

- Prefer `rg`, `rg --files`, `git ls-files`, `git grep`, `npm` scripts, and focused test commands.
- Commands that may access network, mutate external systems, or use secrets must be approved and recorded.
- Do not run destructive commands during audit execution.
- Do not include secrets, tokens, raw private keys, session cookies, or real customer PII in evidence.
