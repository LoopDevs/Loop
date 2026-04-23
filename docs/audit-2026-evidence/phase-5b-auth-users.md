# Phase 5b — Backend `auth/`, `ctx/`, `users/`, `config/` (evidence)

**Commit SHA at capture:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Date captured:** 2026-04-23
**Auditor:** cold-reviewer (Phase 5b)
**Scope:** `apps/backend/src/auth/**`, `apps/backend/src/ctx/**`, `apps/backend/src/users/**`, `apps/backend/src/config/**` (plus their `__tests__/`). Out of scope (other agents): `admin/`, `orders/`, `payments/`, `credits/`, `clustering/`, `merchants/`, `images/`, `public/`, `db/`, top-level files.

Primary evidence: file citations with line numbers, direct reads of handlers, openapi, app.ts, and test files.

Scope-discrepancy note: the Phase 5b ask listed `config/handler, history` — only `config/handler.ts` exists. The "config history" surface lives in `apps/backend/src/admin/configs-history.ts` and is therefore out of this phase's scope (admin bucket).

---

## 1. Per-file disposition

| File                                                   | Lines | Disposition        | Notes                                                                                                                  |
| ------------------------------------------------------ | ----- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/backend/src/auth/handler.ts`                     | 407   | audited-findings-4 | OTP / verify-otp / refresh / logout CTX-proxy + requireAuth middleware. See A2-550, A2-555, A2-558, A2-565             |
| `apps/backend/src/auth/jwt.ts`                         | 43    | audited-findings-1 | Unverified JWT decode — intentional, but callers trust output. See A2-550                                              |
| `apps/backend/src/auth/tokens.ts`                      | 173   | audited-clean      | HS256 sign+verify, dual-key rotation, timingSafeEqual, typ narrowing — correct                                         |
| `apps/backend/src/auth/native.ts`                      | 241   | audited-findings-2 | Loop-native request/verify/refresh. Docstring↔code drift on refresh-reuse. See A2-556, A2-557                          |
| `apps/backend/src/auth/otps.ts`                        | 132   | audited-findings-2 | 6-digit OTP generation + hashed storage. Off-by-one in attempts ceiling; increment scope. See A2-560, A2-561           |
| `apps/backend/src/auth/refresh-tokens.ts`              | 102   | audited-findings-1 | `revokeAllRefreshTokensForUser` exported but unwired. See A2-562                                                       |
| `apps/backend/src/auth/require-admin.ts`               | 56    | audited-findings-1 | Decodes bearer without signature verify; upsert → isAdmin from allowlist. See A2-550 (root cause)                      |
| `apps/backend/src/auth/social.ts`                      | 212   | audited-findings-3 | Google/Apple ID-token path. No nonce; iss drift; duplicate token-pair factory. See A2-566, A2-567, A2-568              |
| `apps/backend/src/auth/id-token.ts`                    | 245   | audited-findings-2 | JWKS fetch + RS256 verify. No `nbf`/`iat` guard; no `kid` enforcement on JWKS; Google iss variants. See A2-567, A2-569 |
| `apps/backend/src/auth/identities.ts`                  | 129   | audited-findings-1 | resolve-or-create races: duplicate-insert path on step-2 ↔ step-3 race. See A2-570                                     |
| `apps/backend/src/auth/email.ts`                       | 79    | audited-findings-1 | Production guard fails when `EMAIL_PROVIDER=console`. See A2-571                                                       |
| `apps/backend/src/ctx/operator-pool.ts`                | 210   | audited-findings-2 | 5xx not retried against second operator despite docstring; `initialised=true` before parse. See A2-572, A2-573         |
| `apps/backend/src/users/handler.ts`                    | 778   | audited-findings-3 | Every `/me` handler re-decodes bearer without verify for CTX path. See A2-550, A2-551, A2-552                          |
| `apps/backend/src/users/cashback-by-merchant.ts`       | 184   | audited-findings-1 | Duplicated resolver with same unverified-JWT weakness. See A2-550                                                      |
| `apps/backend/src/users/cashback-monthly.ts`           | 138   | audited-findings-1 | Duplicated resolver. See A2-550                                                                                        |
| `apps/backend/src/users/flywheel-stats.ts`             | 133   | audited-findings-1 | Duplicated resolver. See A2-550                                                                                        |
| `apps/backend/src/users/orders-summary.ts`             | 137   | audited-findings-1 | Duplicated resolver. See A2-550                                                                                        |
| `apps/backend/src/users/payment-method-share.ts`       | 171   | audited-findings-1 | Duplicated resolver. See A2-550                                                                                        |
| `apps/backend/src/users/stellar-trustlines.ts`         | 122   | audited-findings-1 | Duplicated resolver. See A2-550                                                                                        |
| `apps/backend/src/config/handler.ts`                   | 96    | audited-findings-1 | Unauth `/api/config`. `social` + `loopAssets` are public by design. See A2-574 (low)                                   |
| `apps/backend/src/auth/__tests__/*.test.ts`            | —     | audited-clean      | 12 test files. `require-auth.test.ts` line 109–119 documents the unverified CTX pass-through                           |
| `apps/backend/src/ctx/__tests__/operator-pool.test.ts` | —     | audited-clean      | Full exhaustion + throttle coverage                                                                                    |
| `apps/backend/src/users/__tests__/*.test.ts`           | —     | audited-clean      | 8 test files; all exercise Loop-native `userId` happy path + CTX fallback                                              |
| `apps/backend/src/config/__tests__/handler.test.ts`    | —     | audited-clean      | Shape-regression coverage                                                                                              |

Total in-scope source lines: 3,788.

---

## 2. Per-endpoint matrix

Columns: `auth` — gate applied; `rate` — per-IP limit/min from `app.ts`; `input` — zod schema; `openapi` — registered in `openapi.ts`; `idemp.` — write idempotency; `notes`.

| Method | Path                                    | auth                    | rate | input                   | openapi | idemp. | notes                                                                     |
| ------ | --------------------------------------- | ----------------------- | ---- | ----------------------- | ------- | ------ | ------------------------------------------------------------------------- |
| POST   | `/api/auth/request-otp`                 | public                  | 5    | `RequestOtpBody`        | yes     | n/a    | CTX-proxy default; native when flagged. A2-555 log shape.                 |
| POST   | `/api/auth/verify-otp`                  | public                  | 10   | `VerifyOtpBody`         | yes     | n/a    | A2-560/561 OTP attempts.                                                  |
| POST   | `/api/auth/refresh`                     | public                  | 30   | `RefreshBody`           | yes     | n/a    | Rotation correct in native; CTX path relies upstream.                     |
| POST   | `/api/auth/social/google`               | public                  | 10   | `{idToken}`             | **NO**  | n/a    | A2-568 not registered in openapi.                                         |
| POST   | `/api/auth/social/apple`                | public                  | 10   | `{idToken}`             | **NO**  | n/a    | A2-568 not registered in openapi.                                         |
| DELETE | `/api/auth/session`                     | public (tokens in body) | 20   | `LogoutBody`            | yes     | n/a    | A2-565 native refresh not revoked.                                        |
| GET    | `/api/config`                           | public                  | 120  | n/a                     | yes     | n/a    | Cache-Control: `public, max-age=600`.                                     |
| GET    | `/api/users/me`                         | requireAuth             | 60   | n/a                     | yes     | n/a    | A2-550 — unverified CTX JWT accepted.                                     |
| POST   | `/api/users/me/home-currency`           | requireAuth             | 10   | `{currency}`            | yes     | weak   | A2-551 (caller-identity laundering) + first-order guard is fine.          |
| PUT    | `/api/users/me/stellar-address`         | requireAuth             | 10   | `{address}`             | yes     | none   | A2-551 — attacker can redirect cashback payouts to their Stellar address. |
| GET    | `/api/users/me/stellar-trustlines`      | requireAuth             | 30   | n/a                     | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/cashback-history`        | requireAuth             | 60   | `?limit,?before`        | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/cashback-history.csv`    | requireAuth             | 6    | n/a                     | yes     | n/a    | A2-550. Cap 10,000 rows.                                                  |
| GET    | `/api/users/me/credits`                 | requireAuth             | 60   | n/a                     | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/pending-payouts`         | requireAuth             | 60   | `?state,?before,?limit` | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/pending-payouts/summary` | requireAuth             | 60   | n/a                     | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/pending-payouts/:id`     | requireAuth             | 60   | `:id`                   | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/orders/:orderId/payout`  | requireAuth             | 60   | `:orderId`              | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/cashback-summary`        | requireAuth             | 60   | n/a                     | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/cashback-by-merchant`    | requireAuth             | 60   | `?since,?limit`         | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/cashback-monthly`        | requireAuth             | 60   | n/a                     | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/orders/summary`          | requireAuth             | 60   | n/a                     | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/flywheel-stats`          | requireAuth             | 60   | n/a                     | yes     | n/a    | A2-550.                                                                   |
| GET    | `/api/users/me/payment-method-share`    | requireAuth             | 60   | `?state`                | yes     | n/a    | A2-550.                                                                   |

(Every `/api/users/me/*` also applies `Cache-Control: private, no-store` via `app.ts` L824-830. Every `/api/auth/*` response carries `Cache-Control: no-store` via `app.ts` L739-742.)

---

## 3. Threat-model-driven findings (summary)

- **OTP replay / timing:** code generation is CSPRNG-uniform (`randomInt`, `otps.ts` L32). Storage hashes SHA-256. DB equality of hashes on lookup — hash pre-image attack is the only reachable path, which is protected by CSPRNG. The per-row attempts ceiling is `<=` not `<`, off-by-one documented (A2-560). No timing-attack surface worth exploitation.
- **Refresh rotation:** Loop-native path verifies signature → fetches live row by `jti` → compares token hash → issues new pair → revokes the old row (`native.ts` L202-236). Rotation is **correct** for a well-behaved client, but a reused old refresh drops to a plain 401 rather than the defensive "revoke-all" the docstring promises (A2-556). ADR 013 Phase B intent is bulk-revoke; implementation missing.
- **JWT signing / rotation:** HS256 in `tokens.ts`, two-key overlap (`LOOP_JWT_SIGNING_KEY` + `PREVIOUS`), `timingSafeEqual`. `expectedType` narrows `access`/`refresh`. **Correct**. No `iss`/`aud` are set on the token, which is fine for a single-issuer single-audience service — noted but not a finding.
- **Email/Google/Apple verification:** id-token RS256 verified against JWKS (`id-token.ts`). `exp` is checked. `nbf` and `iat` are not. `iss` is exact-match, but Google's legal `iss` is `accounts.google.com` OR `https://accounts.google.com` (A2-567). No nonce binding is required (A2-566) — a captured id_token with valid `exp` can be replayed on our endpoint within the token TTL.
- **`require-admin` coverage:** every `/api/admin/*` is gated by `requireAuth` → `requireAdmin` in `app.ts` L940-941. No admin handler bypasses the chain. The admin gate itself re-decodes the bearer without verifying the signature (A2-550 root).
- **CTX operator pool:** per-operator circuit breakers, round-robin advance. Retry loop only catches `CircuitOpenError`, not 5xx (A2-572). Exhaustion alert is throttled at 15 min, fires once per quiet window.
- **`users/handler.ts` /me privilege escalation:** `setHomeCurrencyHandler` + `setStellarAddressHandler` Zod schemas restrict input fields; neither can directly flip `is_admin`. The **identity-laundering path** (A2-550 / A2-551) is the real route to harm: with a forged unverified JWT, a caller resolves to the victim's DB row and the stellar-address PUT rewrites the victim's payout destination.
- **`config/handler.ts`:** public by design. No PII. `social.*ClientId*` and `loopAssets.*issuer` are public identifiers. Single nit: `loopAuthNativeEnabled` and `loopOrdersEnabled` leak deployment state (useful reconnaissance but not sensitive). Accepted pattern, recorded as Info (A2-574).
- **Privacy in logs:** `email` is logged on OTP create / social reject / verify failure. pino-redact in `logger.ts` (out of scope) — spot-checked that `email` is not in the redaction key list. OTP codes are logged by the dev `ConsoleEmailProvider` at `info` (by design) but the prod guard is bypassable (A2-571).

---

## 4. Findings

### A2-550 — Unverified CTX-bearer JWT accepted; any claim `sub` resolves to the matching user row

**Severity:** Critical
**Files:** `apps/backend/src/auth/handler.ts:387-407`; `apps/backend/src/auth/jwt.ts:24-43`; every `resolveCallingUser` in `apps/backend/src/users/*.ts` (L93-105 of `handler.ts`, L74-86 of `cashback-by-merchant.ts`, L58-70 of `cashback-monthly.ts`, L59-71 of `flywheel-stats.ts`, L62-74 of `orders-summary.ts`, L64-74 of `payment-method-share.ts`, L55-67 of `stellar-trustlines.ts`); `apps/backend/src/auth/require-admin.ts:27-47`.
**Evidence:** `requireAuth` drops a malformed/bad-signature token to the CTX pass-through branch and calls `c.set('auth', { kind: 'ctx', bearerToken: token })` without any signature check. `auth/__tests__/require-auth.test.ts:109-119` pins this behaviour ("`ctxLike = 'header.payload.signature'`" accepted). Downstream, every `/me` handler re-decodes the same unverified bearer (`decodeJwtPayload(auth.bearerToken)`, header comment at `jwt.ts:1-12` openly states "never verifies the signature") and passes `claims.sub` to `upsertUserFromCtx` or reads `claims.email`.
**Exploitability / impact:** an attacker crafts `header.{"sub":"<victim-ctx-user-id>","email":"attacker@x"}.garbage` and calls any `/api/users/me/*`. `upsertUserFromCtx` finds the victim's existing row by `ctx_user_id` and returns it. `GET /me` leaks email / home-currency / balance / `isAdmin` / stellar address. `PUT /me/stellar-address` rewrites the victim's payout destination — future on-chain cashback goes to the attacker (see also A2-551). `requireAdmin` takes the same unverified path, so if the victim's CTX user id sits in `ADMIN_CTX_USER_IDS`, the attacker reaches every `/api/admin/*` handler. Pre-condition is "attacker knows the victim's CTX `sub`" — CTX subs are opaque but not protected as secrets: any past bearer leak (log, stack trace, screenshot) reveals them, and the admin allowlist env itself may be known to anyone who has seen the deployment config.
**Proposed remediation:** drop the CTX pass-through entirely once ADR 013 migration is past Phase A; until then, require `LOOP_AUTH_NATIVE_ENABLED=true` for every `/me/*` handler (so the route rejects CTX bearers) OR actually verify the CTX JWT signature (introspect upstream, or require `requireAuth` to call `GET /api/auth/me`-equivalent upstream before setting `auth`).

### A2-551 — `PUT /api/users/me/stellar-address` overwrites arbitrary user's payout destination

**Severity:** Critical
**Files:** `apps/backend/src/users/handler.ts:207-241`.
**Evidence:** handler resolves `user` via `resolveCallingUser(c)` — the unverified JWT path in A2-550. The `UPDATE users SET stellar_address = ... WHERE id = user.id` writes to whatever row `resolveCallingUser` returned.
**Exploitability / impact:** downstream of A2-550, an attacker can redirect every future on-chain cashback payout for the target user to an attacker-controlled Stellar public key. Pre-launch so no live funds are at stake yet, but this becomes real loss at Phase 2 unless A2-550 is closed.
**Proposed remediation:** fixed by A2-550. Defense in depth: verify `email` claim equality against `users.email` before update, or require a second factor (re-prompt OTP) for `stellar-address` changes.

### A2-552 — `/me/home-currency` race with `orders` count is guarded but not atomic

**Severity:** Low
**Files:** `apps/backend/src/users/handler.ts:130-189`.
**Evidence:** `setHomeCurrencyHandler` runs `SELECT COUNT(*) FROM orders WHERE user_id = user.id` → `UPDATE users SET home_currency`. No row lock or `WHERE order_count = 0` predicate on the UPDATE. A concurrent `POST /api/orders` can insert between the count and the update.
**Exploitability / impact:** user flips region just as the first order is posted; ledger pins `charge_currency` at order creation (ADR 015) so the user ends up with an order whose currency differs from `home_currency`. Low because the user has to be racing themselves during onboarding.
**Proposed remediation:** add `AND NOT EXISTS (SELECT 1 FROM orders WHERE user_id = users.id)` to the UPDATE; 0-row update → 409 `HOME_CURRENCY_LOCKED`.

### A2-555 — `auth/handler.ts` redundant `response.text()` still logs a 500-char window of upstream bodies

**Severity:** Info
**Files:** `apps/backend/src/auth/handler.ts:83-85`, `149`, `225-227`.
**Evidence:** comments ("pino redact only matches structured field names") justify the 500-char truncation; the truncation is correct. Info-only: a future upstream-drift incident that echoes a one-off JWT in a 5xx body would still write 500 chars of that JWT into the log stream. Consider a stricter sanitiser (regex for `ey[A-Za-z0-9_-]{20,}`) to zero-in on JWT shapes.
**Exploitability / impact:** depends on CTX's error-shape discipline. No current leak.
**Proposed remediation:** add a `sanitiseForLog` helper that strips JWT-shaped substrings before log-emit.

### A2-556 — `nativeRefreshHandler` does not revoke all sessions on reuse, contrary to its docstring

**Severity:** Medium
**Files:** `apps/backend/src/auth/native.ts:183-241`.
**Evidence:** docstring L187-191 claims "A reused refresh (already revoked) is a strong signal of token theft — we revoke all of that user's sessions defensively and reject the request." Implementation L215-221 simply `log.warn` + 401. `revokeAllRefreshTokensForUser` exists but is not called. ADR 013 L257 references `DELETE /api/auth/session/all (bulk revoke …)`.
**Exploitability / impact:** a stolen refresh token remains exploitable until its 30-day expiry even after the legitimate user or our backend detects reuse. Undermines the rotation-on-use defense.
**Proposed remediation:** on `findLiveRefreshToken` → null AND verify-ok, call `revokeAllRefreshTokensForUser(claims.sub)`. Gate on a cheap "was this jti ever issued for this user?" check to avoid panic-revocation on a random invalid jti.

### A2-557 — `issueTokenPair` re-decoded to fish out `jti` instead of using returned claims

**Severity:** Low
**Files:** `apps/backend/src/auth/native.ts:224-235`.
**Evidence:** after calling `issueTokenPair`, the handler re-runs `verifyLoopToken(pair.refreshToken, 'refresh')` just to extract the new `jti` for the `replacedByJti` link. `issueTokenPair` already has the claims in scope and throws them away.
**Exploitability / impact:** nil — wasted CPU + second `timingSafeEqual`. Also expands the surface that must stay in sync (e.g. if the token format evolves, both sites must be updated).
**Proposed remediation:** have `issueTokenPair` return `{ accessToken, refreshToken, refreshJti }` and drop the re-verify.

### A2-558 — `requestOtpHandler` (CTX path) swallows 5xx loudly but skips 4xx "enumeration-safe" branch when circuit opens

**Severity:** Low
**Files:** `apps/backend/src/auth/handler.ts:59-106`.
**Evidence:** A CircuitOpenError returns 503 `SERVICE_UNAVAILABLE`; this is a fingerprint that the email provider is unreachable, distinguishable from the 200 the 4xx-upstream path emits. A probe that times its requests can infer "valid email + upstream temporary problem" vs "rejected email" — information the rest of the handler works hard to conceal.
**Exploitability / impact:** marginal — probing during an outage.
**Proposed remediation:** return 200 with the same "Verification code sent" envelope when the circuit is open; log server-side. Tradeoff: legitimate users during an outage won't know email isn't being sent. Accept that; the native path has the same issue and resolves it the same way.

### A2-560 — OTP attempts ceiling is off-by-one against the docstring (`OTP_MAX_ATTEMPTS = 5` → 6 accepted wrong codes)

**Severity:** Low
**Files:** `apps/backend/src/auth/otps.ts:23-24`, `97-107`, `123-132`.
**Evidence:** `findLiveOtp` where-clause uses `lte(otps.attempts, OTP_MAX_ATTEMPTS)`. On the 6th wrong guess, the row still has `attempts = 5 <= 5` at the moment of the lookup (`incrementOtpAttempts` runs _after_ the failed `findLiveOtp`), so the row is findable for the correctness check. The handler increments to 6 afterwards. Only the 7th guess sees `attempts = 6 > 5` and skips lookup.
**Exploitability / impact:** 6 chances vs 5 at brute-forcing a 6-digit code — `6 / 10^6 = 6e-6` per row, vs intended `5e-6`. Negligible.
**Proposed remediation:** change to `lt(otps.attempts, OTP_MAX_ATTEMPTS)` OR always `incrementOtpAttempts` **before** `findLiveOtp` (race-safer too).

### A2-561 — `incrementOtpAttempts` bumps every live row for the email, not the most recent one

**Severity:** Low
**Files:** `apps/backend/src/auth/otps.ts:119-132`.
**Evidence:** UPDATE predicate is `email = ? AND consumed_at IS NULL AND expires_at > now`. All concurrently-live rows for the same email have their `attempts` bumped on every bad guess, not just the row `findLiveOtp` resolved.
**Exploitability / impact:** a user who requested three OTPs (up to per-email cap) and then typed a wrong code once has all three rows at `attempts=1`. Any subsequent correct code against any of them is allowed, but the attempts share budget. Edge-case correctness, low severity.
**Proposed remediation:** either `ORDER BY created_at DESC LIMIT 1` on the update or accept this "shared budget" behaviour and document it.

### A2-562 — `revokeAllRefreshTokensForUser` is exported and tested but not reachable via any route

**Severity:** Low (dead-code)
**Files:** `apps/backend/src/auth/refresh-tokens.ts:91-102`; `apps/backend/src/auth/__tests__/refresh-tokens.test.ts:134-` (tested in isolation); `apps/backend/src/app.ts` (no mount).
**Evidence:** docstring L91-95 mentions "used by `DELETE /api/auth/session/all` and by the security-revoke pathway when we need to invalidate all sessions." Neither route nor internal caller exists (`grep` returns tests + the definition only).
**Exploitability / impact:** no security-revoke surface exists, so ops cannot bulk-revoke compromised accounts. Also A2-556 depends on this.
**Proposed remediation:** wire `DELETE /api/auth/session/all` behind requireAuth + idempotency, or remove the docstring claim if the route is intentionally deferred.

### A2-565 — `DELETE /api/auth/session` never revokes Loop-native refresh rows

**Severity:** High
**Files:** `apps/backend/src/auth/handler.ts:256-304`; `apps/backend/src/app.ts:759`.
**Evidence:** `logoutHandler` has one code path: CTX `/logout`. It does not branch on `LOOP_AUTH_NATIVE_ENABLED`, does not parse the refresh JWT, does not call `revokeRefreshToken`. When native auth is on, the CTX call is a no-op (upstream doesn't know this jti), the response is always 200, and the `refresh_tokens` row stays live.
**Exploitability / impact:** if the refresh token leaks (shared device, screen-capture, malicious companion app), logging out does not close the attacker's session. A 30-day refresh remains usable.
**Proposed remediation:** when `LOOP_AUTH_NATIVE_ENABLED`, verify the refresh JWT and call `revokeRefreshToken` on its `jti`. Fall through to the CTX path for CTX-shaped bearers during the overlap.

### A2-566 — Social ID-tokens are accepted without nonce binding; replay window ≤ provider TTL

**Severity:** High
**Files:** `apps/backend/src/auth/social.ts:112-174`; `apps/backend/src/auth/id-token.ts:210-234`.
**Evidence:** The Body schema is `{ idToken, platform }`. No `nonce` is required from the client; no `nonce` is checked against anything server-side. Google / Apple id_tokens can embed `nonce`, but we don't mandate it.
**Exploitability / impact:** an id_token captured on any channel (compromised mobile app, MITM on a user's device, Google OAuth proxy page) is replayable against `/api/auth/social/google` within its TTL (≈1 h for Google). Successful replay mints a Loop session pair for the victim.
**Proposed remediation:** add a `/api/auth/social/start` that issues a server-side nonce (HMAC'd, 5-min TTL, single-use), require the client to pass that nonce to Google/Apple when requesting the id_token, and enforce `claims.nonce === issuedNonce && !replayed` in `verifyIdToken`.

### A2-567 — Google `iss` exact-match rejects valid tokens with `iss='accounts.google.com'` (no `https://` prefix)

**Severity:** Medium
**Files:** `apps/backend/src/auth/social.ts:189-199`; `apps/backend/src/auth/id-token.ts:220-222`.
**Evidence:** `expectedIssuer: 'https://accounts.google.com'`. Verifier does an exact string compare. Google's id_token spec documents both `https://accounts.google.com` and `accounts.google.com` as legal `iss` values; current SDKs happen to emit the full URL but this is not guaranteed.
**Exploitability / impact:** functional — a subset of valid tokens will 401 out of the blue when Google rotates issuance behaviour. No security exposure (we just become too-strict).
**Proposed remediation:** accept a small allowlist for Google (`['https://accounts.google.com', 'accounts.google.com']`) rather than a single string.

### A2-568 — `/api/auth/social/google` and `/api/auth/social/apple` not registered in `openapi.ts`

**Severity:** Low
**Files:** `apps/backend/src/app.ts:754-755`; `apps/backend/src/openapi.ts` (grep confirms no entry).
**Evidence:** The `AGENTS.md` rule is explicit: "An API endpoint (add/remove/modify) → Update `apps/backend/src/openapi.ts` registration — declare every status code the handler can return". These routes emit 400/401/404/429/500/503 but none are documented.
**Exploitability / impact:** API contract drift; generated clients (if any) strip fields or get the URL wrong.
**Proposed remediation:** add `registry.registerPath(...)` entries mirroring the `request-otp` / `verify-otp` pattern.

### A2-569 — `id-token.ts` skips `iat` freshness and `nbf`; no upper bound on `exp - iat`

**Severity:** Medium
**Files:** `apps/backend/src/auth/id-token.ts:181-234`.
**Evidence:** verifier enforces `exp >= now`. It does not check `nbf` (present but optional in Google id_tokens) and does not check that `iat` is not wildly in the future. `claims['exp']` of 10 years would be accepted as long as `exp >= now`.
**Exploitability / impact:** a rogue CA-compromise scenario where an attacker forges a signed id_token with a future `iat` + far-off `exp` would pass. Pragmatically bounded by JWKS-trust but defense in depth is missing.
**Proposed remediation:** require `now - 5min ≤ iat ≤ now + 5min`; if `nbf` present, enforce `nbf ≤ now`.

### A2-570 — Social `identities.ts` step-2/step-3 race can violate `users.email` unique index

**Severity:** Low
**Files:** `apps/backend/src/auth/identities.ts:56-99`.
**Evidence:** comment on `db/users.ts:89-100` acknowledges "Best-effort idempotency: if two concurrent verify-otp calls for the same new email both miss the SELECT, they'll both INSERT and create two rows." `identities.ts` step 3 inserts a users row inside a transaction but doesn't handle the unique-violation path — the second concurrent caller's `INSERT` raises and surfaces as a 500.
**Exploitability / impact:** a user double-clicking "Continue with Google" gets an ugly 500 instead of a resolved session.
**Proposed remediation:** `.onConflictDoNothing({ target: users.email })` + re-SELECT pattern, or catch the Postgres unique-violation and retry the resolve from step 1.

### A2-571 — `EMAIL_PROVIDER=console` bypasses the production guard

**Severity:** High
**Files:** `apps/backend/src/auth/email.ts:57-74`.
**Evidence:** the guard condition is `if (env.NODE_ENV === 'production' && configured !== 'console')`. When `configured === 'console'` the inner throw is skipped and the `ConsoleEmailProvider` is returned. Combined with `ConsoleEmailProvider` logging the plaintext OTP at `info` (L38-45), any production deployment that explicitly sets `EMAIL_PROVIDER=console` (misconfig, dev-config leaking into prod, ops typo) will log OTP codes to stdout without sending email.
**Exploitability / impact:** plaintext OTPs in production logs. Depends on who has log access.
**Proposed remediation:** invert the guard: `if (env.NODE_ENV === 'production' && (configured === undefined || configured === 'console')) throw …`. Delete the `configured !== 'console'` clause.

### A2-572 — `operatorFetch` does not retry against a second operator on a 5xx response

**Severity:** Medium
**Files:** `apps/backend/src/ctx/operator-pool.ts:146-201`; `apps/backend/src/circuit-breaker.ts:131-147`.
**Evidence:** docstring L147-151 says "On a transient failure (network or 5xx) against the first picked operator, we retry once against the next healthy operator." Code only catches `CircuitOpenError`; a 5xx from upstream is returned by the inner `wrappedFetch` (circuit-breaker.ts L136-142 updates its own `onFailure` but returns the Response). `operatorFetch` returns that Response to the caller without another pickHealthyOperator cycle.
**Exploitability / impact:** a single lame operator emitting 5xx surfaces as an end-user error even though a healthy second operator is available. Reduces the resilience guarantee the pool is designed to provide.
**Proposed remediation:** if `res.status >= 500` and `i+1 < attempts`, continue the loop instead of returning. Preserve original behaviour for 4xx.

### A2-573 — Operator-pool `initialised = true` is set before parsing, so a parse-throw leaves the pool permanently inert

**Severity:** Low
**Files:** `apps/backend/src/ctx/operator-pool.ts:75-108`.
**Evidence:** `ensureInitialised` sets `initialised = true` as the very first line of the function body. If `JSON.parse` or `OperatorPoolSchema.safeParse` throws, `operators` is never populated but `initialised` is set; every subsequent call short-circuits and throws `OperatorPoolUnavailableError`. Comment on L87-96 calls this "keeps the failure localised" but in practice the operator has no way to recover without a restart even after fixing `CTX_OPERATOR_POOL`.
**Exploitability / impact:** op toil — mid-incident config fix doesn't take effect until redeploy.
**Proposed remediation:** only set `initialised = true` after the successful schema parse; keep the throw so first-call failures are loud, but allow re-evaluation on the next call.

### A2-574 — `/api/config` exposes deployment-feature surface without auth

**Severity:** Info
**Files:** `apps/backend/src/config/handler.ts:69-96`; `apps/backend/src/app.ts:657`.
**Evidence:** the endpoint is public and returns `loopAuthNativeEnabled`, `loopOrdersEnabled`, per-asset `issuer`, social OAuth client IDs. All values are non-secret by design (ADR 013 / 014 / 015 — issuer addresses are public, client IDs are shipped in the web bundle anyway). Recording as Info since the exposure is deliberate.
**Proposed remediation:** none. Consider documenting in ADR 020 §public-api.

---

## 5. Blockers / audit-run issues

None. All in-scope files read; test files sampled for the assertions that matter to each finding (specifically `require-auth.test.ts:109-119` which pins the CTX pass-through behaviour that underlies A2-550).

## 6. Out-of-scope bleed (handoff)

- `require-admin.ts`'s unverified-JWT path reaches into every `apps/backend/src/admin/*` handler. The admin-files bucket is another agent's scope; A2-550 is the root and they should confirm none of the admin handlers re-verify.
- `db/users.ts:89-100` `findOrCreateUserByEmail` race is a known issue and fair game for the `db/` auditor.
- `openapi.ts` missing entries (A2-568) — openapi is not in my scope but the absence was discovered here.
- `logger.ts` redaction key list — spot-checked that `email` is not redacted; full logger audit belongs to the top-level-files auditor.
