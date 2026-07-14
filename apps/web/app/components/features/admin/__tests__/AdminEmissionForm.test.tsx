// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useAuthStore } from '~/stores/auth.store';
import { useAdminStepUpStore } from '~/stores/admin-step-up.store';
import { AdminEmissionForm, parseUnsignedAmountMajor } from '../AdminEmissionForm';

afterEach(cleanup);

const { adminMock, stepUpMock } = vi.hoisted(() => ({
  adminMock: { applyAdminEmission: vi.fn() },
  stepUpMock: { requestOtp: vi.fn(), mintAdminStepUp: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    applyAdminEmission: (args: unknown) => adminMock.applyAdminEmission(args),
  };
});
vi.mock('~/services/auth', () => ({
  requestOtp: (email: string) => stepUpMock.requestOtp(email),
}));
vi.mock('~/services/admin-step-up', () => ({
  mintAdminStepUp: (otp: string) => stepUpMock.mintAdminStepUp(otp),
}));

// A valid Stellar public key (matches STELLAR_PUBKEY_REGEX /^G[A-Z2-7]{55}$/).
const DEST = 'G' + 'A'.repeat(55);

beforeEach(() => {
  adminMock.applyAdminEmission.mockReset();
  stepUpMock.requestOtp.mockReset();
  stepUpMock.mintAdminStepUp.mockReset();
  useAuthStore.setState({ email: 'admin@loop.test' });
  // The modal now reads the pending-action summary from this store;
  // reset it so a prior test can't leak a stale summary into this one.
  useAdminStepUpStore.setState({ pendingAction: null, token: null, expiresAtMs: null });

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

describe('parseUnsignedAmountMajor', () => {
  it('parses a whole number as positive minor units', () => {
    expect(parseUnsignedAmountMajor('100')?.minorString).toBe('10000');
  });

  it('pads a single decimal to two places', () => {
    expect(parseUnsignedAmountMajor('3.1')?.minorString).toBe('310');
  });

  it('parses two decimals exactly', () => {
    expect(parseUnsignedAmountMajor('12.34')?.minorString).toBe('1234');
  });

  it('rejects signed input — emissions are always positive', () => {
    expect(parseUnsignedAmountMajor('+12.34')).toBeNull();
    expect(parseUnsignedAmountMajor('-50')).toBeNull();
  });

  it('rejects more than 2 decimals', () => {
    expect(parseUnsignedAmountMajor('1.234')).toBeNull();
  });

  it('rejects zero', () => {
    expect(parseUnsignedAmountMajor('0')).toBeNull();
    expect(parseUnsignedAmountMajor('0.00')).toBeNull();
  });

  it('rejects empty / whitespace-only', () => {
    expect(parseUnsignedAmountMajor('')).toBeNull();
    expect(parseUnsignedAmountMajor('   ')).toBeNull();
  });

  it('rejects letters / symbols', () => {
    expect(parseUnsignedAmountMajor('abc')).toBeNull();
    expect(parseUnsignedAmountMajor('$12')).toBeNull();
    expect(parseUnsignedAmountMajor('1,000')).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(parseUnsignedAmountMajor('  12.34  ')?.minorString).toBe('1234');
  });
});

function renderForm(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AdminEmissionForm userId="user-1" defaultCurrency="USD" />
    </QueryClientProvider>,
  );
}

/** Fill amount + destination + reason, submit, then confirm the ConfirmDialog. */
async function submitAndConfirm(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/Emission amount in major units/i), {
    target: { value: '500' },
  });
  fireEvent.change(screen.getByLabelText(/Destination Stellar address/i), {
    target: { value: DEST },
  });
  fireEvent.change(screen.getByPlaceholderText(/backfill of failed cashback payout/i), {
    target: { value: 'backfill ticket #abc' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Queue emission$/ }));
  });
  const openDialog = await waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open confirm dialog');
    return d;
  });
  const confirmBtn = within(openDialog).getByRole('button', { name: 'Queue emission' });
  await act(async () => {
    fireEvent.click(confirmBtn);
  });
}

/**
 * P2-07 (load-bearing): drive the real emission flow until a 401
 * STEP_UP_REQUIRED opens the OTP modal, then assert the modal ECHOES
 * the amount + destination + action it authorizes. Pre-wiring, the
 * modal opened with none of that shown — an operator could OTP-approve
 * an unseen, irreversible emission to the wrong address.
 */
describe('<AdminEmissionForm /> — step-up modal echoes the authorized emission (P2-07)', () => {
  it('shows the amount, destination, and action in the step-up modal', async () => {
    adminMock.applyAdminEmission.mockRejectedValue(
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

    // Amount: canonical formatMinorCurrency of 500.00 USD.
    expect(within(stepUpDialog).getByText('$500.00')).toBeDefined();
    // Destination: the Stellar address, verbatim.
    expect(within(stepUpDialog).getByText(DEST)).toBeDefined();
    // Action type.
    expect(within(stepUpDialog).getByText('Queue emission')).toBeDefined();
  });
});
