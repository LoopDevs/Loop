/**
 * Static catalog of the Discord notifiers the backend can emit
 * (ADR 018 operational-visibility surface).
 *
 * Lifted out of `../discord.ts` so the catalog itself — frozen,
 * code-resident, surfaced read-only by the admin UI — lives
 * separately from the channel/helper/ping plumbing in the parent.
 * Same pattern as the per-channel notifier siblings under
 * `./discord/` (orders / monitoring / admin-audit).
 *
 * Keeping the list in code rather than in prose makes it:
 *
 * - **ADR-drift-resistant** — ADR 018 names the taxonomy; a new
 *   notifier landing without updating this const would be caught in
 *   review because the admin UI's surface would silently omit it.
 * - **Zero-DB** — admin handler reads this directly, no round trip.
 * - **Safe for UI** — `channel` is the enum, not the webhook URL, so
 *   no secrets leak through the catalog surface.
 *
 * Keep the entries sorted by channel first, then by function name so
 * the admin-rendered table is stable and diff-friendly.
 *
 * Re-exported from `../discord.ts` so existing import sites keep
 * resolving against the historical path.
 */
import type { DiscordNotifier } from '../discord.js';

export const DISCORD_NOTIFIERS: ReadonlyArray<DiscordNotifier> = Object.freeze([
  {
    name: 'notifyAdminAudit',
    channel: 'admin-audit',
    description:
      'Every successful admin write (ADR 017). One line per mutation with the actor, method, path, status, and replay flag.',
  },
  {
    name: 'notifyAdminBulkRead',
    channel: 'admin-audit',
    description:
      'A2-2008 bulk-read audit. Fires on every successful admin CSV export or full-list bulk read. Single-row drills land in Pino only (would flood the channel).',
  },
  {
    name: 'notifyCashbackConfigChanged',
    channel: 'admin-audit',
    description:
      'Fires on merchant cashback-config create / update (ADR 011). Embeds the old→new pct diff so the commercial impact of the edit is legible in the channel without drilling to the admin UI.',
  },
  {
    name: 'notifyCashbackCredited',
    channel: 'orders',
    description:
      'Fires on every fulfilled order with userCashbackMinor > 0 (ADR 009). Distinct from notifyOrderFulfilled so the "cashback handed out" signal stays separate from the broader fulfillment stream.',
  },
  {
    name: 'notifyCashbackRecycled',
    channel: 'orders',
    description:
      'Fires when a new loop-native order is paid with LOOP-asset cashback the user earned earlier (ADR 015 flywheel). Subset qualifier on notifyOrderCreated — same channel so ops reads volume + flywheel-close together.',
  },
  {
    name: 'notifyFirstCashbackRecycled',
    channel: 'orders',
    description:
      "Fires once per user, on their FIRST loop_asset order — the flywheel-onboarding milestone (ADR 015). Subset of notifyCashbackRecycled; same channel so ops sees the user's graduation from earning → recycling alongside the continuing-recycle signal.",
  },
  {
    name: 'notifyOrderCreated',
    channel: 'orders',
    description: 'Fires on every new loop-native order (ADR 010). Embed lists merchant + amount.',
  },
  {
    name: 'notifyOrderFulfilled',
    channel: 'orders',
    description:
      'Fires when an order transitions to `fulfilled` — the user got their gift card. Complement to the orders-created signal above.',
  },
  {
    name: 'notifyAssetDrift',
    channel: 'monitoring',
    description:
      'Fires when a LOOP asset drifts past the operator threshold — on-chain circulation vs off-chain ledger liability (ADR 015). Persisted dedupe (asset_drift_state): exactly one machine fires once on ok→over, once on over→ok via notifyAssetDriftRecovered.',
  },
  {
    name: 'notifyAssetDriftRecovered',
    channel: 'monitoring',
    description:
      'Fires once per asset on the over→ok transition paired with notifyAssetDrift. Closes the drift incident in the channel so ops reads a beginning AND end for every alert.',
  },
  {
    name: 'notifyDriftFailedRows',
    channel: 'monitoring',
    description:
      'Hardening A2: fires once per asset when terminally-failed burn / interest-mint payout rows appear. These rows keep the drift equation neutral by design (the deposit-held tokens / mirror credits genuinely exist), so drift alone can never surface them — the alert stays open until an operator retries the rows via /admin/payouts?state=failed.',
  },
  {
    name: 'notifyDriftFailedRowsCleared',
    channel: 'monitoring',
    description:
      'Closes the notifyDriftFailedRows incident once the failed burn / interest-mint rows for the asset converge (retried to confirmation). Paired open + close, same pattern as notifyAssetDrift / notifyAssetDriftRecovered.',
  },
  {
    name: 'notifyCircuitBreaker',
    channel: 'monitoring',
    description:
      'Fires when the upstream-CTX circuit breaker transitions open or closed (ADR 013 pool health).',
  },
  {
    name: 'notifyOperatorPoolExhausted',
    channel: 'monitoring',
    description:
      'Fires when every operator in the CTX pool is unhealthy — procurement is blocked. Throttled to once per 15 min per deployment so a sustained outage stays loud without flooding the channel (ADR 013).',
  },
  {
    name: 'notifyLoopAssetOverpayment',
    channel: 'monitoring',
    description:
      'Hardening A7: fires when a LOOP-asset payment overpaid its order charge. The order still fulfils (the user paid enough), but markOrderPaid burns/debits only the charged amount, so the excess is parked at the deposit account (reads as positive drift). Attributed (order/user/excess) so ops can return the excess LOOP directly.',
  },
  {
    name: 'notifyLedgerDrift',
    channel: 'monitoring',
    description:
      'Hardening C1: fires when the off-chain ledger invariant is violated — user_credits.balance_minor disagrees with SUM(credit_transactions) for at least one (user, currency) pair. Run by the ledger-invariant watcher (default daily, single-flighted across machines via advisory lock); deliberately re-pages every tick while the drift persists because an unresolved ledger-integrity incident must not go quiet. Triage via /api/admin/reconciliation.',
  },
  {
    name: 'notifyOperatorCredentialExpired',
    channel: 'monitoring',
    description:
      'CF-13: fires when a CTX operator returns 401 ("token invalid") — its bearer expired or was revoked. operatorFetch pulls the operator from rotation (forces its breaker open) and fails over to a healthy sibling. Per-operator 10-min dedup so a sustained 401 produces one alert per operator per ten minutes (ADR 013).',
  },
  {
    name: 'notifyOperatorFloatDrift',
    channel: 'monitoring',
    description:
      'R3-1: fires when the operator XLM/USDC wallet no longer conserves from its active baseline, or when a Horizon wallet movement is unclassified. Triage via Treasury and the operator-float movement drilldown before treating float as healthy.',
  },
  {
    name: 'notifyCtxSchemaDrift',
    channel: 'monitoring',
    description:
      'A2-1915: fires when an upstream CTX response fails Zod validation on a surface with a recorded contract fixture (A2-1706). Runtime companion to the PR-time contract test. Per-surface 10-min dedup so sustained drift produces one alert per surface per ten minutes, not one per failed request.',
  },
  {
    name: 'notifyHealthChange',
    channel: 'monitoring',
    description:
      'Fires on the /health probe cache transitioning healthy ↔ degraded. Paging-grade for the on-call lookup.',
  },
  {
    name: 'notifyGeoDbStale',
    channel: 'monitoring',
    description:
      "go-live-plan §T1-F: fires when the operator-provided GeoLite2-Country .mmdb is stale (built more than 45 days ago) or configured-but-unopenable. NOT a paging incident — fix is always 'redeploy with the two --build-secret flags' (docs/deployment.md §GeoLite2). Throttled to once per 7 days via a module-level cooldown in health.ts so a forgotten refresh nudges rather than spams.",
  },
  {
    name: 'notifyPayoutFailed',
    channel: 'monitoring',
    description:
      'Fires when a pending_payouts row flips to `failed` (ADR 015/016). Embed carries asset code + user id + lastError preview.',
  },
  {
    name: 'notifyPayoutAwaitingTrustline',
    channel: 'monitoring',
    description:
      'Fires when the payout-worker pre-flight detects the destination account is missing the required trustline (ADR-015 / ADR-016 Phase-2 trustline-probe). Throttled to once per (userId, assetCode) per process. Row stays in `pending` and submits on the next tick once the trustline is added — no admin retry needed.',
  },
  {
    name: 'notifyPegBreakOnFulfillment',
    channel: 'monitoring',
    description:
      "A4-023: fires when an order's pinned chargeCurrency diverges from the user's home_currency at fulfillment time. Off-chain cashback ledger row writes; on-chain payout is skipped. Ops gets a paging-grade signal so the 1:1 LOOP-asset peg can be restored manually before reconciliation drift accumulates.",
  },
  {
    name: 'notifyOrderFailedAfterCtxPaid',
    channel: 'monitoring',
    description:
      'CF-20 (x-flows F1-1): fires when an order fails AFTER Loop already paid CTX (operator XLM/USDC spent) and the user already paid Loop. The worker auto-refunds the user off-chain; ops must chase the wholesale cost back from CTX (operator-side debt). Title escalates to a P0 shape when the auto-refund itself failed (user + treasury both out).',
  },
  {
    name: 'notifyInterestPoolLow',
    channel: 'monitoring',
    description:
      "Fires when a LOOP-asset's interest forward-mint pool can cover fewer than LOOP_INTEREST_POOL_MIN_DAYS_COVER days of forecast daily interest. Deduped once per asset until recovered via the persisted interest_pool_alert_state table (hardening C10a — fleet-consistent, restart-durable, at-least-once); operator's action is to mint the next batch into the pool account before users would be under-allocated.",
  },
  {
    name: 'notifyInterestPoolRecovered',
    channel: 'monitoring',
    description:
      "Closes the prior notifyInterestPoolLow incident once the pool's days-of-cover crosses back above the threshold. Paired open + close mirrors notifyAssetDrift / notifyAssetDriftRecovered so the channel reads as bracketed events.",
  },
  {
    name: 'notifyRedemptionBackfillExhausted',
    channel: 'monitoring',
    description:
      'Fires when the redemption-backfill sweeper has re-fetched the CTX gift-card detail 10 times for a fulfilled order and the redemption payload (code / PIN / URL) is still empty. Per-row — each exhaustion needs a CTX support ticket keyed on the embedded CTX order id (see docs/runbooks/redemption-backfill-exhausted.md).',
  },
  {
    name: 'notifyWalletProvisioningStuck',
    channel: 'monitoring',
    description:
      "Fires when the wallet-provisioning sweeper (ADR 030 Phase C) has failed to provision + activate a user's embedded wallet 10 times and stops retrying. Per-row — each exhaustion needs its own investigation against the wallet-provider dashboard, operator-account funding, and Horizon (see docs/runbooks/wallet-provisioning-stuck.md).",
  },
  {
    name: 'notifyStuckProcurementSwept',
    channel: 'monitoring',
    description:
      'Fires when the sweep flips a stuck `procuring` order to `failed` (A2-621). Per-row so ops can reconcile individually — each row might be a CTX-minted-but-we-lost-track case where refunding the user would double-spend.',
  },
  {
    name: 'notifyStuckPayouts',
    channel: 'monitoring',
    description:
      'Fires when one or more `pending_payouts` rows exceed the watchdog age window. Complements the admin `/stuck-payouts` page with a proactive page instead of requiring manual polling.',
  },
  {
    name: 'notifyPaymentWatcherStuck',
    channel: 'monitoring',
    description:
      "Fires when the payment watcher's Horizon cursor has not advanced in >10 min (A2-626). Catches crashed / hung tickers that would otherwise silently stop processing deposits. One-shot per stuck period.",
  },
  {
    name: 'notifyUsdcBelowFloor',
    channel: 'monitoring',
    description:
      "Fires when Loop's USDC operator balance drops below the alerting floor — time to fund the treasury account before payouts can't clear (ADR 015).",
  },
  {
    name: 'notifyPriceFeedAnomaly',
    channel: 'monitoring',
    description:
      'CF2-06 (2026-06-30 cold audit): fires when the XLM oracle or fiat FX feed returns a rate that jumps by more than the sanity-bound ratio (default 50%) from the last known-good value for that currency. The anomalous rate is rejected (the caller throws and the tick defers), but a feed glitch or compromise still needs operator eyes.',
  },
  {
    name: 'notifyWebhookPing',
    channel: 'monitoring',
    description:
      'Manual test ping from an admin — proves a channel is wired up after rotating the webhook env var. Sent on demand from /api/admin/discord/test; never fires automatically.',
  },
]);
