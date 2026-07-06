# ADR 041 — Media-pipeline tooling dependencies (tesseract.js, tldts)

**Status:** Accepted (2026-07-06)
**Context:** media/content pipeline v2 (`tools/ctx-catalog/IMPROVEMENT-PLAN-2026-07.md`)

## Context

The catalog media pipeline (`tools/ctx-catalog/`) is getting stronger automated
QC and sourcing (v2 plan Q2 + S1) so ~3,400 merchants can be covered without the
per-image human-review cost. Two capabilities need a library the repo doesn't
have:

- **Q2 — text-in-cover detection.** Covers must be storefront/scene photos, not
  promo/logo/text cards or watermarked stock. Detecting baked-in text needs OCR.
- **S1 — confidence-scored domain resolution.** The registrable root must be
  computed with the Public Suffix List (so `tesco.co.uk` → `tesco.co.uk`, not
  `co.uk`) — a hand-rolled "last two labels" is wrong for every ccTLD SLD, which
  is exactly the GB/AU/MX markets we're expanding into.

## Decision

Add two dependencies to the **root `devDependencies`**:

| Dep            | Used by                                      | Why this one                                                                                                                                                                                                                                                                                             |
| -------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tesseract.js` | `tools/ctx-catalog/cover-text-scan.mjs` (Q2) | Pure-WASM Tesseract — no native build / system binary, MIT. Runs the OCR locally, offline, zero per-call cost over the whole catalog. The alternative (a vision-model call per image) is Wave 4 (V1) for the _semantic_ judgments; deterministic OCR is the right, cheap first tier for "is there text". |
| `tldts`        | `tools/ctx-catalog/` domain resolver (S1)    | Actively-maintained Public Suffix List implementation, no native deps. Correct registrable-domain extraction across ccTLD SLDs.                                                                                                                                                                          |

**Why root `devDependencies`, and why this is low-risk:**

- `tools/ctx-catalog/` is not an npm workspace; its scripts already resolve deps
  from root `node_modules` (that's how they use `playwright` and `sharp` today).
- Both are **operator-tooling only** — imported exclusively by `tools/ctx-catalog/`
  scripts an operator runs by hand. They are **never imported by `apps/web`,
  `apps/backend`, or `packages/shared`**, so they are not in any shipped web
  bundle, the backend container image, or the mobile build. The
  `container-cve-scan` (trivy, prod image) and the web bundle-budget gate are
  unaffected; `devDependencies` keeps them out of production installs.
- An ESLint `no-restricted-imports` guard (added with S1) keeps
  `tesseract.js`/`tldts` out of `apps/**` and `packages/**`, so a future change
  can't accidentally pull an OCR/WASM blob into a shipped bundle.

## Consequences

- `npm audit` / `sbom` now include these + their transitive deps; both are
  well-maintained with no known criticals at adoption time.
- `tesseract.js` fetches its WASM core + language traineddata on first run
  (cached under the OS temp/cache dir). Operator-run, not latency-sensitive.
- Text detection is deterministic + free over the full catalog; the semantic
  "does this logo match the brand / is this cover a real scene" judgments remain
  the Claude-vision tier (v2 plan V1), which this does not add.
