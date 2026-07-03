# ADR 040: Cloudflare edge in front of the Fly apps

## Status

Proposed (2026-07-03). Not yet implemented — the geolocation code path is already
in place (see Decision §1); this ADR records the topology decision and the
gotchas to get right before flipping DNS. Supersedes the "geo-IP is a MaxMind
lookup" assumption in ADR 033/034 as the _primary_ signal, without changing
those ADRs' path-based routing model.

## Context

Three problems, one shared fix.

1. **Geolocation is structurally unreliable.** ADR 033/034 resolve a visitor's
   country from the backend `/api/public/geo`, which reads the free **MaxMind
   GeoLite2** DB. The free DB has ISP-level coverage gaps: a real UK visitor on
   Box Broadband (`149.102.9.36`) resolves to an **empty** country, and empty
   falls through to `DEFAULT_COUNTRY = 'US'` — so a first-time UK user lands on
   the US site. Confirmed live 2026-07-03 (incognito → `/us/en`). A fresher or
   paid GeoLite2/GeoIP2 would raise the hit rate but never close the gap, and
   it's a DB we have to keep refreshing (see the GeoLite2-refresh orphaned-work
   item). #1520 added an `Accept-Language` backstop (an `en-GB` browser resolves
   to GB even when the IP is unknown) — but that leans on the browser's language
   preference, not the IP, so it's an **interim backstop, not a real fix**
   (an `en-US` browser in the UK, or a bare `en`, still misses).

2. **Fly gives us no edge geolocation.** Fly forwards the client IP but adds no
   country header, so MaxMind is the only server-side option and it's the one
   that's failing.

3. **EU latency + no launch hardening.** Both `loopfinance-web` machines run in
   `iad` (US-East), so UK/EU visitors are SSR'd from the US. There is also no
   WAF, DDoS protection, or CDN caching in front of the origin today.

Cloudflare's edge solves all three: its `CF-IPCountry` header geolocated the
_exact same failing IP_ correctly (verified 2026-07-03: `cdn-cgi/trace` →
`loc=GB`, `colo=LHR`), from a London edge, for free.

## Decision

Put **Cloudflare in front of the Fly apps** (proxied DNS: browser → Cloudflare
edge → Fly origin), and treat Cloudflare's edge as the primary source of the
three things it does better than our origin: geolocation, TLS/edge termination
near the user, and volumetric/WAF protection.

1. **Geolocation via `CF-IPCountry` — already coded.** `home-geo-redirect.tsx`
   already reads `cf-ipcountry` _before_ the backend MaxMind lookup and skips the
   `/api/public/geo` round-trip when it's present (precedence: saved cookie →
   `CF-IPCountry` → MaxMind → `Accept-Language` → default). So geolocation
   upgrades **automatically** the day traffic flows through Cloudflare — no
   further code change. MaxMind + the `Accept-Language` backstop stay as
   fallbacks (and cover the never-behind-CF dev/native cases).

2. **Incremental rollout.** Proxy `beta.loopfinance.io` and `api.loopfinance.io`
   first; verify geo, rate-limiting, and caching (below); then proxy apex/www at
   public launch. The apex staying on GitHub Pages until launch is unaffected.

3. **TLS: Full (strict).** Cloudflare terminates TLS at the edge; the origin
   (Fly) keeps its own certificate and Cloudflare validates it (Full **strict**,
   not Flexible) so the CF→origin hop is encrypted and authenticated.

4. **MaxMind becomes optional.** Once CF geo is proven in production we may retire
   the `.mmdb` build pipeline entirely (closing the GeoLite2-refresh item), or
   keep it as a thin fallback. Decide after CF is live, not now.

## Consequences

### Security — the load-bearing gotcha: only trust CF headers from CF

The moment we trust `CF-IPCountry` (geo) and `CF-Connecting-IP` (client IP for
rate-limiting), a request that reaches the Fly origin **directly** — bypassing
Cloudflare — could **spoof** them: forge any country, or forge a client IP to
evade per-IP rate limits (the `/api/auth/*` limiters, the global 600/min/IP
backstop). This is the one thing that must not ship half-done. Mitigation, in
order of preference:

- **Cloudflare Authenticated Origin Pulls (mTLS)** — the origin only accepts
  connections presenting Cloudflare's client cert. Strongest; preferred.
- **Lock the Fly origin to Cloudflare's published IP ranges** (fly.toml / a
  network rule), so direct-to-origin requests are refused.
- At minimum, a **shared secret header** set by a Cloudflare rule and required by
  the origin.

Until one of these is in place, `clientIpFor()` / the geo redirect must **not**
treat CF headers as authoritative. Track this as a hard prerequisite of the
cutover, not a follow-up.

### Client-IP source changes (rate limiting)

`middleware/rate-limit.ts:clientIpFor()` currently takes the **leftmost**
`X-Forwarded-For` entry under `TRUST_PROXY`. Behind Cloudflare the authoritative
client IP is `CF-Connecting-IP` (single value), and the XFF chain grows a hop
(client, …, cf-edge, fly-edge). Update `clientIpFor()` to prefer
`CF-Connecting-IP` when present (guarded by the origin-lock above) so per-IP
limits key on the real visitor, not a Cloudflare edge IP (which would bucket the
whole planet behind one edge and either nuke real users or neuter the limit).
Re-check `RATE_LIMIT_MACHINE_COUNT_ESTIMATE` at the same time — CF can absorb some
volumetric load at the edge, changing the per-machine budget maths.

### Caching rules (must not cache the dynamic surface)

Cloudflare must be configured to **bypass cache** for:

- `GET /` — the per-visitor geo `302` (a cached redirect would pin one visitor's
  country for everyone; this is exactly why ADR 034 mandates a 302, not a 301).
- everything authed and every `/api/*` **except** the deliberately-cacheable
  `/api/public/*` surface, which already sets its own `Cache-Control` (ADR 020) —
  Cloudflare can honour those headers.

Static hashed assets (JS/CSS/images) **should** be edge-cached — that's the CDN
win. The `/api/image` proxy already sets long cache headers and is a good edge-
cache candidate too.

### CORS / origins

`PRODUCTION_ORIGINS` (`middleware/cors.ts`) is unchanged — the browser-facing
hostnames don't change, Cloudflare just fronts them. Verify Cloudflare doesn't
strip or rewrite the `Origin` header (it doesn't by default) so preflight still
passes, and that the Capacitor native origins keep working (they don't traverse
Cloudflare — the native app calls `api.loopfinance.io` directly, which is fine).

### Cost / scope

Cloudflare's free tier covers `CF-IPCountry`, basic WAF, unmetered DDoS
mitigation, and CDN caching — sufficient for launch. No paid plan is assumed.

## Alternatives considered

- **Paid MaxMind GeoIP2** — better coverage than GeoLite2, but still a DB to
  maintain, still has gaps, and buys nothing for latency, WAF, or CDN. Rejected
  as strictly worse than CF for the same geo goal.
- **A geolocation API call per request** (ipinfo/ipapi) — adds an external
  dependency, latency, and a rate-limited third party on the hot `/` path.
  Rejected.
- **Stay Fly-only, lean on `Accept-Language`** — leaves the structural geo gap
  and the EU-latency/WAF gaps unsolved. Rejected; it's the interim state, not the
  destination.
