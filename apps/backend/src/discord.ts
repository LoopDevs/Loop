import { env } from './env.js';
import { logger } from './logger.js';

const log = logger.child({ module: 'discord' });

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  timestamp?: string;
}

/**
 * Discord embed field values have a 1024-char cap and descriptions a 4096-char
 * cap. Truncating here means upstream data that happens to contain a giant
 * string (e.g. a stack trace passed into `details`) won't cause Discord to
 * reject the entire webhook with 400.
 */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Escapes characters that Discord interprets as markdown or code-fence syntax.
 * Merchant names, order IDs, etc. are upstream-sourced — a value containing
 * backticks or underscores would otherwise break the embed's formatting.
 */
function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_~|>])/g, '\\$1');
}

/** Sends a message to a Discord webhook. Fails silently — never blocks app logic. */
async function sendWebhook(webhookUrl: string | undefined, embed: DiscordEmbed): Promise<void> {
  if (!webhookUrl) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        embeds: [{ ...embed, timestamp: embed.timestamp ?? new Date().toISOString() }],
        // Discord webhooks default to parsing @everyone/@here/@user mentions
        // out of message content AND embed fields. A merchant or order field
        // containing `@everyone` would ping the whole channel. Explicitly
        // setting `parse: []` suppresses every mention type. Our embeds
        // never need to ping anyone, so this is a pure safety setting.
        allowed_mentions: { parse: [] },
      }),
      signal: AbortSignal.timeout(5000),
    });
    // Discord returns 204 on success, 400 for malformed payloads, 429 if
    // we've hit the per-webhook rate limit. Log bad statuses so we notice
    // schema drift or accidental webhook flooding before ops does. Include
    // a truncated body so schema-drift debugging doesn't require reproducing.
    if (!response.ok) {
      let body = '';
      try {
        body = (await response.text()).slice(0, 500);
      } catch {
        /* body unreadable */
      }
      log.warn({ status: response.status, body }, 'Discord webhook returned non-success status');
    }
  } catch (err) {
    log.warn({ err }, 'Failed to send Discord notification');
  }
}

// Colors
const GREEN = 3066993;
const RED = 15158332;
const ORANGE = 16753920;
const BLUE = 3447003;

// Discord field-value cap per API docs.
const FIELD_VALUE_MAX = 1024;
const DESCRIPTION_MAX = 4096;

/**
 * Format an amount for display. The previous code always prefixed `$`
 * regardless of currency, producing nonsense like "$25.00 EUR". Use the
 * currency-specific symbol when we know it, otherwise fall back to the
 * currency code on its own (e.g. "25.00 GBP"). Deliberately narrow
 * mapping — anything not in this table falls back to the safe format.
 */
const CURRENCY_SYMBOLS: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', CAD: 'C$' };
function formatAmount(amount: number, currency: string): string {
  const code = escapeMarkdown(currency);
  const body = amount.toFixed(2);
  const symbol = CURRENCY_SYMBOLS[currency.toUpperCase()];
  return symbol !== undefined ? `${symbol}${body} ${code}` : `${body} ${code}`;
}

/** Notify: new order created */
export function notifyOrderCreated(
  orderId: string,
  merchantName: string,
  amount: number,
  currency: string,
  xlmAmount: string,
): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '🛒 New Order',
    color: BLUE,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Amount', value: formatAmount(amount, currency), inline: true },
      { name: 'XLM', value: truncate(escapeMarkdown(xlmAmount), FIELD_VALUE_MAX), inline: true },
      { name: 'Order ID', value: `\`${escapeMarkdown(orderId)}\``, inline: false },
    ],
  });
}

/**
 * Notify: a new order has been placed paying with a LOOP-branded
 * stablecoin — the user is recycling cashback they previously
 * earned into a new gift card purchase (ADR 015 flywheel).
 *
 * Distinct signal from `notifyOrderCreated`: that one fires for
 * every order; this one flags the subset that closes the cashback
 * loop. Ops watches it to see the flywheel light up in real time,
 * separately from fleet volume. Channel: `orders` (same as the
 * generic order signal — co-located so the flywheel subset reads
 * as a qualifier on the normal feed rather than a wholly separate
 * channel to monitor).
 */
export function notifyCashbackRecycled(args: {
  orderId: string;
  merchantName: string;
  /** Face-value amount for the gift card, in the catalog currency. */
  amount: number;
  currency: string;
  /** LOOP asset code: USDLOOP / GBPLOOP / EURLOOP. */
  assetCode: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '♻️ Cashback Recycled',
    description:
      'A user is paying for a new order with LOOP-asset cashback they previously earned.',
    color: GREEN,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(args.merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Amount', value: formatAmount(args.amount, args.currency), inline: true },
      {
        name: 'Asset',
        value: truncate(escapeMarkdown(args.assetCode), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Order ID', value: `\`${escapeMarkdown(args.orderId)}\``, inline: false },
    ],
  });
}

/**
 * Notify: a user's FIRST loop_asset order — the flywheel-onboarding
 * milestone (ADR 015). Subset-of-subset relative to
 * notifyCashbackRecycled: recycled fires every time; this fires
 * exactly once per user, on the order that graduates them from
 * "earns cashback" to "spends cashback on new orders."
 *
 * Caller confirms first-ness (cheap pre-insert count) — the Discord
 * layer doesn't own the invariant. Silent no-op when the orders
 * webhook isn't configured. Channel: orders (same as
 * notifyCashbackRecycled / notifyOrderCreated) so ops reads
 * volume → recycling → milestones in one feed.
 */
export function notifyFirstCashbackRecycled(args: {
  orderId: string;
  userId: string;
  userEmail: string;
  merchantName: string;
  /** Face-value amount for the gift card, in the catalog currency. */
  amount: number;
  currency: string;
  /** LOOP asset code: USDLOOP / GBPLOOP / EURLOOP. */
  assetCode: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '🎉 First Cashback Recycled',
    description:
      'A user just graduated from earning cashback to spending it — their first `loop_asset` order has landed.',
    color: GREEN,
    fields: [
      {
        name: 'User',
        value: truncate(escapeMarkdown(args.userEmail), FIELD_VALUE_MAX),
        inline: true,
      },
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(args.merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Amount', value: formatAmount(args.amount, args.currency), inline: true },
      {
        name: 'Asset',
        value: truncate(escapeMarkdown(args.assetCode), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'User ID', value: `\`${escapeMarkdown(args.userId)}\``, inline: false },
      { name: 'Order ID', value: `\`${escapeMarkdown(args.orderId)}\``, inline: false },
    ],
  });
}

/** Notify: order fulfilled (gift card ready) */
export function notifyOrderFulfilled(
  orderId: string,
  merchantName: string,
  amount: number,
  currency: string,
  redeemType: string,
): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '✅ Order Fulfilled',
    color: GREEN,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Amount', value: formatAmount(amount, currency), inline: true },
      {
        name: 'Redeem',
        value: truncate(escapeMarkdown(redeemType), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Order ID', value: `\`${escapeMarkdown(orderId)}\``, inline: false },
    ],
  });
}

/**
 * Notify: cashback credited to a user (ADR 009 / 011 / 015).
 *
 * Fires from the Loop-native fulfillment path (procurement worker) once
 * the ledger write has committed. Distinct from `notifyOrderFulfilled`:
 * the order-fulfilled signal goes out on every successful procurement;
 * this signal only fires when the user actually earned a positive cashback
 * credit. The two messages together are the "customer just got money
 * from Loop" event — useful for an ops-visible running tally of how much
 * Loop is handing back each day.
 *
 * `amountMinor` is the signed bigint-string that went into the ledger
 * (positive for cashback credits). `currency` is the user's home currency.
 */
export function notifyCashbackCredited(args: {
  orderId: string;
  merchantName: string;
  amountMinor: string;
  currency: string;
  userId: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '💰 Cashback Credited',
    color: GREEN,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(args.merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      {
        name: 'Amount',
        value: formatMinorAmount(args.amountMinor, args.currency),
        inline: true,
      },
      {
        name: 'User',
        value: `\`${escapeMarkdown(args.userId.slice(0, 8))}…\``,
        inline: true,
      },
      { name: 'Order ID', value: `\`${escapeMarkdown(args.orderId)}\``, inline: false },
    ],
  });
}

/**
 * Minor-unit bigint-string → human currency. Mirrors the web's fmtMinor
 * but bigint-safe — a cashback of 250000 minor units on a GBP order
 * must render as £2,500.00, not lose precision through a Number cast.
 * Trailing 2 chars are always fractional (we don't support 0/3-decimal
 * currencies on Loop today).
 */
function formatMinorAmount(minorStr: string, currency: string): string {
  const negative = minorStr.startsWith('-');
  const digits = negative ? minorStr.slice(1) : minorStr;
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2);
  const fraction = padded.slice(-2);
  const sign = negative ? '-' : '';
  const code = currency.toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code];
  const wholeWithSeparators = Number(whole).toLocaleString('en-US');
  const body = `${wholeWithSeparators}.${fraction}`;
  return symbol !== undefined ? `${sign}${symbol}${body} ${code}` : `${sign}${body} ${code}`;
}

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
  orderId: string;
  assetCode: string;
  amount: string;
  kind: string;
  reason: string;
  attempts: number;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Stellar Payout Failed',
    color: RED,
    fields: [
      { name: 'Kind', value: `\`${escapeMarkdown(args.kind)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Amount', value: escapeMarkdown(args.amount), inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      { name: 'User', value: `\`${escapeMarkdown(args.userId)}\``, inline: true },
      { name: 'Order', value: `\`${escapeMarkdown(args.orderId)}\``, inline: true },
      { name: 'Payout ID', value: `\`${escapeMarkdown(args.payoutId)}\``, inline: false },
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
 * is still in the ledger for audit.
 */
export function notifyAdminAudit(args: {
  actorUserId: string;
  actorEmail: string;
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
    { name: 'Actor', value: `\`${actorTail}\` ${escapeMarkdown(args.actorEmail)}`, inline: true },
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

/** Notify: circuit breaker state change */
export function notifyCircuitBreaker(
  state: 'open' | 'closed',
  consecutiveFailures: number,
  cooldownSeconds = 30,
): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: state === 'open' ? '🔴 Circuit Breaker OPEN' : '🟢 Circuit Breaker Closed',
    description:
      state === 'open'
        ? `Upstream API unreachable after ${consecutiveFailures} consecutive failures. Requests will fail fast for ${cooldownSeconds}s.`
        : 'Upstream API recovered. Normal operation resumed.',
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
