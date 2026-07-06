# tools/ctx-catalog/data — recovered media-pipeline working set

The durable output of the 2026-06 CTX merchant media / description / coverage
pipeline (see `../README.md` + memory `project_ctx_media_pipeline`). Previously
this lived only in `/tmp` (wiped on reboot) and later `~/loop-media-work/` (a
single unbacked-up copy). **Brought into git 2026-07-04 so the AI/Tavily/
brand.dev sourcing + human review work can never evaporate again** — this is the
irreplaceable, expensive-to-regenerate state.

> ⚠️ **Secrets scrubbed.** The logo.dev token was embedded 1,847× in
> `ctx-media-final.json` + `brandqc-input.json` (in `token=pk_…` query params);
> it's been redacted to `token=LOGODEV_KEY_REDACTED`. Every entry keeps its
> `domain`, so a logo.dev URL is deterministically reconstructable:
> `https://img.logo.dev/<domain>?token=$LOGODEV_KEY&size=512&format=png`. A
> later pass also scrubbed third-party CDN signed-URL tokens (`?auth=<hex>` on
> scraped cover URLs) to `auth=SIGNED_URL_TOKEN_REDACTED` — these are
> third-party, short-lived, not Loop secrets, but tokens don't belong in git.
> Never re-commit a real token here; `.gitleaks.toml` narrowly allowlists the
> `auth=<hex>` class (by match) while still catching a real Loop key.

## State at recovery (2026-07-04)

- **`ctx-media-final.json`** — **1,156 merchants with sourced media**, 1,154 with
  a resolved `logoUrl` (logoSource: logo.dev 816, vision-QC'd 218, logo 80,
  generic 19, user-picked 15, Tavily 2, amazon 3, tillo 1). The core sourcing
  asset — what `ctx-apply --images` pushes to CTX.
- **`review-decisions.json`** — 1,039 merchant keys (by CTX id); **~40 carry an
  explicit ✓/✗ verdict** (38 logo-approved / 2 rejected; 31 cover / 8). The rest
  are entries without a recorded logo/cover decision. The review-server
  (`../review-server.mjs`) reads/writes this.
- **`ctx-domains-final.json`** — resolved registrable domains per merchant (the
  logo.dev / brand lookup key; see `../ctx-domain-resolve.mjs`).
- **`ctx-enrichment.json`** (1.4 MB) — descriptions / info enrichment.
- **`cov2-out-*.json`** — cover-image sourcing rounds.
- **`brandqc-input.json`** — vision-QC input set.
- **`ctx-create-plan2.json` / `ctx-staged-renames.json` /
  `ctx-staged-name-reverts.json` / `ctx-famcfg.json` / `ctx-missing-genuine.json`**
  — create / rename / family-config / gap plans.
- **`ctx-fresh.json` (1.3 MB) / `ctx-info.json` (1.2 MB)** — a June-7 catalog
  pull + info snapshot. **Regenerable** (`../recount.mjs` with `CTX_TOKEN`);
  kept for provenance.

## The gap this exposes

Only **~109 of 3,468 live merchants have media in CTX today (3.2%)** — but
**1,154 logos are sourced + sitting here**, largely un-applied. So the fix for
the missing-imagery problem (readiness-backlog **T0-2**) is mostly _apply the
recovered manifest_, not re-source from scratch. The catalog also grew (Tillo/
EzPin resyncs → 3,468) after this pass, so the newer brands still need sourcing.

## Going forward

**M1 landed** (`../paths.mjs`): the `CTX_DATA_DIR` convention (default this dir)

- `cachePath`/`withLogodevKey` helpers. The core review loop — `review-server`
  (reads the manifests + persists decisions here; re-injects `LOGODEV_KEY` into the
  scrubbed URLs) and `recount` — now reads/writes here, so approvals + sourcing
  persist automatically. The remaining ad-hoc scripts still hardcode `/tmp`;
  migrating them is a mechanical follow-up. Override with `CTX_DATA_DIR=/tmp` for a
  throwaway run.
