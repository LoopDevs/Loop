# Media pipeline — end-to-end runbook

How the v2 scripts fit together, in order. Every script has a `--self-test` (no
network/keys) that proves its logic; the live commands need the keys noted per
stage. Nothing writes to CTX until the final apply, which is **dry-run by
default**. Design + rationale: [`IMPROVEMENT-PLAN-2026-07.md`](./IMPROVEMENT-PLAN-2026-07.md).

```
supplier data ─┐
CTX catalog ───┤─▶ 0 aggregate ─▶ 1 resolve ─▶ 2 source ─▶ 3 extract ─▶ 4 QC ─▶ 5 review ─▶ 6 apply
web (Tavily) ──┘   brand-brief      domain-tools  images    ai-extract   image-qc  review-    ctx-write
                                    brand-family  logos     ai-info      cover-    server     (dry-run
                                                            vision-qc*    text-scan            first)
```

`*` vision-qc is both a QC tier and an extraction input (wrong-brand).

## Keys (per stage, in a gitignored env — never in the repo)

| Var                      | Used by                              | Scope                                                 |
| ------------------------ | ------------------------------------ | ----------------------------------------------------- |
| `CTX_TOKEN`              | `recount`, `ctx-write`               | CTX admin, read for coverage; write only on `--apply` |
| Tillo / SVS / EzPin keys | supplier-pull adapters (todo)        | **read-only / catalog** — never transactional         |
| `LOGODEV_KEY`            | `fetch-logos`, `review-server`       | logo.dev publishable `pk_`                            |
| `TAVILY_API_KEY`         | `source-images-tavily`               | Tavily search                                         |
| `ANTHROPIC_API_KEY`      | `ai-extract`, `ai-info`, `vision-qc` | Anthropic Messages API                                |

## Stages

**0 · Aggregate** — `brand-brief.mjs` unions every supplier record per merchant
(verbatim, with provenance), mines embedded URLs, and anchors the domain to a
supplier-provided URL over any web guess. `build-state.mjs --build` seeds the
lifecycle ledger from the recovered manifests.

**1 · Resolve identity** — `domain-tools.mjs` gives the registrable root (PSL),
the reseller/marketplace deny-list, and confidence scoring (auto-accept ≥ 0.8).
`brand-family.mjs` groups regional variants so a resolved logo is shared once
per family, not re-sourced per variant.

**2 · Source assets** — `source-images-tavily.mjs` (covers, category+country
disambiguated queries + faceplate reject) and `fetch-logos.mjs` (logos via
`logo-sources.mjs`, always `fallback=404` so a miss is a clean gap).

**3 · Extract (Claude)** — `ai-extract.mjs` → `redeemableAt` cross-brands +
category + evidence (drives the merchant splits). `ai-info.mjs` → uniform
intro/description/instructions/terms with a style contract (no price/expiry
claims), validated before use.

**4 · QC (3 tiers → human residue only)** — `image-qc.mjs` (sharp: blur /
upscale / near-dup) → `cover-text-scan.mjs` (OCR: baked-in text, covers only) →
`vision-qc.mjs` (Claude: wrong-brand / low-quality). Reject auto-re-sources;
only `flag` reaches a human.

**5 · Review** — `review-server.mjs` (loopback + token-gated UI on :7654) reads
the manifests from `data/` and persists verdicts durably. `merchant-state`
records `reviewed.{logo,cover}`.

**6 · Apply — dry-run first** — `ctx-write.mjs` computes the apply queue from the
ledger (`needsApply()` = sourced + review-approved + not-applied), previews the
plan to `data/plans/`, and only writes with `--apply`. Idempotent from
`applied.<ts>`, throttled. **Stage to CTX staging before production.**

## Coverage at any time

```bash
node tools/ctx-catalog/merchant-state.mjs --coverage    # sourced/reviewed/applied board
node tools/ctx-catalog/recount.mjs                       # live CTX coverage (needs CTX_TOKEN)
```

## Run every self-test

```bash
npm run test:tools          # network-free subset, also run in CI's Quality job
node tools/ctx-catalog/cover-text-scan.mjs --self-test   # the one that boots Tesseract
```

`npm run test:tools` (→ `scripts/test-catalog-tools.sh`) runs the 12 network-free
self-tests plus `cover-text-scan`'s network-free classify logic
(`--self-test-logic`), and is wired into CI so a regression in any tool script
fails the build. `cover-text-scan`'s **full** self-test (the end-to-end OCR pass)
is run separately because it downloads Tesseract traineddata.

## Status

Every stage above is built + self-tested. The one missing piece is the
**supplier-pull adapters** (Tillo/SVS/EzPin read-only fetchers) that fill stage 0
with raw supplier data — everything downstream is ready to consume it. See the
improvement plan for the outstanding-work detail.
