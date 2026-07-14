// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useAuthStore } from '~/stores/auth.store';
import { useAdminStepUpStore } from '~/stores/admin-step-up.store';
import { CreditAdjustmentForm, parseAmountMajor } from '../CreditAdjustmentForm';

afterEach(cleanup);

const { adminMock, stepUpMock } = vi.hoisted(() => ({
  adminMock: { applyCreditAdjustment: vi.fn() },
  stepUpMock: { requestOtp: vi.fn(), mintAdminStepUp: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    applyCreditAdjustment: (args: unknown) => adminMock.applyCreditAdjustment(args),
  };
});

vi.mock('~/services/auth', () => ({
  requestOtp: (email: string) => stepUpMock.requestOtp(email),
}));
vi.mock('~/services/admin-step-up', () => ({
  mintAdminStepUp: (otp: string) => stepUpMock.mintAdminStepUp(otp),
}));

beforeEach(() => {
  adminMock.applyCreditAdjustment.mockReset();
  stepUpMock.requestOtp.mockReset();
  stepUpMock.mintAdminStepUp.mockReset();
  // StepUpModal reads the admin email from the auth store to send the OTP.
  useAuthStore.setState({ email: 'admin@loop.test' });
  // P2-07: the modal reads the pending-action summary from this store —
  // reset it so no stale summary leaks between tests.
  useAdminStepUpStore.setState({ pendingAction: null, token: null, expiresAtMs: null });

  // jsdom doesn't ship a complete <dialog> implementation.
  const proto = HTMLDialogElement.prototype as any;
  if (typeof proto.showModal !== 'function') {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
  }
  if (typeof proto.close !== 'function') {
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
  }
});

describe('parseAmountMajor', () => {
  it('parses an unsigned whole number as positive minor units', () => {
    expect(parseAmountMajor('100')?.minorString).toBe('10000');
  });

  it('parses an explicit leading + as positive', () => {
    expect(parseAmountMajor('+12.34')?.minorString).toBe('1234');
  });

  it('parses a leading - as a signed debit', () => {
    expect(parseAmountMajor('-0.50')?.minorString).toBe('-50');
  });

  it('pads a single decimal to two places', () => {
    expect(parseAmountMajor('3.1')?.minorString).toBe('310');
  });

  it('accepts whole numbers with no decimal', () => {
    expect(parseAmountMajor('-50')?.minorString).toBe('-5000');
  });

  it('rejects more than 2 decimals', () => {
    expect(parseAmountMajor('1.234')).toBeNull();
  });

  it('rejects zero (positive and negative) to match backend non-zero rule', () => {
    expect(parseAmountMajor('0')).toBeNull();
    expect(parseAmountMajor('-0.00')).toBeNull();
    expect(parseAmountMajor('+0')).toBeNull();
  });

  it('rejects empty / whitespace-only', () => {
    expect(parseAmountMajor('')).toBeNull();
    expect(parseAmountMajor('   ')).toBeNull();
  });

  it('rejects letters / symbols', () => {
    expect(parseAmountMajor('abc')).toBeNull();
    expect(parseAmountMajor('$12')).toBeNull();
    expect(parseAmountMajor('1,000')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseAmountMajor('  12.34  ')?.minorString).toBe('1234');
  });
});

function envelope(
  result: Record<string, unknown>,
  replayed = false,
): { result: Record<string, unknown>; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-07-10T10:00:00.000Z',
      replayed,
    },
  };
}

function renderForm(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CreditAdjustmentForm userId="user-1" defaultCurrency="USD" />
    </QueryClientProvider>,
  );
}

/** Fill amount + reason, submit, then confirm the ConfirmDialog. */
async function submitAndConfirm(amount = '+12.34', reason = 'goodwill credit'): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Credit adjustment amount/i), {
    target: { value: amount },
  });
  fireEvent.change(screen.getByPlaceholderText(/goodwill credit for order/i), {
    target: { value: reason },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Apply adjustment$/ }));
  });
  const openDialog = await waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open confirm dialog');
    return d;
  });
  const confirmBtn = within(openDialog).getByRole('button', { name: 'Apply adjustment' });
  await act(async () => {
    fireEvent.click(confirmBtn);
  });
}

/**
 * Q6-3: the credit-adjustment mutation flow through the ADR-017 +
 * ADR-028 client envelope — this form previously had ZERO coverage of
 * anything beyond the pure `parseAmountMajor` helper.
 */
describe('<CreditAdjustmentForm /> — submit flow', () => {
  it('submit → confirm dialog → service called with amount/currency/reason + a generated idempotencyKey', async () => {
    adminMock.applyCreditAdjustment.mockResolvedValue(
      envelope({
        id: 'ct-1',
        userId: 'user-1',
        currency: 'USD',
        amountMinor: '1234',
        priorBalanceMinor: '0',
        newBalanceMinor: '1234',
        createdAt: '2026-07-10T10:00:00.000Z',
      }),
    );
    renderForm();
    await submitAndConfirm();

    await waitFor(() => {
      expect(adminMock.applyCreditAdjustment).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-1',
          amountMinor: '1234',
          currency: 'USD',
          reason: 'goodwill credit',
          idempotencyKey: expect.any(String),
        }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/Adjustment applied/i)).toBeDefined();
    });
  });

  it('rejects a too-short reason before calling the service', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Credit adjustment amount/i), {
      target: { value: '+12.34' },
    });
    fireEvent.change(screen.getByPlaceholderText(/goodwill credit for order/i), {
      target: { value: 'x' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Apply adjustment$/ }));
    });
    expect(screen.getByText(/Reason must be 2–500 characters/)).toBeDefined();
    expect(adminMock.applyCreditAdjustment).not.toHaveBeenCalled();
  });

  it('rejects an invalid amount before calling the service', async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/Credit adjustment amount/i), {
      target: { value: 'abc' },
    });
    fireEvent.change(screen.getByPlaceholderText(/goodwill credit for order/i), {
      target: { value: 'a valid reason here' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Apply adjustment$/ }));
    });
    expect(screen.getByText(/Amount must be a non-zero signed number/)).toBeDefined();
    expect(adminMock.applyCreditAdjustment).not.toHaveBeenCalled();
  });

  it('a non-step-up error (e.g. 409 daily cap) surfaces as a form error without retrying', async () => {
    adminMock.applyCreditAdjustment.mockRejectedValue(
      new ApiException(409, {
        code: 'DAILY_ADJUSTMENT_CAP_EXCEEDED',
        message: 'Daily adjustment cap exceeded',
      }),
    );
    renderForm();
    await submitAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(/Daily adjustment cap exceeded/)).toBeDefined();
    });
    expect(adminMock.applyCreditAdjustment).toHaveBeenCalledTimes(1);
  });
});

describe('<CreditAdjustmentForm /> — step-up retry (CF-09)', () => {
  it('401 STEP_UP_REQUIRED opens the StepUpModal instead of dead-ending', async () => {
    adminMock.applyCreditAdjustment.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
    );
    renderForm();
    await submitAndConfirm();

    await waitFor(() => {
      expect(screen.getByText(/Confirm with your verification code/)).toBeDefined();
    });
  });

  it('the step-up modal echoes the amount + target user it authorizes (P2-07)', async () => {
    adminMock.applyCreditAdjustment.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
    );
    renderForm();
    await submitAndConfirm('+12.34', 'goodwill credit');

    const stepUpDialog = await waitFor(() => {
      const d = Array.from(document.querySelectorAll('dialog[open]')).find((el) =>
        /Confirm with your verification code/.test(el.textContent ?? ''),
      );
      if (!(d instanceof HTMLElement)) throw new Error('step-up dialog not open yet');
      return d;
    });

    // Amount (canonical formatMinorCurrency) + the target user + action.
    expect(within(stepUpDialog).getByText('$12.34')).toBeDefined();
    expect(within(stepUpDialog).getByText('user-1')).toBeDefined();
    expect(within(stepUpDialog).getByText('Apply credit adjustment')).toBeDefined();
  });

  it('reuses the same Idempotency-Key across the step-up retry — no double-credit risk', async () => {
    adminMock.applyCreditAdjustment
      .mockRejectedValueOnce(
        new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
      )
      .mockResolvedValueOnce(
        envelope({
          id: 'ct-1',
          userId: 'user-1',
          currency: 'USD',
          amountMinor: '1234',
          priorBalanceMinor: '0',
          newBalanceMinor: '1234',
          createdAt: '2026-07-10T10:00:00.000Z',
        }),
      );
    stepUpMock.requestOtp.mockResolvedValue(undefined);
    stepUpMock.mintAdminStepUp.mockResolvedValue({
      stepUpToken: 'tok',
      expiresAt: '2026-07-10T10:10:00.000Z',
    });

    renderForm();
    await submitAndConfirm();

    const sendBtn = await screen.findByRole('button', { name: /Send code/ });
    await act(async () => {
      fireEvent.click(sendBtn);
    });
    const otpInput = await screen.findByLabelText(/Verification code/);
    await act(async () => {
      fireEvent.change(otpInput, { target: { value: '123456' } });
    });
    const confirmBtn = await screen.findByRole('button', { name: 'Confirm' });
    await act(async () => {
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(adminMock.applyCreditAdjustment).toHaveBeenCalledTimes(2);
    });
    const firstArgs = adminMock.applyCreditAdjustment.mock.calls[0]?.[0] as
      | { idempotencyKey?: string }
      | undefined;
    const secondArgs = adminMock.applyCreditAdjustment.mock.calls[1]?.[0] as
      | { idempotencyKey?: string }
      | undefined;
    expect(firstArgs?.idempotencyKey).toBeDefined();
    expect(secondArgs?.idempotencyKey).toBe(firstArgs?.idempotencyKey);
    await waitFor(() => {
      expect(screen.getByText(/Adjustment applied/i)).toBeDefined();
    });
  });

  it('cancelling the step-up modal rejects without performing the write again', async () => {
    adminMock.applyCreditAdjustment.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
    );
    renderForm();
    await submitAndConfirm();

    const stepUpDialog = await waitFor(() => {
      const dialogs = Array.from(document.querySelectorAll('dialog[open]'));
      const d = dialogs.find((el) =>
        /Confirm with your verification code/.test(el.textContent ?? ''),
      );
      if (!(d instanceof HTMLElement)) throw new Error('step-up dialog not open yet');
      return d;
    });
    await act(async () => {
      fireEvent.click(within(stepUpDialog).getByRole('button', { name: 'Cancel' }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Admin step-up cancelled/i)).toBeDefined();
    });
    // The cancelled step-up must not trigger a second (retried) call.
    expect(adminMock.applyCreditAdjustment).toHaveBeenCalledTimes(1);
  });
});
