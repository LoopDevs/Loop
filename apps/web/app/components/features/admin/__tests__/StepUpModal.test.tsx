// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { StepUpModal } from '../StepUpModal';

afterEach(cleanup);

const { authMock, stepUpMock } = vi.hoisted(() => ({
  authMock: { requestOtp: vi.fn() },
  stepUpMock: { mintAdminStepUp: vi.fn() },
}));

vi.mock('~/services/auth', () => ({
  requestOtp: (email: string) => authMock.requestOtp(email),
}));
vi.mock('~/services/admin-step-up', () => ({
  mintAdminStepUp: (otp: string) => stepUpMock.mintAdminStepUp(otp),
}));
vi.mock('~/stores/auth.store', () => ({
  useAuthStore: (selector: (s: { email: string | null }) => unknown) =>
    selector({ email: 'admin@loop.test' }),
}));

beforeEach(() => {
  authMock.requestOtp.mockReset();
  stepUpMock.mintAdminStepUp.mockReset();

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
    render(<StepUpModal onConfirm={onConfirm} onCancel={vi.fn()} />);

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
      expect(stepUpMock.mintAdminStepUp).toHaveBeenCalledWith('123456');
      expect(onConfirm).toHaveBeenCalledWith('jwt-step-up', '2026-06-11T12:05:00.000Z');
    });
  });
});
