# ADR 033: IP geolocation for the region selector

## Status

Accepted

## Context

loopfinance.io is gaining a region selector (US / CA / UK / EUR, top-right of the
navbar) that filters the merchant catalogue and sets the price-display currency.
The selector's _first guess_ should match the visitor's location so the catalogue is
relevant on first paint, before any account exists — then the user can override it.

We need a server-side IP→country lookup (the browser can't see its own public IP /
country reliably, and `navigator.language` is only a weak fallback).

## Decision

- Add the **`maxmind`** npm package to `apps/backend` — a small, pure-JS reader for
  MaxMind `.mmdb` databases (no native bindings) — and read a self-hosted
  **GeoLite2-Country** database. The `.mmdb` is **operator-provided** (it carries a
  MaxMind licence, so it is _not_ committed) via the `MAXMIND_GEOLITE2_PATH` env var.
- Expose **`GET /api/public/geo`** following the ADR 020 public-surface discipline:
  unauthenticated, **never-500**, `Cache-Control` set, **no-PII**. It returns
  `{ countryCode, region }` (shape: `GeoResponse` in `@loop/shared`). The client IP is
  resolved with the existing `clientIpFor` helper (TRUST_PROXY-aware); **only the country
  code leaves the server** — the IP is never returned or logged here.
- **Graceful degradation:** if `MAXMIND_GEOLITE2_PATH` is unset/missing or the lookup
  fails, the endpoint returns `{ countryCode: '', region: 'US' }` (the default). The
  selector still works; the first guess simply defaults to US and the web client falls
  back to `navigator.language`.

## Consequences

- One new dependency (`maxmind`) in the backend; reader is lazy-opened + cached.
- Ops must provision `GeoLite2-Country.mmdb` and set `MAXMIND_GEOLITE2_PATH` for live
  geolocation. Documented in `docs/development.md` / `.env.example`.
- The region's currency is **display-only**. It is intentionally decoupled from the
  cashback _home currency_ (USDLOOP/GBPLOOP/EURLOOP, ADR 015). There is no CADLOOP asset,
  so a CAD home-currency / CAD cashback is **out of scope** here — CA visitors see CA
  merchants and CAD-formatted prices, with cashback still settling in a supported LOOP
  asset until a CAD-backed asset exists.
