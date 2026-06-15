# Cross-Cutting Security Sweep — 2026-06-15 Cold Audit

> Adversarial whole-tree pass focused on **systemic invariants that must hold across ALL
> files** — not single-file findings the per-vertical agents already own. Scope: the six
> sweep dimensions (authz-on-every-:id, idempotency-on-every-write, secret leakage,
> injection/SSRF/XSS/traversal/ReDoS/open-redirect, crypto+replay, headers/CORS/CSRF/
> rate-limit). Every backend route mount, every write handler, the image-proxy SSRF guard,
> the web render/redirect surface, and the operator tooling were enumerated.

---

## Findings

### [P1] Money-moving admin writes inconsistently gated by step-up auth (refund + payout-compensate)

- **Severity:** P1 / High
- **Vertical:** V8 admin / V25 financial integrity
- **File:** `apps/backend/src/routes/admin-credit-writes.ts:58` (refunds);
  `apps/backend/src/routes/admin-payouts.ts:99` (compensate)
- **Impact:** ADR-028's step-up auth is the control that stops a _stolen admin bearer_
  from moving money. It is applied to credit-adjustments (`admin-credit-writes.ts:49`),
  withdrawals (`:72`), payout-retry (`admin-payouts.ts:93`), and the home-currency write
  (`admin-user-writes.ts:28`) — but **NOT** to two sibling money-moving writes:
  - `POST /api/admin/users/:userId/refunds` issues a **positive-amount `credit_transactions`
    row** that mints user balance (`admin/refunds.ts:4-5`, schema CHECK forces positive).
  - `POST /api/admin/payouts/:id/compensate` **re-credits** a user after a failed withdrawal
    (`admin/payout-compensation.ts`). It wears `killSwitch('withdrawals')` but no step-up.
    A captured bearer (no step-up token) can therefore mint credit via refunds and re-credit
    via compensate, bypassing the very control its siblings enforce. This is a systemic
    inconsistency in the destructive-write gate, not a one-off.
- **Evidence:** `grep requireAdminStepUp routes/` returns 5 mounts; refund and compensate
  are the two money-moving writes absent from that set. admin.ts:243 comment lists only
  "credit-adjust / withdrawals / payout-retry" as step-up-gated — refund/compensate were
  never added.
- **Fix:** Add `requireAdminStepUp()` to both mounts (after `rateLimit`, before the handler),
  matching the credit-adjust/withdrawal pattern. Update the admin.ts step-up comment +
  `docs/adr/028` + openapi 503 declarations. Add a test asserting 503 STEP_UP_UNAVAILABLE
  on both when the step-up key is unset, mirroring the existing credit-adjust test.
- **Ref:** ADR 028; ADR 017 admin-write invariants; ADR 024 §5.

### [P2] `.gitignore` lacks defense-in-depth for signing keys / cert material outside `apps/mobile/android/`

- **Severity:** P2 / Medium
- **Vertical:** V10 mobile / cross-cutting secrets
- **File:** `.gitignore` (no `*.jks` / `*.keystore` / `*.p12` / `*.pem` / `keystore.properties` entries)
- **Impact:** The Android release-keystore work is an OPEN Phase-1 task (per project memory:
  "Android keystore one-time genkeypair … offline backup needed"). The operator-instructed
  path `apps/mobile/android/keystore.properties` _is_ ignored (the whole `apps/mobile/android/`
  dir is), so the documented happy path is safe. But there is **no global guard**: a `*.jks`,
  `*.keystore`, `*.p12`, `*.pem`, or a stray `keystore.properties` dropped at the repo root,
  under `apps/web/`, or `tools/` is **NOT NULL ignored** (`git check-ignore` returns "NOT
  IGNORED" for all of them). With the keystore generation imminent, an operator one path-typo
  away from committing the Play Store signing identity is a real, time-correlated risk. gitleaks
  is advisory (non-gating) until launch, so it won't block the commit.
- **Evidence:** `git check-ignore test.jks test.keystore test.p12 test.pem apps/web/foo.pem
apps/mobile/native-overlays/android/keystore.properties` → all "NOT IGNORED".
- **Fix:** Add to `.gitignore`: `*.jks`, `*.keystore`, `*.p12`, `*.pfx`, `*.pem`, `*.key`,
  `keystore.properties`, `*.mobileprovision`, `GoogleService-Info.plist`,
  `google-services.json`. Keep `*.example` exclusions intact (none of these patterns hit the
  committed `keystore.properties.example`).
- **Ref:** ADR 006/027; project-memory Phase-1 keystore task.

### [P3] In-process rate limiter multiplies effective limits by instance count (auth/OTP surface)

- **Severity:** P3 / Low (mitigated; documented for completeness)
- **Vertical:** V14 middleware / V1 auth
- **File:** `apps/backend/src/middleware/rate-limit.ts:39` (`rateLimitMap` is module-local)
- **Impact:** The limiter's bucket map is per-process. On a multi-instance Fly deployment the
  documented per-IP limits (e.g. request-otp 5/min, verify-otp 10/min) become Nx the value
  across the fleet, weakening the OTP-flood / brute-force ceiling proportional to instance
  count. This is correctly mitigated for the two surfaces that matter most: OTP request flood
  is bounded by the **DB-backed per-email cap** (`otps.ts:69` `countRecentOtpsForEmail`,
  3/min, cross-instance) and OTP verify brute-force by the **DB-backed per-row attempt cap**
  (`otps.ts:108`, 5, cross-instance). So the security ceiling holds; only the IP-DoS budget is
  multiplied. Flag so it isn't mistaken for a guarantee.
- **Evidence:** No shared store (Redis/Postgres) backs `rateLimitMap`; `RATE_LIMIT_MAP_MAX`
  is per-process.
- **Fix:** None required pre-launch (single-instance + DB-backed auth caps cover it). At scale,
  move the limiter to a shared store, or document the single-instance assumption in
  `docs/slo.md` / `AGENTS.md` middleware section.
- **Ref:** A4-001; A2-560/561 (DB attempt caps).

### [P3] Privy webhook HMAC verifier is an orphan — no inbound webhook route mounted

- **Severity:** P3 / Low (documented gap, no live exposure)
- **Vertical:** V17 webhooks / V5 wallet
- **File:** `apps/backend/src/webhooks/hmac-verify.ts` (tested but never imported)
- **Impact:** `webhooks/hmac-verify.ts` + its test exist, but `grep` finds **zero importers**
  and **no `/api/webhooks/*` route is mounted** (app.ts mounts 7 route modules; none is a
  webhook). The Privy `wallet.created` / `wallet.recovered` handler the wallet build needs
  (ADR 030, §29 of the checklist) is unbuilt. No live security exposure today (nothing to
  attack), but the HMAC helper is dead code that gives a false impression the surface is wired.
  When the handler IS built, it must use this verifier with timestamp + replay protection
  (the helper is HMAC-only; verify timestamp-window + idempotency get added at the handler).
- **Evidence:** `grep -rn "hmac-verify\|verifyHmac" --include=*.ts src` excluding the file
  itself returns nothing; no webhook mount in `routes/` or `app.ts`.
- **Fix:** Either mount the Privy webhook handler (HMAC + timestamp-window + replay table +
  idempotency) on the wallet branch, or mark `hmac-verify.ts` as a forward-declared stub with
  a ticket. Don't ship the helper as unreferenced.
- **Ref:** ADR 030; checklist §29 / V17.

### [P3] Loop-native order idempotency is opt-in (header-gated), allowing double-submit when absent

- **Severity:** P3 / Low (known/documented as A2-2003)
- **Vertical:** V2 orders
- **File:** `apps/backend/src/orders/loop-handler.ts:178-198`
- **Impact:** `POST /api/orders/loop` only enforces idempotency when the client sends an
  `Idempotency-Key` header; absent it, a double-click creates two orders (and for credit-funded
  orders, two `user_credits` debits). The (user_id, key) unique index is correct **when a key
  is supplied**. This is documented A2-2003 ("the header is opt-in for now while the loop-native
  client rolls out"). Flagged as a systemic write-idempotency gap: every other money-touching
  write (admin writes, favorites) is either header-required or naturally idempotent — orders is
  the one user-facing write where the guard is optional. The legacy `POST /api/orders` (CTX
  proxy) has no Loop-side idempotency either, but is upstream-owned.
- **Evidence:** `idempotencyKey !== undefined` gate at :179 — the create path runs unguarded
  when the header is omitted.
- **Fix:** Make the client always send a UUID `Idempotency-Key` (the web purchase flow already
  generates a client UUID per checklist §15), then flip the handler to require it. Track the
  flip with a ticket so "opt-in" doesn't become permanent.
- **Ref:** A2-2003; checklist §3 / §15.

---

## Coverage

**1. authz-on-every-:id** — Enumerated all 19 route modules / ~110 mounts.

- `/api/admin/*` (~80 endpoints): gated by namespace `app.use('/api/admin/*', requireAuth)` +
  `requireAdmin` (admin.ts:125-126). Verified NO admin sub-route mounts a path outside
  `/api/admin/*` (grep confirms all under prefix), so none escapes the gate. Admins legitimately
  access any user's data by role — correct by design.
- `/api/users/me/*` (~24 endpoints): namespace `requireAuth` (users.ts:88-89). Per-id reads
  owner-scoped: `getPayoutForUser(id, user.id)` (pending-payouts-detail.ts:69),
  `getPayoutByOrderIdForUser(orderId, user.id)` (:123), 404-not-403 on cross-user. Favorites
  DELETE scoped by `(userId, merchantId)` (favorites-handler.ts:217). ✓
- `/api/orders/*`: namespace `requireAuth` (orders.ts:57-58). Loop reads owner-scoped via
  `and(eq(orders.id,id), eq(orders.userId, auth.userId))` (loop-read-handlers.ts:124,174);
  404-not-403. Legacy reads proxy to CTX with the user's bearer (CTX-enforced ownership). ✓
- `/api/merchants/:id|:slug|:merchantId`: catalog data, not user-owned → no IDOR. Authed
  `/api/merchants/:id` proxies to CTX with user bearer. ✓
- **No missing ownership/role scoping found.**

**2. idempotency-on-every-write** — Enumerated all POST/PUT/DELETE.

- Admin writes (credit-adjust / refund / withdrawal / compensate / payout-retry / home-currency):
  ALL require `Idempotency-Key` via `withIdempotencyGuard` + DB unique indexes
  (partial unique on (type, reference_type, reference_id); active-withdrawal fence). ✓
- User writes: home-currency/stellar-address are last-write-wins setters; favorites use
  `onConflictDoNothing` + idempotent DELETE; dsr/delete idempotent. ✓
- Orders: loop = opt-in header (P3 above); legacy = upstream-owned.
- Auth: OTP consume-once, refresh CAS-rotate, social one-shot consume (all idempotent by design).
- **Only gap: opt-in order idempotency (P3).**

**3. Secret leakage** — Whole-repo grep (secret prefixes: sk*live/re*/AKIA/ghp*/xoxb/PEM/
Stellar S-seeds) across apps/tools/packages/scripts/stellar/.github excluding node_modules:
**zero hardcoded secrets** in source. `git log -S` spot-checks (RESEND_API_KEY=, LOOP_JWT*
SIGNING*KEY=, storePassword=, STELLAR_TEST_SECRET_KEY=): all matches are `.env.example` /
docs key-\_names* only, no values. Audit residue artifact is redacted (key names + metadata).
`apps/web/.env.production` committed but contains only the public `VITE_API_URL`. No non-VITE
`process.env`/`import.meta.env` refs in `apps/web/app` (no server secret in client bundle).
`.gitignore` covers `.env*`/`*.apk|aab|ipa`/native dirs but **misses key-material patterns
(P2)**.

**4. injection/SSRF/XSS/traversal/ReDoS/open-redirect** —

- SSRF: image proxy guard (ssrf-guard.ts) = protocol+allowlist+DNS-resolve+IPv4/IPv6 private-
  range check incl. IPv4-mapped IPv6; `redirect:'manual'` rejects redirects; 30s timeout;
  allowlist production-required (env A-025). DNS-rebind TOCTOU documented+allowlist-mitigated. ✓
- All other server-side fetches (Horizon, Resend, Discord, CTX, JWKS) target operator-config'd
  URLs, not user input; all carry `AbortSignal.timeout`. ✓
- SQL injection: Drizzle parameterized everywhere; only `sql.raw` is test-setup TRUNCATE with a
  hardcoded table list. ✓
- XSS: single `dangerouslySetInnerHTML` (root.tsx:305) = a static literal theme-init string,
  CSP-nonce-stamped on SSR. No user content in SSR HTML/script. ✓
- Path traversal: no `readFile`/`path.join` over request input (matches are Zod issue-path
  formatting); mmdb is operator-provided. ✓
- ReDoS: no nested-quantifier user-influenced regexes found. ✓
- Open redirect: geo-redirect target derives from allowlist-validated `parseCountryCookie`
  (gated by `isSupportedCountryCode`) / `resolveCountryPath` (falls back to DEFAULT_COUNTRY).
  No attacker-controlled redirect path. ✓
- Info leakage: global onError returns generic message+requestId (no stack); `upstream-body-
scrub.ts` redacts JWT/token/email/card/Stellar-key/Discord-webhook before logging. ✓

**5. crypto + replay** —

- OTP: CSPRNG `randomInt` (no modulo bias), SHA-256 hash storage, consume-once
  (`markOtpConsumed`), strict-`lt` per-row attempt cap, per-email DB rate cap. ✓
- Refresh: SHA-256 storage, CAS single-shot revoke (`tryRevokeIfLive`), reuse-detection
  (`findRefreshTokenRecord`) → family-wide revoke. Gold standard. ✓
- JWT: alg pinned to HS256/RS256 (rejects `alg:none` + unknown), exp/iss/aud exact-match, typ
  enforced, verifiers keyed by header alg (no current alg-confusion; RS256 unwired). ✓
- Social: verify-first → one-shot `consumeIdToken` (SHA-256, PK-conflict, fail-closed on DB
  err); aud-per-platform; JWKS URLs hardcoded constants. Wired at social.ts:122. ✓
- Constant-time: `timingSafeEqual` for HMAC (signer.ts:45) + step-up (admin-step-up.ts:163).
  OTP/refresh use hashed-DB-lookup equality — acceptable (opaque 128-bit jti / hashed code +
  attempt caps; no practical timing oracle). ✓

**6. headers/CORS/CSRF/rate-limit** —

- CORS: prod allowlist (loopfinance.io/www/beta + capacitor origins), `*` only in dev/test, no
  `credentials:true`. Bearer-in-header auth (no ambient cookie) → CSRF largely N/A. `http://
localhost` correctly dropped (A2-1009). ✓
- Rate-limit: EVERY route mount has a `rateLimit(...)` (mounts==rateLimit count per file);
  per-route+per-IP key `${name}:${ip}` (A4-001), LRU-capped, Retry-After, DISABLE only via
  flag. In-process multiplier caveat = P3. ✓
- Cache-Control: `private, no-store` namespace-mounted BEFORE requireAuth on admin/orders/users
  so 401/403 envelopes carry it (no "URL is admin-only" cache-leak). `/api/config` public
  max-age=600 (no secrets). ✓
- Security headers: secureHeaders middleware in the stack (HSTS/XCTO/XFO etc per AGENTS.md). ✓

---

## Summary

Cross-cutting posture is **strong** — the systemic invariants the verticals depend on largely
hold: authz scoping is uniform (namespace `requireAuth`+`requireAdmin`, owner-scoped per-id
reads with 404-not-403), admin write idempotency is consistent (`withIdempotencyGuard` + DB
unique fences everywhere), no hardcoded secrets in source or history, SSRF/SQLi/XSS/traversal/
open-redirect surfaces are closed, and the crypto+replay primitives (OTP consume-once, refresh
CAS+reuse-detection, social one-shot, JWT alg-pinning) are textbook.

**5 findings: 0 P0, 1 P1, 1 P2, 3 P3.**

- **P1** — the only material gap: refund + payout-compensate (both mint/re-credit user balance)
  are **missing the `requireAdminStepUp()` gate** their money-moving siblings enforce. A stolen
  admin bearer can move money via these two paths without step-up. Fix = add the middleware to
  2 mounts + tests + ADR-028/openapi update.
- **P2** — `.gitignore` has no global guard for `*.jks`/`*.keystore`/`*.p12`/`*.pem`/
  `keystore.properties`; the documented keystore path is safe but with keystore generation an
  open Phase-1 task, a one-path-typo commit of the Play Store signing identity is a live risk.
- **P3** — in-process rate-limit multiplier (mitigated by DB-backed auth caps), orphan Privy
  webhook HMAC verifier (no live exposure), opt-in order idempotency (known A2-2003).

**Scope note:** This pass deliberately did NOT re-derive single-file findings the per-vertical
agents own (e.g. specific handler logic bugs, per-file test gaps). It enumerated the
cross-file/cross-vertical seams and the must-hold-everywhere invariants. The P1 step-up
inconsistency is the headline because it spans the V8/V25 seam (admin writes ↔ financial
integrity) — exactly the class a single-file agent would miss by checking each handler in
isolation rather than the gate-consistency across the write family.
