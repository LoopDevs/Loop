# ADR 014: Social login — Google and Apple

Status: Accepted
Date: 2026-04-21
Implemented: 2026-04-21 onwards (`POST /api/auth/social/google` + `/apple` in auth/social.ts; JWKS verification in auth/id-token.ts; identity resolve-or-create in auth/identities.ts — both handlers gated on `LOOP_AUTH_NATIVE_ENABLED` plus per-provider audience env configuration)
Related: ADR 013 (Loop-owned auth + CTX operator pool)

## Context

ADR 013 made Loop the identity provider: Loop mints JWTs, CTX is a
supplier behind an operator pool, users never see CTX. Identity is
proven by email OTP.

OTP works but is high-friction for return users: switch to email,
wait, copy a six-digit code, switch back, paste. Two additional
sign-in paths reduce that friction without changing the shape of the
resulting session:

- **Sign in with Google** — the dominant phone/email identity for
  Android and for the majority of desktop users.
- **Sign in with Apple** — mandatory on iOS if any third-party sign-in
  is offered ([App Store Review 4.8](https://developer.apple.com/app-store/review/guidelines/#sign-in-with-apple)),
  and the friction-lowest option for a large slice of iOS users.

The product framing is unchanged: all three paths (OTP, Google, Apple)
resolve to one Loop user row keyed by email, mint one Loop-signed
JWT pair, and feed the same `credits ledger` / admin / orders
surfaces. A user who signed up with OTP on day 1 and with Apple on
day 30 is one user.

## Decision

### Both providers use the authorization-code flow verified server-side

Mobile and web clients obtain an **id_token** from Google or Apple
(via the native SDK on device, or via the redirect flow on web) and
POST it to our backend. The backend verifies the id_token's signature
against the provider's JWKS, pulls `email` / `email_verified` /
`sub`, and issues a Loop-signed access + refresh pair — identical to
what `verify-otp` returns.

```
iOS / Android app ───┐
Web redirect flow ───┼─── id_token ───▶ POST /api/auth/social/{google|apple}
                     │                       │
                     │                       ▼
                     │                  verify signature vs JWKS,
                     │                  enforce audience,
                     │                  require email_verified,
                     │                  find-or-create users row,
                     │                  link identity in user_identities,
                     │                  mint Loop JWT pair
                     │                       │
                     └──◀── { accessToken, refreshToken } ──┘
```

Verifying on the backend (not just trusting the SDK's claim) is the
single most important security property. A compromised client can't
forge a Google / Apple `id_token` — the provider's signing key is
authoritative.

### Identity linking via a `user_identities` table

```sql
CREATE TABLE user_identities (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,     -- 'otp' | 'google' | 'apple'
  provider_sub  TEXT NOT NULL,     -- stable opaque id from the provider
  email_at_link TEXT NOT NULL,     -- email reported by the provider when first linked
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_sub)
);
```

- One row per provider identity per user. A user can link multiple
  providers over time.
- `UNIQUE(provider, provider_sub)` prevents the same Google account
  from resolving to two Loop users.
- `users.email` stays the principal — the `sub` claim in Loop JWTs is
  still `users.id`. Providers are recognition hints, not the identity.

### Resolution policy — match by verified email

On a successful social login:

1. Verify `id_token` signature, audience, expiry. Reject otherwise.
2. If the provider does not assert `email_verified = true`, reject.
   Apple sometimes returns a relay email (`@privaterelay.appleid.com`);
   that counts as verified (Apple has already run deliverability).
3. Look up `user_identities` by `(provider, provider_sub)`. If a row
   exists → resolve its `user_id`, issue the pair, done.
4. Otherwise look up `users` by lower-cased email. If a user exists
   → insert a new `user_identities` row linking the new provider,
   issue the pair.
5. Otherwise create a fresh `users` row, insert the `user_identities`
   row, issue the pair.

Step 4 is deliberate: a user who signed up via OTP and then chooses
"Sign in with Google" against the same email should land in the same
account — not a second one. The risk model accepts that Google /
Apple's email verification is sufficient; we do not require a second
OTP before linking.

### Apple-specific concerns

- Apple only returns the user's name + email on **first** login.
  Persist both on the very first `user_identities` insert; on
  subsequent logins Apple returns only the `sub`.
- The `email` claim may be a private relay. Store as-is — delivery
  via the relay works, and conversion to a real email is user-driven
  outside our system.
- The `team_id` + bundle-id is part of the audience check (`aud`
  claim). Hardcode the iOS app's audience in env; reject mismatches.

### Google-specific concerns

- The audience check pins the Google OAuth **client ID** matching the
  current platform (iOS / Android / web — they differ in Google
  Cloud Console and in the `id_token`). Similar pattern to our existing
  `CTX_CLIENT_ID_{WEB,IOS,ANDROID}` split.
- Google's JWKS endpoint rotates every few hours; cache keys with an
  expiry (1h), not indefinitely.

### Envelope

Two new endpoints, both unauthed (the id_token IS the auth):

```
POST /api/auth/social/google
  body: { idToken: string, platform: 'web' | 'ios' | 'android' }
  → { accessToken, refreshToken }

POST /api/auth/social/apple
  body: { idToken: string, platform: 'web' | 'ios' | 'android' }
  → { accessToken, refreshToken }
```

Rate-limited per-IP identically to `/verify-otp` (10/min). Fronted by
a new `getUpstreamCircuit('google-jwks')` / `getUpstreamCircuit('apple-jwks')`
so a provider JWKS outage doesn't pin request handling threads.

### Secrets

- `GOOGLE_OAUTH_CLIENT_ID_WEB`, `GOOGLE_OAUTH_CLIENT_ID_IOS`,
  `GOOGLE_OAUTH_CLIENT_ID_ANDROID` — audience allowlist.
- `APPLE_SIGN_IN_SERVICE_ID` — audience for the Apple id_token
  (services ID + native bundle ID).
- No provider **secret** is needed on the backend for the id_token
  flow (we only verify signatures). The "Sign in with Apple" native
  token-exchange requires a signed JWT client_secret if/when we add
  server-to-server refresh; deferred.

### What doesn't change

- Loop JWT shape (ADR 013).
- Refresh-token rotation, refresh_tokens table, revocation flows.
- OTP path remains; users can freely mix and match provider + OTP.
- `requireAuth`'s dual-validation path — social logins issue standard
  Loop-signed access tokens, no middleware change.

## Consequences

### Positive

- 2-tap sign-in on phones; 1-click sign-in on web.
- iOS App Store compliance (Sign in with Apple is now mandatory given
  Google will be live as an alternative provider).
- Identity linking by verified email means a user trying both paths
  doesn't end up with duplicate accounts.

### Negative

- Dependency on Google + Apple SDK surfaces on the mobile side.
  Maintenance cost is low (both SDKs are stable) but real.
- JWKS fetch on every login (with cache) means a provider outage
  blocks social sign-in. OTP remains the fallback.
- Store-of-record complication: a user can now disable their Google
  account and still have a live Loop session. This is correct — the
  Loop refresh token is independent of the provider — but it means
  "revoke Loop access by dropping Google" is not a path we offer.
  Users revoke via sign-out or `DELETE /api/auth/session/all`.

### Deferred

- **Account linking UI** (link/unlink providers from a settings
  page). Not a blocker for first sign-up; can ship after launch.
- **Apple server-to-server refresh** — we don't refresh Apple tokens
  today because we only use them for sign-in verification. If we ever
  need to query Apple for profile updates or honour Apple's
  account-delete notifications, revisit.
- **Google One Tap** on web. A nice-to-have, not a launch blocker.

## Rollout checklist

- [ ] ADR 013's `LOOP_AUTH_NATIVE_ENABLED` must be live first — social
      login only makes sense once Loop is the identity provider.
- [ ] Backend: `user_identities` table + migration
- [ ] Backend: `auth/verify-social.ts` — provider-agnostic verify +
      resolve-or-create
- [ ] Backend: `auth/google.ts` — JWKS fetch + cache, audience
      allowlist, id_token verify
- [ ] Backend: `auth/apple.ts` — same shape, Apple-specific claims
- [ ] Backend: `/api/auth/social/google` + `/api/auth/social/apple`
      endpoints (unauthed, per-IP rate-limited)
- [ ] Env: Google client IDs (web/ios/android), Apple service ID
- [ ] Web: Google Sign-In button + redirect flow (on-device libraries
      exist)
- [ ] iOS: Sign in with Apple native button (required by App Store
      review guidelines)
- [ ] Android: Google Sign-In Credential Manager flow
- [ ] Observability: per-provider login volume + failure rate

## Open questions

- **Apple Developer enrolment vs TestFlight for Sign in with Apple.**
  The service-id audience is tied to the production bundle id. For
  TestFlight builds, the same bundle id applies; no separate service
  id needed.
- **Email-change flow.** Providers can update the email behind a
  `sub`. On each login, if the email differs from the last known
  value AND no other user row has it, update `users.email`. If there
  is a collision, surface a support path (merge flow) — deferred.
