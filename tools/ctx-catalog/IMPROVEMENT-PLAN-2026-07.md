# CTX catalog media/content pipeline — v2 improvement plan (2026-07)

Principal-engineer synthesis of a four-lens deep review (sourcing/prompts,
image QC/vision, automation/robustness, content model → app render). The media +
content system (branding, covers, descriptions, redemption instructions, terms)
is a core surface: it's what every merchant page and the whole directory look
like. Today it's at **3.2% live coverage** (109/3,468 CTX merchants) despite
**~1,150 merchants' worth of logos + full LLM-written info already sourced and
sitting un-applied** in `data/` (recovered 2026-07-04).

## The one-line diagnosis

**Everything is done as repair, not prevention.** Ambiguous brands are
disambiguated only in _archived second-pass_ scripts after QC fails; "is it
applied?" is rediscovered by GET-ing the whole catalog each run; every candidate
is pushed to human review because nothing carries a confidence score or an
auto-QC verdict. Flip each of those to _prevention_ and the per-merchant cost
collapses — which is what makes 3,400 merchants tractable.

---

## Target architecture

Four load-bearing concepts; every improvement hangs off one of them.

### 1. The brand brief — one canonical per-merchant input

Compute once, read everywhere (kills sourcing leaks: ambiguity, wrong region,
ccTLD root, no family reuse):

```jsonc
{
  "id": "…",
  "name": "Aerie US",
  "brandBase": "Aerie", // country-stripped
  "aliases": ["American Eagle Aerie"],
  "registrableDomain": "ae.com", // Public Suffix List, NOT last-2-labels
  "countryDomain": "ae.com", // ccTLD storefront if one exists
  "country": "US",
  "currency": "USD",
  "category": "apparel", // seed from the `vertical` already in ctx-media-final
  "supplierUrls": { "tillo": "…", "svs": null, "ezpin": null },
  "variantOf": "brand:aerie", // family key → share logo across regional variants
  "domainConfidence": 0.92,
}
```

### 2. `merchant-state.json` — the durable lifecycle ledger (git-tracked)

The single source of truth the whole pipeline reads/writes, keyed by CTX id:

```jsonc
"<ctxId>": {
  "sourced":  { "logo": true, "cover": true, "info": true },
  "qc":       { "logo": "pass", "cover": "flag:text" },        // deterministic gate verdict
  "reviewed": { "logo": "yes", "cover": null },                // human/vision verdict (null=unseen)
  "applied":  { "logo": "2026-07-04T…Z+s3url", "cover": null },// ISO ts once PUT succeeds
  "ctxHas":   { "logo": true, "cover": false } }               // last observed live state
```

Because `applied.*` records a timestamp, **resume is a local filter — no
network**. Rebuilt/updated by `coverage.mjs` + written in place by apply/QC/review.

### 3. Tiered QC — humans see only what the machine can't decide

```
source → [Tier 1: deterministic auto-gate] → [Tier 2: Claude vision] → [Tier 3: human ✓/✗] → apply
             sharp + OCR, per-image                only ambiguous +          only the residue
             reject / flag / pass                  semantic (wrong-brand)
```

Today Tier 1 is thin (dims + blank + an _archived_ blur scorer) and Tiers 2/3
are the same thing — a person eyeballing contact sheets. That's why all ~1,039
rows went to review and only ~40 got a verdict.

### 4. Coverage-driven + safe apply

`coverage.mjs` (grown from `recount.mjs`) rebuilds the ledger and emits
`coverage.json` (per-merchant matrix), `coverage-report.md` (the 3.2%→100%
board, per-country/supplier), and `queue-{source,apply}.json` (the exact gap
sets the next stage consumes). New merchants from supplier resyncs auto-enqueue
(diff fresh pull vs ledger). Apply is **dry-run by default, `--apply` to write**,
idempotent from `applied.*`, with a printed plan + a `data/plans/<ts>.json`
preview.

---

## Roadmap (prioritized; each is a serial PR)

Ordered by leverage × safety. `[dep]` = needs a dependency decision, `[CTX]` =
needs `CTX_TOKEN` to run against production.

### Wave 1 — foundations (mechanical, unblocks everything, no prod writes)

- **M1 · `CTX_DATA_DIR` + `paths.mjs`.** One helper; replace every hardcoded
  `/tmp/…` with `dataPath('…')` defaulting to the git-tracked `data/`. Kills the
  "cp from /tmp or lose it" failure class. Keep `/tmp` only for the throwaway
  image proxy cache. _~1 hr, mechanical._
- **M2 · Migrate `review-decisions.json` → `merchant-state.json`** and repoint
  `review-server` to read/write the ledger. Preserves the ~40 verdicts; makes
  review resumable.
- **M3 · Un-archive `ctx-apply.mjs` to `./` as the canonical applier; make
  `--apply` the write gate (dry-run default) + plan-file preview.** Resolves the
  contradiction that the _safe_ applier is marked do-not-run while the no-gate
  bulk writers aren't. Extract the throttle/backoff/idempotency into a shared
  `ctx-write.mjs` every writer imports.

### Wave 2 — the auto-QC gate (your two explicit asks + more; sharp-only, no dep)

- **Q1 · `image-qc.mjs` (sharp-only) — the deterministic gate.** Promote
  `archive/brandqc-prep.mjs`'s Laplacian-variance blur scorer out of archive, and
  add:
  - **Upscale / low-quality-at-correct-resolution detection** — downscale→upscale
    **round-trip residual**: `recon = resize(resize(img, w/2), w, cubic)`;
    `residual = meanAbsDiff(img, recon)`. A detailed image loses real
    high-frequency content (high residual); a 128px-blown-to-512px one is nearly
    identical (low residual → reject). This is the detector for "right resolution
    but visually garbage." Iterate /2, /4 to estimate true source resolution.
  - **Blur** (Laplacian variance on the trimmed content bbox). Grounded
    thresholds from `data/brandqc-input.json`: cover reject <300 (p10=353), logo
    flag <150 (p25=155) — but never gate a logo on variance alone (minimalist
    wordmarks are legitimately low-energy).
  - **pHash near-duplicate** (dHash, Hamming clusters) — auto-flag when two
    _different_ brands share a near-identical logo. Catches the `ui-avatars` /
    logo.dev generic-monogram proliferation + reused supplier placeholders.
  - Transparent-vs-white-bg, padding/tiny-logo, near-uniform/placeholder/404.
  - Exports `scoreLogo(buf)` / `scoreCover(buf)` → called at _selection_ time
    (skip a bad candidate before it wins) **and** as a batch `qc-scan.mjs` writing
    `qc:{…}` into the ledger. `reject` auto-re-sources; only `flag` reaches humans.
- **Q2 · Text-in-cover detection.** `[dep]` Covers must be scenes, not
  promo/logo/text cards. Tier-1 **`tesseract.js`** (pure-WASM, no native build)
  over each cover: reject if text-area coverage >8%, or ≥5 confident words, or a
  stock-watermark token (`shutterstock|getty|alamy|©…`). Clean → pass;
  ambiguous band → Tier-2 vision. **Never run on logos** (wordmarks are text by
  design). _Needs an ADR for `tesseract.js`, or use the vision tier instead._

### Wave 3 — sourcing hit-rate (prevention, not repair)

- **S1 · Confidence-scored, country-aware domain resolver** (the keystone). A
  committed structured Claude call: given name/country/category/candidates, return
  `{domain, registrable, confidence, reason}` with a hard deny-list (marketplaces,
  gift-card resellers, socials). Auto-accept ≥0.8; rest → `domain-review-server`.
  Registrable via **Public Suffix List** (`tldts`), fixing `tesco.co.uk`→`co.uk`
  for the GB/AU/MX markets.
- **S2 · Category+country disambiguated _first-pass_ queries** using the
  `category`/`vertical` already in the data (`"Wickes DIY UK store interior"` not
  `"Wickes storefront"`) → the whole `qc-fixed`/`refix` re-source round largely
  disappears.
- **S3 · Explicit fallback ladder + `fallback=404`** (add it to
  `fetch-logos.mjs`), actually call `brand.dev` (documented, used nowhere),
  supplier-faceplate rejection on covers.
- **S4 · Codify the info-generation prompt + schema** (today ephemeral / off-repo)
  so `intro/description/instructions/terms` are reproducible + uniform for the
  ~2,300 newer brands, with a length/tone/no-price-claims contract.
- **S5 · Brand-family fan-out** — resolve once, share logo across regional
  variants (wire `ctx-crossredeem.mjs`'s family detection into the source step).

### Wave 4 — Claude vision Tier-2 (semantic QC)

- **V1 · Vision pass over the existing montages** — replace "human eyeballs the
  sheet" with a structured Claude vision call over the same 30-tile montage PNG:
  per-cell `{verdict: ok|wrong_brand|has_text|low_quality, reason}`. `[dep]`
  `@anthropic-ai/sdk`. Sweep with Haiku 4.5 / Sonnet 5 for throughput via the
  **Batches API** (50% off, not latency-sensitive), escalate borderline to Opus.
  This is the only place that catches **wrong-brand** (logo doesn't match name).

### Wave 5 — app-side (make partial coverage look intentional; ships independently)

- **A1 · Apply the recovered manifest.** `[CTX]` The single highest-leverage
  action: `ctx-apply --info data/ctx-info.json` (1,150 records) + `--images` (remap
  `headerUrl`→`cardImageUrl`) with `--apply-unless-rejected` → content coverage
  **3.2% → ~33%**, logos to ~1,154, with work already paid for. Blocked only on
  M3 (safe applier) + CTX_TOKEN.
- **A2 · Fix the `LazyImage` onError bug** (`components/ui/LazyImage.tsx:36-39`):
  a present-but-broken URL (logo.dev 404) renders a permanent blank grey box —
  _worse_ than no URL. Fall through to the letter/brand-color tile on error.
- **A3 · `brandColor` fallback tiles.** Add `brandColor` to `Merchant`; render
  fallbacks in the brand's color (cheap: deterministic HSL from name hash; better:
  extract dominant logo color at apply time) instead of the one identical blue
  gradient. Makes the directory look designed at any coverage.
- **A4 · Surface `intro` + `category`.** Both are sourced (intro at 100%, vertical
  on 431) and dropped by the sync (`sync-upstream.ts:124-152`,
  `handler.ts:167`) — add to `Merchant`, map, render as tagline + category pills
  (`MobileHome.tsx:44` already wants them).
- **A5 · Never-empty redemption section** — a minimal `Enter your code at checkout
on <domain>` default so "How to redeem" doesn't silently vanish (a trust hit at
  the conversion moment). Unify the monogram fallback across all card components.

## Dependencies / decisions needed

- **`CTX_TOKEN`** — to run coverage against CTX, verify the merchant-split apply
  state, and apply the recovered manifest (A1).
- **Dependency calls:** `tesseract.js` (Q2), `tldts`/PSL (S1), `@anthropic-ai/sdk`
  (V1) — each a small `[dep]` ADR, or Q2/V1 collapse into one vision-based path.
- **Sequencing:** Wave 1 → 2 → (3 ∥ 5) → 4. Wave 5 (app-side) is independent and
  can ship first for immediate UX gains; A1 (apply) is the biggest single win but
  needs M3 + CTX_TOKEN.

## Success measures

`coverage-report.md` tracked in git: % with logo / cover / info / applied, per
country + supplier; auto-QC reject rate; % auto-accepted at source (should rise
from ~4% toward >60%); human-review queue size per 1,000 merchants (should fall).
