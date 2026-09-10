import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

const { mirrorMock } = vi.hoisted(() => ({
  mirrorMock: {
    resolveOrderForCard: vi.fn(async () => null as unknown),
    applyCtxCardStatus: vi.fn(async () => {}),
  },
}));
vi.mock('../mirror-apply.js', () => mirrorMock);

import { registerGiftcardWsEvents } from '../ws-events.js';
import { __handleCtxWsMessageForTests, __resetCtxWsForTests } from '../../ctx/ws-events.js';

function eventFrame(eventName: string, data: unknown): string {
  return JSON.stringify({ type: 'event', topic: 'giftcard', event: eventName, data });
}

const CARD = {
  id: 'gc-1',
  displayStatus: 'paid',
  reference: 'order-ref-1',
};

async function flushDispatch(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

describe('giftcard ws event handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mirrorMock.resolveOrderForCard.mockResolvedValue(null);
    __resetCtxWsForTests();
    registerGiftcardWsEvents();
  });

  it('applies the card status to the resolved order', async () => {
    const order = { id: 'o-1' };
    mirrorMock.resolveOrderForCard.mockResolvedValue(order);

    __handleCtxWsMessageForTests(eventFrame('system.giftcard.paid', CARD));
    await flushDispatch();

    expect(mirrorMock.applyCtxCardStatus).toHaveBeenCalledExactlyOnceWith(
      order,
      expect.objectContaining({ id: 'gc-1', displayStatus: 'paid' }),
    );
  });

  it('applies nothing when the card resolves to no local order', async () => {
    __handleCtxWsMessageForTests(eventFrame('system.giftcard.fulfilled', CARD));
    await flushDispatch();

    expect(mirrorMock.resolveOrderForCard).toHaveBeenCalledTimes(1);
    expect(mirrorMock.applyCtxCardStatus).not.toHaveBeenCalled();
  });

  it('ignores payloads that fail CtxGiftCardSchema validation', async () => {
    __handleCtxWsMessageForTests(eventFrame('system.giftcard.paid', { nope: true }));
    await flushDispatch();

    expect(mirrorMock.resolveOrderForCard).not.toHaveBeenCalled();
  });

  it('ignores events outside the giftcard set', async () => {
    __handleCtxWsMessageForTests(eventFrame('system.merchant.updated', CARD));
    await flushDispatch();

    expect(mirrorMock.resolveOrderForCard).not.toHaveBeenCalled();
  });
});
