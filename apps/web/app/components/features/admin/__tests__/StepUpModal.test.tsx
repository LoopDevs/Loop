// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ApiException } from '@loop/shared';
import { StepUpModal } from '../StepUpModal';

afterEach(cleanup);

// `authState` is a mutable holder so a single test can drop the admin's
// email (the "no admin session" guard) without a bespoke module mock.
// Defaults back to the real value in beforeEach so every other test sees
// the same signed-in admin the original suite assumed.
const { authMock, stepUpMock, authState } = vi.hoisted(() => ({
  authMock: { requestOtp: vi.fn() },
  stepUpMock: { mintAdminStepUp: vi.fn() },
  authState: { email: 'admin@loop.test' as string | null },
}));

vi.mock('~/services/auth', () => ({
  requestOtp: (email: string) => authMock.requestOtp(email),
}));
vi.mock('~/services/admin-step-up', () => ({
  // SEC-02-stepup: the modal mints a token scoped to the pending action.
  mintAdminStepUp: (otp: string, scope: string) => stepUpMock.mintAdminStepUp(otp, scope),
}));

// SEC-02-stepup: the modal requires a pending action (carrying the
// action-CLASS `scope`) to mint a class-bound token. Every render that
// reaches the Confirm step supplies one.
const EMISSION_ACTION = { action: 'Queue emission', scope: 'emission' as const };
vi.mock('~/stores/auth.store', () => ({
  useAuthStore: (selector: (s: { email: string | null }) => unknown) =>
    selector({ email: authState.email }),
}));

beforeEach(() => {
  authMock.requestOtp.mockReset();
  stepUpMock.mintAdminStepUp.mockReset();
  authState.email = 'admin@loop.test';

  // jsdom doesn't ship a complete <dialog> implementation: showModal
  // and close are missing on HTMLDialogElement. Polyfill the minimum
  // surface StepUpModal.tsx exercises (same shim as the
  // MerchantResyncButton / ReasonDialog tests).
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

describe('<StepUpModal />', () => {
  it('renders as an open native <dialog> (focus trap + ESC come from the browser)', () => {
    render(<StepUpModal onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = document.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.hasAttribute('open')).toBe(true);
    expect(screen.getByText(/Confirm with your verification code/i)).toBeDefined();
  });

  it('invokes onCancel when the Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<StepUpModal onConfirm={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('invokes onCancel on the native cancel event (ESC key path)', () => {
    const onCancel = vi.fn();
    render(<StepUpModal onConfirm={vi.fn()} onCancel={onCancel} />);
    const dialog = document.querySelector('dialog');
    expect(dialog).not.toBeNull();
    fireEvent(dialog as HTMLDialogElement, new Event('cancel', { cancelable: true }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('walks the send-code → confirm flow and surfaces the minted token', async () => {
    authMock.requestOtp.mockResolvedValue(undefined);
    stepUpMock.mintAdminStepUp.mockResolvedValue({
      stepUpToken: 'jwt-step-up',
      expiresAt: '2026-06-11T12:05:00.000Z',
    });
    const onConfirm = vi.fn();
    render(
      <StepUpModal onConfirm={onConfirm} onCancel={vi.fn()} pendingAction={EMISSION_ACTION} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    await waitFor(() => {
      expect(authMock.requestOtp).toHaveBeenCalledWith('admin@loop.test');
    });

    // Anchored: the <dialog> itself is labelled "Confirm with your
    // verification code" via aria-labelledby, which a loose regex
    // would also match.
    const input = await screen.findByLabelText(/^verification code$/i);
    fireEvent.change(input, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    await waitFor(() => {
      expect(stepUpMock.mintAdminStepUp).toHaveBeenCalledWith('123456', 'emission');
      expect(onConfirm).toHaveBeenCalledWith('jwt-step-up', '2026-06-11T12:05:00.000Z');
    });
  });

  // FE-15: the emailed 6-digit code should autofill from the OS
  // notification (iOS suggestion bar / Android autofill) and bring up a
  // numeric keypad — same contract as the login + onboarding OTP inputs
  // (auth.tsx, signup-tail.tsx).
  it('gives the OTP input one-time-code autofill + a numeric keypad (FE-15)', async () => {
    authMock.requestOtp.mockResolvedValue(undefined);
    render(<StepUpModal onConfirm={vi.fn()} onCancel={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    const input = await screen.findByLabelText(/^verification code$/i);

    expect(input.getAttribute('autocomplete')).toBe('one-time-code');
    expect(input.getAttribute('inputmode')).toBe('numeric');
  });

  // P2-07: the modal must echo WHAT the OTP authorizes — amount
  // (canonical formatter), destination, and action — so an operator
  // cannot blind-approve an unseen, irreversible money movement.
  it('echoes the pending action amount and destination it authorizes (P2-07)', () => {
    render(
      <StepUpModal
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        pendingAction={{
          action: 'Queue emission',
          scope: 'emission',
          amount: { minor: '5000', currency: 'USD' },
          destination: 'GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXRGH6DUVZ',
        }}
      />,
    );

    // Amount rendered via the canonical formatMinorCurrency (not hand-rolled).
    expect(screen.getByText('$50.00')).toBeDefined();
    // Destination shown verbatim.
    expect(screen.getByText('GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXRGH6DUVZ')).toBeDefined();
    // Action type shown.
    expect(screen.getByText('Queue emission')).toBeDefined();
  });

  // FE-14: a failed confirm must be announced to AT (assertive live
  // region) and return focus to the OTP field so the admin can correct
  // and retry — the confirm click otherwise strands focus on the button.
  it('announces a confirm error via role="alert" and returns focus to the OTP field (FE-14)', async () => {
    authMock.requestOtp.mockResolvedValue(undefined);
    stepUpMock.mintAdminStepUp.mockRejectedValue(new Error('bad code'));
    render(<StepUpModal onConfirm={vi.fn()} onCancel={vi.fn()} pendingAction={EMISSION_ACTION} />);

    fireEvent.click(screen.getByRole('button', { name: /send code/i }));
    const input = await screen.findByLabelText(/^verification code$/i);
    fireEvent.change(input, { target: { value: '000000' } });

    // A real submit click leaves focus on the Confirm button; move focus
    // off the field first so the focus-return assertion is non-vacuous
    // (fireEvent.click does not move focus on its own).
    screen.getByRole('button', { name: /cancel/i }).focus();
    fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/bad code/i);

    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  // FE-36: the error branches of the OTP flow were previously untested.
  // The load-bearing property for every one of them is the same: a
  // FAILED verification must be SURFACED and must NOT be mistaken for
  // success — `onConfirm` (which mints the destructive-action token) must
  // never fire on an error path, and the modal must stay open so the
  // admin can correct/retry rather than silently sail through.
  describe('error branches (FE-36)', () => {
    // Drive the modal to the code-entry step and submit `code`, leaving
    // `mintAdminStepUp` to reject however the individual test configured.
    async function submitCode(
      onConfirm: (stepUpToken: string, expiresAt: string) => void,
      code: string,
    ): Promise<HTMLElement> {
      authMock.requestOtp.mockResolvedValue(undefined);
      render(
        <StepUpModal onConfirm={onConfirm} onCancel={vi.fn()} pendingAction={EMISSION_ACTION} />,
      );
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));
      const input = await screen.findByLabelText(/^verification code$/i);
      fireEvent.change(input, { target: { value: code } });
      fireEvent.click(screen.getByRole('button', { name: /^confirm$/i }));
      return input;
    }

    it('surfaces a wrong-code error (401 STEP_UP_INVALID) and does NOT confirm', async () => {
      const onConfirm = vi.fn();
      stepUpMock.mintAdminStepUp.mockRejectedValue(
        new ApiException(401, {
          code: 'STEP_UP_INVALID',
          message: 'That verification code is incorrect.',
        }),
      );
      const input = await submitCode(onConfirm, '000000');

      // The server's message is surfaced verbatim (friendlyError).
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/incorrect/i);

      // The mint WAS attempted with the typed code (we exercised the real
      // path) but its rejection was NOT treated as success.
      expect(stepUpMock.mintAdminStepUp).toHaveBeenCalledWith('000000', 'emission');
      expect(onConfirm).not.toHaveBeenCalled();

      // Modal stays open on the code-entry step so the admin can retry.
      expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
      expect(input).toBeDefined();
      expect(screen.getByRole('button', { name: /^confirm$/i })).toBeDefined();
    });

    it('surfaces an expired-code error and offers Resend without confirming', async () => {
      const onConfirm = vi.fn();
      stepUpMock.mintAdminStepUp.mockRejectedValue(
        new ApiException(401, {
          code: 'UNAUTHORIZED',
          message: 'Your verification code has expired. Request a new one.',
        }),
      );
      await submitCode(onConfirm, '111111');

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/expired/i);
      expect(onConfirm).not.toHaveBeenCalled();

      // Recovery path is live: back on the code-entry step, the Resend
      // button is present and enabled so a fresh code can be requested.
      const resend = screen.getByRole('button', { name: /resend/i });
      expect(resend).toBeDefined();
      expect((resend as HTMLButtonElement).disabled).toBe(false);
    });

    it('shows the ops "not configured" copy on a 503 and does NOT confirm (STEP_UP_UNAVAILABLE)', async () => {
      const onConfirm = vi.fn();
      stepUpMock.mintAdminStepUp.mockRejectedValue(
        new ApiException(503, {
          code: 'STEP_UP_UNAVAILABLE',
          message: 'signing key missing',
        }),
      );
      await submitCode(onConfirm, '222222');

      // The component substitutes its own ops-facing copy for the 503
      // branch instead of echoing the raw server message.
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/not configured on this deployment/i);
      expect(alert.textContent).toMatch(/contact ops/i);
      expect(alert.textContent).not.toMatch(/signing key missing/i);

      expect(onConfirm).not.toHaveBeenCalled();
      expect(document.querySelector('dialog')?.hasAttribute('open')).toBe(true);
    });

    it('falls back to a generic message when the rejection is not an Error/ApiException', async () => {
      const onConfirm = vi.fn();
      // A non-Error rejection exercises friendlyError's fallback branch.
      stepUpMock.mintAdminStepUp.mockRejectedValue('kaboom');
      await submitCode(onConfirm, '333333');

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/verification failed/i);
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('surfaces a send-code failure and does not advance to code entry or confirm', async () => {
      const onConfirm = vi.fn();
      authMock.requestOtp.mockRejectedValue(
        new ApiException(429, {
          code: 'RATE_LIMITED',
          message: 'Too many code requests. Try again shortly.',
        }),
      );
      render(<StepUpModal onConfirm={onConfirm} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/too many code requests/i);

      // A failed send returns to the idle step: the "Send code" button is
      // shown again for retry and no OTP field is exposed. onConfirm is
      // untouched — a send failure can never authorize the action.
      expect(screen.getByRole('button', { name: /send code/i })).toBeDefined();
      expect(screen.queryByLabelText(/^verification code$/i)).toBeNull();
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('surfaces a Resend failure from the code-entry step and does not confirm', async () => {
      const onConfirm = vi.fn();
      authMock.requestOtp.mockResolvedValueOnce(undefined); // first send succeeds
      render(<StepUpModal onConfirm={onConfirm} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));
      await screen.findByLabelText(/^verification code$/i);

      // Now the resend attempt fails.
      authMock.requestOtp.mockRejectedValueOnce(
        new ApiException(429, {
          code: 'RATE_LIMITED',
          message: 'Slow down — too many resends.',
        }),
      );
      fireEvent.click(screen.getByRole('button', { name: /resend/i }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/too many resends/i);
      expect(stepUpMock.mintAdminStepUp).not.toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('blocks send-code with no admin session and never calls requestOtp (email === null)', async () => {
      authState.email = null;
      const onConfirm = vi.fn();
      render(<StepUpModal onConfirm={onConfirm} onCancel={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: /send code/i }));

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/no admin session/i);
      // Guard short-circuits before any network call or success callback.
      expect(authMock.requestOtp).not.toHaveBeenCalled();
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });
});
