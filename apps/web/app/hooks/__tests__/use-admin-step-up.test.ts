// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ApiException } from '@loop/shared';
import { useAdminStepUp } from '../use-admin-step-up';
import { useAdminStepUpStore } from '~/stores/admin-step-up.store';

// Flush all pending microtasks (promise chains) by yielding a macrotask.
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  useAdminStepUpStore.getState().clear();
});

describe('useAdminStepUp', () => {
  it('passes through when the mutation succeeds first try', async () => {
    const { result } = renderHook(() => useAdminStepUp());
    const mutation = vi.fn().mockResolvedValue('ok');
    await act(async () => {
      const value = await result.current.runWithStepUp(mutation);
      expect(value).toBe('ok');
    });
    expect(result.current.modalOpen).toBe(false);
    expect(mutation).toHaveBeenCalledTimes(1);
  });

  it('opens the modal on STEP_UP_REQUIRED, retries after confirm', async () => {
    const { result } = renderHook(() => useAdminStepUp());
    const mutation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'step-up required' }),
      )
      .mockResolvedValueOnce('retry-ok');

    let pending: Promise<string> | undefined;
    await act(async () => {
      pending = result.current.runWithStepUp(mutation);
      // Let the inner promise reject so the hook flips modalOpen.
      await Promise.resolve();
    });
    expect(result.current.modalOpen).toBe(true);

    // Simulate the modal returning a fresh token.
    const futureExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await act(async () => {
      result.current.handleStepUpConfirm('fresh-token', futureExp);
      await pending;
      // Let the single-use `.finally(clearStepUp)` microtask run.
      await Promise.resolve();
    });
    expect(result.current.modalOpen).toBe(false);
    // SEC-02-stepup: the minted token is single-use — it's consumed by
    // the one retried write and then BURNED from the store, so the next
    // protected write re-mints a fresh scoped token rather than replaying
    // a now-dead one (re-mint-per-row / least-privilege).
    expect(useAdminStepUpStore.getState().token).toBeNull();
    expect(mutation).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toBe('retry-ok');
  });

  // SEC-02-stepup: a single-use token that's already been spent
  // (STEP_UP_ALREADY_USED) or was minted for a different class
  // (STEP_UP_PURPOSE_MISMATCH) is recovered the same way — re-open the
  // modal and mint a fresh scoped token.
  it.each(['STEP_UP_ALREADY_USED', 'STEP_UP_PURPOSE_MISMATCH'])(
    'opens the modal on %s (re-mint a fresh scoped token)',
    async (code) => {
      const { result } = renderHook(() => useAdminStepUp());
      const mutation = vi
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(new ApiException(401, { code, message: code }))
        .mockResolvedValueOnce('retry-ok');

      let pending: Promise<string> | undefined;
      await act(async () => {
        pending = result.current.runWithStepUp(mutation);
        await Promise.resolve();
      });
      expect(result.current.modalOpen).toBe(true);

      const futureExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
      await act(async () => {
        result.current.handleStepUpConfirm('fresh-token', futureExp);
        await pending;
      });
      await expect(pending).resolves.toBe('retry-ok');
      expect(mutation).toHaveBeenCalledTimes(2);
    },
  );

  it('rejects the queued mutation when the modal is cancelled', async () => {
    const { result } = renderHook(() => useAdminStepUp());
    const mutation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new ApiException(401, { code: 'STEP_UP_INVALID', message: 'invalid' }),
      );
    let pending!: Promise<string>;
    // Attach the rejection-tracking `.catch` immediately so the
    // microtask queue never sees an "unhandled rejection" before
    // the cancellation path resolves it.
    let outcome: { state: 'pending' | 'rejected'; reason?: unknown } = { state: 'pending' };
    await act(async () => {
      pending = result.current.runWithStepUp(mutation);
      pending.catch((reason: unknown) => {
        outcome = { state: 'rejected', reason };
      });
      await Promise.resolve();
    });
    expect(result.current.modalOpen).toBe(true);

    await act(async () => {
      result.current.handleStepUpCancel();
      await Promise.resolve();
    });
    expect(outcome.state).toBe('rejected');
    expect((outcome.reason as Error).message).toMatch(/cancelled/i);
    expect(result.current.modalOpen).toBe(false);
  });

  it('does NOT open the modal on a non-step-up error', async () => {
    const { result } = renderHook(() => useAdminStepUp());
    const mutation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new ApiException(409, { code: 'INSUFFICIENT_BALANCE', message: 'out of money' }),
      );
    await expect(result.current.runWithStepUp(mutation)).rejects.toThrow(/out of money/i);
    expect(result.current.modalOpen).toBe(false);
  });

  // P2-06: two concurrent step-up-blocked mutations must BOTH be served
  // by a single token mint — neither may be silently dropped. The prior
  // single-slot pending state let the second call's `setPendingResolve`
  // overwrite the first, so the first mutation's promise never resolved
  // or rejected (it hung forever) and its retry never ran.
  it('serves BOTH concurrent step-up demands after one confirm (P2-06)', async () => {
    const { result } = renderHook(() => useAdminStepUp());
    const mutationA = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'a' }))
      .mockResolvedValueOnce('A-ok');
    const mutationB = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'b' }))
      .mockResolvedValueOnce('B-ok');

    // Track each outcome WITHOUT awaiting: a dropped promise never
    // settles, so awaiting it directly would hang the test instead of
    // failing with a clear assertion.
    const outcomeA: { settled: boolean; value?: unknown } = { settled: false };
    const outcomeB: { settled: boolean; value?: unknown } = { settled: false };

    await act(async () => {
      void result.current
        .runWithStepUp(mutationA, { action: 'Action A', scope: 'credit-adjustment' })
        .then((v) => {
          outcomeA.settled = true;
          outcomeA.value = v;
        });
      void result.current
        .runWithStepUp(mutationB, { action: 'Action B', scope: 'emission' })
        .then((v) => {
        outcomeB.settled = true;
        outcomeB.value = v;
      });
      // Flush both inner rejections so each enqueues + opens the modal.
      await flush();
    });
    expect(result.current.modalOpen).toBe(true);

    const futureExp = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    await act(async () => {
      result.current.handleStepUpConfirm('fresh-token', futureExp);
      await flush();
    });

    // Both mutations were retried and both promises resolved — no drop.
    expect(mutationA).toHaveBeenCalledTimes(2);
    expect(mutationB).toHaveBeenCalledTimes(2);
    expect(outcomeA).toEqual({ settled: true, value: 'A-ok' });
    expect(outcomeB).toEqual({ settled: true, value: 'B-ok' });
  });

  // P2-06 (cancel path): cancelling with two demands queued must reject
  // BOTH deterministically — neither is left hanging.
  it('rejects BOTH concurrent step-up demands on cancel (P2-06)', async () => {
    const { result } = renderHook(() => useAdminStepUp());
    const mutationA = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'a' }));
    const mutationB = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'b' }));

    const outcomeA: { rejected: boolean; reason?: unknown } = { rejected: false };
    const outcomeB: { rejected: boolean; reason?: unknown } = { rejected: false };

    await act(async () => {
      void result.current.runWithStepUp(mutationA).catch((e: unknown) => {
        outcomeA.rejected = true;
        outcomeA.reason = e;
      });
      void result.current.runWithStepUp(mutationB).catch((e: unknown) => {
        outcomeB.rejected = true;
        outcomeB.reason = e;
      });
      await flush();
    });
    expect(result.current.modalOpen).toBe(true);

    await act(async () => {
      result.current.handleStepUpCancel();
      await flush();
    });

    expect(outcomeA.rejected).toBe(true);
    expect(outcomeB.rejected).toBe(true);
    expect((outcomeA.reason as Error).message).toMatch(/cancelled/i);
    expect((outcomeB.reason as Error).message).toMatch(/cancelled/i);
  });
});
