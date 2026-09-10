// CTX ws `merchant` topic — event-driven merchant-store maintenance
import { logger } from '../logger.js';
import {
  applyMerchantRemoval,
  applyMerchantUpsert,
  isMerchantDenylisted,
  refreshMerchants,
} from './sync.js';
import { UpstreamMerchantSchema, mapUpstreamMerchant } from './sync-upstream.js';
import { registerCtxWsTopic } from '../ctx/ws-events.js';

const log = logger.child({ module: 'merchants-ws' });

const EVENT_DELETED = 'system.merchant.deleted';
const MERCHANT_EVENTS = new Set([
  'system.merchant.created',
  'system.merchant.updated',
  'system.merchant.status_changed',
  EVENT_DELETED,
  // Merchant-LINK mutations arrive on the same topic with the same
  // merchant-shaped payload — CTX resolves the link to its merchant
  // before delivery, so the handling below is identical.
  'system.merchantlink.created',
  'system.merchantlink.updated',
  'system.merchantlink.status_changed',
]);

export function registerMerchantWsEvents(): void {
  registerCtxWsTopic({
    topic: 'merchant',
    events: MERCHANT_EVENTS,
    onEvent: handleMerchantEvent,
    onSubscribed: ({ resubscribe }) => {
      if (!resubscribe) return;
      // Events during the disconnect window are unrecoverable —
      // resync the whole catalog (coalesces via the sweep mutex).
      log.info('Resyncing merchant catalog after ws reconnect');
      void refreshMerchants();
    },
  });
}

function handleMerchantEvent(eventName: string, data: unknown): void {
  const merchantParsed = UpstreamMerchantSchema.safeParse(data);
  if (!merchantParsed.success) {
    log.warn(
      { event: eventName, issues: merchantParsed.error.issues.slice(0, 5) },
      'CTX ws merchant event payload failed validation — ignoring',
    );
    return;
  }
  const upstream = merchantParsed.data;

  if (eventName === EVENT_DELETED) {
    applyMerchantRemoval(upstream.id);
    log.info({ merchantId: upstream.id, event: eventName }, 'Merchant removed via ws event');
    return;
  }

  if (isMerchantDenylisted(upstream.id)) {
    log.info(
      { merchantId: upstream.id, merchantName: upstream.name },
      'Merchant ws event filtered by LOOP_MERCHANT_DENYLIST',
    );
    return;
  }

  const merchant = mapUpstreamMerchant(upstream);
  if (merchant === null) {
    // Disabled upstream — the sweep would drop it, so the event drops
    // it too.
    applyMerchantRemoval(upstream.id);
    log.info({ merchantId: upstream.id, event: eventName }, 'Merchant dropped via ws event');
    return;
  }

  applyMerchantUpsert(merchant);
  log.info(
    { merchantId: merchant.id, merchantName: merchant.name, event: eventName },
    'Merchant upserted via ws event',
  );
}
