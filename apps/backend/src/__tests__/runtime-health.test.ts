import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetRuntimeHealthForTests,
  getRuntimeHealthSnapshot,
  markWorkerBlocked,
  markWorkerStarted,
  markWorkerTickSkippedLocked,
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

  it('recordOtpSendFailure does not re-arm a disabled kill-switch; only a successful send does', () => {
    setOtpDeliveryEnabled(false);
    recordOtpSendFailure(new Error('provider down'));

    const silenced = getRuntimeHealthSnapshot();
    expect(silenced.otpDelivery.enabled).toBe(false);
    expect(silenced.otpDelivery.degraded).toBe(false);
    expect(silenced.degraded).toBe(false);
    expect(silenced.otpDelivery.lastError).toBe('provider down');
    expect(silenced.otpDelivery.lastFailureAtMs).not.toBeNull();

    recordOtpSendSuccess();
    const rearmed = getRuntimeHealthSnapshot();
    expect(rearmed.otpDelivery.enabled).toBe(true);
    expect(rearmed.otpDelivery.degraded).toBe(false);
  });

  it('treats a blocked required worker as degraded', () => {
    markWorkerBlocked('ctx_mirror_sweep', {
      reason: 'LOOP_STELLAR_DEPOSIT_ADDRESS is unset',
      staleAfterMs: 30_000,
    });

    const snapshot = getRuntimeHealthSnapshot();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.workers).toEqual([
      expect.objectContaining({
        name: 'ctx_mirror_sweep',
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

  it('S4-8: a lock-skipped tick counts as liveness (not stale/degraded) but is distinguishable from a led tick', () => {
    markWorkerStarted('ctx_mirror_sweep', { staleAfterMs: 1_000 });
    markWorkerTickSkippedLocked('ctx_mirror_sweep');

    const snap = getRuntimeHealthSnapshot();
    const worker = snap.workers[0]!;
    expect(worker.stale).toBe(false);
    expect(worker.degraded).toBe(false);
    expect(worker.lastSuccessAtMs).not.toBeNull();
    expect(worker.lastSkippedLockedAtMs).toBe(worker.lastSuccessAtMs);
    expect(worker.lastLeadTickAtMs).toBeNull();

    const fresh = getRuntimeHealthSnapshot((worker.lastSuccessAtMs ?? 0) + 500);
    expect(fresh.workers[0]).toEqual(expect.objectContaining({ stale: false, degraded: false }));

    markWorkerTickSuccess('ctx_mirror_sweep');
    const led = getRuntimeHealthSnapshot().workers[0]!;
    expect(led.lastLeadTickAtMs).not.toBeNull();
    expect(led.lastLeadTickAtMs).toBe(led.lastSuccessAtMs);
  });

  it('A4-111: marks a worker whose first tick never resolves as stale once startedAtMs ages out', () => {
    markWorkerStarted('payout_worker', { staleAfterMs: 1_000 });
    const startedAtMs = getRuntimeHealthSnapshot().workers[0]?.startedAtMs ?? 0;
    const fresh = getRuntimeHealthSnapshot(startedAtMs + 500);
    expect(fresh.workers[0]).toEqual(expect.objectContaining({ stale: false, degraded: false }));
    const stale = getRuntimeHealthSnapshot(startedAtMs + 1_500);
    expect(stale.workers[0]).toEqual(expect.objectContaining({ stale: true, degraded: true }));
  });
});
