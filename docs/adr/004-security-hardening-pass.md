# ADR 004: Security-hardening architectural decisions

Status: Accepted
Date: 2026-04-17

## Context

An audit sweep across the backend, shared, and web packages uncovered multiple
classes of issue that were addressed in a single hardening push. This document
records the architectural decisions made during that pass so future
maintainers understand _why_ the code looks the way it does, rather than
having to reconstruct intent from commit messages.

## Decision

### Per-endpoint circuit breakers

A single `upstreamCircuit` singleton used to wrap every call to
`spend.ctx.com`. One slow endpoint (e.g. `/merchants` sync) could push
consecutive failures past the threshold and trip the breaker for _all_
upstream traffic — auth, orders, everything — even if those endpoints were
healthy.

**Decision:** `getUpstreamCircuit(key)` returns a breaker scoped to a logical
endpoint category. Keys in current use: `login`, `verify-email`,
`refresh-token`, `logout`, `gift-cards`, `merchants`, `locations`. Each is
tracked independently. A failing endpoint only trips its own breaker.

**Alternative considered:** per-URL breakers (auto-derived from fetch URL).
Rejected: each `GET /gift-cards/:id` would get its own breaker and only a
small number of orders would trip it. The logical-key approach groups calls
to the same upstream service.

### Authoritative server-side `expiresAt`

The client used to compute `expiresAt = Date.now() + 30 * 60 * 1000` for the
payment window. Under clock skew that drifted from the server and either
expired the UI prematurely or showed remaining time on a server-expired
order.

**Decision:** Server issues `expiresAt` (unix seconds) in the
`CreateOrderResponse`. `ORDER_EXPIRY_SECONDS` is the single source of truth
in `apps/backend/src/orders/handler.ts`. If CTX ever returns its own expiry
on the `/gift-cards` response, we prefer it via `.passthrough()`.

### Coalesced refresh-token requests

When TanStack Query fired N authenticated requests in parallel on page load
and each hit a 401, each would POST `/api/auth/refresh` independently. CTX
rotates the refresh token on use, so only the first POST succeeded. The rest
failed with a stale token, cleared the session, and dropped the user out of
a perfectly valid session they'd just refreshed.

**Decision:** `tryRefresh()` in `apps/web/app/services/api-client.ts` is
backed by an in-flight `Promise` singleton. Concurrent callers — including
mount-time `useSessionRestore` and any active `authenticatedRequest` — share
the single pending refresh.

### Content-Security-Policy is restrictive by default

The backend serves only JSON/binary API responses, never HTML. Any browser
that interprets a response as HTML (e.g. via an injected attack) has no
legitimate reason to load sub-resources.

**Decision:** `secureHeaders` is configured with
`default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action
'none'`. Defense-in-depth against any future innerHTML-class XSS (one such
bug was caught in the hardening sweep itself: `ClusterMap` popups).

### Structured-field log redaction, not content scrubbing

pino redact paths cover Authorization headers, access/refresh tokens, OTP
codes, passwords, API keys across multiple nesting depths. But pino redact
is field-name-based: a token inside a raw `response.text()` string would
slip through unredacted.

**Decision:** All raw upstream response-bodies logged on error paths are
truncated to 500 characters before passing to the logger. Field-name
redaction is the primary line; truncation is defense-in-depth. We
deliberately do _not_ redact email — operators need it to debug auth
flows and the security benefit is marginal.

### Order of stricter ESLint over plugin coverage

`eslint-plugin-react` was loaded in the config but only to disable two of
its rules. The plugin's peer-dep is capped at eslint 9, which blocked the
eslint 10 upgrade.

**Decision:** Dropped the plugin entirely. We never extended its
`recommended` config, so no active rule was lost. Once
`eslint-plugin-react` publishes eslint 10 support, a follow-up PR should
add it back _with_ `recommended` enabled — rules like `jsx-key`,
`jsx-no-target-blank`, and `no-array-index-key` would have auto-caught
bugs this audit found (XSS via innerHTML merchant names; tabnabbing in
the inline WebView fallback).

### Native app is auth-gated; web is browse-first

Web users expect to browse merchants without signing in and hit auth only
at checkout. Native users have no such expectation — a logged-out native
install shows the same directory but can't transact.

**Decision:** `root.tsx` gates the entire React tree behind auth on
native (`useNativePlatform().isNative && !isAuthenticated` →
`<AuthRoute />`). Web flow is untouched. The tab bar hides when
unauthenticated.

## Consequences

- Circuit breaker state is no longer global; observability tooling must
  enumerate all active keys (`getAllCircuitStates()` on the `/metrics`
  endpoint handles this).
- Payment-window correctness relies on the server clock being accurate.
  Compromised by the same class of risk as any TLS-aware server: acceptable
  given our deployment model.
- Refresh coalescing is in-process state. Horizontal replicas don't share
  the lock — a user whose requests hit different replicas on a mobile
  network transition could still duplicate. Currently single-replica, so
  not an issue. Tracked as follow-up when we scale.
- CSP `default-src 'none'` means if we ever add any non-JSON API response
  that loads external resources (e.g. an HTML error page with an image),
  we must explicitly relax CSP on that route.
