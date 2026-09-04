# ADR 051: Single operator API key — retire the CTX operator pool

Status: Accepted
Date: 2026-08-27
Supersedes: ADR 013 §"CTX becomes a supplier behind a shared
operator-account pool" (the auth-takeover half of ADR 013 stands)
Related: ADR 010 (principal switch), ADR 013 (Loop-owned auth),
ADR 022 / 023 (admin drill patterns — operator axes retired here)

## Context

ADR 013 put a pool of CTX _user-session bearers_ between Loop and
CTX: several service accounts, round-robin selection, per-operator
circuit breakers, and failover. The pool existed because Loop was
talking to CTX as an ordinary retail customer — bearers expired, a
fraud freeze on one account could take the product down, per-account
rate limits applied, and rotating a single bearer was a flag-day.

The CTX interop work has since made Loop a first-class operator in
the CTX namespace:

- Loop authenticates every server-to-server call with its company
  API key (`X-Api-Key` / `X-Api-Secret`) — a long-lived credential
  scoped to Loop's company, not a session bearer that expires.
- The attributed-operator-traffic contract lets that one credential
  act on behalf of any provisioned customer (`X-User-Id`) and stamp
  the request-origin client (`X-Client-Id`), so per-user attribution
  no longer needs distinct accounts.
- Rate limits, lockout policy, and quotas are negotiated CTX-side at
  the company level — Loop is an internal partner, not an anonymous
  account that fraud heuristics might freeze.

Every problem the pool solved is solved upstream. What remained was
pure carrying cost: pool config (`CTX_OPERATOR_POOL`), selection +
failover logic, per-operator breakers, the `ctx_operator_id` order
stamp (only ever written with the placeholder `'pool'`), and an
admin "operator fleet" observability surface (stats, latency,
mix-axis drills, snapshot CSV) rendering a distribution that no
longer exists.

## Decision

- All CTX calls go through one client, `ctx/api-fetch.ts::ctxFetch`,
  authenticated with `GIFT_CARD_API_KEY` / `GIFT_CARD_API_SECRET`.
  Callers may pre-set `X-User-Id` (act-as) and `X-Client-Id`;
  `ctxFetch` fills `X-Client-Id` from `CTX_CLIENT_ID_WEB` when the
  caller didn't.
- The SSE gift-card stream authenticates with the same header pair
  (`ctxApiCredentials()`), dropping the bearer-in-query workaround —
  that existed only for browser EventSource, which the server-side
  stream never was.
- What survives from the pool era, because callers depend on the
  semantics: a single upstream circuit breaker (OPEN → defer), 429 →
  `CtxRateLimitedError` carrying `Retry-After` (procurement backs
  off instead of failing paid orders), 401 → credential alert +
  breaker forced OPEN + transient `CtxUnavailableError` (orders stay
  retryable while the key is rotated), 30s default timeout, and
  `X-Request-Id` propagation.
- Removed: `CTX_OPERATOR_POOL`; `orders.ctx_operator_id` + its two
  indexes (migration 0075); the per-operator admin endpoints
  (`/api/admin/operator-stats`, `/operators/latency`,
  `/operators/:id/{supplier-spend,activity,merchant-mix}`,
  `/merchants/:id/operator-mix`, `/users/:id/operator-mix`,
  `/operators-snapshot.csv`) and their web pages/cards; the
  treasury snapshot's `operatorPool` section (now `ctxApi:
{ configured, state }`); `notifyOperatorPoolExhausted` and the
  per-operator credential alert (now the single
  `notifyCtxCredentialInvalid`).

## Consequences

### Positive

- One credential, one breaker, one health signal. `/health` and the
  admin treasury page report a single CTX upstream state instead of
  a pool distribution.
- No bearer expiry class of incident: the API key doesn't rot on a
  session TTL, and rotation is an env swap coordinated with CTX,
  not a flag-day across N accounts.
- CTX-side observability replaces the Loop-side fleet drill: with
  act-as attribution, CTX's own admin tooling sees real per-user
  traffic under Loop's company, which is where supplier-side
  questions belong.

### Negative

- A 401 (key revoked/rotated upstream) is now a full CTX outage
  rather than a degraded pool — mitigated by the breaker-defer
  posture (paid orders revert to `paid` and retry) and the
  10-min-deduped credential alert.
- A CTX-side rate limit has no second lane to fail over to. This is
  deliberate: limits are company-scoped now, so the fix is quota
  coordination with CTX ops, not multiplexing accounts.

## Rollout

No phased migration: the pool was configured but the API-key path
already carried provisioning, merchant sync, commission reads, and
attributed purchases. Deploy = env cleanup (`CTX_OPERATOR_POOL`
removed) + migration 0075.
