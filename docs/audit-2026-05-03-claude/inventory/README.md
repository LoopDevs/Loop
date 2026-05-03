# Inventory

Inventory is the source of truth for audit coverage. The execution audit must update these files, not rely on memory.

Generated at scaffold start:

- [tracked-files.txt](./tracked-files.txt): `git ls-files` at baseline.
- [workspace-files.txt](./workspace-files.txt): `rg --files` excluding dependency and build output.
- [git-status-short.txt](./git-status-short.txt): clean baseline proof.
- [scaffold-git-status-short.txt](./scaffold-git-status-short.txt): expected status after audit scaffold edits.
- [scaffold-files.txt](./scaffold-files.txt): audit scaffold file list.
- [scaffold-disposition.tsv](./scaffold-disposition.tsv): self-review register for the audit plan files.
- [directory-map.txt](./directory-map.txt): shallow directory map excluding dependency and build output.
- [file-counts-by-root.txt](./file-counts-by-root.txt): tracked file counts by root.
- [backend-src-counts.txt](./backend-src-counts.txt): tracked backend `src` counts.
- [web-app-counts.txt](./web-app-counts.txt): tracked web `app` counts.
- [file-counts-by-phase.txt](./file-counts-by-phase.txt): initial path-based phase ownership counts.
- [file-disposition.tsv](./file-disposition.tsv): one row per tracked file.

The initial file-disposition phase assignments are path-based and must be confirmed during Phase 00 and Phase 22. A file may have one primary phase and multiple secondary phases. The primary phase owns final disposition, but secondary phases must record cross-file interaction evidence when relevant.

No file may remain `unreviewed` at audit close.

The baseline tracked-file register covers the repository state before this audit scaffold. The scaffold register covers the audit plan files created by this work and must be closed during Phase 25.
