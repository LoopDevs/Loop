// Monitoring-channel Discord notifiers (fleet health, payouts, reserve floor)
import { config } from '../config/index.js';
import {
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
  GREEN,
  ORANGE,
  RED,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './shared.js';

export function notifyHealthChange(status: 'healthy' | 'degraded', details: string): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: status === 'healthy' ? '💚 Service Healthy' : '🟠 Service Degraded',
    description: truncate(details, DESCRIPTION_MAX),
    color: status === 'healthy' ? GREEN : ORANGE,
  });
}

// go-live-plan §T1-F: throttled to once per 7 days at call site
export function notifyGeoDbStale(args: {
  buildEpoch: string | null;
  ageDays: number | null;
  thresholdDays: number;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟡 GeoLite2 database stale',
    description: truncate(
      args.buildEpoch === null
        ? `MAXMIND_GEOLITE2_PATH is configured but the .mmdb failed to open — the \`/\` geo-redirect first-guess is silently falling back to the US default (ADR 034). Redeploy with the two --build-secret flags (docs/deployment.md §GeoLite2) to restore it.`
        : `The baked-in GeoLite2-Country .mmdb was built ${args.ageDays ?? '?'} day(s) ago (built ${args.buildEpoch}), past the ${args.thresholdDays}-day staleness threshold. MaxMind ships weekly — redeploy with the two --build-secret flags (docs/deployment.md §GeoLite2) to pick up a fresh database.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Build epoch', value: args.buildEpoch ?? '_open failed_', inline: true },
      {
        name: 'Age (days)',
        value: args.ageDays === null ? '_n/a_' : String(args.ageDays),
        inline: true,
      },
      { name: 'Threshold (days)', value: String(args.thresholdDays), inline: true },
    ],
  });
}

export function notifyPayoutFailed(args: {
  payoutId: string;
  userId: string;
  /** Null for `kind='emission'` / `kind='interest_mint'` payouts (ADR-024 §2 / ADR 036 / ADR 031). */
  orderId: string | null;
  /**
   * `pending_payouts.kind` — labels the Order field for order-less
   * rows so an interest mint doesn't read as an emission. Optional
   * for caller compatibility; absent + null orderId renders the
   * historical `_emission_`.
   */
  payoutKind?: string | undefined;
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
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
        value:
          args.orderId === null
            ? `_${escapeMarkdown(args.payoutKind ?? 'emission')}_`
            : `\`${args.orderId.slice(-8)}\``,
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

// PAYOUT-HASHHISTORY: potential double-pay if prior tx landed during Horizon lag
export function notifyPayoutTxHashOverwriteRefused(args: {
  payoutId: string;
  userId: string;
  /** The preserved durable anchor hash. */
  anchorTxHash: string;
  /** The re-submit hash that was appended to history (not made the anchor). */
  newTxHash: string;
  attempts: number;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟠 Payout tx-hash overwrite refused',
    description: truncate(
      `Re-submit of payout ${args.payoutId.slice(-8)} signed a new tx hash while a durable anchor was already set. The anchor was PRESERVED and the new hash appended to \`payout_tx_hashes\`. If the anchored tx also landed (deep Horizon lag), this may be a double-pay — reconcile both hashes against Horizon.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Payout', value: `\`${args.payoutId.slice(-8)}\``, inline: true },
      { name: 'Attempts', value: String(args.attempts), inline: true },
      { name: 'Anchor hash', value: `\`${args.anchorTxHash.slice(0, 12)}…\``, inline: false },
      { name: 'New hash', value: `\`${args.newTxHash.slice(0, 12)}…\``, inline: false },
    ],
  });
}

// Throttled to once per (userId, assetCode) per process
const awaitingTrustlineFired = new Set<string>();
export function __resetAwaitingTrustlineDedupForTests(): void {
  awaitingTrustlineFired.clear();
}
export function notifyPayoutAwaitingTrustline(args: {
  payoutId: string;
  userId: string;
  account: string;
  assetCode: string;
  assetIssuer: string;
  accountExists: boolean;
}): void {
  const key = `${args.userId}::${args.assetCode}`;
  if (awaitingTrustlineFired.has(key)) return;
  awaitingTrustlineFired.add(key);
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟡 Payout awaiting trustline',
    description: truncate(
      `User ${args.userId.slice(-8)} has linked ${args.account.slice(0, 8)}…${args.account.slice(-4)} but ${
        args.accountExists
          ? `the account has no trustline to ${args.assetCode}`
          : `the account is not yet activated on Stellar (no balance reserve)`
      }. Payout ${args.payoutId.slice(-8)} stays in \`pending\` and will submit on the next worker tick after the trustline is added.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Issuer', value: `\`${args.assetIssuer.slice(0, 8)}…\``, inline: true },
      { name: 'Account exists?', value: args.accountExists ? 'yes' : 'no', inline: true },
      { name: 'Payout', value: `\`${args.payoutId.slice(-8)}\``, inline: true },
    ],
  });
}

// C10a: PURE SENDERS — dedup moved to `interest_pool_alert_state`
export function notifyInterestPoolLow(args: {
  assetCode: string;
  poolStroops: string;
  dailyInterestStroops: string;
  daysOfCover: number;
  minDaysOfCover: number;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟠 Interest pool running low',
    description: truncate(
      `${escapeMarkdown(args.assetCode)} forward-mint pool has ${args.daysOfCover.toFixed(1)} days of cover left (minimum ${args.minDaysOfCover}). Mint the next batch into the pool account before users are under-allocated.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Pool (stroops)', value: escapeMarkdown(args.poolStroops), inline: true },
      {
        name: 'Daily interest (stroops)',
        value: escapeMarkdown(args.dailyInterestStroops),
        inline: true,
      },
      { name: 'Days of cover', value: args.daysOfCover.toFixed(2), inline: true },
      { name: 'Minimum', value: String(args.minDaysOfCover), inline: true },
    ],
  });
}

export function notifyInterestPoolRecovered(args: {
  assetCode: string;
  poolStroops: string;
  daysOfCover: number;
}): Promise<boolean> {
  // C10a: recovery driven by persisted state; daysOfCover may be Infinity
  const coverText = Number.isFinite(args.daysOfCover) ? args.daysOfCover.toFixed(1) : 'ample';
  const coverField = Number.isFinite(args.daysOfCover) ? args.daysOfCover.toFixed(2) : 'ample';
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '✅ Interest pool replenished',
    description: truncate(
      `${escapeMarkdown(args.assetCode)} forward-mint pool now has ${coverText} days of cover. Closing the prior depletion alert.`,
      DESCRIPTION_MAX,
    ),
    color: GREEN,
    fields: [
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Pool (stroops)', value: escapeMarkdown(args.poolStroops), inline: true },
      { name: 'Days of cover', value: coverField, inline: true },
    ],
  });
}

// A4-023: on-chain payout skipped due to currency divergence
export function notifyPegBreakOnFulfillment(args: {
  orderId: string;
  userId: string;
  chargeCurrency: string;
  userHomeCurrency: string;
  cashbackMinor: string;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🚨 LOOP-asset peg break on fulfillment',
    description: truncate(
      `Order ${escapeMarkdown(args.orderId)} fulfilled with chargeCurrency=${escapeMarkdown(args.chargeCurrency)} but user.homeCurrency=${escapeMarkdown(args.userHomeCurrency)}. Off-chain cashback credited; on-chain payout SKIPPED. Manual compensation needed to restore the 1:1 peg.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'Order', value: escapeMarkdown(args.orderId), inline: true },
      { name: 'User', value: escapeMarkdown(args.userId), inline: true },
      { name: 'Charge ccy', value: escapeMarkdown(args.chargeCurrency), inline: true },
      { name: 'Home ccy', value: escapeMarkdown(args.userHomeCurrency), inline: true },
      { name: 'Cashback (minor)', value: escapeMarkdown(args.cashbackMinor), inline: true },
    ],
  });
}

// C1: no transition dedup — re-pages daily while drift persists
export function notifyLedgerDrift(args: {
  driftCount: number;
  /** True when the query limit was hit — the real count may be higher. */
  limitHit: boolean;
  sample: Array<{
    userId: string;
    currency: string;
    balanceMinor: string;
    ledgerSumMinor: string;
    deltaMinor: string;
  }>;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🚨 Ledger Invariant Violated',
    color: RED,
    description: truncate(
      `${args.driftCount}${args.limitHit ? '+' : ''} (user, currency) pair(s) where user_credits.balance_minor ≠ SUM(credit_transactions). The mirror can no longer be trusted until this is explained — triage via /api/admin/reconciliation. This page repeats daily while the drift persists.`,
      DESCRIPTION_MAX,
    ),
    fields: args.sample.slice(0, 5).map((d) => ({
      name: `${escapeMarkdown(d.userId.slice(0, 8))}… ${escapeMarkdown(d.currency)}`,
      value: truncate(
        `balance=${escapeMarkdown(d.balanceMinor)} ledger=${escapeMarkdown(d.ledgerSumMinor)} Δ=${escapeMarkdown(d.deltaMinor)}`,
        FIELD_VALUE_MAX,
      ),
      inline: false,
    })),
  });
}

export {
  notifyAssetDrift,
  notifyAssetDriftRecovered,
  notifyDriftFailedRows,
  notifyDriftFailedRowsCleared,
} from './monitoring-asset-drift.js';

export {
  notifyVaultShareDrift,
  notifyVaultShareDriftRecovered,
  notifyVaultSolvencyBreach,
  notifyVaultSolvencyRecovered,
  notifyVaultFloatDesync,
} from './monitoring-vault-drift.js';

export {
  notifyHotFloatBackingShortfall,
  type HotFloatBackingShortfallArgs,
} from './monitoring-hot-float-backing.js';

export {
  notifyCtxSchemaDrift,
  __resetCtxSchemaDriftDedupForTests,
} from './monitoring-ctx-schema-drift.js';

// CF-13: 10-minute dedup window
const CTX_CREDENTIAL_DEDUP_MS = 10 * 60 * 1000;
let ctxCredentialLastNotified = 0;

export function __resetCtxCredentialDedupForTests(): void {
  ctxCredentialLastNotified = 0;
}

// ADR 051: full outage of CTX calls until credentials restored
export function notifyCtxCredentialInvalid(): void {
  const now = Date.now();
  if (now - ctxCredentialLastNotified < CTX_CREDENTIAL_DEDUP_MS) {
    return;
  }
  ctxCredentialLastNotified = now;
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🔴 CTX API Key Rejected (401)',
    description: truncate(
      `CTX returned 401 — the operator API key was rejected (revoked, rotated upstream, or misconfigured). Every CTX call fails until \`ctx.credentials\` is restored. Calls raise a transient error, so procurement defers and paid orders stay retryable rather than failing (ADR 051).`,
      DESCRIPTION_MAX,
    ),
    color: RED,
  });
}

export {
  notifyRedemptionBackfillExhausted,
  notifyStuckPayouts,
  notifyVaultEmissionFailed,
  notifyVaultRedemptionFailed,
  notifyVaultRedemptionsStuck,
  notifyVaultEmissionsStuck,
  notifyWalletProvisioningStuck,
} from './monitoring-stuck-sweepers.js';

// ADR 045 (B-3): flag only, no automated account action
export function notifyDuplicateAccountSignal(args: {
  userId: string;
  relatedUserId: string;
  sourceAccount: string;
  orderId: string;
  relatedOrderId: string;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🟡 Duplicate-account signal — shared funding source',
    description: truncate(
      `The same on-chain funding account paid orders for two distinct Loop users. Flag only (ADR 045) — no account action was taken; review both accounts before deciding whether this is a shared household wallet or account-farming.`,
      DESCRIPTION_MAX,
    ),
    color: ORANGE,
    fields: [
      { name: 'User', value: `\`${escapeMarkdown(args.userId.slice(0, 8))}…\``, inline: true },
      {
        name: 'Related user',
        value: `\`${escapeMarkdown(args.relatedUserId.slice(0, 8))}…\``,
        inline: true,
      },
      {
        name: 'Funding account',
        value: `\`${escapeMarkdown(args.sourceAccount.slice(0, 8))}…${escapeMarkdown(args.sourceAccount.slice(-4))}\``,
        inline: true,
      },
      { name: 'Order', value: `\`${escapeMarkdown(args.orderId.slice(0, 8))}…\``, inline: true },
      {
        name: 'Related order',
        value: `\`${escapeMarkdown(args.relatedOrderId.slice(0, 8))}…\``,
        inline: true,
      },
    ],
  });
}
