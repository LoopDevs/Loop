# Changelog

All notable changes to this project are documented here.

- Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- Loop is pre-launch and continuously deployed; we do not tag
  versioned releases. Each entry under **Unreleased** describes a
  merged change; moving entries into a dated release section will
  start at the first public launch.
- Audit-remediation PRs reference the finding ID (e.g. `A2-552`) so
  the audit-tracker and the changelog point at the same work.

## Unreleased

### Admin panel + treasury

- **A2-502** — `PUT /api/admin/merchant-cashback-configs/:merchantId`
  is now ADR-017 compliant end-to-end: `Idempotency-Key` required,
  `reason` required, `{result, audit}` envelope, Discord fanout,
  reason prompt in the admin UI.
- **A2-509 / A2-1004** — `POST /api/admin/merchants/resync`
  brought into ADR-017 compliance alongside the other admin
  writes.
- **A2-507** — five admin handlers (`listConfigs`,
  `configHistory`, `adminMerchantFlowsHandler`,
  `adminUserSearchHandler`, `adminReconciliationHandler`) now
  catch their own DB errors so logs keep the handler-scoped
  binding instead of falling through to the generic 500.
- **A2-501** — admin Discord-config surface now reports the
  `DISCORD_WEBHOOK_ADMIN_AUDIT` channel status.
- **A2-511** — admin-audit Discord embed drops the full admin
  email; actor-id tail matches the rest of the audit channel.
- **A2-908** — ledger writes (`type='adjustment' / 'refund'`)
  persist the operator `reason` on the row itself, not just in
  the 24h-TTL idempotency snapshot.
- **A2-907** — reconciliation response renames `userCount` to
  `rowCount` so the semantic matches the aggregation (rows, not
  distinct users).
- **A2-503 / A2-504** — admin merchants-catalog CSV now scopes
  the `merchant_cashback_configs` query to the emitted rows via
  `inArray`, and drops the no-op `eq(merchantId, merchantId)`
  self-comparison.
- **A2-510** — user-credits CSV truncation sentinel routes
  through the shared `csvRow` helper for parity with the other
  Tier-3 exports.
- **A2-513** — admin `upsertConfigHandler` +
  `configHistoryHandler` validate the `merchantId` shape
  (`[A-Za-z0-9._-]` + 128-char cap) before touching the DB.

### Ledger / stablecoin

- **A2-704** — `credit_transactions.currency` picks up a CHECK
  constraint matching `user_credits.currency_known`; rogue-currency
  ledger rows can no longer land and orphan through the
  reconciliation view.
- **A2-702** — `user_credits` promoted to a composite primary key
  `(user_id, currency)`. Replication / CDC tools now see a stable
  row identity; query plans unchanged.
- **A2-703** — migration 0016 re-asserts the
  `merchant_cashback_configs_audit` trigger + plpgsql function
  idempotently so drizzle-push can't silently drop the ADR-011
  audit trail.
- **A2-203** — `DEFAULT_USER_CASHBACK_PCT_OF_CTX` +
  `DEFAULT_LOOP_MARGIN_PCT_OF_CTX` env vars now drive the default
  split for merchants without an admin-set
  `merchant_cashback_configs` row.
- **A2-552** — `setHomeCurrency` collapsed into an atomic UPDATE
  with a `NOT EXISTS (SELECT 1 FROM orders ...)` guard; no more
  count→update race with concurrent order inserts.

### CTX-as-supplier / operator pool

- **A2-572** — `operatorFetch` retries against the next healthy
  operator on 5xx and network errors, matching the docstring. 4xx
  still propagates verbatim.
- **A2-573** — operator-pool `initialised` flag no longer latches
  before a successful parse; a malformed `CTX_OPERATOR_POOL` can
  be fixed at runtime without a restart.
- **A2-1510** — `operatorFetch` applies a 30s default-timeout
  signal when the caller doesn't supply one.

### Shared types / helpers

- **A2-812** — backend + web converge on the shared
  `isLoopAssetCode` / `loopAssetForCurrency` helpers from
  `@loop/shared/loop-asset` instead of duplicating the lookup.
- **A2-811** — `CreditTransactionType` moved from local web
  duplicate to `@loop/shared`.
- **A2-512** — UUID regex consolidated into
  `apps/backend/src/uuid.ts` across 15 call sites.
- **A2-204** — `ApiErrorCode` picks up every backend-emitted code
  (`IDEMPOTENCY_KEY_REQUIRED`, `INSUFFICIENT_BALANCE`,
  `INSUFFICIENT_CREDIT`, `HOME_CURRENCY_LOCKED`,
  `REFUND_ALREADY_ISSUED`, `NOT_CONFIGURED`,
  `WEBHOOK_NOT_CONFIGURED`, `UPSTREAM_UNAVAILABLE`) so web
  switches catch future drift at the TypeScript layer.

### Auth / web

- **A2-1156** — 10 `['me', …]` cashback / orders queries
  auth-gated on `isAuthenticated`; stops the cold-boot
  thundering-herd of 401 → tryRefresh calls during session
  restore.
- **A2-567** — social-login verifier accepts both Google `iss`
  variants (`https://accounts.google.com` and
  `accounts.google.com`).

### Infra / security / docs

- **A2-114** — `superfly/flyctl-actions/setup-flyctl@master`
  SHA-pinned to release 1.5.
- **A2-116** — workflow-level `permissions: {}` (deny-by-default)
  on `pr-automation.yml` + `pr-review.yml`.
- **A2-104** — CODEOWNERS now covers credits / admin / payments /
  ctx / db / migrations / shared wire types / ADRs explicitly.
- **A2-109** — CONTRIBUTING review-gate line now reflects actual
  enforcement (CODEOWNERS team doesn't exist yet; admin bypass
  permitted).
- **A2-124 / A2-125** — `LICENSE` (source-available-for-review)
  - `SECURITY.md` (responsible disclosure) on the public repo.
- **A2-111** — `.gitattributes` with LF pins on shell/SQL +
  lockfile / proto / migration-meta `linguist-generated`.
- **A2-411** — `.husky/pre-push` runs `scripts/verify.sh` so
  local-vs-CI Quality-job parity is maintained.
- **A2-108 / A2-110** — `CONTRIBUTING` branch-type list +
  CI-job-count drift fixed.
- **A2-201 / A2-202** — AGENTS.md rules rewritten to match
  actual auth + loader architecture.
- **A2-555** — upstream body logs scrub JWT-shaped and
  opaque-token substrings before Pino emits them.
- **A2-558** — OTP circuit-open + fetch-error responses collapse
  to the generic 200 enumeration envelope.
- **A2-560 / A2-561** — OTP attempts ceiling off-by-one fix +
  `incrementOtpAttempts` targets the single newest live row.
- **A2-550 / A2-551 / A2-565** — CTX pass-through bearer no
  longer trusted for identity resolution; logout revokes every
  live refresh row.
