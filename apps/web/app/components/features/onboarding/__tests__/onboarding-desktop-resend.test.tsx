// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { OnboardingDesktop } from '../OnboardingDesktop';

/**
 * UX-07 (docs/ux-pass-2026-07-09.md): the web onboarding OTP step only
 * offered "Use a different email" (a full re-entry) with no direct
 * "resend to the same address" action. Mirrors the native flow's
 * explicit "Resend code" (signup-tail.tsx's `handleResend` /
 * `OtpEntry`'s `onResend`), plus a post-send cooldown so the button
 * can't be used to hammer the backend's 5/min request-otp rate limit
 * (AGENTS.md middleware stack).
 */

const requestOtpMock = vi.fn().mockResolvedValue(undefined);

vi.mock('~/services/auth', () => ({
  requestOtp: (...args: unknown[]) => requestOtpMock(...args),
  verifyOtp: vi.fn(),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: true }, isLoading: false }),
}));

beforeEach(() => {
  requestOtpMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderDesktop(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OnboardingDesktop />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function advanceToOtpStep(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/email address/i), {
    target: { value: 'ash@example.com' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /send verification code/i }));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect(screen.getByText('Check your email')).toBeDefined();
}

describe('<OnboardingDesktop /> OTP resend (UX-07)', () => {
  it('offers an enabled "Resend code" action as soon as the OTP step opens', async () => {
    renderDesktop();
    await advanceToOtpStep();
    const resend = screen.getByRole('button', { name: 'Resend code' });
    expect(resend).toHaveProperty('disabled', false);
    // The initial send already counts as one request-otp call.
    expect(requestOtpMock).toHaveBeenCalledTimes(1);
  });

  it('disables the resend button with a countdown immediately after tapping it', async () => {
    renderDesktop();
    await advanceToOtpStep();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(requestOtpMock).toHaveBeenCalledTimes(2);

    const cooldownButton = screen.getByRole('button', { name: 'Resend code in 30s' });
    expect(cooldownButton).toHaveProperty('disabled', true);
  });

  it('re-enables the resend button once the cooldown elapses', async () => {
    vi.useFakeTimers();
    renderDesktop();
    await advanceToOtpStep();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Resend code in 30s' })).toBeDefined();

    // Drain the full 30s cooldown; the interval decrements once/sec.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    const resendAgain = screen.getByRole('button', { name: 'Resend code' });
    expect(resendAgain).toHaveProperty('disabled', false);
  });

  it('resets a pending cooldown when switching to a different email', async () => {
    renderDesktop();
    await advanceToOtpStep();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Resend code in 30s' })).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /use a different email/i }));
    expect(screen.getByText(/welcome to the club/i)).toBeDefined();

    // A fresh send on the new OTP step starts with the plain
    // (non-cooldown) label — no leaked cooldown from the prior email.
    await advanceToOtpStep();
    expect(screen.getByRole('button', { name: 'Resend code' })).toBeDefined();
  });
});
