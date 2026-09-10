import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }) },
}));

import {
  registerCtxWsTopic,
  getCtxWsStatus,
  getCtxWsSubscribedTopics,
  __dropCtxWsSessionForTests,
  __handleCtxWsMessageForTests,
  __resetCtxWsForTests,
} from '../ws-events.js';

function subscribeOk(subscriptions?: string[], topic?: string): string {
  return JSON.stringify({ type: 'ok', action: 'subscribe', subscriptions, topic });
}

function eventFrame(eventName: string, data: unknown): string {
  return JSON.stringify({ type: 'event', event: eventName, data });
}

describe('ctx ws hub', () => {
  const alphaEvents = vi.fn();
  const betaEvents = vi.fn();
  const alphaSubscribed = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    __resetCtxWsForTests();
    registerCtxWsTopic({
      topic: 'alpha',
      events: new Set(['system.alpha.updated']),
      onEvent: alphaEvents,
      onSubscribed: alphaSubscribed,
    });
    registerCtxWsTopic({
      topic: 'beta',
      events: new Set(['system.beta.updated']),
      onEvent: betaEvents,
    });
  });

  it('rejects a duplicate topic registration', () => {
    expect(() =>
      registerCtxWsTopic({ topic: 'alpha', events: new Set(), onEvent: vi.fn() }),
    ).toThrow(/already registered/);
  });

  it('routes each event to the handler that claims it', () => {
    __handleCtxWsMessageForTests(eventFrame('system.alpha.updated', { id: 'a-1' }));
    __handleCtxWsMessageForTests(eventFrame('system.beta.updated', { id: 'b-1' }));
    __handleCtxWsMessageForTests(eventFrame('system.gamma.updated', { id: 'g-1' }));

    expect(alphaEvents).toHaveBeenCalledExactlyOnceWith('system.alpha.updated', { id: 'a-1' });
    expect(betaEvents).toHaveBeenCalledExactlyOnceWith('system.beta.updated', { id: 'b-1' });
  });

  it('ignores non-JSON and unexpectedly shaped frames', () => {
    __handleCtxWsMessageForTests('not json');
    __handleCtxWsMessageForTests(JSON.stringify({ type: 'weird' }));
    expect(alphaEvents).not.toHaveBeenCalled();
    expect(betaEvents).not.toHaveBeenCalled();
  });

  it('a rejecting handler never breaks dispatch of later events', () => {
    alphaEvents.mockRejectedValueOnce(new Error('boom'));
    __handleCtxWsMessageForTests(eventFrame('system.alpha.updated', {}));
    __handleCtxWsMessageForTests(eventFrame('system.beta.updated', {}));
    expect(betaEvents).toHaveBeenCalledTimes(1);
  });

  it('reports connected only once every registered topic is acked', () => {
    __handleCtxWsMessageForTests(subscribeOk(['alpha']));
    expect(getCtxWsStatus()).not.toBe('connected');
    expect(getCtxWsSubscribedTopics()).toEqual(['alpha']);

    __handleCtxWsMessageForTests(subscribeOk(['alpha', 'beta']));
    expect(getCtxWsStatus()).toBe('connected');
    expect(getCtxWsSubscribedTopics()).toEqual(['alpha', 'beta']);
  });

  it('acks via the single-topic field when the ack lists no subscriptions', () => {
    __handleCtxWsMessageForTests(subscribeOk(undefined, 'beta'));
    expect(getCtxWsSubscribedTopics()).toEqual(['beta']);
  });

  it('acks the oldest un-acked topic when the ack names none', () => {
    __handleCtxWsMessageForTests(subscribeOk());
    expect(getCtxWsSubscribedTopics()).toEqual(['alpha']);
    __handleCtxWsMessageForTests(subscribeOk());
    expect(getCtxWsSubscribedTopics()).toEqual(['alpha', 'beta']);
  });

  it('ignores acks for unregistered topics', () => {
    __handleCtxWsMessageForTests(subscribeOk(['gamma']));
    expect(getCtxWsSubscribedTopics()).toEqual([]);
  });

  it('flags onSubscribed as a resubscribe only after a dropped session', () => {
    __handleCtxWsMessageForTests(subscribeOk(['alpha']));
    expect(alphaSubscribed).toHaveBeenCalledExactlyOnceWith({ resubscribe: false });

    __handleCtxWsMessageForTests(subscribeOk(['alpha']));
    expect(alphaSubscribed).toHaveBeenCalledTimes(1);

    __dropCtxWsSessionForTests();
    __handleCtxWsMessageForTests(subscribeOk(['alpha']));
    expect(alphaSubscribed).toHaveBeenLastCalledWith({ resubscribe: true });
  });
});
