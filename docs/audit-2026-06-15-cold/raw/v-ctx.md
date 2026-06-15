# Cold Audit — CTX Upstream Integration vertical (V11 + dimension 28)

> Branch `fix/stranded-order-hardening`. Adversarial cold audit of the CTX
> upstream integration: operator pool, SSE stream, upstream URL builder,
> body scrubber, circuit breaker(s), and the upstream-touching call sites
> in `auth/` and `orders/` that consume the pool/stream.

## Coverage

Files examined (15 source + 2 test):

| File                                                                        | Role                                                            | Read           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------- |
| `apps/backend/src/ctx/operator-pool.ts`                                     | Operator credential pool, selection, exhaustion, breaker-per-op | full           |
| `apps/backend/src/ctx/stream.ts`                                            | CTX SSE gift-card status stream                                 | full           |
| `apps/backend/src/upstream.ts`                                              | `upstreamUrl()` path validation / SSRF guard                    | full           |
| `apps/backend/src/upstream-body-scrub.ts`                                   | Secret/PII scrub of upstream error bodies                       | full           |
| `apps/backend/src/circuit-breaker.ts`                                       | Breaker state machine + `wrappedFetch`                          | full           |
| `apps/backend/src/circuit-breaker-registry.ts`                              | Per-endpoint named breaker registry                             | full           |
| `apps/backend/src/orders/procure-one.ts`                                    | Procurement: POST /gift-cards, Idempotency-Key, pay-ctx, schema | full           |
| `apps/backend/src/orders/procurement-redemption.ts`                         | `waitForRedemption` (SSE + poll), `fetchRedemption`             | full           |
| `apps/backend/src/orders/redemption-backfill.ts`                            | Backfill sweeper consuming the pool                             | full           |
| `apps/backend/src/auth/handler.ts`                                          | CTX-proxy auth (login/verify/refresh) breakers + scrub          | full           |
| `apps/backend/src/auth/logout-handler.ts`                                   | Logout breaker                                                  | scanned        |
| `apps/backend/src/merchants/sync.ts`                                        | Merchants pull: Zod, MAX_PAGES, breaker                         | call-site read |
| `apps/backend/src/orders/handler.ts` + `get-handler.ts` + `list-handler.ts` | Legacy CTX-proxy order paths (user bearer)                      | call-site read |
| `apps/backend/src/orders/pay-ctx.ts`                                        | Idempotency + amount/asset reconcile (consumed by procure-one)  | scanned        |
| `apps/backend/src/admin/treasury.ts`                                        | `getOperatorHealth` / `operatorPoolSize` observability sink     | call-site read |
| `apps/backend/src/ctx/__tests__/operator-pool.test.ts`                      | Pool tests                                                      | full           |
| `apps/backend/src/ctx/__tests__/stream.test.ts`                             | Stream tests                                                    | full           |

Dimension-28 checklist items covered: Zod-validation of all upstream
responses; per-endpoint independent breakers; operator-pool health /
exhaustion / selection; token-rotation persistence; X-Client-Id↔JWT
clientId pairing; Idempotency-Key on procurement; SSE terminal/transport/
body-read handling; body-scrub leak surface; 429/rate-limit handling toward
upstream + backoff. Plus security (cred-leak / SSRF), correctness, error
handling, tests, observability, completeness.

Runbooks confirmed present: `ctx-circuit-open.md`, `ctx-schema-drift.md`,
`operator-pool-exhausted.md`, `redemption-backfill-exhausted.md`.

---

## Findings

### CTX-P1-01 — No upstream-429 handling: no Retry-After honor, no throttle/backoff toward CTX

- **severity:** P1
- **vertical:** V11 / dimension 28 (rate-limit toward upstream)
- **file:** `apps/backend/src/circuit-breaker.ts:171-184`, `apps/backend/src/ctx/operator-pool.ts:266-302`, `apps/backend/src/auth/handler.ts:223-240`, `apps/backend/src/orders/procure-one.ts:179-184`
- **description:** Dimension 28 explicitly requires "Rate-limit/429 handling toward upstream; throttle/backoff." There is **none anywhere** in the vertical. The breaker only treats `>=500` as a failure (line 173), so a CTX 429 is a "success" that resets `consecutiveFailures` to 0 — the breaker never opens under sustained rate-limiting. `operatorFetch` treats 429 as a 4xx and returns it verbatim without retry or backoff (line 275 only retries `>=500`). No code reads the `Retry-After` header on any upstream response. Under a CTX rate-limit storm the procurement worker, merchants sync, and auth proxy all hammer CTX at full tick cadence, deepening the limit.
- **impact:** A CTX-side rate limit degrades into a self-sustaining hot loop instead of backing off; procurement fails order-by-order (`markOrderFailed` on the non-ok 429 in procure-one) rather than deferring; auth refresh surfaces 429 as a generic `UPSTREAM_ERROR` 502. No alert fires (429 isn't a 5xx, doesn't trip the breaker, doesn't exhaust the pool). This is a documented dimension-28 requirement with zero implementation.
- **evidence:** `grep -rn "429|Retry-After|backoff"` over `ctx/`, `procure-one.ts`, `procurement-redemption.ts`, `circuit-breaker.ts` returns nothing (excluding inbound `rateLimit()` mounts).
- **fix:** Classify 429 as a breaker/operator-health signal distinct from 4xx: on 429, parse `Retry-After`, skip the operator (or open its breaker for the indicated window), and have the procurement tick defer rather than `markOrderFailed`. At minimum, count 429 toward `consecutiveFailures` so the breaker opens and the existing cooldown applies.
- **ref:** checklist §28 ("Rate-limit/429 handling toward upstream; throttle/backoff"), §4, §13 ("Horizon/CTX call efficiency — page caps, throttle, backoff").

### CTX-P1-02 — Expired operator bearer (CTX 401) is not retried, not detected, never rotated → silent fail-over hole

- **severity:** P1
- **vertical:** V11 / dimension 28 (token rotation persistence; X-Client-Id keystone)
- **file:** `apps/backend/src/ctx/operator-pool.ts:30-51,121-132,266-302`
- **description:** Operator bearers are loaded once from the static `CTX_OPERATOR_POOL` JSON (`OperatorEntry` is `{id, bearer, clientId}`) and **never refreshed or rotated** — there is no `/refresh-token` call for operator credentials, no expiry tracking, no re-login. CTX JWTs expire. When an operator's bearer expires, CTX returns **401** ("token invalid"), which `operatorFetch` treats as a verbatim 4xx (line 275: only `>=500` retries) — so it does **not** fail over to a healthy sibling operator, does **not** trip the operator's breaker, and does **not** alert. The pool's whole point (ADR 013) is that "a single lame account shouldn't surface as an end-user error," but the most likely lame-account failure mode (expired token) defeats fail-over entirely.
- **impact:** When the primary operator's bearer expires, every procurement / redemption fetch routed to it returns 401 → `procure-one` does `markOrderFailed(order.id, 'CTX returned 401')` on real paid orders, while a perfectly healthy backup operator sits unused. No Discord alert (401 isn't 5xx, doesn't exhaust the pool). Silent, money-adjacent failure on real traffic. Project memory (`project_ctx_refresh_rotation.md`) records that CTX rotates the refresh token on every `/refresh-token` call — there is no operator-side persistence path for this at all.
- **evidence:** `grep -rn "refresh|rotate|expire|exp" operator-pool.ts` → nothing. operator-pool docstring calls the pool "inert until the principal-switch work wires it in" but `procure-one.ts:150` and `procurement-redemption.ts:63` already use it on the live loop-native order path.
- **fix:** (a) Treat a 401 from an operator as an operator-health signal: skip to the next operator and mark the 401'd operator unhealthy (open its breaker) so it's pulled from rotation and alerts. (b) Add operator-token refresh/rotation persistence (re-login or `/refresh-token` against CTX, persisting the rotated token) before the pool carries production traffic. (c) Track this as a known-limitation/ADR deferral if rotation is out of scope for Tranche-1.
- **ref:** ADR 013 (operator pool), `project_ctx_refresh_rotation.md`, `project_ctx_x_client_id_pairing.md`, checklist §28 ("Token rotation persistence").

### CTX-P2-01 — Operator bearer is exposed to CTX in the SSE URL query string (`?token=`)

- **severity:** P2
- **vertical:** V11 / security (cred-leak)
- **file:** `apps/backend/src/ctx/stream.ts:88-104`
- **description:** The SSE stream puts the operator bearer in the query string: `?stream=true&token=<bearer>`. The code is careful never to `log.*` this URL (good — `stream.test.ts:117` asserts the bearer goes in `?token=` and never in `Authorization`, and the thrown error message at `stream.ts:110` uses the token-free `base`). But the credential is still in the **request line**, which lands in CTX's own access logs, any TLS-terminating proxy in between, and Node/undici internal error objects (e.g. an `AggregateError.cause` from a failed connect can carry the input URL). This is an accepted EventSource workaround per the docstring, but the bearer here is a long-lived operator credential, not a per-user token — leak blast radius is the whole pool.
- **impact:** Operator credential exposure in upstream/intermediary logs. Lower likelihood than CTX-P1-02 but high blast radius (one leaked operator bearer = full CTX operator access until manual rotation, and there is no rotation — see CTX-P1-02).
- **evidence:** `stream.ts:90` `const url = \`${base}?stream=true&token=${encodeURIComponent(opts.bearer)}\``.
- **fix:** Confirm CTX accepts the bearer via `Authorization` header on the SSE endpoint (we're not using browser EventSource — line 16 confirms "we're not actually using EventSource on our side"), and move it out of the query string. If CTX truly requires `?token=`, document the accepted risk in an ADR/known-limitation and tighten operator-bearer rotation (CTX-P1-02). Also audit that the URL never reaches Sentry breadcrumbs via a wrapped fetch error.
- **ref:** checklist §2 (Secrets — never logged/transmitted in URLs), §28.

### CTX-P2-02 — SSE initial connect has no own timeout; relies entirely on caller signal (up to 5 min hang)

- **severity:** P2
- **vertical:** V11 / dimension 4 (timeouts on every IO call)
- **file:** `apps/backend/src/ctx/stream.ts:92-104`, `apps/backend/src/orders/procurement-redemption.ts:171-187`
- **description:** `streamGiftCardStatus` only sets `init.signal` when the caller passes one (`stream.ts:103`). It applies **no default fetch timeout** of its own — unlike `operatorFetch` (`operator-pool.ts:223` 30s default) and every breaker call site (15-30s `AbortSignal.timeout`). Its sole caller, `waitForRedemption`, passes a signal that aborts only at `totalTimeoutMs` (5 min default). So a wedged CTX SSE endpoint that accepts the TCP connection but never sends bytes parks a procurement tick's redemption wait for the **full 5 minutes** before falling back to polling.
- **impact:** Worst-case 5-minute stall per stuck order on the redemption path; no connect-level timeout means a half-open CTX socket isn't detected promptly. Procurement throughput collapses under a CTX SSE brownout instead of degrading to fast polling.
- **evidence:** No `AbortSignal.timeout` in `stream.ts`; `waitForRedemption` controller aborts at `totalTimeoutMs` only.
- **fix:** Add an idle/connect timeout inside `streamGiftCardStatus` (e.g. abort if no first byte within N seconds, or a per-read idle timer) so a dead stream falls back to polling quickly instead of consuming the whole budget. The function already documents "On any stream error … fall back to polling" — a connect timeout makes that path actually fire.
- **ref:** checklist §4 ("Timeouts on every network/IO call"), §13.

### CTX-P2-03 — `fetchRedemption` swallows non-ok and schema-drift as empty payload — masks real CTX failures (matches the open MEMORY redemption finding)

- **severity:** P2
- **vertical:** V11 / dimension 4 (swallowed errors that hide failures)
- **file:** `apps/backend/src/orders/procurement-redemption.ts:58-104`
- **description:** `fetchRedemption` returns `{code:null,pin:null,url:null}` on **both** a non-ok HTTP status (`:68-74`) and a Zod schema mismatch (`:77-83`), logged only at `warn`. The caller (`waitForRedemption` poll loop / `redemption-backfill`) cannot distinguish "CTX 500 / schema drift" from "CTX 200, codes genuinely not issued yet." A persistent CTX schema drift on `GET /gift-cards/:id` would therefore be invisible at the order level: the order fulfills with null codes, the backfill sweeper retries 10× (all "still empty"), and only then pages — never firing `notifyCtxSchemaDrift` the way the auth/merchants/order-create paths do. Project memory's still-open item ("redeemUrl/Code/Pin returned false — either CTX delay or fetchRedemption swallowing an error") is exactly this swallow.
- **impact:** A real CTX-side failure (5xx, auth, or schema drift) on the redemption-detail endpoint is indistinguishable from normal issuance latency, so it doesn't alert via the schema-drift notifier and burns the full 10-attempt backfill budget before paging. Diagnosis-blind on the user-facing "Ready" payload path.
- **evidence:** `:73` and `:82` both `return { code:null, pin:null, url:null }`; only the all-null-200 case logs a body preview (`:95-102`). No `notifyCtxSchemaDrift` call here, unlike `handler.ts`, `get-handler.ts`, `merchants/sync.ts`.
- **fix:** Distinguish the three outcomes: fire `notifyCtxSchemaDrift({surface:'GET /gift-cards/:id'})` on the safeParse failure (parity with sibling handlers), and surface non-ok status to the caller (e.g. a discriminated result) so the backfill sweeper can treat a 5xx as a transient error worth a faster retry vs. a 200-empty worth the backoff schedule. Closes the open MEMORY redemption-fetch investigation.
- **ref:** checklist §4, §6 (no alert gaps / silent failures), §28; `MEMORY.md` "Redemption-fetch follow-up".

### CTX-P2-04 — HALF_OPEN probe is shared across all concurrent callers of a breaker; a slow non-procurement probe can starve procurement on the same key

- **severity:** P2
- **vertical:** V11 / dimension 4 / 11 (breaker concurrency)
- **file:** `apps/backend/src/circuit-breaker.ts:131-139,68-84`, `apps/backend/src/circuit-breaker-registry.ts:21-37`
- **description:** Breakers are keyed by endpoint **category** (`'gift-cards'`, `'merchants'`, etc.). The `'gift-cards'` breaker is shared by legacy order-create (`handler.ts`), order-get (`get-handler.ts`), and order-list (`list-handler.ts`) — but note `operatorFetch` uses **per-operator** breakers (`operator:<id>`), so the loop-native procurement path is on a different breaker from the legacy `'gift-cards'` proxy. Within a shared key: in HALF_OPEN only one probe is allowed (`halfOpenInFlight`), and the probe inherits the **caller's** timeout. A caller with a long timeout (e.g. order-create's 30s) holding the single probe slot means every other caller on that key gets `CircuitOpenError` for up to 30s (or the 60s `probeTimeoutMs` failsafe). The probe winner is non-deterministic.
- **impact:** Recovery latency is gated by whichever caller happens to win the probe; a slow/large request can monopolize the half-open slot and reject faster siblings. The `probeTimeoutMs` failsafe (`:68-84`) caps the damage at 60s and is correctly `unref`'d, so this is bounded, not unbounded — hence P2 not P1.
- **evidence:** single `halfOpenInFlight` flag per breaker; probe uses `outboundInit`'s caller signal, not a breaker-owned probe timeout.
- **fix:** Consider a breaker-owned probe timeout (independent of caller signal) so a long-timeout caller can't hold the slot for its full window; or document the shared-probe semantics as accepted. Low urgency given the 60s failsafe.
- **ref:** checklist §4 ("half-open probes; independent breakers"), §11.

### CTX-P3-01 — Idempotency-Key on procurement is best-effort/unverified; no fallback if CTX ignores it

- **severity:** P3
- **vertical:** V11 / dimension 3 (idempotency on writes)
- **file:** `apps/backend/src/orders/procure-one.ts:154-164`
- **description:** The `Idempotency-Key: order.id` on `POST /gift-cards` is honestly documented as "if they honour it; worst case the header is inert" (`:160-162`). The real double-charge protection is the downstream `pay-ctx` Horizon `findOutboundPaymentByMemo` + amount/asset reconcile (CTX-side: PayCtxReconcileError). That's a sound belt-and-suspenders design, but: if CTX silently ignores Idempotency-Key, a lost-response retry creates a **second CTX gift-card order** (a second `ctx_order_id`) even though Loop only pays one of them via the memo idempotency. The order row only stores one `ctx_order_id`, so the orphan CTX order is invisible to Loop and never reconciled.
- **impact:** Potential orphaned/unpaid duplicate CTX-side orders on retry-after-lost-response, undetected on Loop's side. Money risk is contained by pay-ctx memo idempotency (Loop pays once), but supplier-side reconciliation drift is possible. Low likelihood (requires lost-response + CTX ignoring the key).
- **evidence:** `:163` `'Idempotency-Key': order.id`; comment `:160` "if they honour it."
- **fix:** Verify with CTX whether Idempotency-Key is honored (contract test / recorded fixture). If not, add a pre-create check ("does a CTX order already exist for this Loop order id?") before re-POSTing, or persist+reconcile any duplicate `ctx_order_id`. Track as a deferral if accepted for Phase 1.
- **ref:** checklist §3, §11, §25 (settlement to CTX correctness); ADR 010.

### CTX-P3-02 — `OPAQUE_TOKEN_RE` (32+ base64url chars) can over-redact legitimate long IDs in error bodies, hurting diagnosis

- **severity:** P3
- **vertical:** V11 / observability
- **file:** `apps/backend/src/upstream-body-scrub.ts:34,62-77`
- **description:** `OPAQUE_TOKEN_RE = /\b[A-Za-z0-9_-]{32,}\b/g` redacts any 32+ char alphanumeric run. CTX order ids, request ids, and merchant ids can easily exceed 32 chars and would be replaced with `[REDACTED_TOKEN]`, stripping exactly the identifiers an operator needs to debug a schema drift from the truncated body. This is a deliberate "false positives acceptable" trade (docstring), and erring toward over-redaction is the safe direction — but it does degrade the diagnostic value the scrubber exists to preserve.
- **impact:** Truncated error-body logs may redact harmless correlation ids, making CTX incident triage harder. No security downside; purely diagnostic.
- **evidence:** `:34` pattern; `CARD_RE = /\b\d{13,19}\b/g` (`:36`) similarly redacts any 13-19 digit run (long numeric ids).
- **fix:** Accept as-is (safe default), or narrow OPAQUE_TOKEN_RE to require mixed-class entropy / a token-ish prefix. Low priority.
- **ref:** checklist §6 (redaction vs diagnosability).

### CTX-P3-03 — `procure-one` stores a placeholder `ctxOperatorId: 'pool'`, so the documented operator-recovery sweep can't join to the real operator

- **severity:** P3
- **vertical:** V11 / completeness
- **file:** `apps/backend/src/orders/procure-one.ts:85-93`
- **description:** `markOrderProcuring(order.id, { ctxOperatorId: 'pool' })` stashes the literal string `'pool'` because `operatorFetch` picks the operator internally and the call site doesn't know which one was used. The comment references "an operator-recovery sweep (deferred)" that would "join against" this label — but a constant `'pool'` for every order makes that join meaningless. The recovery sweep is unbuilt (deferred), so this is a latent gap, not a live bug.
- **impact:** A future operator-recovery sweep can't attribute a stranded `procuring` order to the operator that handled it. Audit-trail value of `ctx_operator_id` is nil today.
- **evidence:** `:89` literal `'pool'`; `:86-88` comment "best-effort audit label."
- **fix:** Have `operatorFetch` return (or expose) the selected operator id so the call site can persist the real id, or drop the column until the recovery sweep is built. Tie to a ticket.
- **ref:** checklist §17 (stuck-row recovery), Part 5 completeness sweep (deferred/half-built).

### CTX-P3-04 — Test gaps: no test for operator 401 fail-over, 429 toward upstream, SSE token never reaching logs/Sentry, or X-Request-Id propagation in operatorFetch

- **severity:** P3
- **vertical:** V11 / test coverage
- **file:** `apps/backend/src/ctx/__tests__/operator-pool.test.ts`, `apps/backend/src/ctx/__tests__/stream.test.ts`
- **description:** Pool tests cover round-robin, 5xx/network retry, 4xx pass-through, exhaustion alert + throttle, default-timeout signal, and clientId override — solid. But the risky behaviors flagged above are untested: (a) what `operatorFetch` does on a **401** (CTX-P1-02) — there's no test asserting it does/doesn't fail over; (b) **429** handling (CTX-P1-01); (c) X-Request-Id propagation onto the outbound (the pool sets it at `:262-265` but no test); (d) the SSE bearer never leaking into a thrown error / log (the positive `?token=` test exists, but no negative "token absent from error.message" test despite `stream.ts:88` calling it out as load-bearing). `redemption-backfill` and `procure-one` pool-unavailable revert paths are tested in their own suites.
- **impact:** The two P1 behaviors have no regression guard, so a future change could silently make 401/429 fail-over worse.
- **evidence:** `grep "401\|429\|X-Request-Id"` over the two CTX test files → no matches.
- **fix:** Add tests for 401-fail-over (after CTX-P1-02 fix), 429-backoff (after CTX-P1-01 fix), X-Request-Id propagation, and SSE-bearer-not-in-error.
- **ref:** checklist §12.

### CTX-N-01 (nit) — `redemption-backfill.ts` `BackfillRow` interface drops `ctxOrderId`/`fulfilledAt` nullability vs. the select; harmless but mildly misleading

- **severity:** P3 (nit)
- **vertical:** V11 / code quality
- **file:** `apps/backend/src/orders/redemption-backfill.ts:231-238`
- **description:** `BackfillRow` types `ctxOrderId: string | null` and `fulfilledAt: Date | null`, but `recordEmptyAttempt` is only ever called after the `row.ctxOrderId === null` guard (`:147`). Minor; no bug.
- **fix:** None required; optional narrowing.
- **ref:** §14.

---

## Summary

**Severity counts:** P0: 0 · P1: 2 · P2: 4 · P3: 5 (incl. 1 nit) — 11 findings.

The vertical is, on the whole, **well-built and clearly the product of prior
audit rounds** (A2-572/573, A2-1305/1326/1510, A4-017/083/101 are all visibly
landed and tested). Strong points: every upstream response is Zod-validated
before use/forward (procure-one, redemption, auth, merchants, orders);
breakers are per-endpoint and independent with an `unref`'d half-open
failsafe; `upstreamUrl` is a thorough SSRF/CRLF/traversal guard (raw +
percent-encoded `..`, C0/C1 controls, protocol-relative); the body-scrubber
covers JWT/token/email/card/Stellar/Discord shapes; pool exhaustion and
schema drift both alert with dedup + runbooks; the X-Client-Id↔clientId
keystone and the Idempotency-Key + pay-ctx memo-reconcile hardening are
present and correct.

The two **P1s are both omissions of a documented dimension-28 requirement**,
not regressions:

1. **No 429/rate-limit handling toward CTX** — a CTX rate-limit becomes a
   self-sustaining hot loop (breaker treats 429 as success; no Retry-After;
   procurement fails orders instead of deferring). (CTX-P1-01)
2. **Operator-bearer expiry (CTX 401) defeats pool fail-over** — bearers are
   static, never rotated, and a 401 is treated as a verbatim 4xx, so an
   expired primary operator fails real paid orders while a healthy backup
   sits idle, silently (no alert). (CTX-P1-02)

Both are live on the loop-native order path (procure-one / redemption already
consume the pool, despite the module docstring still calling it "inert").
P2-03 also matches the still-open MEMORY redemption-fetch finding: a CTX
schema drift on `GET /gift-cards/:id` is swallowed as "empty payload" and
never fires the schema-drift notifier.

**Launch-readiness:** acceptable for Tranche-1 _only if_ the operator pool is
either single-operator (no fail-over to lose) with manual bearer refresh and
alerting bolted on, or if CTX-P1-01/02 are remediated before the pool carries
production order traffic.
