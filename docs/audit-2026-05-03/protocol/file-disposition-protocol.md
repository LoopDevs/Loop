# File Disposition Protocol

The register is [../inventory/file-disposition.tsv](../inventory/file-disposition.tsv).

## Columns

- `path`: tracked file path from `git ls-files`.
- `primary_phase`: phase that owns final disposition.
- `secondary_phases`: comma-separated phases that must review interactions.
- `disposition`: current file status.
- `evidence_refs`: phase notes or artifact references.
- `findings_refs`: finding IDs affecting the file.
- `notes`: short review note.

## Valid Dispositions

- `unreviewed`: not yet reviewed.
- `reviewed-no-finding`: reviewed and no finding filed.
- `reviewed-with-finding`: reviewed and linked to at least one finding.
- `generated-reviewed`: generated file reviewed against source or generation command.
- `generated-excluded`: generated file excluded with documented reason.
- `binary-reviewed`: binary or image reviewed through metadata, visual inspection, or source comparison.
- `external-output-excluded`: dependency/build/runtime output excluded by policy.
- `dead-or-orphaned`: file appears unused, stale, or misleading and needs finding or explicit accepted status.
- `blocked`: cannot be reviewed yet, with blocker recorded in `tracker.md`.

## Review Expectations by File Type

Source code:

- read logic
- map inputs/outputs
- trace imports/exports
- identify tests, docs, config, and runtime paths

Tests:

- identify behavior asserted
- identify missing negative cases
- detect overmocking and fixture drift
- map test to implementation risk

Config:

- compare to docs and runtime behavior
- verify defaults, env vars, permissions, paths, and generated effects

Docs:

- verify every claim against code, config, command output, or runtime behavior
- mark historical docs as historical if they are not current

Generated files:

- identify generator and source file
- verify output freshness or mark drift
- avoid manual source review as the only proof

Binary/assets:

- identify purpose, owner, size, format, path, and shipping surface
- inspect metadata and usage
- verify no sensitive or misleading asset content
