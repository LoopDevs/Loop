// stuck-row sweeper notifiers — A2-621, A2-626, ADR 031, ADR 030
import { config } from '../config/index.js';
import {
  DESCRIPTION_MAX,
  FIELD_VALUE_MAX,
  RED,
  escapeMarkdown,
  sendWebhook,
  truncate,
} from './shared.js';

export function notifyRedemptionBackfillExhausted(args: {
  orderId: string;
  userId: string;
  merchantId: string;
  ctxOrderId: string;
  attempts: number;
  fulfilledAtMs: number | null;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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

// returns promise so watchdog persists alert_active only after delivery confirms
export function notifyStuckPayouts(args: {
  rowCount: number;
  thresholdMinutes: number;
  oldestAgeMinutes: number;
  pendingCount: number;
  submittedCount: number;
  payoutId: string | null;
  assetCode: string | null;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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

// ADR 031 V3: terminal failed state, no auto-retry
export function notifyVaultEmissionFailed(args: {
  vaultEmissionId: string;
  orderId: string;
  userId: string;
  assetCode: string;
  cashbackMinor: string;
  attempts: number;
  lastError: string | null;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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

// ADR 031 V4: terminal failed state for vault-share redemption
export function notifyVaultRedemptionFailed(args: {
  vaultRedemptionId: string;
  sourceType: string;
  sourceId: string;
  userId: string;
  assetCode: string;
  valueMinor: string;
  attempts: number;
  lastError: string | null;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🔴 Vault Redemption Failed (terminal)',
    description: truncate(
      `A vault-share redemption reached \`failed\` after ${args.attempts} attempts and will NOT be auto-retried. The share collect, payout, and/or mirror debit for this ${args.sourceType} is incomplete — inspect the row and reconcile.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      {
        name: 'Vault redemption',
        value: `\`${escapeMarkdown(args.vaultRedemptionId)}\``,
        inline: false,
      },
      { name: 'Source', value: `${args.sourceType} \`${args.sourceId.slice(-8)}\``, inline: true },
      { name: 'User', value: `\`${args.userId.slice(-8)}\``, inline: true },
      { name: 'Asset', value: escapeMarkdown(args.assetCode), inline: true },
      { name: 'Value (minor)', value: escapeMarkdown(args.valueMinor), inline: true },
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

// ADR 031 V4: stuck in-flight redemptions
export function notifyVaultRedemptionsStuck(args: {
  rowCount: number;
  thresholdMinutes: number;
  oldestAgeMinutes: number;
  states: string;
  vaultRedemptionId: string | null;
  assetCode: string | null;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
    title: '🔴 Stuck Vault Redemptions Detected',
    description: truncate(
      `One or more vault-share redemptions have sat in an in-flight state (\`collecting\`/\`redeemed\`) past the ${args.thresholdMinutes}-minute watchdog window. The sweep is not advancing them — check the vault-redemption sweep worker, Soroban RPC reachability, the wallet provider, and operator funding.`,
      DESCRIPTION_MAX,
    ),
    color: RED,
    fields: [
      { name: 'Rows', value: String(args.rowCount), inline: true },
      { name: 'States', value: escapeMarkdown(args.states), inline: true },
      { name: 'Oldest age (min)', value: String(args.oldestAgeMinutes), inline: true },
      { name: 'Threshold (min)', value: String(args.thresholdMinutes), inline: true },
      {
        name: 'Example redemption',
        value:
          args.vaultRedemptionId === null
            ? '_none_'
            : `\`${escapeMarkdown(args.vaultRedemptionId)}\``,
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

// ADR 031 V3: stuck in-flight emissions
export function notifyVaultEmissionsStuck(args: {
  rowCount: number;
  thresholdMinutes: number;
  oldestAgeMinutes: number;
  states: string;
  vaultEmissionId: string | null;
  assetCode: string | null;
}): Promise<boolean> {
  return sendWebhook(config.observability.discord.monitoringWebhook, {
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

// ADR 030 Phase C1: wallet provisioning exhaustion
export function notifyWalletProvisioningStuck(args: {
  userId: string;
  walletId: string | null;
  walletAddress: string | null;
  provisioning: string;
  attempts: number;
}): void {
  void sendWebhook(config.observability.discord.monitoringWebhook, {
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
