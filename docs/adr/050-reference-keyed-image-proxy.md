# ADR 050 — Reference-keyed image proxy (retire the URL-driven API + host allowlist)

**Status:** Accepted (2026-08-27)

## Context

`GET /api/image?url=<encoded>` fetched, resized, and cached whatever URL
arrived in the query string. The URL was client-supplied on every
request — the merchant catalog was merely where the web app happened to
find the URLs it embedded. That made the endpoint a public SSRF gadget:
"make Loop's backend, from inside its network position, GET any address
I choose" — cloud-metadata endpoints, Fly `.internal` services, and an
error-code oracle for port-scanning. Keeping it safe required a stack
of controls: an unconditional loopback/private-IP rejection, a
DNS-rebinding connect-time re-check, the `IMAGE_PROXY_ALLOWED_HOSTS`
allowlist, and a production boot guard forcing the allowlist on (audit
A-025, hardened again by A2-654).

The unconditional loopback rejection also broke a legitimate dev flow:
a local CTX instance mints file URLs against its own base
(`http://localhost:7777/files/...`), which the proxy could never fetch.

Every image the proxy serves is one the backend can already name from
its own data: merchant logos/cards from the catalog store, map pins
from the locations feed, and order barcodes from the CTX gift-card
record. No consumer genuinely needs to supply a URL.

## Decision

**Key the proxy by reference, never by URL.**

- `GET /api/image?merchantId=<id>&kind=<logo|card|pin>` — the backend
  resolves the URL from the merchant store (`pin` from the locations
  feed, falling back to the logo), fetches, transforms, caches. The
  `v` param (merchant `updatedAt`) stays as the cache-busting version.
- `GET /api/orders/:id/barcode-image` — authed (mounts under the
  `/api/orders/*` `requireAuth` middleware; CTX bearer-scoping decides
  order visibility, same R3-11 trust boundary as `GET /api/orders/:id`).
  Resolves the barcode URL from the CTX order record per request and
  serves the bytes `private, no-store`, always JPEG. The previous flow
  forwarded the raw CTX URL to the client and proxied it through the
  **unauthenticated** URL API — this closes that too.
- **Retired:** the `url` param, `IMAGE_PROXY_ALLOWED_HOSTS`,
  `DISABLE_IMAGE_PROXY_ALLOWLIST_ENFORCEMENT`, and the A-025 production
  boot guard. With no client-supplied URLs there is nothing for an
  allowlist to bound — the control is structural now, which is the
  stronger tier (same reasoning as `docs/invariants.md`'s preference
  for DB/structural enforcement over configuration).
- **Residual defense-in-depth** (`images/ssrf-guard.ts`,
  `validateResolvedImageUrl`): the resolved URL is still CTX-controlled
  data, so a compromised CTX (or anyone with merchant-edit rights
  upstream) could point catalog URLs at internal targets. In
  production, resolved URLs must be HTTPS and every resolved address
  public (pre-flight + connect-time `ssrfSafeLookup`). Outside
  production the check passes any http(s) URL — which is what makes
  local CTX file hosts (`localhost:7777`) work in dev with no
  carve-out config.

## Consequences

- The client-driven SSRF class is gone structurally; two env vars, a
  boot guard, and a class of allowlist-rotation ops work disappear.
- Proxy URLs are stable references (`merchantId`+`kind`+`v`), so cache
  keys no longer multiply per upstream-URL variant.
- A merchant image renders only if the catalog knows the merchant —
  an evicted merchant's images 404 (matching ADR 021's public-drop
  semantics) instead of remaining fetchable by anyone holding the URL.
- Barcode images now require the order owner's auth; previously any
  holder of the CTX URL could pull them through the public proxy.
- A-025's tracker entry is superseded by this ADR: the finding's goal
  (bound what the proxy can fetch) is met structurally rather than by
  configuration.
