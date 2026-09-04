/**
 * Orders-channel Discord notifiers — fires to
 * `env.DISCORD_WEBHOOK_ORDERS`. Five signals that read together as
 * the customer-facing money-flow narrative:
 *
 *   1. **Order Created** — every new order, fleet-volume signal.
 *   2. **Cashback Recycled** — orders paid with LOOP-asset
 *      cashback (subset of (1)). ADR 015 flywheel light-up.
 *   3. **First Cashback Recycled** — fires once per user, on the
 *      order that graduates them from "earns cashback" to "spends
 *      cashback on new orders." Subset-of-subset of (2).
 *   4. **Order Fulfilled** — gift card ready signal.
 *   5. **Cashback Credited** — cashback delta committed to the
 *      ledger (ADR 009). Distinct from (4): fulfilled fires every
 *      successful procurement, credited only when the user
 *      actually earned positive cashback.
 *
 * Pulled out of `discord.ts` so the per-channel surfaces are
 * traceable to one file each. Shared infrastructure
 * (`sendWebhook`, `truncate`, `escapeMarkdown`, `formatAmount`,
 * `formatMinorAmount`, colour constants) lives in
 * `./shared.ts`.
 */
import { env } from '../env.js';
import {
  BLUE,
  FIELD_VALUE_MAX,
  GREEN,
  escapeMarkdown,
  formatMinorAmount,
  sendWebhook,
  truncate,
} from './shared.js';

/** Notify: new order created (ADR 052 — the customer pays CTX). */
export function notifyOrderCreated(args: {
  orderId: string;
  merchantName: string;
  faceValueMinor: bigint;
  currency: string;
  cryptoCurrency: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '🛒 New Order',
    color: BLUE,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(args.merchantName), FIELD_VALUE_MAX),
        inline: true,
      },
      {
        name: 'Amount',
        value: formatMinorAmount(args.faceValueMinor.toString(), args.currency),
        inline: true,
      },
      {
        name: 'Pays CTX in',
        value: truncate(escapeMarkdown(args.cryptoCurrency), FIELD_VALUE_MAX),
        inline: true,
      },
      { name: 'Order ID', value: `\`${escapeMarkdown(args.orderId)}\``, inline: false },
    ],
  });
}

/** Notify: order fulfilled (gift card ready). */
export function notifyOrderFulfilled(args: {
  orderId: string;
  merchantId: string;
  faceValueMinor: bigint;
  currency: string;
}): void {
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '✅ Order Fulfilled',
    color: GREEN,
    fields: [
      {
        name: 'Merchant',
        value: truncate(escapeMarkdown(args.merchantId), FIELD_VALUE_MAX),
        inline: true,
      },
      {
        name: 'Amount',
        value: formatMinorAmount(args.faceValueMinor.toString(), args.currency),
        inline: true,
      },
      { name: 'Order ID', value: `\`${escapeMarkdown(args.orderId)}\``, inline: false },
    ],
  });
}
