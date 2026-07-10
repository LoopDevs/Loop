# ADR 048: First-party, cookieless privacy analytics (Core Web Vitals + page views)

Status: Accepted — implemented, dark by default
Date: 2026-07-10
Related: `docs/log-policy.md`, `docs/observability.md`, ADR 020 (public API surface)
Resolves: readiness-backlog/go-live-plan §P3 "privacy analytics"

## Context

Loop has no first-party real-user-monitoring signal. `docs/audit-2026-evidence/phase-13-observability.md`
(A2-1324) flagged this: Sentry's `browserTracingIntegration` captures
some Core Web Vitals as a side effect of error tracing, but only at the
10% `tracesSampleRate` (Sentry's standalone-span opt-in narrowed that
gap for LCP/CLS only — INP still isn't covered), and Sentry is an
error-tracking tool, not a RUM/analytics surface. There's no page-view
count and no vendor-neutral way to see "is the site fast for real
users" without reading Sentry's trace sample.

The obvious fix — a third-party analytics vendor (GA4, Plausible,
PostHog, …) — was deliberately not chosen:

- It's a new runtime dependency (script origin, CSP allowlist, data
  processor agreement) for a decision that doesn't need one yet.
- Most vendors default to cookies or a persistent client-side id,
  which pulls in a consent-banner requirement Loop doesn't otherwise
  need (no other cookie sets `docs/log-policy.md` tracks).
- Loop already runs a Prometheus `/metrics` surface
  (`docs/observability.md`) that operators scrape today — a small,
  first-party counter/histogram addition reuses that pipe instead of
  standing up a second one.

## Decision

Ship a **first-party, cookieless** capture path: the web app posts
Core Web Vitals + a page-view marker to the Loop backend, which folds
them into the existing `/metrics` Prometheus surface. No new vendor,
no DB table, no per-user or per-session identifier persisted anywhere.

### What's captured

- **Core Web Vitals** (LCP, INP, CLS, FCP, TTFB) via the
  [`web-vitals`](https://github.com/GoogleChrome/web-vitals) library
  (~2 KB gzipped, Google's reference implementation — the same metric
  definitions Chrome's own tooling and Sentry's standalone spans use).
- **A page view** — one event per app load, no route-level breakdown.
  Route-by-route granularity would need either a persistent session id
  (to dedupe an SPA's client-side navigations from the real entry) or
  a per-path Prometheus label, and per-path labels are an unbounded-
  cardinality risk on `/cashback/:merchant-slug` SEO pages. A single
  fleet-wide counter avoids both problems; per-route detail is a
  Sentry-trace / access-log concern, not this surface's job.

Nothing else — no click tracking, no scroll depth, no referrer, no
user agent parsing, no IP retention (the backend never persists the
caller's IP for this endpoint; it doesn't even read it).

### Privacy posture

- **Cookieless.** No cookie is set by this feature.
- **No persistent identifier.** The client keeps no localStorage id,
  no fingerprint, nothing that survives a page reload. If a future
  iteration needs session-scoped de-duplication, it stays in-memory
  and per-tab at most — never written to disk.
- **No PII in the wire body.** The POST body is `{ type: 'vital', name,
value }` or `{ type: 'pageview' }` — five enum values and a bounded
  number. There's nothing to redact because there's nothing personal
  to begin with.
- **Legal basis: legitimate interest**, not consent. GDPR Recital 47 /
  Art. 6(1)(f) — measuring whether the product is fast and used is a
  legitimate interest of the operator, and cookieless aggregate
  telemetry with no persistent identifier is exactly the profile GDPR
  guidance (and every DPA cookie-consent exemption list) treats as
  "strictly necessary"-adjacent and outside the ePrivacy cookie-consent
  trigger. No consent banner is added for this feature. If Loop later
  adds a vendor that sets a persistent id, that decision needs its own
  ADR and consent-flow work — this ADR does not pre-authorize it.
- **Aligns with `docs/log-policy.md`**: that doc's redaction/retention
  rules govern structured logs and DB rows. This endpoint writes to
  neither — it only increments in-memory Prometheus counters, which
  `docs/log-policy.md` doesn't currently scope (there's nothing to
  retain or purge; a restart zeroes the counters).

### The endpoint

`POST /api/public/rum` — new `/api/public/*` route (ADR 020
discipline: unauthenticated, never-500, no-PII, `Cache-Control:
no-store` since it's a write, not a cacheable read). Rate-limited
60/min per IP, matching every other public endpoint. Zod-validated,
bounded body (a five-value discriminated union — there's no dimension
along which a valid body can grow). A malformed body is a 400; nothing
else in the handler can throw (no I/O beyond an in-memory `Map`
increment), so the try/catch around the handler body is defensive, not
load-bearing.

Recorded into `/metrics`:

- `loop_web_vital_bucket{vital="LCP"|"INP"|"CLS"|"FCP"|"TTFB",le=…}` /
  `_sum` / `_count` — a Prometheus histogram per vital, bucketed at the
  vitals.dev "good" / "needs improvement" / "poor" thresholds. Unit
  varies by vital (ms for four of them, an unitless layout-shift score
  for CLS) — documented in the `# HELP` line since Prometheus has no
  native per-label unit concept.
- `loop_page_views_total` — a plain counter.

### The client

Env-gated on `VITE_ANALYTICS_ENABLED` (default unset/off — dark by
default, per the go-live-plan §P3 proportionality note: this ships the
capability, not an operator decision to turn it on). When enabled, a
tiny init hook (`apps/web/app/utils/analytics-lazy.ts`, same
idle-scheduled dynamic-import pattern as `sentry-lazy.ts`) dynamically
imports `web-vitals`, registers the five `on*` callbacks, and posts
each observation — plus one page-view marker — through
`apps/web/app/services/analytics.ts` (never a raw `fetch()` in a
component or hook, per the repo's `app/services/` boundary rule). The
POST is fire-and-forget: network failure, a 429, or the flag being off
never throws into the app or blocks rendering.

No CSP change is needed — `connect-src 'self' ${apiOrigin}` in
`apps/web/app/utils/security-headers.ts` already covers a same-origin/
API-origin POST.

## Consequences

- Operators get real p50/p95 Core Web Vitals + a page-view rate in the
  existing Prometheus/Grafana pipe, once one is stood up
  (`docs/observability.md` — the 🟢 code/config half is done; the 👤
  half, a real Prometheus instance, is a separate operator track).
- **Follow-up (👤 operator, not this PR):** flip `VITE_ANALYTICS_ENABLED=true`
  on a real deploy, and optionally add a Grafana panel for the new
  `loop_web_vital_*` / `loop_page_views_total` series (mirroring the
  panel-per-SLO pattern `docs/observability/grafana-dashboard.json`
  already uses). Neither blocks merge — the feature is inert until the
  flag flips.
- In-memory counters reset on every deploy/restart, same as every
  other `/metrics` counter in this codebase (`loop_requests_total`,
  `loop_rate_limit_hits_total`, …) — acceptable for a scrape-driven
  dashboard, not acceptable if someone later wants long-horizon RUM
  trends (that would need a real time-series backend, out of scope
  here).

## Alternatives considered

- **Third-party vendor (GA4 / Plausible / PostHog).** Rejected for
  now — see Context. Revisit if product analytics needs (funnels,
  cohorts, session replay) grow past what a Prometheus counter can
  express; that's a bigger decision deserving its own ADR + consent
  review, not a rider on the RUM-gap fix.
- **Route-level page-view breakdown.** Rejected — unbounded label
  cardinality on SEO merchant pages; see "What's captured" above.
- **Sentry standalone spans as the only signal.** Rejected as
  insufficient on its own — ties RUM visibility to a paid vendor's
  quota/sampling decisions and doesn't produce a page-view counter at
  all; this ADR adds a vendor-independent floor underneath it, it
  doesn't replace Sentry's tracing.
