# ADR 013: Loop-owned auth and CTX operator-account pool

Status: Accepted
Date: 2026-04-21
Implemented: 2026-04-21 onwards (HS256 JWT minting in auth/tokens.ts, OTP generation in auth/otps.ts, native-handler dispatch in auth/native.ts, refresh-token rotation + reuse-detection in auth/refresh-tokens.ts, CTX operator pool in ctx/operator-pool.ts — all gated on `LOOP_AUTH_NATIVE_ENABLED`)
Related: ADR 009 (credits ledger), ADR 010 (principal switch), ADR 011 (admin panel), ADR 012 (Drizzle + Fly Postgres)

## Context

Today, every Loop user is also a CTX user. Auth flows proxy through
CTX: request-otp and verify-otp hit `spend.ctx.com`, CTX sends the
email, CTX issues the access/refresh pair, and our backend forwards
those upstream tokens straight to the client. The `sub` claim in the
JWT is a CTX user id, and every authenticated request carries that
bearer into CTX.

Three problems compound once we ship ADR 010 (principal switch):

1. **Loop becomes the merchant of record.** Under ADR 010 users pay
   Loop, and Loop procures wholesale from CTX. There is no CTX-side
   user identity to attach a purchase to — the purchase is Loop's, the
   gift-card fulfilment with CTX is a server-to-server transaction.
   Creating a per-user CTX account for every Loop user is pure
   friction.

2. **CTX becomes a supplier, not a brand surface.** In the cashback
   product, the user's counterparty is Loop. CTX is a wholesale API
   that exchanges money for gift-card codes. The user should never
   see a CTX email, a CTX branded OTP, a CTX account, or any CTX
   failure mode. Today the "Loop" OTP email is actually rendered by
   CTX and simply branded — that's a leaky abstraction that will
   bite the moment we switch rails.

3. **The token on every request is not ours.** We cannot attach
   cashback state, admin roles, or ledger rows to a token we do not
   control. ADR 011 already had to paper over this by introspecting
   the CTX JWT's `sub` (ADR 012 `jwt.ts`, decode-only) and upserting
   a Loop user on demand. That works as a transitional shim; it is
   not where we want to live.

We have one unusual advantage: **Loop owns CTX**. The commercial
relationship is internal, so we have a free hand to redesign it — we
are not negotiating with a third party, we are rewiring two services
under the same roof.

## Decision

### Loop owns user identity end-to-end

- Loop sends the OTP email (branded Loop, from a Loop domain, via
  a provider we control — Resend / Postmark / SES, decision deferred
  to an infra PR).
- Loop issues Loop-signed JWTs. The `sub` claim is the Loop user's
  internal UUID (`users.id`), not a CTX identifier.
- Loop keeps the refresh token in Keychain / EncryptedSharedPreferences
  (already the case — ADR 006) but the token is now minted by Loop.
- No user-level credential ever leaves Loop to CTX.

After this lands, a Loop user row is authoritative. `users.id`
is the `sub` that everything downstream — credit balances, orders,
admin state — keys on.

### CTX becomes a supplier behind a shared operator-account pool

The backend holds credentials for one _and at least one backup_ CTX
operator account. All CTX API calls — order creation, merchant sync,
location sync, image proxy of merchant logos — use one of these
shared accounts. CTX treats Loop as a single high-throughput
customer, not as a proxy for thousands of end users.

```
┌─────────────────────────────────────────────────────────────┐
│ User                                                        │
│   ↕ Loop OTP + Loop JWT                                     │
├─────────────────────────────────────────────────────────────┤
│ Loop backend                                                │
│   • issues Loop tokens                                      │
│   • stores users.id ↔ email                                 │
│   • selects a healthy CTX operator from the pool            │
│   ↕ CTX operator bearer (rotated, not per-user)             │
├─────────────────────────────────────────────────────────────┤
│ CTX upstream                                                │
│   • sees N operator accounts, not N million users           │
└─────────────────────────────────────────────────────────────┘
```

### Why a _pool_, not a single operator account

A single account is a single point of failure. Specifically:

- **Rate limits.** CTX's per-account throttles apply whether the
  requests came from one human or a million. A spike in gift-card
  orders during a promo can 429 the one account; a second account
  gives us a lane to fall over to.
- **Lockouts.** Any fraud-detection or "unusual activity" freeze on
  the operator account takes the entire Loop product offline for
  the duration of a human support round-trip with CTX. Backups mean
  the user never sees this.
- **Rotation.** Rotating a single operator's secret is a flag-day —
  there is no way to deploy the new secret without a window where
  one of {old, new} is rejected. A pool lets us add `operator-b` with
  a new secret, promote it, and drain `operator-a` asynchronously.

Operator selection is per-request and deliberately simple:

- Each operator has a circuit-breaker keyed on CTX-side failures
  (same module as today's per-endpoint breakers).
- Requests route to the least-recently-used healthy operator (round
  robin among healthy, skipping OPEN-state ones).
- A HALF_OPEN operator probes on one synthetic request before being
  re-admitted.

### Migration path (there is existing traffic)

Every existing Loop install has a CTX-signed refresh token in secure
storage. We cannot force them all to re-sign-in on upgrade without
losing sessions.

Phased rollout:

1. **Phase A — Loop JWTs ride alongside CTX tokens.** Loop starts
   issuing its own OTP and Loop-signed JWTs. On each authed request
   the backend accepts either a Loop JWT or a legacy CTX JWT
   (existing `decodeJwtPayload` path). New sessions are Loop-minted;
   old sessions keep working on the CTX shape until the refresh
   token expires naturally.
2. **Phase B — CTX-sub upgrade.** When a legacy CTX bearer arrives,
   the backend resolves or creates the matching Loop `users` row
   (already implemented in `db/users.ts`). On the next refresh, the
   response contains Loop-signed tokens; the client transparently
   swaps.
3. **Phase C — CTX-token acceptance removed.** After the legacy
   refresh horizon (≥30 days — long enough that any client that
   has opened the app once since rollout has migrated), drop the
   CTX-token code path. `require-admin.ts` and `require-auth.ts`
   verify Loop signatures only; `decodeJwtPayload` and the CTX
   refresh proxy are deleted.

### Token format

Loop JWTs are HS256-signed with a secret in `LOOP_JWT_SIGNING_KEY`.

Claims:

- `sub`: `users.id` (UUID)
- `email`: user email (kept in the claim so the client doesn't need
  a separate `/me` round-trip — also useful for Sentry tagging)
- `iat`, `exp`: standard
- `typ`: `'access'` | `'refresh'` — distinguishes token roles; the
  refresh-only endpoint refuses an access typ and vice versa

Access tokens: 15 min. Refresh tokens: 30 days, rotated on every use
(mirrors CTX's behaviour — and the
[`project_ctx_refresh_rotation`](../../memory/project_ctx_refresh_rotation.md)
note calls this out as a known pattern in our current proxy).

RS256 is deferred. HS256 is adequate for a single-service verifier
(the backend both signs and verifies), and a key rotation is simpler
without a JWKS. If a second service needs to verify tokens offline,
revisit.

### Secrets

- `LOOP_JWT_SIGNING_KEY` (backend env) — symmetric HS256 secret.
  Rotated by running two-key overlap: sign with key B, verify with
  {A, B} for the access-token TTL, then drop A.
- `CTX_OPERATOR_POOL` (backend env) — JSON array:
  `[{id, bearer, refreshToken, status}]`. Rotated operator-by-operator
  without downtime; the backend refreshes each entry's access token
  independently on its own cadence.

Both land in the env schema with the usual zod validation. Absent
`CTX_OPERATOR_POOL`, the backend logs a loud warn but still boots —
merchant / locations sync degrades gracefully; order creation
returns 503 (no operator available).

### What doesn't change

- `@aparajita/capacitor-secure-storage` is still where refresh
  tokens live on device (ADR 006).
- The Zustand auth store shape is unchanged — the client doesn't
  care who signed the token as long as the backend accepts it on
  refresh.
- Per-user rate limits on `/api/auth/*` still stand (CTX operator
  rate limits are separate and pool-wide).
- Existing admin allowlist (`ADMIN_CTX_USER_IDS`) is kept as a
  transitional alias; once migration is complete it's replaced with
  `ADMIN_USER_IDS` keyed on Loop UUIDs. Both live in env during the
  overlap window.

## Consequences

### Positive

- Loop-branded auth that actually originates at Loop. No user-facing
  artefact of CTX remains.
- The per-request token is Loop's, so attaching ledger / admin /
  role state to it is no longer a shim — it's the native identity.
- Operator pool isolates the product from a single CTX-side
  incident (lock / rate-limit / rotation).
- CTX calls collapse to ~N operator accounts — a simpler posture to
  monitor and a smaller surface for CTX-side policy changes.

### Negative

- We become responsible for OTP deliverability. If the email
  provider blips, we can't send OTPs. Mitigation: the provider is a
  managed SaaS with its own SLA; we add a fallback provider via an
  abstraction in `apps/backend/src/auth/email.ts`.
- We become responsible for refresh-token rotation correctness. A
  bug here is a silent session-loss for all users. Mitigation: the
  rotation is exercised in integration tests that pin the refresh
  `typ` and verify single-use semantics.
- More backend state: `refresh_tokens` table (hash + user_id +
  expires_at + revoked_at). Adds a migration; already covered under
  ADR 012.

### Deferred

- Passwordless-via-magic-link (as an alternative to OTP) — same
  `auth/email.ts` surface accommodates it later.
- Device attestation (bind a refresh token to a specific device
  fingerprint) — nice to have, not a launch blocker.
- RS256 + JWKS — only relevant when a second service verifies Loop
  tokens offline.

## Rollout checklist

- [ ] Backend: `LOOP_JWT_SIGNING_KEY`, `CTX_OPERATOR_POOL` in env.ts
- [ ] Backend: `auth/email.ts` provider abstraction + one adapter
- [ ] Backend: `auth/tokens.ts` sign/verify for Loop JWTs
- [ ] Backend: `refresh_tokens` table + migration
- [ ] Backend: OTP table (hash + user_id + expires_at + consumed_at)
- [ ] Backend: `/api/auth/request-otp` + `/api/auth/verify-otp`
      implemented natively; existing proxy path stays alive behind
      a feature flag until Phase C
- [ ] Backend: Operator pool module + per-operator circuit breakers
- [ ] Backend: All `/gift-cards`, `/merchants`, `/locations` calls
      route through `operatorPool.fetch(...)` instead of the
      per-request bearer
- [ ] Migration job: any existing CTX-only `users` rows gain an
      `email` column populated from their next Loop-minted token
- [ ] Feature flag: `LOOP_AUTH_NATIVE_ENABLED` — flip per-env once
      email delivery is verified
- [ ] Observability: per-operator request volume + failure rate in
      the metrics endpoint; alerting on pool-wide health

## Open questions

- **Email provider**: Resend vs Postmark vs SES. Deferred to an
  infra PR after this ADR lands — all three fit `auth/email.ts` and
  the choice is reversible.
- **OTP length / expiry**: 6 digits, 10 min, single use. Matches
  CTX's current policy. Noted here so a later reviewer doesn't
  "improve" it without thinking about deliverability + UX.
- **Refresh-token revocation on password reset**: no password to
  reset. Revocation happens on explicit sign-out or on a security
  incident via `DELETE /api/auth/session/all` (bulk revoke by
  user_id).
