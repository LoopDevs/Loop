import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRuntimeHealthForTests,
  getRuntimeHealthSnapshot,
  markWorkerBlocked,
  markWorkerStarted,
  markWorkerTickSuccess,
  recordOtpSendFailure,
  recordOtpSendSuccess,
  setOtpDeliveryEnabled,
} from '../runtime-health.js';

beforeEach(() => {
  __resetRuntimeHealthForTests();
});

describe('runtime health snapshot', () => {
  it('tracks OTP delivery degradation until a later success clears it', () => {
    setOtpDeliveryEnabled(true);
    recordOtpSendFailure(new Error('provider down'));

    const degraded = getRuntimeHealthSnapshot();
    expect(degraded.degraded).toBe(true);
    expect(degraded.otpDelivery.degraded).toBe(true);
    expect(degraded.otpDelivery.lastError).toBe('provider down');

    recordOtpSendSuccess();
    const recovered = getRuntimeHealthSnapshot();
    expect(recovered.degraded).toBe(false);
    expect(recovered.otpDelivery.degraded).toBe(false);
  });

  it('treats a blocked required worker as degraded', () => {
    markWorkerBlocked('payment_watcher', {
      reason: 'LOOP_STELLAR_DEPOSIT_ADDRESS is unset',
      staleAfterMs: 30_000,
    });

    const snapshot = getRuntimeHealthSnapshot();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.workers).toEqual([
      expect.objectContaining({
        name: 'payment_watcher',
        degraded: true,
        running: false,
        blockedReason: 'LOOP_STELLAR_DEPOSIT_ADDRESS is unset',
      }),
    ]);
  });

  it('marks a started worker stale when it misses its success window', () => {
    markWorkerStarted('payout_worker', { staleAfterMs: 1_000 });
    markWorkerTickSuccess('payout_worker');

    const lastSuccessAtMs = getRuntimeHealthSnapshot().workers[0]?.lastSuccessAtMs ?? 0;
    const stale = getRuntimeHealthSnapshot(lastSuccessAtMs + 1_500);
    expect(stale.workers[0]).toEqual(
      expect.objectContaining({
        name: 'payout_worker',
        stale: true,
        degraded: true,
      }),
    );
  });

  it('A4-111: marks a worker whose first tick never resolves as stale once startedAtMs ages out', () => {
    // Earlier behaviour: with no `lastSuccessAtMs` and no
    // `lastErrorAtMs`, /health reported the worker green forever
    // — a hung first tick masqueraded as healthy. Now we treat
    // `startedAtMs` as the staleness anchor until the first success.
    markWorkerStarted('payout_worker', { staleAfterMs: 1_000 });
    const startedAtMs = getRuntimeHealthSnapshot().workers[0]?.startedAtMs ?? 0;
    const fresh = getRuntimeHealthSnapshot(startedAtMs + 500);
    expect(fresh.workers[0]).toEqual(expect.objectContaining({ stale: false, degraded: false }));
    const stale = getRuntimeHealthSnapshot(startedAtMs + 1_500);
    expect(stale.workers[0]).toEqual(expect.objectContaining({ stale: true, degraded: true }));
  });
});
