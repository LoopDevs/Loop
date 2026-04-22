# ADR 020 — Public API surface conventions

**Status:** Accepted
**Date:** 2026-04-22
**Depends on:** ADR 011 (admin cashback config), ADR 015 (stablecoin topology), ADR 019 (admin three-tier data model)

## Context

The Loop backend exposes two audiences from the same Hono app:

1. **App clients** — authenticated users and admins, API under `/api/*` (auth, orders, cashback history, admin panel, …).
2. **The public web** — unauthenticated loopfinance.io visitors and mobile onboarding screens that show marketing numbers before login. API under `/api/public/*`.

The public surface grew fast during the cashback-app pivot:

- `/api/config` (pre-existing — not under `/public/` because it predates the naming rule, but serves the same role)
- `/api/public/stats` (#409) — Loop-wide cashback-paid / order-count aggregates
- `/api/public/top-cashback-merchants` (#430) — ordered marketing list
- `/api/public/cashback-stats` (#434) — headline aggregate ("N brands · avg X% · up to Y%")

Each landed with its own Cache-Control, rate limit, and failure-handling convention. ADR 019 names the pattern for admin endpoints; this ADR does the same for public endpoints so future additions don't drift.

## Decision

Every public endpoint follows the six rules below. Deviations require a note in the handler comment and, for anything surfaced on loopfinance.io, explicit sign-off because these endpoints determine whether the landing page renders.

### 1 — Path prefix: `/api/public/*`

All **new** unauthenticated, non-diagnostic, non-image-proxy endpoints mount under `/api/public/*`. Existing endpoints that predate this rule (`/api/config`, `/api/clusters`, `/api/merchants`, `/api/image`, `/api/health`) stay where they are — the prefix is about clarifying intent for new additions, not churning the URL surface.

The prefix signals three guarantees to reviewers: (a) no auth middleware, (b) no PII or per-user shape, (c) follows rules 2–6 below.

### 2 — Never 500 a marketing surface

Any endpoint that's rendered **above the fold on loopfinance.io or in the mobile onboarding flow** must return a valid response shape even when the DB is down, the merchant catalog is empty, or an upstream dependency is flaky.

The pattern is:

```ts
try {
  const rows = await db.execute(...)
  return c.json({ ...real shape... })
} catch (err) {
  log.error({ err }, 'Public X failed')
  c.header('Cache-Control', 'public, max-age=60')  // short fallback cache
  return c.json({ ...zero shape... })
}
```

The **shorter 60s cache on fallback** matters — without it, a transient DB blip pins the zero shape at the edge for the full 300s cache window. Short fallback cache means the next page load after the blip gets the real numbers.

Diagnostic endpoints (`/api/health`, `/api/image` SSRF rejections) still return 5xx. The rule is scoped to marketing-rendering endpoints.

### 3 — Cache-Control posture

| Response                            | `Cache-Control`            |
| ----------------------------------- | -------------------------- |
| Success                             | `public, max-age=300`      |
| Fallback (see rule 2)               | `public, max-age=60`       |
| Diagnostic (`/health`, image proxy) | per handler — out of scope |

300s is the sweet spot for cashback-config-derived headlines: admin config changes take ≤5 minutes to propagate to the marketing page, which is acceptable for a surface that changes rarely. If a future endpoint needs faster invalidation, it should introduce an ETag rather than shorten the cache for everyone.

`public` (not `private`) because these responses have **no user-identifying data** — they're safe to cache at CDN/edge layers.

### 4 — Rate limit: 300/min per IP

Matches `/api/image` (cold-page-load budget). Higher than admin snapshots (60/min) and auth flows (5–30/min) because landing-page visitors load multiple public endpoints in parallel on arrival.

No per-endpoint tuning within the `/public/*` tree unless a specific endpoint proves expensive under real traffic. Tune up from 300, never down — a public surface with a restrictive rate limit creates "works in dev, broken on Product Hunt launch day" risk.

### 5 — Catalog-eviction policy: drop, don't fallback

When a response references the in-memory merchant catalog (name, logo) and a merchant has been evicted upstream, **drop the row from the public response** rather than rendering the bare merchantId.

Differs deliberately from admin surfaces, which fall back to `merchantId` so support can still find the row. The public audience can't act on a bare id; partial data is worse than none.

Concretely, `/api/public/top-cashback-merchants` (#430) overshoots its DB fetch by 4× so after dropping catalog-evicted rows it can still fill the `?limit=` the client asked for.

### 6 — No PII, no per-user shape, no write paths

- No request body (`POST` / `PUT` / `DELETE` don't belong under `/public/*` — use a route outside the prefix, with auth).
- No `Authorization` header needed. If a route starts taking a bearer, move it out of `/public/*`.
- No user ids, emails, or Stellar addresses in the response. Aggregates only, or catalog data.

These three together make the responses safely CDN-cacheable and safe to log in full.

## Consequences

### Positive

- **New public endpoints land correctly by default.** A contributor adding "brands-by-category for the SEO page" knows it's under `/public/*`, 300/max-age, 300/min rate limit, never-500 — without asking.
- **Cache-Control is consistent.** CDN rules for loopfinance.io can be set once: the public prefix has a uniform caching policy.
- **Marketing page stability.** The never-500 rule means the landing page never breaks because of a backend incident — it degrades to zero numbers, which is still a usable page.

### Negative / open issues

- **Two existing endpoints are "public by nature, not by path"**: `/api/config`, `/api/clusters`, `/api/merchants`, `/api/image`, `/api/health`. Moving them would be a breaking URL change for mobile clients in the wild; they stay as-is and this ADR acknowledges the inconsistency.
- **No ETag plumbing.** The 300s cache is acceptable for cashback config changes; if a future endpoint needs sub-300s freshness, add an ETag-aware variant rather than shortening the cache universally.
- **"Marketing-rendering endpoints" is judgment-based.** The never-500 rule applies to anything that's rendered on loopfinance.io, mobile onboarding, or any surface where a 5xx would break first-contact UX. The handler comment should say where it renders so future edits preserve the contract.

## Non-goals

- **Not a CDN config.** `Cache-Control` headers make edge caching correct; the choice of edge (Fly proxy, Cloudflare, bare Fly) is orthogonal.
- **Not a rewriting plan for legacy paths.** Existing public-ish endpoints stay where they are.
- **Not an auth model.** `/public/*` means "no auth"; finer authz (user bearer, admin bearer) is ADR 013 / 019's domain.

## Rollout

- Descriptive: the four endpoints cited above already follow these rules. No migration.
- New public endpoint PRs must link this ADR in the description and name which of rules 1–6 they depart from (if any). "We're breaking rule 5 because …" is a valid explanation; silent deviation isn't.
- Reviewers should cite this ADR when a PR deviates. Same escalation pattern as ADR 019.
