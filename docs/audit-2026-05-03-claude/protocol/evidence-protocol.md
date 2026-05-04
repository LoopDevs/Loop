# Evidence Protocol

## Evidence Structure

Each phase has:

- `notes.md`: narrative, commands, manual reasoning, file dispositions, findings discovered.
- `artifacts/`: raw or large command output, JSON, logs, grep dumps, generated route maps, schema maps.

## Required Evidence Header

Every `notes.md` entry should include:

- date/time
- commit SHA
- worktree state
- phase owner
- commands run
- files reviewed
- artifacts written
- findings or no-finding statement

## Artifact Naming

Use stable names:

- `git-status-short.txt`
- `route-map.txt`
- `openapi-paths.txt`
- `env-vars.txt`
- `db-schema-vs-migrations.txt`
- `npm-audit.json`
- `workflow-permissions.txt`
- `query-sites.txt`
- `fetch-sites.txt`
- `native-plugin-imports.txt`
- `runbook-command-map.txt`

## Evidence Quality Bar

Good evidence:

- points to exact files and lines where possible
- can be reproduced from the baseline
- distinguishes code fact, runtime fact, and reviewer inference
- includes negative results for important searches
- redacts sensitive material and states what was redacted

Weak evidence:

- says "looks fine" without file refs
- trusts a doc claim without code verification
- uses prior audit text as proof
- cites tests without checking whether the tests assert the risky behavior
- captures command output without command, date, commit, or context
