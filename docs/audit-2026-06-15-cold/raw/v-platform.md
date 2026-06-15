# Cold Audit — Platform Layer (middleware, config/env, images, webhooks, openapi, app wiring)

> Vertical owner: V14 (middleware) + V16 (config/env) + V17 (webhooks) + V18 (images) + V19 (openapi) + app/index wiring.
> Date: 2026-06-15. Branch: `fix/stranded-order-hardening`. Adversarial cold re-audit.
> Method: every in-scope file read in full; cross-checked against AGENTS.md middleware/header/env claims, the
> per-route mount sites, the openapi-parity gate (run live), env.ts↔.env.example parity (run live), and the
> Part-1/Part-2 checklist dimensions for each surface.

## Coverage

Files examined (read in full unless noted): **27**

Middleware (`apps/backend/src/middleware/`):

- `cors.ts`, `secure-headers.ts`, `body-limit.ts`, `request-id.ts`, `request-context.ts`, `access-log.ts`,
  `request-counter.ts`, `rate-limit.ts`, `kill-switch.ts`, `cache-control.ts`, `probe-gate.ts`
  (all 11 of the `*.ts` in the dir; no others present)

App wiring / runtime:

- `app.ts` (middleware mount order + route mounts + error/404 handlers + cleanup)
- `index.ts` (boot gates, migration run, worker wiring, graceful shutdown, crash handlers)
- `kill-switches.ts` (KillSwitch enum + `isKilled` runtime read)
- `runtime-health.ts` (worker liveness/staleness + OTP-delivery health surface)
- `circuit-breaker.ts` (+ confirmed `circuit-breaker-registry.ts` is the per-endpoint map; re-exported)
- `auth/admin-step-up-middleware.ts` (in-scope per "admin-step-up" line item)

Config / env:

- `config/handler.ts` (`GET /api/config` public flags)
- `env.ts` (full schema + `parseEnv` boot validation + tripwires)
- `scripts/check-env-perms.sh` (env-perms hygiene gate)

Images (`apps/backend/src/images/`):

- `proxy.ts` (fetch-with-limit, sharp re-encode, LRU cache, redirect/content-type guards)
- `ssrf-guard.ts` (URL validate, allowlist, IPv4/IPv6 private-range, DNS-rebinding doc)

Webhooks (`apps/backend/src/webhooks/`):

- `hmac-verify.ts` (generic HMAC + timestamp + replay-window primitive) — **only file in the dir**

OpenAPI:

- `openapi.ts` (registry + shared components + section dispatch) and confirmed the 8 section registrars
  exist under `openapi/` (66 files); `scripts/check-openapi-parity.mjs` read in full.

Cross-checks run live:

- `node scripts/check-openapi-parity.mjs` → **144 mounts / 144 registrations, OK** (allowlist empty).
- env.ts top-level keys (82) vs `apps/backend/.env.example` (384 lines) → **zero missing** keys.
- Hono `secureHeaders` defaults inspected in `node_modules` to confirm which headers are actually emitted.
- kill-switch mount sites grepped against the documented dangerous-path set.

Note: the branch diff vs `main` is entirely in `orders/` + `payments/` (stranded-order hardening) — **no
platform-layer file changed on this branch**, so findings below are against the resident platform code.

---

## Findings

### P0 / Critical

None.

### P1 / High

None. The middleware order, rate-limiter (per-route+IP key, LRU cap+eviction, Retry-After, TRUST_PROXY
boundary), CORS allowlist, secure headers (incl. HSTS), body limit, image-proxy SSRF guard, env boot
validation/fail-closed, kill switches (runtime read + fail-closed), and openapi parity are all correct and
well-defended. No auth bypass, no SSRF hole, no fail-open security default found in scope.

### P2 / Medium

**PLAT-01 — Privy webhook handler is absent (documented-but-unimplemented).**
`webhooks/` contains only `hmac-verify.ts`, a generic HMAC primitive with no callers
(`grep verifyHmacWebhook` across `src/` outside its own test → zero importers). No `webhooks/privy.ts`, no
mounted webhook route (`grep webhook` in `routes/` → only Discord-management comments). ADR 030 + checklist
§29 require a Privy `wallet.created`/`wallet.recovered` webhook handler with HMAC+timestamp+replay+idempotency;
only the verification half exists, and even that is dead code on `main`/this branch.
_Impact:_ wallet provisioning relies on the synchronous create path only; any async Privy callback (recovery,
out-of-band creation) is silently dropped. The `webhook_events` dedupe table the primitive's own header
comment names is also out of scope/unbuilt, so idempotency isn't wired even if a handler were added.
_Evidence:_ `apps/backend/src/webhooks/hmac-verify.ts:19-26` ("the per-vendor handler in `webhooks/<vendor>.ts`"
— that file does not exist); `ls apps/backend/src/webhooks/`.
_Fix:_ gate as a Phase-2/branch item (wallet vertical, PR stack #1424-#1428). For platform-layer accounting,
flag `verifyHmacWebhook` as an intentionally-staged primitive, not orphaned dead code, and reference the
wallet-build ticket so the dead-code sweep doesn't delete it.
_Ref:_ ADR 030, checklist §29, V5/V17.

### P3 / Low

**PLAT-02 — `request-context.ts:44` retains the inbound `X-Request-Id` fallback that A4-008 removed everywhere
else.** `const id = c.get('requestId') ?? c.req.header('X-Request-Id') ?? 'unknown';`
`requestIdMiddleware` (A4-008) is mounted _before_ request-context in `app.ts` and unconditionally sets
`c.get('requestId')` to a server-minted UUID, so the header fallback is unreachable in practice — but `app.ts`
and `access-log.ts` both deliberately dropped this exact `?? c.req.header('X-Request-Id')` clause to close the
log-poisoning sidechannel, and this one was missed. Not exploitable (the `??` short-circuits on the always-set
context value), purely an A4-008-consistency leftover.
_Fix:_ drop the header fallback: `c.get('requestId') ?? 'unknown'`.
_Ref:_ A4-008, checklist §2 (info-leakage/correlation-id integrity), §14 (dead code).

**PLAT-03 — `body-limit` is mounted before `request-id`, so the 413 envelope carries no `requestId`.**
`app.ts` order is CORS → secure-headers → **body-limit** → request-id → request-context → access-log. A body
that overflows the 1 MiB cap is rejected by `bodyLimitMiddleware.onError` before `requestIdMiddleware` runs, so
the 413 `PAYLOAD_TOO_LARGE` response has no `X-Request-Id` header and the access-log line for it has
`requestId: undefined`. Every other 4xx/5xx is correlatable; the 413 is the one gap. Low impact (413s are rare
and self-explanatory) but it breaks the "every response is correlatable" property the rest of the chain upholds.
_Fix:_ move `requestIdMiddleware` (and `secureHeaders`) ahead of `bodyLimitMiddleware`, or accept the gap and
document it. Note this is a deliberate-looking order (CORS/headers/body-limit reject cheaply before minting an
id), so "document it" is defensible.
_Ref:_ checklist §6 (request-correlation), §4 (error→observability).

**PLAT-04 — AGENTS.md middleware-stack list (§"Backend middleware stack") omits four global middlewares and
states circuit-breaker as #7 global.** The doc lists CORS→secure-headers→body-limit→request-id→logger→
rate-limit→circuit-breaker as the 7-step global chain. The actual global chain in `app.ts` is CORS →
secure-headers → body-limit → request-id → **request-context** → access-log → **request-counter** (+ optional
Sentry first). Rate-limiting and circuit-breaking are **per-route**, not global middleware — rate-limit is a
factory mounted per `app.get/post`, and the circuit breaker wraps outbound `fetch` (it's not a Hono
middleware at all). The doc conflates "logical order things happen" with "global `app.use` chain." Mostly
accurate in spirit but a reader auditing the global stack will look for a global rate-limit/circuit middleware
that doesn't exist, and won't find request-context/request-counter that do.
_Fix:_ split the AGENTS.md section into "global middleware (app.use, in order)" vs "per-route guards (rate-limit,
kill-switch, cache-control, requireAuth/Admin/StepUp)" vs "outbound resilience (circuit breaker on fetch)".
_Ref:_ checklist §5 (doc↔code drift), §14, AGENTS.md doc-update rules ("Middleware ordering → AGENTS.md").

**PLAT-05 — `admin-step-up-middleware.ts:105` subject-pin guard is gated on `auth?.userId !== undefined`.**
For loop-native admins this is always defined (`require-auth.ts:47-48,95-96` types `kind:'loop'` with
`userId: string` set from `verified.claims.sub`), so the pin always runs — no live gap. But the middleware's
local `AuthLike` interface widens `userId` to optional, so a future auth shape where a loop admin lands here
with `userId === undefined` would _skip_ the subject pin and accept any validly-signed step-up token. Defense-
in-depth nit: the guard should fail-closed (reject) when `userId` is missing on a non-`ctx` path rather than
skip the check.
_Fix:_ `if (auth?.kind !== 'ctx' && (auth?.userId === undefined || verified.claims.sub !== auth.userId)) reject`.
_Ref:_ ADR 028, checklist §2 (replay/horizontal-escalation), §4 (fail-closed).

**PLAT-06 — HSTS is emitted in all environments (incl. dev/test over http).** `secureHeaders` defaults
`strictTransportSecurity: true` → `max-age=15552000; includeSubDomains`, and the Loop config doesn't override
it, so HSTS ships on every response including local `http://localhost:8080` dev. Browsers ignore HSTS over
plain http, so this is harmless, but it means (a) HSTS is _not_ explicitly pinned in the Loop config — it rides
the Hono default, so a Hono major bump that flips the default would silently drop it, and (b) there's no
`preload` directive (180-day max-age, no preload) — fine for Phase 1, but worth a conscious decision before
public launch rather than an inherited default. AGENTS.md's "HSTS" claim is technically satisfied by the
default but isn't enforced by Loop's own code.
_Fix:_ set `strictTransportSecurity` explicitly in `secure-headers.ts` to pin the value (and decide on preload)
rather than depending on the library default; add a header assertion test.
_Ref:_ checklist §2 (security headers), §5 (doc↔code: claim relies on transitive default).

**PLAT-07 — Image proxy `mode=private` fully bypasses the LRU cache on a public, unauthenticated route.**
`proxy.ts:67,71` — any caller can append `?mode=private` to force a cold fetch + sharp re-encode on every
request (cache read skipped _and_ write skipped). The route is rate-limited (300/min/IP) and bounded by
`FETCH_TIMEOUT_MS` + 10 MB body cap, so it's not a DoS amplifier, but `mode=private` lets an attacker
deterministically defeat the cache and pin CPU on sharp re-encoding for allowlisted hosts at the per-IP rate.
The `private` mode exists for sensitive per-user images, but nothing scopes it to authenticated callers.
_Fix:_ either require auth for `mode=private`, or keep caching internally and only vary the `Cache-Control`
response header by mode (cache the bytes regardless; emit `private, no-store` for private mode).
_Ref:_ checklist §13 (image-proxy cost), §2 (DoS).

---

## Summary

| Severity  | Count |
| --------- | ----- |
| P0        | 0     |
| P1        | 0     |
| P2        | 1     |
| P3        | 6     |
| **Total** | **7** |

**Verdict — platform layer is launch-ready for Phase 1.** The security-critical controls are correct and
adversarially sound:

- **Middleware order** matches the documented intent; global chain is CORS→secure-headers→body-limit→
  request-id→request-context→access-log→request-counter (PLAT-04 is a doc-precision nit, not a behavior bug).
- **Rate limiter** keys on `${name}:${ip}` (A4-001 per-route fix verified), caps the map at 10k with
  insertion-order eviction + an hourly sweep, emits `Retry-After`, and honours `TRUST_PROXY` so X-Forwarded-For
  can't be spoofed when unset. `DISABLE_RATE_LIMITING` is hard-refused at boot in production (env.ts).
- **CORS** has no wildcard in prod (explicit 5-origin allowlist incl. both Capacitor schemes), `http://localhost`
  correctly dropped (A2-1009), wildcard only in dev/test.
- **Secure headers**: CSP `default-src 'none'` + `frame-ancestors 'none'`, CORP `same-origin` in prod, and HSTS/
  XCTO/XFO ride the Hono defaults (PLAT-06: should be pinned explicitly).
- **Body limit**: 1 MiB → explicit 413 envelope (PLAT-03: 413 lacks requestId due to mount order).
- **Image-proxy SSRF guard** is thorough: HTTPS-only (http dev-only), allowlist, localhost reject, full IPv4
  private/loopback/link-local/CGNAT/multicast/0-net ranges, IPv6 loopback/ULA/link-local/multicast + IPv4-mapped
  forms (dotted + hex), per-resolved-address check, manual-redirect rejection, content-type `image/*` gate,
  streamed 10 MB read cap, and sharp re-encode (which neutralises SVG/HTML payloads — no passthrough). The
  DNS-rebinding TOCTOU is honestly documented and mitigated by the production-enforced allowlist (env.ts refuses
  to boot in prod without `IMAGE_PROXY_ALLOWED_HOSTS` unless explicitly overridden). Tests cover all SSRF classes
  incl. mixed public/private DNS and metadata-IP (169.254.169.254).
- **env.ts** validates at boot, fails-closed on the security-relevant cases (image-allowlist in prod, rate-limit
  bypass in prod, cashback-split >100%, native-auth-without-email-provider in index.ts), and parity with
  `.env.example` is clean (82/82 keys).
- **Kill switches** read `process.env` live (no redeploy), fail **closed** on unrecognised values (A4-047),
  support per-path order overrides, and are mounted on all four documented dangerous paths (orders legacy/loop,
  auth, withdrawals + compensate) before `rateLimit` so a killed subsystem doesn't burn rate budget.
- **OpenAPI parity** gate passes clean (144/144) with an empty allowlist.

Top item to track for Phase 2: **PLAT-01** (Privy webhook handler + `webhook_events` idempotency table are
documented but unbuilt; the HMAC primitive is a staged, currently-unwired half). The remaining P3s are doc-
precision (PLAT-04, PLAT-06), an unreachable-fallback cleanup (PLAT-02), a correlation gap on 413 (PLAT-03), a
defense-in-depth fail-closed tightening on step-up (PLAT-05), and a cache-bypass hardening on the image proxy
(PLAT-07) — none gate launch.
