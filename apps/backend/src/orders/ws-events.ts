// CTX ws `giftcard` topic — event-driven order-mirror maintenance (ADR 052)
import { logger } from '../logger.js';
import { CtxGiftCardSchema } from './ctx-order.js';
import { applyCtxCardStatus, resolveOrderForCard } from './mirror-apply.js';
import { registerCtxWsTopic } from '../ctx/ws-events.js';

const log = logger.child({ module: 'giftcard-ws' });

const GIFTCARD_EVENTS = new Set([
  'system.giftcard.created',
  'system.giftcard.paid',
  'system.giftcard.fulfilled',
  'system.giftcard.rejected',
  'system.giftcard.refunded',
  'system.giftcard.display_status_updated',
]);

export function registerGiftcardWsEvents(): void {
  registerCtxWsTopic({
    topic: 'giftcard',
    events: GIFTCARD_EVENTS,
    onEvent: handleGiftcardEvent,
    // Events during a disconnect window are unrecoverable — the
    // mirror sweep is the standing reconciler, no resync here.
  });
}

async function handleGiftcardEvent(eventName: string, data: unknown): Promise<void> {
  const cardParsed = CtxGiftCardSchema.safeParse(data);
  if (!cardParsed.success) {
    log.warn(
      { event: eventName, issues: cardParsed.error.issues.slice(0, 5) },
      'CTX giftcard ws event payload failed validation — ignoring',
    );
    return;
  }
  const card = cardParsed.data;

  const order = await resolveOrderForCard(card);
  if (order === null) return;
  await applyCtxCardStatus(order, card);
}
