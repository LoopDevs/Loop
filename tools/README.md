# tools/ — standalone operator tooling

Not an npm workspace. Each subdirectory is self-contained and self-documented
— see its own README / the doc that owns it. New one-shot tooling should get
its own dated subdirectory (or land in the relevant one below with a note in
its README) rather than sitting loose at this top level, so it doesn't
accumulate into an undocumented pile (§P3 scripts-pile cleanup,
comprehensive-audit-2026-06-11.md Part IV phase 9).

| Directory                                 | What it is                                                                                                                                                                                                                                                                                     |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ctx-catalog/`](./ctx-catalog/README.md) | CTX merchant-catalog operator tooling — supplier pulls, allocators, media pipeline, QC, review servers. Talks to the production CTX admin API and external media services. Has its own `archive/` for consumed one-shot passes; see its README's "Layout" section for the live/archived split. |
| [`load-test/`](../docs/load-testing.md)   | k6 load-test harness (browse + auth→order scenarios). Run via `./tools/load-test/run-local.sh`; documented end-to-end in `docs/load-testing.md`. `results/` is git-ignored run output, not source.                                                                                             |

Repo-infra scripts (CI gates, dev/release plumbing, git hooks) live in
[`scripts/`](../scripts/README.md), not here.
