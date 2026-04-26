# Log policy (A2-1911)

This document is the source of truth for **what gets logged, what
gets redacted, how long logs are kept, and who can read them**.

## What gets logged

The Loop backend logs:

- **Per-request access lines** (Pino-backed access middleware,
  `apps/backend/src/app.ts`). Method, path, status, duration,
  request id, client IP. Per-line tag: `area: 'access'`.
- **Application events**: every handler-level decision worth
  surfacing — auth path, rate-limit hits, circuit-breaker
  transitions, payout-submit results, ledger writes (admin or
  cashback). Tagged via Pino child loggers (`logger.child({ area:
'admin-write' })` etc.).
- **Admin read audit lines** (A2-2008). Every admin GET that returns
  200 emits a structured line tagged `area: 'admin-read-audit'`
  with `actorUserId`, `path`, `query`, `isBulk`. The line-item read
  trail ships off-host so a malicious admin deleting DB rows can't
  cover the read trail.
- **Errors** with stack + redacted context.

The Loop web app SSR layer follows the same pattern — Pino under the
hood, same redaction list. The static-export build doesn't run on a
server, so it has no logs.

## What gets redacted

Pino's `redact: { paths: ... }` config in
`apps/backend/src/logger.ts` (`REDACT_PATHS`) replaces the matched
paths with `[REDACTED]` before any record reaches a transport.
Categories:

- **Auth bearers** — `authorization`, cookie headers, every nested
  variant.
- **Token fields** — `accessToken`, `refreshToken`, OTP `code`,
  password.
- **API credentials** — `apiKey`, `apiSecret`, `X-Api-Key`,
  `X-Api-Secret` at every depth.
- **Stellar wallet material** — `secret`, `privateKey`, `secretKey`,
  `seedPhrase`, `mnemonic`, `operatorSecret`. Defence-in-depth:
  these should never touch the backend in the first place; the
  redaction is a backstop against a bug logging the wrong object.

**Email is intentionally NOT redacted.** Operators need to know
which user an auth failure or admin write applied to; redacting
emails would defeat the audit story. The trade-off is documented
inline in `logger.ts:10-11`.

Sentry has a parallel scrubber (`apps/backend/src/sentry-init.ts` /
`apps/web/app/sentry.client.ts`) that strips JWT-shaped substrings
from error breadcrumbs before Sentry receives them — covers cases
where Pino redaction misses a nested string-encoded payload.

## Log retention (Phase 1)

| Surface                           | Retention | Source of truth                                              |
| --------------------------------- | --------- | ------------------------------------------------------------ |
| Fly machine logs                  | 14 days   | Fly logflow default                                          |
| Sentry events                     | 30 days   | Sentry plan default                                          |
| Discord audit feed                | unbounded | Discord channel history (subject to Discord's own retention) |
| Postgres `admin_idempotency_keys` | 24 hours  | Sweep job (ADR 017 / A2-500)                                 |

Fly logflow's 14-day default is acceptable for Phase 1 — most
incident triage happens within that window. Phase-2 work will move
the access-log + admin-audit streams into a longer-retention
external sink (likely BetterStack or a self-hosted Loki) before Loop
processes EU PII at scale.

## PII redaction floor

The redact list is the **floor**, not the ceiling. Any new field
shape that could carry tokens or credentials is added to
`REDACT_PATHS` in the same PR that introduces it. The unit tests in
`apps/backend/src/__tests__/logger.test.ts` exercise the canonical
shapes (auth bearer, refresh token, OTP, API key, operator secret)
so a regression that drops a path fails CI, not prod.

## Access RBAC

| Role             | Can read                                                     |
| ---------------- | ------------------------------------------------------------ |
| `loop-admin`     | Fly logs (via `flyctl`), Sentry, Discord audit               |
| `loop-readonly`  | Postgres SELECT only — no log access                         |
| `support`        | Discord audit channel (read-only via per-channel permission) |
| External vendors | None                                                         |

Role assignments live in 1Password's "Loop · Access" vault; rotating
out a maintainer is a single-vault change plus a `flyctl` token
revoke.

## Phase-2 deferrals

- External long-retention log sink (90+ days, EU-hosted).
- PII detection scanners on log shipping (regex + tokenisation
  catches anything `REDACT_PATHS` misses).
- Per-user log-export flow tied to the DSR work (A2-1906).

These are tracked as separate tickets and don't block Phase-1
launch.

## When this doc updates

Anything that changes the **redact list, the retention window, or
the access roles** lands in the same PR that changes the underlying
config. The doc is the audit trail; if `REDACT_PATHS` gains a new
field the policy changes here in lock-step. ADR-required if the
change is structural (new sink, new role).
