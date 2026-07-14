// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useOnboardingAuth } from '../signup-tail';

/**
 * P2-05 — onboarding client-side double-verify race.
 *
 * The OTP-verify action can be dispatched twice for the same one-time
 * code before React commits the `verifyingOtp` state flag: a double-tap
 * on the "Verify" CTA, the `OtpEntry` auto-submit `setTimeout` firing
 * while the user also taps the CTA, or an effect re-fire. A guard that
 * reads `verifyingOtp` (React state) cannot stop this — state doesn't
 * update synchronously, so both dispatches read `false` and each fires a
 * `verifyOtp` network call, consuming the single-use code twice.
 *
 * The hook must hold a *synchronous* in-flight lock so exactly ONE
 * `verifyOtp` request leaves the client per code.
 */

// A deferred verifyOtp: the first request stays in-flight while the
// second dispatch happens — the exact double-submit window. Each call
// parks its resolver so nothing dangles (the un-fixed code makes two).
const resolvers: Array<(v: { accessToken: string; refreshToken: string }) => void> = [];
const verifyOtpMock = vi.fn(
  (..._args: unknown[]) =>
    new Promise<{ accessToken: string; refreshToken: string }>((res) => {
      resolvers.push(res);
    }),
);

vi.mock('~/services/auth', () => ({
  requestOtp: vi.fn().mockResolvedValue(undefined),
  verifyOtp: (...args: unknown[]) => verifyOtpMock(...args),
}));

// Keep the success path hermetic — no secure-storage / native writes.
vi.mock('~/stores/auth.store', () => ({
  useAuthStore: { getState: () => ({ setSession: vi.fn() }) },
}));

beforeEach(() => {
  verifyOtpMock.mockClear();
  resolvers.length = 0;
});

afterEach(() => {
  cleanup();
});

describe('useOnboardingAuth().verify — P2-05 double-verify race', () => {
  it('fires verifyOtp exactly once when two dispatches race for the same code', async () => {
    const { result } = renderHook(() => useOnboardingAuth());

    const pending: Array<Promise<boolean>> = [];
    await act(async () => {
      // Two near-simultaneous dispatches in one tick — before the
      // `verifyingOtp` state flag can commit between them.
      pending.push(result.current.verify('ash@example.com', '123456'));
      pending.push(result.current.verify('ash@example.com', '123456'));
      await Promise.resolve();
    });

    // The security property: one one-time code -> one verify request.
    expect(verifyOtpMock).toHaveBeenCalledTimes(1);

    // Drain: resolve every in-flight request and let both dispatches
    // settle so no promise is left dangling.
    await act(async () => {
      for (const res of resolvers) res({ accessToken: 'a', refreshToken: 'r' });
      await Promise.all(pending);
    });
  });
});
