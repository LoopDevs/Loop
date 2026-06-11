# tools/ctx-catalog — CTX merchant-catalog operator tooling

Operator scripts from the 2026-06 CTX merchant media / description / supplier-coverage overhaul
(see memory: `project_ctx_media_pipeline`). Previously untracked in `scripts/`; committed here by
the comprehensive-audit remediation (Part IV phase 9) so they survive machine loss and carry
review history. Repo-infra scripts (verify, preflight, e2e, lint-docs, check-\*) stay in
`scripts/` — this directory is exclusively catalog-ops tooling that talks to the production CTX
admin API and external media services.

## Auth & inputs

- **CTX admin token**: every script reads `process.env.CTX_TOKEN`, falling back to
  `/tmp/ctx-token.txt`. Never hardcode it.
- **logo.dev**: `process.env.LOGODEV_KEY`, falling back to `/tmp/logodev-key.txt` (publishable
  `pk_` tier, but treat it like a secret anyway).
- **Tavily**: `process.env.TAVILY_API_KEY`.
- Most scripts consume/produce JSON snapshots under `/tmp/` (`ctx-fresh.json`,
  `ctx-domains-final.json`, `ctx-media-final.json`, …) — transient by design; regenerate with the
  pull scripts before a run.

## ⚠️ Safety

Several scripts perform **bulk writes against the production CTX catalog** (`PUT /merchants/:id`
fan-outs). They predate a uniform `--dry-run` convention: the allocators (`tillo-allocate`,
`svs-allocate`) support `--dry-run`; most others do not. **Read a script before running it**, and
prefer regenerating the `/tmp` snapshot first so you can diff intended changes. Adding a uniform
dry-run/confirm gate is tracked follow-up (comprehensive-audit Part IV phase 9 residue).

## Layout

- `./` — re-runnable tooling: supplier pulls (`pull-*`, `supplier-*`), allocators
  (`*-allocate`, `ezpin-availability-sweep`), media pipeline (`fetch-logos`, `scrape-*`,
  `source-images-*`, `build-logo-*`, `warm-img-cache`), QC + review UIs (`review-server`,
  `domain-review-server`, `logo-dims`, `logo-opacity-scan`, `recount`, `ctx-anomalies`,
  `ctx-dup-scan`, `ctx-provider-gaps`, domain resolvers), and `demo-seed`.
- `./archive/` — **consumed one-shot passes** kept for provenance only (the `ctx-*-apply` /
  retag / casing / dedup-apply family, cover fix rounds, `qc-residue-fix`, `note-*`,
  `merge-pairs`, …). Their `/tmp` inputs are gone; do not re-run them — they encode decisions
  already applied to the live catalog. `qc-residue-fix.mjs` additionally hardcodes a
  session-transient input path and cannot run anywhere.
