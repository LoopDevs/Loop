# ADR 018: Discord operational-visibility surface

Status: Accepted
Date: 2026-04-22
Implemented: incrementally since PR #211 (first `notifyOrderCreated`). Most recent additions: PR #405 (`notifyCashbackCredited`), #411 (`notifyOperatorPoolExhausted`), #415 (`notifyAdminCreditAdjustment`), #416 (`notifyOrderRefunded`), #419 (`notifyPayoutRetried`).
Related: ADR 009 (credits ledger), ADR 013 (CTX operator pool), ADR 015 (stablecoin topology + payouts), ADR 017 (admin credit primitives)

## Context

Over the last several weeks we've grown a family of Discord notifiers in `apps/backend/src/discord.ts`. They started as one-offs — first a new-order signal, then a fulfilment signal, then a few ops pagers — and have accumulated faster than the operator muscle memory can track. The rate this is adding up, we need a design document before the next handful land.

The family today:

| Notifier                            | Channel    | Trigger                                          |
| ----------------------------------- | ---------- | ------------------------------------------------ |
| `notifyOrderCreated` 🛒             | orders     | New Loop order created                           |
| `notifyOrderFulfilled` ✅           | orders     | CTX procurement succeeded, gift card ready       |
| `notifyCashbackCredited` 💰         | orders     | Positive cashback row written on fulfilment      |
| `notifyOrderRefunded` ↩️            | orders     | Admin refunded a failed order                    |
| `notifyAdminCreditAdjustment` 🟢/🟠 | monitoring | Admin wrote a credit-ledger adjustment           |
| `notifyPayoutFailed` 🔴             | monitoring | Outbound Stellar payout transitioned to failed   |
| `notifyPayoutRetried` 🔄            | monitoring | Admin flipped a failed payout back to pending    |
| `notifyCircuitBreaker` 🔴/🟢        | monitoring | An upstream circuit transitioned open / closed   |
| `notifyHealthChange` 💚/🟠          | monitoring | Merchant/location store health changed           |
| `notifyOperatorPoolExhausted` 🔴    | monitoring | Every CTX operator's breaker is open             |
| `notifyUsdcBelowFloor` 🟡           | monitoring | Operator USDC balance under `USDC_FLOOR_STROOPS` |

Without a captured policy, the next operator-activity signal will end up wherever the author felt was cleanest that afternoon. With one, every follow-up is a 30-second routing decision.

## Decision

### Two channels, three categories

Every signal goes to exactly one of two webhooks:

- **`DISCORD_WEBHOOK_ORDERS`** (a.k.a. "orders" channel) — **customer-facing money movement**. A customer just got an order / cashback / refund. Volume is proportional to sales; ops watches for throughput + trends, not for paging.
- **`DISCORD_WEBHOOK_MONITORING`** (a.k.a. "monitoring" channel) — **operational events worth ops attention**. Ops either _audits_ the event (who did what, when) or _responds_ to it (page, investigate, remediate). Volume should stay low; every signal here should either be rare or rate-limited.

Within those two channels, signals fall into three conceptual categories — which inform _what_ we put in the embed, not _where_ we send it:

1. **Customer event** (orders channel). One-line summary of the customer-visible outcome. Merchant + amount + order id. No stack traces, no admin ids.

   Examples: `notifyOrderCreated`, `notifyOrderFulfilled`, `notifyCashbackCredited`, `notifyOrderRefunded`.

2. **Admin audit trail** (monitoring channel). Someone inside Loop did something that touches the ledger or the state machine. The embed names the actor (truncated admin id), the subject (truncated user / payout id), and the _why_ (note / reason / prior-attempt count). This is the Discord analog of the `reference_type='admin_adjustment'` audit trail on the ledger row itself (ADR 017).

   Examples: `notifyAdminCreditAdjustment`, `notifyPayoutRetried`.

3. **Infrastructure health / paging** (monitoring channel). An upstream or internal system entered a degraded state that needs ops action. Throttled at the caller so a sustained outage doesn't spam. Red / orange colour-coding so the channel reads as a dashboard.

   Examples: `notifyPayoutFailed`, `notifyCircuitBreaker` (open), `notifyHealthChange` (degraded), `notifyOperatorPoolExhausted`, `notifyUsdcBelowFloor`.

### Conventions every notifier obeys

- **Fire-and-forget**. The notifier is a sync function returning `void`; internally it calls `void sendWebhook(...)`. Callers never `await` the notification — a slow Discord API must never block a customer request or a DB transaction.
- **Never inside a DB transaction**. Every caller fires _after_ its transaction commits. A flaky webhook cannot stretch a Postgres lock, and a webhook failure never rolls back the ledger row. See the consistent "fire after txn commits" comment in `credit-adjustments.ts`, `refund.ts`, `payouts.ts`.
- **Markdown escape every upstream string**. `escapeMarkdown()` runs on merchant names, reasons, notes — anything that originated outside our codebase. Prevents a customer-facing `Evil\`merchant_name` from breaking the embed layout or injecting formatting.
- **Mention-parse suppression**. Every `sendWebhook()` call sets `allowed_mentions: { parse: [] }`. A merchant or user-supplied name containing `@everyone` would otherwise ping the channel.
- **Bigint-safe amount formatting**. Monetary signals use `formatMinorAmount(bigintString, currency)` — never cast to `Number` mid-flight. A cashback credit in 100k minor units must render as `£1,000.00`, not lose precision.
- **Truncate upstream fields** to Discord's 1024-char field-value cap. A 10k-character failure reason won't reject the whole webhook with 400.
- **Failure is silent** — `sendWebhook` logs a warn but never throws. A missing `DISCORD_WEBHOOK_*` env is a no-op; ops gets signals when it configures the hook, no config is a "don't page" mode.

### Throttling policy

Only _health / paging_ signals are throttled. Audit and customer signals fire every time.

- `notifyOperatorPoolExhausted`: 15-minute window per process (module-scoped `lastExhaustedAlertAt`).
- `notifyUsdcBelowFloor`: 15-minute window per process.
- `notifyCircuitBreaker`: no module throttle — the breaker itself de-dupes the transition-to-OPEN edge (only the first thresholded failure fires; subsequent failures inside OPEN are no-ops).

Fifteen minutes is long enough that ops isn't scrolling past dozens of duplicate pages; short enough that a "still bad" ping arrives within the first response rotation.

Every throttle has a `__reset*ForTests` seam so tests can exercise the window deterministically without mocking `Date.now()`.

### Actor id truncation

Audit signals include admin and target-user ids. Discord embed fields are capped at 1024 chars, which isn't the constraint — it's visual noise. Every id is truncated to 8 chars (`abcd1234…`), which is:

- Unique enough to distinguish actors in practice (UUIDv4 first 8 hex chars give ~4 billion possibilities; a Loop team is <100 people).
- Log-friendly — a reviewer scrolling the channel can pattern-match on a familiar 8-char prefix without reading the whole UUID.
- Privacy-safe — the truncation is the same format we use in Pino logs, so a Discord embed doesn't accidentally widen the PII footprint beyond what `log.info` already commits.

Full UUIDs remain on the DB row (`reference_id` for adjustments, `id` columns on the payout / order tables). The Discord signal is a pointer, not a dump.

## Consequences

### What this changes

- New signals are 1-sentence decisions: _who_ is the audience (customer-visible → orders; ops → monitoring)? _What_ is the category (customer / audit / health)? The embed shape falls out of the category.
- A future consolidation pass (shared helper for field-building, consistent truncation lengths, etc.) can hang off this taxonomy without a "but what about…" argument per signal.
- The throttling story is consistent: rare operational alerts throttle at the caller; audit + customer signals always fire. An adjustment that fires 100 times in an hour is a feature (the channel IS the audit log); a pool-exhausted that fires 100 times is noise.

### What this deliberately does NOT do

- **No migration to a real observability tool.** Discord isn't Datadog — it's a chat bridge with `fetch`. The value is that ops already lives in Discord and doesn't have to context-switch. If Loop grows into a team that routes alerts through PagerDuty, that's a migration; this ADR only shapes the current design.
- **No structured / machine-readable payloads.** Every signal is a human-readable embed. If we ever want to pipe these back out (e.g., a sister bot ingesting the channel as a timeline feed), we'd want to emit a secondary structured event — not retrofit the embed fields.
- **No per-signal retry.** `sendWebhook` has a 5-second timeout and no retries. Discord's own rate-limiting is 429-returning; re-sending after that would only amplify. A missed signal is missed — the DB row still exists, the request-ID still logs, and `/admin/treasury` still shows the state.
- **No channel sharding within Discord.** Two webhooks, period. A future "alerts" sub-channel for red-only monitoring embeds is a configuration change, not a code change (the notifier signature wouldn't change — only the webhook URL).
- **No Discord-bot / interactive commands.** The outbound direction is enough for the primitives we need. Reading ops input back through Discord is a much bigger surface (identity mapping, command auth, rate limits) that we don't need to solve to get value from the outbound signals.

### Operational observability notes

- Every notifier has a unit test under `apps/backend/src/__tests__/discord.test.ts` asserting the embed shape, channel allocation, mention-parse suppression, and markdown escape. Adding a new notifier without one is a review-time nit.
- Call-site tests assert that the notify fires _only_ on the success path and _never_ on 4xx / 5xx responses (see `credit-adjustments.test.ts`, `refund.test.ts`, `payouts.test.ts`). This catches the "wired up in the wrong place" mistake where a signal fires before the DB commit.
- The `DISCORD_WEBHOOK_*` env vars are optional. In development / test environments they're unset; `sendWebhook()` short-circuits and ops never sees noise from dev orders. Production deployments set both; staging typically sets monitoring only (ops sees infra-paging signals, no customer noise).

## Migration path

No migration required. This ADR captures existing behaviour and the incremental additions from PRs #405, #411, #415, #416, #419. Future notifiers should land with a Discord-test case and a reference to this ADR in the handler's module doc.
