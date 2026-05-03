# Phase 0 — Inventory & Freeze

- Capture date: 2026-04-29
- Freeze commit: `761107214e436613a7fbbe4e91e82d197c521f71`
- Auditor: Codex
- Phase status: complete

## Scope and baseline

Phase 0 established the execution baseline for the cold audit and generated the initial inventory artifacts. The baseline commit is the current `HEAD` at capture time.

The worktree was not fully clean at freeze time. The only local changes were the audit scaffold itself:

- `AGENTS.md`
- `docs/audit-2026-04-29/**`

That caveat is recorded in the tracker and does not affect product-code conclusions.

## Artifacts

- Inventory list: [../../inventory/git-ls-files.txt](../../inventory/git-ls-files.txt)
- Initial phase map: [../../inventory/phase-map.md](../../inventory/phase-map.md)
- Exclusions: [../../inventory/exclusions.md](../../inventory/exclusions.md)
- File counts: [../../inventory/file-counts.txt](../../inventory/file-counts.txt)
- Worktree snapshot: [artifacts/git-status-short.txt](./artifacts/git-status-short.txt)

## Initial footprint

- `apps/backend/src`: 548 files
- `apps/web/app`: 345 files
- `apps/mobile`: 1305 files
- `packages/shared/src`: 28 files
- `docs`: 108 files
- `.github`: 12 files
- `scripts`: 7 files

## Findings

None in Phase 0. This phase is inventory and control-plane setup only.
