# ADR 020: Public API surface conventions

Status: Accepted
Date: 2026-04-22
Related: ADR 009 (credits ledger), ADR 015 (stablecoin topology), ADR 018 (admin panel architecture), ADR 019 (`@loop/shared` package policy)

## Context

The cashback-app pivot added a new family of unauthenticated endpoints
under `/api/public/*`, serving landing-page / marketing / onboarding
data with a different failure-handling and caching posture than the
admin or user-scoped surfaces. These endpoints exist so the
loopfinance.io landing page can render headline numbers
("$X cashback paid to N users") and a "top cashback merchants" tile
without forcing a log-in.

Four endpoints in production or about to land under the prefix:

- `/api/public/stats` — app-wide headline counts.
- `/api/public/cashback-stats` — fleet-wide cashback totals + fulfilled
  order count, per-currency grouping.
- `/api/public/top-cashback-merchants` — CDN-friendly "best cashback"
  list for the landing tile.
- (plus the pre-existing `/api/config` surface that predates the
  prefix — it stays where it is).

Each shipped independently and each contributor picked a slightly
different posture on caching, rate limits, and failure fallback. The
last two landed with deliberate alignment to the first two. Writing
this ADR pins the shape so the next contributor inherits the pattern
rather than reinventing it.

This ADR is **descriptive**, not migratory — it names what's already
there. It has no bearing on the auth, admin, or user-scoped surfaces.

## Decision

### 1. Path prefix: `/api/public/*`

New unauthenticated, non-diagnostic endpoints mount under this prefix.

Pre-existing "public-by-nature" paths (`/api/config`,
`/api/clusters`, `/api/merchants`, `/api/merchants/by-slug/:slug`,
`/api/merchants/cashback-rates`, `/api/image`, `/api/health`) are
exempt — they existed before the pivot and renaming them would break
deployed client-side caches. Future additions follow the prefix.

### 2. Never 500 a marketing surface

A public endpoint must return a valid, parseable response on every DB
failure. The accepted shapes are, in order of preference:

1. **Last-known-good snapshot.** Cache the most recent successful
   response in-process. Serve it on the next failure with a shorter
   `max-age` so the CDN re-asks soon.
2. **Zero-shape bootstrap.** If no prior snapshot exists (cold start
   - immediate DB failure), serve a well-formed response with
     zero-valued counters, empty arrays, `asOf = now()`. The landing
     page's empty-state copy ("— cashback earned so far") is robust
     to zeros.

Never a 5xx.

### 3. Cache-Control

- **Success:** `Cache-Control: public, max-age=300` (5 minutes).
  These are aggregates, not transactional data. A brief staleness is
  preferable to hammering Postgres on every landing-page visit.
- **Fallback path:** `Cache-Control: public, max-age=60` (1 minute).
  Serve stale briefly, refresh soon so recovery is fast.

No ETag / `If-Modified-Since` plumbing yet. If CDN traffic warrants
it, add it as a follow-up ADR.

### 4. Rate limit: 60/min per IP

Matches the cold-page-load budget. Landing pages rendered via CDN
won't hit origin at all after the first visit in the 5-minute window,
so 60/min is generous for legitimate traffic and tight enough to
throttle a scraper once the CDN has warmed.

(The earlier draft of this ADR quoted 300/min — matching `/api/image`.
The current live setting is 60/min on all `/api/public/*` handlers.
This ADR records the live value; bumping it is a separate decision.)

### 5. Catalog eviction: drop the row, don't fall back

Distinct from admin (which falls back to a bare `merchantId` when the
catalog cache has evicted the underlying row). Public tiles can't
meaningfully render a bare id — the user has no way to act on it.
Filter the row out of the response instead. The landing tile silently
shows N−1 merchants rather than a broken card.

### 6. No PII, no per-user shape, no write paths

`/api/public/*` responses are:

- **Aggregate** (counts, sums, per-currency groupings).
- **Catalog** (merchant names, slugs, images — same data the
  `/api/merchants` surface serves).

They are never:

- Per-user (no `userId`, `email`, Stellar address, or balance).
- Write endpoints (no POST / PUT / DELETE under `/api/public/*`).

This keeps responses safely CDN-cacheable, log-safe, and eliminates
an entire class of cache-key-collision concerns (no per-user
variation means one cached response serves every visitor).

## Consequences

**Positive.**

- Landing page reliability: a DB incident doesn't brown out marketing
  surfaces.
- CDN amplification: 5-minute cache lifetime means origin load scales
  with distinct POPs, not visits.
- Safety: the no-PII rule makes cache invalidation trivial — all
  public responses are identical for every caller.
- Onboarding clarity: the six rules above tell a new contributor
  everything they need to add a new `/api/public/*` endpoint
  correctly.

**Negative.**

- **Freshness is lower** than authenticated surfaces. A landing-page
  "fulfilled orders" counter can be up to 5 minutes behind reality.
  Acceptable for marketing, unacceptable for transactional views —
  those stay in their respective auth-scoped surfaces.
- **Per-process last-known-good state** means a rolling restart or
  a fresh pod can temporarily serve zeros. Acceptable because the
  DB-failure window is short; a more robust solution (Redis-backed
  LKG) is not warranted.

## Open issues

- **Cross-region LKG.** Not yet — single Fly region, single pod per
  region. When we scale horizontally, the per-process LKG becomes a
  cache-incoherence source. Revisit via follow-up ADR at that point.
- **ETag / conditional GET.** Not implemented. Would halve origin
  load on landing-page reloads within the 5-minute window. Candidate
  for a follow-up.
- **Edge caching strategy.** Out of scope — which edge (Fly proxy,
  Cloudflare, bare Fly) is orthogonal to this ADR. The handler-level
  `Cache-Control` is the truth; the edge just honours it.

## Related

- ADR 018 — admin panel architecture — the sibling "drill-down /
  triage / compliance CSV" rules for the admin-scoped surface.
- ADR 019 — `@loop/shared` package policy — the cross-surface rule
  that `/api/public/*` response shapes are also
  candidates-for-extraction when the web needs to render them.
