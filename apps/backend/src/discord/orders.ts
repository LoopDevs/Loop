// Orders-channel Discord notifiers — ADR 015, ADR 009, ADR 052
import { config } from '../config/index.js';
import {
  BLUE,
  FIELD_VALUE_MAX,
  GREEN,
  escapeMarkdown,
  formatMinorAmount,
  sendWebhook,
  truncate,
} from './shared.js';

// ADR 052 — customer pays CTX
export function notifyOrderCreated(args: {
  orderId: string;
  merchantName: string;
  faceValueMinor: bigint;
  currency: string;
  cryptoCurrency: string;
}): void {
  void sendWebhook(config.observability.discord.ordersWebhook, {
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

export function notifyOrderFulfilled(args: {
  orderId: string;
  merchantId: string;
  faceValueMinor: bigint;
  currency: string;
}): void {
  void sendWebhook(config.observability.discord.ordersWebhook, {
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
