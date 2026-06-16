// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import AdminPayoutDetailRoute from '../admin.payouts.$id';
import { fmtStroops } from '~/utils/format-stellar';
import { useAuthStore } from '~/stores/auth.store';

afterEach(cleanup);

const { adminMock, authMock, stepUpMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminPayout: vi.fn(),
    retryPayout: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
  stepUpMock: {
    requestOtp: vi.fn(),
    mintAdminStepUp: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminPayout: (id: string) => adminMock.getAdminPayout(id),
    retryPayout: (args: unknown) => adminMock.retryPayout(args),
    getTreasurySnapshot: vi.fn().mockResolvedValue({
      outstanding: {},
      totals: {},
      liabilities: {},
      assets: { USDC: { stroops: null }, XLM: { stroops: null } },
      payouts: {},
      operatorPool: { size: 0, operators: [] },
    }),
  };
});

// CF-09: the StepUpModal mints a token via these two services. Mock
// them so the step-up flow drives to completion in the test without a
// real backend.
vi.mock('~/services/auth', () => ({
  requestOtp: (email: string) => stepUpMock.requestOtp(email),
}));
vi.mock('~/services/admin-step-up', () => ({
  mintAdminStepUp: (otp: string) => stepUpMock.mintAdminStepUp(otp),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// jsdom doesn't ship a complete <dialog> implementation: showModal +
// close are missing on HTMLDialogElement. Polyfill the minimum surface
// ReasonDialog / StepUpModal exercise so the dialogs open / close.
beforeEach(() => {
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

// A2-1101: RequireAdmin gates the admin shell on /api/users/me.isAdmin.
import type * as UserModule from '~/services/user';
vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: vi.fn(async () => ({
      id: 'u1',
      email: 'admin@loop.test',
      isAdmin: true,
      homeCurrency: 'USD' as const,
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    })),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderAt(path = '/admin/payouts/aaaa1111'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/payouts/:id" element={<AdminPayoutDetailRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const baseRow = {
  id: 'aaaa1111',
  userId: '11111111-1111-1111-1111-111111111111',
  orderId: 'bbbb2222',
  assetCode: 'GBPLOOP',
  assetIssuer: 'GISSUER',
  toAddress: 'GDESTINATION',
  amountStroops: '12500000',
  memoText: 'order-bbbb2222',
  state: 'confirmed' as const,
  txHash: 'abcdef0123456789',
  lastError: null,
  attempts: 1,
  createdAt: '2026-04-20T10:00:00.000Z',
  submittedAt: '2026-04-20T10:01:00.000Z',
  confirmedAt: '2026-04-20T10:02:00.000Z',
  failedAt: null,
};

describe('fmtStroops', () => {
  it('trims trailing zeros', () => {
    expect(fmtStroops('12500000', 'GBPLOOP')).toBe('1.25 GBPLOOP');
  });

  it('handles whole-number amounts', () => {
    expect(fmtStroops('10000000', 'USDLOOP')).toBe('1 USDLOOP');
  });

  it('returns em-dash for non-numeric input', () => {
    expect(fmtStroops('garbage', 'GBPLOOP')).toBe('—');
  });
});

describe('<AdminPayoutDetailRoute />', () => {
  it('renders the row with a Stellar Expert link for confirmed payouts', async () => {
    adminMock.getAdminPayout.mockResolvedValue(baseRow);
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('1.25 GBPLOOP')).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /View on Stellar Expert/ });
    expect(link.getAttribute('href')).toMatch(/stellar\.expert/);
  });

  it('shows the retry button only on failed rows', async () => {
    adminMock.getAdminPayout.mockResolvedValue({
      ...baseRow,
      state: 'failed',
      failedAt: '2026-04-20T10:03:00.000Z',
      lastError: 'op_underfunded',
      txHash: null,
      confirmedAt: null,
    });
    renderAt();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Retry payout/ })).toBeDefined();
    });
    expect(screen.getByText(/op_underfunded/)).toBeDefined();
  });

  it('renders a 404 body when the payout is not found', async () => {
    adminMock.getAdminPayout.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Not found' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Payout not found/)).toBeDefined();
    });
  });

  it('renders a generic error when the fetch fails with non-404', async () => {
    adminMock.getAdminPayout.mockRejectedValue(new Error('boom'));
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load payout/)).toBeDefined();
    });
  });
});

describe('<AdminPayoutDetailRoute /> step-up retry (W-01 / CF-09)', () => {
  const failedRow = {
    ...baseRow,
    state: 'failed' as const,
    failedAt: '2026-04-20T10:03:00.000Z',
    lastError: 'op_underfunded',
    txHash: null,
    confirmedAt: null,
  };

  beforeEach(() => {
    adminMock.getAdminPayout.mockReset();
    adminMock.retryPayout.mockReset();
    stepUpMock.requestOtp.mockReset();
    stepUpMock.mintAdminStepUp.mockReset();
    // StepUpModal reads the admin email from the auth store to send the OTP.
    useAuthStore.setState({ email: 'admin@loop.test' });
  });

  // Drive the failed row → Retry button → ReasonDialog → mutate.
  async function clickRetryWithReason(reason: string): Promise<void> {
    adminMock.getAdminPayout.mockResolvedValue(failedRow);
    renderAt();
    const retryBtn = await screen.findByRole('button', { name: /Retry payout/ });
    await act(async () => {
      fireEvent.click(retryBtn);
    });
    const textarea = await screen.findByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: reason } });
    });
    const form = textarea.closest('form');
    if (form === null) throw new Error('reason dialog form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
  }

  it('opens the StepUpModal instead of dead-ending on 401 STEP_UP_REQUIRED', async () => {
    adminMock.retryPayout.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
    );
    await clickRetryWithReason('retry stuck payout');
    // The modal must appear — the W-01 dead-end was that no modal mounted.
    await waitFor(() => {
      expect(screen.getByText(/Confirm with your verification code/)).toBeDefined();
    });
    // The raw "Retry failed" error must NOT be shown — the flow elevates instead.
    expect(screen.queryByText(/Retry failed:/)).toBeNull();
  });

  it('reuses the same Idempotency-Key across the step-up retry (CF-09)', async () => {
    // First call rejects with step-up, second (post-mint) resolves.
    adminMock.retryPayout
      .mockRejectedValueOnce(
        new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'Step-up required' }),
      )
      .mockResolvedValueOnce({
        result: { ...failedRow, state: 'pending' },
        audit: {
          actorUserId: 'admin',
          actorEmail: 'admin@loop.test',
          idempotencyKey: 'k',
          appliedAt: '2026-04-20T10:05:00.000Z',
          replayed: false,
        },
      });
    stepUpMock.requestOtp.mockResolvedValue(undefined);
    stepUpMock.mintAdminStepUp.mockResolvedValue({
      stepUpToken: 'tok',
      expiresAt: '2026-04-20T10:10:00.000Z',
    });

    await clickRetryWithReason('retry stuck payout');

    // Modal opens; send + confirm the code.
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
      expect(adminMock.retryPayout).toHaveBeenCalledTimes(2);
    });
    const firstArgs = adminMock.retryPayout.mock.calls[0]?.[0] as
      | { idempotencyKey?: string }
      | undefined;
    const secondArgs = adminMock.retryPayout.mock.calls[1]?.[0] as
      | { idempotencyKey?: string }
      | undefined;
    expect(firstArgs?.idempotencyKey).toBeDefined();
    // The retry must re-send the SAME key so ADR-017 dedup collapses it.
    expect(secondArgs?.idempotencyKey).toBe(firstArgs?.idempotencyKey);
  });
});
