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
  formatAmount,
  formatMinorAmount,
  sendWebhook,
  truncate,
} from './shared.js';

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
 * `notifyCashbackRecycled`: recycled fires every time; this fires
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
  merchantName: string;
  /** Face-value amount for the gift card, in the catalog currency. */
  amount: number;
  currency: string;
  /** LOOP asset code: USDLOOP / GBPLOOP / EURLOOP. */
  assetCode: string;
}): void {
  // A2-1313: follow the ADR-018 last-8 convention for user + order
  // ids. Prior shape leaked `userEmail` and full uuids to a broadly-
  // visible channel; the milestone is ops/celebration-grade, not
  // forensic — the tail-id is enough to look up the user in the
  // admin shell, and full ids remain in the ledger + access log
  // where they're useful.
  const userTail = args.userId.slice(-8);
  const orderTail = args.orderId.slice(-8);
  void sendWebhook(env.DISCORD_WEBHOOK_ORDERS, {
    title: '🎉 First Cashback Recycled',
    description:
      'A user just graduated from earning cashback to spending it — their first `loop_asset` order has landed.',
    color: GREEN,
    fields: [
      { name: 'User', value: `\`${userTail}\``, inline: true },
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
      { name: 'Order', value: `\`${orderTail}\``, inline: true },
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
 * Fires from the Loop-native fulfillment path (procurement worker)
 * once the ledger write has committed. Distinct from
 * `notifyOrderFulfilled`: the order-fulfilled signal goes out on
 * every successful procurement; this signal only fires when the
 * user actually earned a positive cashback credit. The two
 * messages together are the "customer just got money from Loop"
 * event — useful for an ops-visible running tally of how much
 * Loop is handing back each day.
 *
 * `amountMinor` is the signed bigint-string that went into the
 * ledger (positive for cashback credits). `currency` is the
 * user's home currency.
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
