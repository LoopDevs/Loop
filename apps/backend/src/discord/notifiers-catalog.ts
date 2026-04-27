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
      'Fires when a LOOP asset drifts past the operator threshold — on-chain circulation vs off-chain ledger liability (ADR 015). In-memory dedupe: fires once on ok→over, once on over→ok via notifyAssetDriftRecovered.',
  },
  {
    name: 'notifyAssetDriftRecovered',
    channel: 'monitoring',
    description:
      'Fires once per asset on the over→ok transition paired with notifyAssetDrift. Closes the drift incident in the channel so ops reads a beginning AND end for every alert.',
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
    name: 'notifyPayoutFailed',
    channel: 'monitoring',
    description:
      'Fires when a pending_payouts row flips to `failed` (ADR 015/016). Embed carries asset code + user id + lastError preview.',
  },
  {
    name: 'notifyStuckProcurementSwept',
    channel: 'monitoring',
    description:
      'Fires when the sweep flips a stuck `procuring` order to `failed` (A2-621). Per-row so ops can reconcile individually — each row might be a CTX-minted-but-we-lost-track case where refunding the user would double-spend.',
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
    name: 'notifyWebhookPing',
    channel: 'monitoring',
    description:
      'Manual test ping from an admin — proves a channel is wired up after rotating the webhook env var. Sent on demand from /api/admin/discord/test; never fires automatically.',
  },
]);
