// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { ApiException } from '@loop/shared';
import { useAdminStepUp } from '../use-admin-step-up';
import { useAdminStepUpStore } from '~/stores/admin-step-up.store';

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
    });
    expect(result.current.modalOpen).toBe(false);
    expect(useAdminStepUpStore.getState().token).toBe('fresh-token');
    expect(mutation).toHaveBeenCalledTimes(2);
    await expect(pending).resolves.toBe('retry-ok');
  });

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
});
