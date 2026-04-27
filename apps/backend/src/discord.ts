import { env } from './env.js';
import {
  BLUE,
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
  GREEN,
  ORANGE,
  RED,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './discord/shared.js';

// Orders-channel notifiers (5 functions) live in `./discord/orders.ts`.
// Re-exported here so existing call sites
// (`notifyOrderCreated` etc. imported from `./discord.js`) keep
// working without re-targeting their imports.
export {
  notifyOrderCreated,
  notifyCashbackRecycled,
  notifyFirstCashbackRecycled,
  notifyOrderFulfilled,
  notifyCashbackCredited,
} from './discord/orders.js';

/** Notify: health status changed */
export function notifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: status === 'healthy' ? '💚 Service Healthy' : '🟠 Service Degraded',
    description: truncate(details, DESCRIPTION_MAX),
    color: status === 'healthy' ? GREEN : ORANGE,
  });
}

/**
 * Notify: an outbound Stellar payout has transitioned to `failed`
 * (ADR 015/016). Pages the monitoring channel so ops sees it
 * real-time rather than discovering failed rows on the next
 * admin-treasury refresh. The `kind` (from PayoutSubmitError) tells
 * ops whether it's an ops-actionable issue (op_no_trust,
 * op_underfunded) or a retry-exhausted transient — the former
 * often needs the user to add a trustline, the latter is a cue to
 * check Horizon / operator reserves.
 */
export function notifyPayoutFailed(args: {
  payoutId: string;
  userId: string;
  /** Null for `kind='withdrawal'` payouts (A2-901 / ADR-024 §2). */
  orderId: string | null;
  assetCode: string;
  amount: string;
  kind: string;
  reason: string;
  attempts: number;
}): void {
  // A2-1314: ADR-018 last-8 convention. Prior shape emitted full
  // userId / orderId / payoutId into the monitoring channel, so an
  // admin with Discord access but no DB access could reconstruct a
  // user's full uuid + order history from a stream of failures. The
  // tail-id is enough to pivot into the admin shell where the full
  // id lives alongside the access-controlled context.
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Stellar Payout Failed',
    color: RED,
    fields: [
      { name: 'Kind', value: `\`${escapeMarkdown(args.kind)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Amount', value: escapeMarkdown(args.amount), inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      {
        name: 'Order',
        value: args.orderId === null ? '_withdrawal_' : `\`${args.orderId.slice(-8)}\``,
        inline: true,
      },
      { name: 'Payout', value: `\`${args.payoutId.slice(-8)}\``, inline: true },
      {
        name: 'Reason',
        value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

/**
 * Notify: operator USDC balance has dropped below the configured
 * floor (ADR 015). Procurement is now paying CTX in XLM until the
 * reserve is topped up. Ops needs to know because XLM is the
 * break-glass rail — we're burning the (smaller) XLM reserve to
 * keep orders flowing and the USDC pile isn't earning defindex
 * yield while it's empty.
 *
 * Throttled at the caller (once per `LOOP_BELOW_FLOOR_ALERT_INTERVAL_MS`
 * per process) — this function itself fires every time.
 */
export function notifyUsdcBelowFloor(args: {
  balanceStroops: string;
  floorStroops: string;
  account: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 USDC Reserve Below Floor',
    description: truncate(
      `Procurement has fallen back to XLM. Top up ${escapeMarkdown(args.account)} with USDC to re-enable the yield-earning path.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Balance (stroops)', value: escapeMarkdown(args.balanceStroops), inline: true },
      { name: 'Floor (stroops)', value: escapeMarkdown(args.floorStroops), inline: true },
    ],
  });
}

/**
 * Notify: admin write action (ADR 017/018). Called fire-and-forget
 * AFTER the DB commit of every admin mutation. Actor id truncated to
 * the last 8 chars so the embed doesn't expose a full uuid; full id
 * is still in the ledger for audit. A2-511: actor email dropped from
 * the embed — the tail-id convention is the Discord-side identifier,
 * and admin emails are reserved for the ledger row (where they're
 * useful) rather than the webhook feed (where they aren't).
 */
export function notifyAdminAudit(args: {
  actorUserId: string;
  endpoint: string;
  targetUserId?: string;
  amountMinor?: string;
  currency?: string;
  reason: string;
  idempotencyKey: string;
  replayed: boolean;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Actor', value: `\`${actorTail}\``, inline: true },
    { name: 'Endpoint', value: `\`${escapeMarkdown(args.endpoint)}\``, inline: true },
  ];
  if (args.targetUserId !== undefined) {
    fields.push({
      name: 'Target user',
      value: `\`${args.targetUserId.slice(-8)}\``,
      inline: true,
    });
  }
  if (args.amountMinor !== undefined && args.currency !== undefined) {
    fields.push({
      name: 'Amount (minor)',
      value: `${escapeMarkdown(args.amountMinor)} ${escapeMarkdown(args.currency)}`,
      inline: true,
    });
  }
  fields.push({
    name: 'Reason',
    value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
    inline: false,
  });
  fields.push({
    name: 'Idempotency-Key',
    value: `\`${escapeMarkdown(args.idempotencyKey).slice(0, 32)}\``,
    inline: true,
  });
  if (args.replayed) {
    fields.push({ name: 'Replayed', value: 'yes', inline: true });
  }
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: args.replayed ? '🔁 Admin write (replayed)' : '🛠️ Admin write',
    color: args.replayed ? BLUE : GREEN,
    fields,
  });
}

/**
 * A2-2008: bulk-read audit notification. Admin reads are a separate
 * surface from admin writes — logging every single-row drill would
 * flood the channel — but bulk exports (CSV downloads, full-list
 * pulls past a row threshold) are a high-PII surface where a
 * malicious or mis-targeted admin can exfiltrate user data without
 * leaving a trace.
 *
 * Fires on:
 *   - any `GET /api/admin/*.csv` 200 response
 *   - admin GETs flagged as "bulk" by the middleware (large-page
 *     full lists)
 *
 * The Pino access log (server-side, ships off-host via Fly logflow)
 * is the line-item read audit; this Discord post is the human-visible
 * "someone's running an export right now" signal.
 */
export function notifyAdminBulkRead(args: {
  actorUserId: string;
  endpoint: string;
  /** Optional query string (truncated) for context. */
  queryString?: string;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    { name: 'Actor', value: `\`${actorTail}\``, inline: true },
    { name: 'Endpoint', value: `\`${escapeMarkdown(args.endpoint)}\``, inline: true },
  ];
  if (args.queryString !== undefined && args.queryString.length > 0) {
    fields.push({
      name: 'Query',
      value: `\`${truncate(escapeMarkdown(args.queryString), 200)}\``,
      inline: false,
    });
  }
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: '📤 Admin bulk read',
    color: BLUE,
    fields,
  });
}

/**
 * Notify: merchant cashback-config create / update (ADR 011 / 018).
 * Called fire-and-forget AFTER the DB upsert commits, from
 * `upsertConfigHandler`. The admin-audit channel already receives a
 * generic `notifyAdminAudit` line; this one is the domain-specific
 * view with the old → new pct diff so the commercial impact of the
 * edit is readable in Discord.
 *
 * `previous` is null for first-time creates (no prior row to diff).
 * Actor id is truncated to the last 8 chars per ADR 018 convention.
 * `merchantName` falls back to merchantId at the call site — we
 * don't redo the fallback here so the embed text reflects what the
 * admin actually saw in the UI.
 */
export interface CashbackConfigSnapshot {
  wholesalePct: string;
  userCashbackPct: string;
  loopMarginPct: string;
  active: boolean;
}

export function notifyCashbackConfigChanged(args: {
  merchantId: string;
  merchantName: string;
  actorUserId: string;
  previous: CashbackConfigSnapshot | null;
  next: CashbackConfigSnapshot;
}): void {
  const actorTail = args.actorUserId.slice(-8);
  const fields: Array<{ name: string; value: string; inline?: boolean }> = [
    {
      name: 'Merchant',
      value: truncate(escapeMarkdown(args.merchantName), FIELD_VALUE_MAX),
      inline: true,
    },
    { name: 'Admin', value: `\`${actorTail}\``, inline: true },
    {
      name: 'New',
      value: fmtConfigLine(args.next),
      inline: false,
    },
  ];
  if (args.previous !== null) {
    fields.push({
      name: 'Previous',
      value: fmtConfigLine(args.previous),
      inline: false,
    });
  }
  const isCreate = args.previous === null;
  void sendWebhook(env.DISCORD_WEBHOOK_ADMIN_AUDIT, {
    title: isCreate ? '🟢 Cashback config created' : '🔧 Cashback config updated',
    color: isCreate ? GREEN : BLUE,
    fields,
  });
}

function fmtConfigLine(s: CashbackConfigSnapshot): string {
  const body =
    `wholesale ${escapeMarkdown(s.wholesalePct)}%` +
    ` · cashback ${escapeMarkdown(s.userCashbackPct)}%` +
    ` · margin ${escapeMarkdown(s.loopMarginPct)}%` +
    ` · ${s.active ? 'active' : 'inactive'}`;
  return truncate(body, FIELD_VALUE_MAX);
}

/**
 * Notify: a LOOP-asset has drifted past the operator threshold
 * (ADR 015). `driftStroops = onChainStroops - ledgerLiabilityMinor × 1e5`.
 * Positive drift → over-minted (the riskier direction — users are
 * holding more LOOP asset than the ledger says we owe). Negative
 * drift → unsettled backlog; usually self-heals as the payout worker
 * catches up.
 *
 * Fires exactly once per ok→over transition (in-memory dedupe at
 * the watcher). The `notifyAssetDriftRecovered` sibling fires on the
 * over→ok transition so the channel gets the all-clear. State is
 * lost on restart: the first post-restart tick re-pages if still
 * over, which is correct (ops should reassess anyway).
 */
export function notifyAssetDrift(args: {
  assetCode: string;
  driftStroops: string;
  thresholdStroops: string;
  onChainStroops: string;
  ledgerLiabilityMinor: string;
}): void {
  const direction = args.driftStroops.startsWith('-') ? 'Settlement backlog' : 'Over-minted';
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '⚠️ Asset Drift Exceeded Threshold',
    description: `\`${escapeMarkdown(args.assetCode)}\` drift exceeds the configured threshold. Direction: **${direction}**.`,
    color: ORANGE,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Drift (stroops)', value: escapeMarkdown(args.driftStroops), inline: true },
      { name: 'Threshold (stroops)', value: escapeMarkdown(args.thresholdStroops), inline: true },
      { name: 'On-chain (stroops)', value: escapeMarkdown(args.onChainStroops), inline: true },
      {
        name: 'Ledger (minor)',
        value: escapeMarkdown(args.ledgerLiabilityMinor),
        inline: true,
      },
    ],
  });
}

/**
 * Notify: a previously-drifting asset has returned within the
 * threshold. Sibling of `notifyAssetDrift` — fires on over→ok so
 * the channel reads as a closed incident rather than an indefinite
 * open alert.
 */
export function notifyAssetDriftRecovered(args: {
  assetCode: string;
  driftStroops: string;
  thresholdStroops: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟢 Asset Drift Recovered',
    description: `\`${escapeMarkdown(args.assetCode)}\` drift is back within the configured threshold.`,
    color: GREEN,
    fields: [
      { name: 'Asset', value: `\`${escapeMarkdown(args.assetCode)}\``, inline: true },
      { name: 'Drift (stroops)', value: escapeMarkdown(args.driftStroops), inline: true },
      { name: 'Threshold (stroops)', value: escapeMarkdown(args.thresholdStroops), inline: true },
    ],
  });
}

/**
 * Notify: the CTX operator pool has no healthy operators (ADR 013).
 * Fires from `operatorFetch` after every breaker in the pool tripped.
 * Paired with a 15-minute throttle at the call site so sustained
 * outages don't flood the monitoring channel.
 */
/**
 * A2-621: notify when a `procuring` order ages out and the recovery
 * sweep flipped it to `failed`. A sweep-swept row is ambiguous — we
 * don't know whether CTX actually minted the gift card (in which
 * case Loop was charged but the user is stuck) or the POST never
 * landed (in which case Loop is whole). Ops has to reconcile
 * manually against CTX's side by looking up the order id or the
 * operator's charge history.
 *
 * Runs per-swept-row (not aggregated) because each row needs
 * individual investigation and the sweep normally catches zero rows
 * per tick — the day this fires is the day the channel needs the
 * full drill-down, not a "1 more swept" counter.
 */
export function notifyStuckProcurementSwept(args: {
  orderId: string;
  userId: string;
  merchantId: string;
  chargeMinor: string;
  chargeCurrency: string;
  ctxOperatorId: string | null;
  procuredAtMs: number;
}): void {
  const stuckForMs = Date.now() - args.procuredAtMs;
  const stuckForMin = Math.round(stuckForMs / 60_000);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🟡 Stuck Procuring Order Swept to Failed',
    description: truncate(
      `An order sat in \`procuring\` for ${stuckForMin} min and was just swept to \`failed\`. Reconcile against CTX before any user-facing refund — if CTX minted the card, the user is stuck with a paid CTX gift card that Loop thinks never happened.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Order', value: `\`${escapeMarkdown(args.orderId)}\``, inline: false },
      { name: 'User', value: `\`${escapeMarkdown(args.userId)}\``, inline: true },
      { name: 'Merchant', value: escapeMarkdown(args.merchantId), inline: true },
      { name: 'Charge', value: `${args.chargeMinor} ${args.chargeCurrency}`, inline: true },
      {
        name: 'Operator',
        value: args.ctxOperatorId ? `\`${escapeMarkdown(args.ctxOperatorId)}\`` : '_none_',
        inline: true,
      },
      { name: 'Stuck for (min)', value: String(stuckForMin), inline: true },
    ],
  });
}

/**
 * A2-626: notify when the payment watcher's cursor hasn't advanced
 * past the stale-threshold. Fires once per stuck period — if the
 * cursor moves again, the per-process gate resets and a future stall
 * can alert fresh.
 *
 * Distinct signal from circuit breaker or health-change: the
 * watcher can be "running" (no exception loop-killing) but stuck
 * on an upstream Horizon issue, a DB write failure on cursor
 * persistence, or a subtle bug in the tick. The cursor-age probe
 * is the only independent observation that catches all of those.
 */
export function notifyPaymentWatcherStuck(args: {
  cursorAgeMs: number;
  lastCursor: string;
  lastUpdatedAtMs: number;
}): void {
  const ageMin = Math.round(args.cursorAgeMs / 60_000);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Payment Watcher Cursor Stuck',
    description: truncate(
      `The payment watcher cursor has not advanced in ${ageMin} min. Fresh deposits are not being observed. Check the watcher process, Horizon reachability, and the DB's ability to persist the cursor row.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Cursor age (min)', value: String(ageMin), inline: true },
      {
        name: 'Last cursor',
        value: truncate(`\`${escapeMarkdown(args.lastCursor)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
      {
        name: 'Last updated',
        value: new Date(args.lastUpdatedAtMs).toISOString(),
        inline: true,
      },
    ],
  });
}

/**
 * A2-1915: dedup keyed on the surface name so a single CTX endpoint
 * silently breaking doesn't flood `#monitoring` with one alert per
 * failed parse. Same 10-minute window as the circuit-breaker dedup.
 */
const CTX_SCHEMA_DRIFT_DEDUP_MS = 10 * 60 * 1000;
const ctxSchemaDriftLastNotified = new Map<string, number>();

/**
 * A2-1915 — runtime CTX-schema drift detector.
 *
 * Fires when an upstream CTX response fails Zod validation on a
 * surface that has a recorded contract fixture (A2-1706). This is
 * the runtime companion to the PR-time contract test:
 *
 *   - PR-time gate: `apps/backend/src/__tests__/ctx-contract.test.ts`
 *     blocks our-side narrowings against the recorded fixtures.
 *   - Runtime detector: this notifier surfaces CTX-side drift when
 *     a real response no longer matches our expected shape.
 *
 * Per-surface dedup means a sustained drift produces one alert per
 * 10 minutes, not one per failed request. The `surface` arg should
 * be the same identifier used in the contract test
 * (`POST /verify-email`, `GET /merchants`, etc.) so ops can grep
 * back to the fixture / schema pair.
 */
export function notifyCtxSchemaDrift(args: { surface: string; issuesSummary: string }): void {
  const now = Date.now();
  const last = ctxSchemaDriftLastNotified.get(args.surface);
  if (last !== undefined && now - last < CTX_SCHEMA_DRIFT_DEDUP_MS) {
    return;
  }
  ctxSchemaDriftLastNotified.set(args.surface, now);
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '⚠️ CTX schema drift detected',
    description: truncate(
      `Upstream CTX response no longer matches the expected schema for \`${escapeMarkdown(args.surface)}\`. Cross-check against the recorded fixture in \`apps/backend/src/__fixtures__/ctx/\` (A2-1706) and either update our schema or escalate to CTX.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Surface', value: `\`${escapeMarkdown(args.surface)}\``, inline: true },
      {
        name: 'Zod issues',
        value: truncate(escapeMarkdown(args.issuesSummary), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

export function notifyOperatorPoolExhausted(args: { poolSize: number; reason: string }): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 CTX Operator Pool Exhausted',
    description: truncate(
      `Every operator in the pool is unhealthy. Loop-native procurement is blocked until at least one circuit recovers.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Pool size', value: String(args.poolSize), inline: true },
      {
        name: 'Last error',
        value: truncate(escapeMarkdown(args.reason), FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

/**
 * A2-1326: per-(key, state) dedup window. Within one process, a
 * flapping circuit (open → half_open → open → half_open → ...)
 * previously emitted one embed per transition — across 7 upstream
 * breakers + N operator breakers, that's the "120 embeds/hour"
 * pattern the audit flagged. The map keys are `${name}:${state}` so
 * "login open" and "merchants open" dedup independently.
 *
 * 10 minutes is chosen so a persistent-outage scenario still gets
 * one fresh embed every ten minutes — ops sees the issue isn't
 * transient — while a minute-cadence flap produces exactly one
 * embed per (key, state).
 */
const CIRCUIT_NOTIFY_DEDUP_MS = 10 * 60 * 1000;
const circuitNotifyLastAt = new Map<string, number>();

/** Test helper — wipe the dedup map so tests can exercise the throttle. */
export function __resetCircuitNotifyDedupForTests(): void {
  circuitNotifyLastAt.clear();
}

/** A2-1915: same idea for the CTX-schema-drift dedup map. */
export function __resetCtxSchemaDriftDedupForTests(): void {
  ctxSchemaDriftLastNotified.clear();
}

/**
 * Notify: circuit breaker state change.
 *
 * `name` identifies the circuit (e.g. `upstream:login`,
 * `operator:op-beta-02`). Within the same process, a repeat
 * `(name, state)` pair fires at most once per
 * `CIRCUIT_NOTIFY_DEDUP_MS`. Absent `name` falls back to the
 * legacy `'unknown'` bucket — all un-named breakers share one
 * dedup entry, which is the conservative direction (too-quiet
 * rather than too-loud).
 */
export function notifyCircuitBreaker(
  state: 'open' | 'closed',
  consecutiveFailures: number,
  cooldownSeconds = 30,
  name = 'unknown',
): void {
  const key = `${name}:${state}`;
  const now = Date.now();
  const lastAt = circuitNotifyLastAt.get(key) ?? 0;
  if (now - lastAt < CIRCUIT_NOTIFY_DEDUP_MS) return;
  circuitNotifyLastAt.set(key, now);

  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: state === 'open' ? '🔴 Circuit Breaker OPEN' : '🟢 Circuit Breaker Closed',
    description:
      state === 'open'
        ? `\`${name}\` unreachable after ${consecutiveFailures} consecutive failures. Requests will fail fast for ${cooldownSeconds}s.`
        : `\`${name}\` recovered. Normal operation resumed.`,
    color: state === 'open' ? RED : GREEN,
  });
}

/**
 * Discord channels the backend posts to. Mirrors the three
 * `DISCORD_WEBHOOK_*` env vars — keeping this as a closed union
 * means adding a new channel is a type-level change that forces
 * every catalog entry to declare which channel it posts to.
 */
export type DiscordChannel = 'orders' | 'monitoring' | 'admin-audit';

/**
 * One catalogued notifier — the function name, the channel it posts
 * to, and a one-line description of when it fires. Catalog is an
 * `Object.freeze`d const so runtime mutation throws (the admin
 * endpoint surfaces this read-only; nobody should be rewriting it).
 */
export interface DiscordNotifier {
  name: string;
  channel: DiscordChannel;
  description: string;
}

/**
 * Resolves the raw webhook URL for a given channel. Centralised so
 * the test-ping handler + the catalog stay in lockstep — one place
 * in this module maps channel → env var.
 */
function webhookUrlFor(channel: DiscordChannel): string | undefined {
  switch (channel) {
    case 'orders':
      return env.DISCORD_WEBHOOK_ORDERS;
    case 'monitoring':
      return env.DISCORD_WEBHOOK_MONITORING;
    case 'admin-audit':
      return env.DISCORD_WEBHOOK_ADMIN_AUDIT;
  }
}

/**
 * True when the given channel's webhook env var is set. Admin
 * test-ping uses this to distinguish "we tried to deliver" from
 * "URL was never configured, delivery was a silent no-op". Without
 * the check, a freshly-deployed backend with a missing env var
 * would swallow every message indistinguishably from success.
 */
export function hasWebhookConfigured(channel: DiscordChannel): boolean {
  const url = webhookUrlFor(channel);
  return url !== undefined && url.length > 0;
}

/**
 * Fires a benign test ping on a channel so an admin can verify
 * webhook wiring after rotating env vars or redeploying. `actorId`
 * is truncated to 8 chars in the embed so the audit trail can
 * correlate the ping to the admin who triggered it without leaking
 * the full uuid to the channel.
 *
 * Fire-and-forget like every other notifier — the caller should
 * already have checked `hasWebhookConfigured(channel)` before
 * invoking this (the admin handler maps an unconfigured channel to
 * a 409 so the UI shows "webhook not configured" instead of a
 * silent 200).
 */
export function notifyWebhookPing(channel: DiscordChannel, actorId: string): void {
  const url = webhookUrlFor(channel);
  const shortActor = actorId.length > 8 ? actorId.slice(0, 8) : actorId;
  void sendWebhook(url, {
    title: '🧪 Test ping',
    description: `Manual test ping from admin \`${escapeMarkdown(shortActor)}\` — delivery proves the webhook URL for the \`${channel}\` channel is wired up.`,
    color: BLUE,
  });
}

/**
 * Static catalog of the Discord notifiers the backend can emit
 * (ADR 018 operational-visibility surface).
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
 */
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
