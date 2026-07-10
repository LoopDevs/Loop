/**
 * `notifyStuckProcurementSwept` (A2-621) and
 * `notifyPaymentWatcherStuck` (A2-626) — the two stuck-row
 * sweeper notifiers.
 *
 * Lifted out of `apps/backend/src/discord/monitoring.ts` because
 * both notifiers cover the same concern: a worker has noticed that
 * a row that *should* have advanced past a transient state hasn't,
 * and ops needs the per-row drill-down so they can reconcile (in
 * the procurement case) or restart the watcher (in the cursor
 * case).
 *
 * Re-exported through `discord/monitoring.ts` (and by extension
 * the top-level `discord.ts` barrel) so existing import sites
 * keep working unchanged.
 */
import { env } from '../env.js';
import {
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
  ORANGE,
  RED,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './shared.js';

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
 * past the stale-threshold. Fires once per stuck period — the
 * fired/re-arm dedup lives in `watchdog_alert_state` (S4-8 follow-up,
 * durable + fleet-consistent), managed by `cursor-watchdog.ts`.
 *
 * Distinct signal from circuit breaker or health-change: the
 * watcher can be "running" (no exception loop-killing) but stuck
 * on an upstream Horizon issue, a DB write failure on cursor
 * persistence, or a subtle bug in the tick. The cursor-age probe
 * is the only independent observation that catches all of those.
 *
 * PURE SENDER (same contract as `notifyInterestPoolLow`, C10a):
 * returns the `sendWebhook` promise so the watchdog only persists
 * `alert_active=true` after delivery confirms — a send lost to a
 * Discord outage stays due and is retried on the next tick.
 */
export function notifyPaymentWatcherStuck(args: {
  cursorAgeMs: number;
  lastCursor: string;
  lastUpdatedAtMs: number;
}): Promise<boolean> {
  const ageMin = Math.round(args.cursorAgeMs / 60_000);
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
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
 * Redemption-backfill exhaustion (comprehensive audit 2026-06-11
 * §redemption follow-up): a `fulfilled` order has had its CTX
 * gift-card detail re-fetched `attempts` times by the backfill
 * sweeper and STILL carries no redeem code / PIN / URL. The user
 * paid and the order fulfilled, but there is nothing to show on the
 * "Ready" screen — ops must reconcile against CTX support with the
 * supplier-side order id.
 *
 * Per-row (not aggregated) for the same reason as
 * `notifyStuckProcurementSwept`: exhaustion is rare and each row
 * needs its own CTX-side investigation. Loop-side ids follow the
 * A2-1314 last-8 convention; `ctxOrderId` is emitted in full because
 * it is the supplier's id (not Loop PII) and is exactly what the CTX
 * support ticket needs.
 */
export function notifyRedemptionBackfillExhausted(args: {
  orderId: string;
  userId: string;
  merchantId: string;
  ctxOrderId: string;
  attempts: number;
  fulfilledAtMs: number | null;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Redemption Backfill Exhausted',
    description: truncate(
      `A fulfilled order still has no redemption payload after ${args.attempts} backfill attempts. The user paid and CTX shows the order, but GET /gift-cards/:id keeps returning empty redemption fields. Open a CTX support ticket with the CTX order id below — see runbook redemption-backfill-exhausted.md.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Order', value: `\`${args.orderId.slice(-8)}\``, inline: true },
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Merchant', value: escapeMarkdown(args.merchantId), inline: true },
      {
        name: 'CTX order',
        value: truncate(`\`${escapeMarkdown(args.ctxOrderId)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      {
        name: 'Fulfilled at',
        value:
          args.fulfilledAtMs === null ? '_unknown_' : new Date(args.fulfilledAtMs).toISOString(),
        inline: true,
      },
    ],
  });
}

/**
 * Stuck-payout backlog alert. Fired once per incident by
 * `stuck-payout-watchdog.ts`, whose fired/re-arm dedup lives in
 * `watchdog_alert_state` (S4-8 follow-up).
 *
 * PURE SENDER (same contract as `notifyPaymentWatcherStuck` above):
 * returns the `sendWebhook` promise so the watchdog only persists
 * `alert_active=true` after delivery confirms — at-least-once.
 */
export function notifyStuckPayouts(args: {
  rowCount: number;
  thresholdMinutes: number;
  oldestAgeMinutes: number;
  pendingCount: number;
  submittedCount: number;
  payoutId: string | null;
  assetCode: string | null;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Stuck Payout Backlog Detected',
    description: truncate(
      `One or more payout rows have exceeded the ${args.thresholdMinutes}-minute watchdog window. Check the payout worker, Horizon reachability, and operator funding before manually retrying anything.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Rows', value: String(args.rowCount), inline: true },
      { name: 'Pending', value: String(args.pendingCount), inline: true },
      { name: 'Submitted', value: String(args.submittedCount), inline: true },
      { name: 'Oldest age (min)', value: String(args.oldestAgeMinutes), inline: true },
      { name: 'Threshold (min)', value: String(args.thresholdMinutes), inline: true },
      {
        name: 'Example payout',
        value: args.payoutId === null ? '_none_' : `\`${escapeMarkdown(args.payoutId)}\``,
        inline: true,
      },
      {
        name: 'Example asset',
        value: args.assetCode === null ? '_unknown_' : escapeMarkdown(args.assetCode),
        inline: true,
      },
    ],
  });
}

/**
 * ADR 031 V3 (money-review #1647 P1-2a): a vault cashback emission
 * reached the terminal `failed` state (mirror step failed
 * `VAULT_EMISSION_MAX_ATTEMPTS` times, or a step kept erroring). The
 * user's cashback for this order is stuck — neither the on-chain
 * share transfer NOR the off-chain mirror credit is guaranteed
 * complete, and the row is NOT auto-retried. Ops must inspect the
 * row's `last_error` + tx hashes and reconcile (the admin re-drive
 * endpoint is a V5 follow-up).
 *
 * Per-row (not aggregated) like `notifyStuckProcurementSwept` — a
 * terminal vault emission is rare and each needs individual
 * investigation. Fire-and-forget void (not the pure-sender shape):
 * this fires INLINE from `recordStepFailure` on the terminal
 * transition, not from a fire-once watchdog, so there's no
 * `watchdog_alert_state` delivery-confirmation contract to honour.
 */
export function notifyVaultEmissionFailed(args: {
  vaultEmissionId: string;
  orderId: string;
  userId: string;
  assetCode: string;
  cashbackMinor: string;
  attempts: number;
  lastError: string | null;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Vault Emission Failed (terminal)',
    description: truncate(
      `A vault cashback emission reached \`failed\` after ${args.attempts} attempts and will NOT be auto-retried. The on-chain share transfer and/or the off-chain mirror credit for this order is incomplete — inspect the row and reconcile (see the vault-emission runbook; the admin re-drive endpoint is a follow-up).`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      {
        name: 'Vault emission',
        value: `\`${escapeMarkdown(args.vaultEmissionId)}\``,
        inline: false,
      },
      { name: 'Order', value: `\`${args.orderId.slice(-8)}\``, inline: true },
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Cashback (minor)', value: escapeMarkdown(args.cashbackMinor), inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      {
        name: 'Last error',
        value:
          args.lastError === null
            ? '_none_'
            : truncate(`\`${escapeMarkdown(args.lastError)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}

/**
 * ADR 031 V3 (money-review #1647 P1-2b): one or more vault emissions
 * have sat in a non-terminal in-flight state
 * (`depositing`/`deposited`/`transferred`) past the watchdog window —
 * the sweep isn't making progress on them (worker down, Soroban RPC
 * unreachable, operator-account sequence contention, …). Distinct
 * from `notifyVaultEmissionFailed` (which fires on a row that reached
 * terminal `failed`): this catches rows that are STUCK without having
 * exhausted their attempts, which `failed`-paging alone would never
 * surface.
 *
 * PURE SENDER (same contract as `notifyStuckPayouts` / `notifyPaymentWatcherStuck`):
 * returns the `sendWebhook` promise so `vault-emission-stuck-watchdog`
 * only persists `alert_active=true` after delivery confirms —
 * at-least-once per incident, fleet-wide.
 */
export function notifyVaultEmissionsStuck(args: {
  rowCount: number;
  thresholdMinutes: number;
  oldestAgeMinutes: number;
  states: string;
  vaultEmissionId: string | null;
  assetCode: string | null;
}): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Stuck Vault Emissions Detected',
    description: truncate(
      `One or more vault cashback emissions have sat in an in-flight state (\`depositing\`/\`deposited\`/\`transferred\`) past the ${args.thresholdMinutes}-minute watchdog window. The sweep is not advancing them — check the vault-emission sweep worker, Soroban RPC reachability, and operator funding.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Rows', value: String(args.rowCount), inline: true },
      { name: 'States', value: escapeMarkdown(args.states), inline: true },
      { name: 'Oldest age (min)', value: String(args.oldestAgeMinutes), inline: true },
      { name: 'Threshold (min)', value: String(args.thresholdMinutes), inline: true },
      {
        name: 'Example emission',
        value:
          args.vaultEmissionId === null ? '_none_' : `\`${escapeMarkdown(args.vaultEmissionId)}\``,
        inline: true,
      },
      {
        name: 'Example asset',
        value: args.assetCode === null ? '_unknown_' : escapeMarkdown(args.assetCode),
        inline: true,
      },
    ],
  });
}

/**
 * Wallet-provisioning exhaustion (ADR 030 Phase C1): a user's
 * embedded-wallet provisioning has failed `attempts` consecutive
 * drives (provider createWallet, sponsored activation submit, or
 * Horizon reads) and the sweeper has stopped retrying. The user can
 * still browse + buy — only on-chain payouts wait on the wallet —
 * but cashback emission for them is parked until ops intervenes.
 *
 * Per-row for the same reason as the redemption-backfill alert:
 * exhaustion is rare and each row needs its own investigation
 * (Privy dashboard state, operator account funding, Horizon health).
 * Runbook: docs/runbooks/wallet-provisioning-stuck.md.
 */
export function notifyWalletProvisioningStuck(args: {
  userId: string;
  walletId: string | null;
  walletAddress: string | null;
  provisioning: string;
  attempts: number;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: '🔴 Wallet Provisioning Stuck',
    description: truncate(
      `A user's embedded-wallet provisioning is still incomplete after ${args.attempts} attempts — the sweeper has stopped retrying. Check the wallet provider dashboard, operator-account funding, and Horizon before re-driving. See runbook wallet-provisioning-stuck.md.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'State', value: escapeMarkdown(args.provisioning), inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      {
        name: 'Wallet id',
        value:
          args.walletId === null
            ? '_none_'
            : truncate(`\`${escapeMarkdown(args.walletId)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
      {
        name: 'Address',
        value:
          args.walletAddress === null
            ? '_none_'
            : truncate(`\`${escapeMarkdown(args.walletAddress)}\``, FIELD_VALUE_MAX),
        inline: false,
      },
    ],
  });
}
