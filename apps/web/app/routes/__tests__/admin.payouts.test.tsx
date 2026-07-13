// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as AdminModule from '~/services/admin';
import type { AdminPayoutView } from '~/services/admin';
import AdminPayoutsRoute from '../admin.payouts';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    listPayouts: vi.fn(),
    retryPayout: vi.fn(),
  },
  authMock: { isAuthenticated: true },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    listPayouts: (opts: unknown) => adminMock.listPayouts(opts),
    retryPayout: (args: unknown) => adminMock.retryPayout(args),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// A2-1101 / ADR 037: RequireStaff + useStaffRole gate on /api/users/me.
// `isAdmin: true` resolves to the admin role, which is what surfaces the
// money-write Retry button.
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

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

// jsdom ships no <dialog> impl: polyfill the minimum surface ReasonDialog
// exercises so the reason prompt opens / closes.
beforeEach(() => {
  const proto = HTMLDialogElement.prototype as unknown as {
    showModal?: () => void;
    close?: () => void;
  };
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
  adminMock.listPayouts.mockReset();
  adminMock.retryPayout.mockReset();
});

function failedRow(id: string, lastError: string): AdminPayoutView {
  return {
    id,
    userId: '11111111-1111-1111-1111-111111111111',
    orderId: `order-${id}`,
    kind: 'order_cashback',
    assetCode: 'GBPLOOP',
    assetIssuer: 'GISSUER',
    toAddress: `Gdest-${id}`,
    amountStroops: '12500000',
    memoText: `order-${id}`,
    state: 'failed',
    txHash: null,
    lastError,
    attempts: 1,
    createdAt: '2026-04-20T10:00:00.000Z',
    submittedAt: '2026-04-20T10:01:00.000Z',
    confirmedAt: null,
    failedAt: '2026-04-20T10:03:00.000Z',
  };
}

function renderRoute(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/payouts']}>
        <Routes>
          <Route path="/admin/payouts" element={<AdminPayoutsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Drive a row's Retry button through the ReasonDialog to the mutate call.
async function retryRow(row: HTMLElement, reason: string): Promise<void> {
  await act(async () => {
    fireEvent.click(within(row).getByRole('button'));
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

describe('<AdminPayoutsRoute /> per-row retry state (FE-12)', () => {
  it('keeps row A loading/disabled while a concurrent retry on row B starts', async () => {
    adminMock.listPayouts.mockResolvedValue({
      payouts: [failedRow('aaaa', 'error-on-row-A'), failedRow('bbbb', 'error-on-row-B')],
    });
    // Never settles: both retries stay in flight for the duration of the
    // test so we can observe two rows loading simultaneously.
    adminMock.retryPayout.mockReturnValue(new Promise<never>(() => {}));

    renderRoute();

    const rowA = (await screen.findByText('error-on-row-A')).closest('tr');
    const rowB = (await screen.findByText('error-on-row-B')).closest('tr');
    if (rowA === null || rowB === null) throw new Error('failed rows not found');

    // Start retry on A, then — before A resolves — on B.
    await retryRow(rowA, 'retry stuck payout A');
    await retryRow(rowB, 'retry stuck payout B');

    const btnA = within(rowA).getByRole('button') as HTMLButtonElement;
    const btnB = within(rowB).getByRole('button') as HTMLButtonElement;

    // The single-scalar bug: starting B overwrote the tracked id, so A's
    // button reverted to an enabled "Retry" mid-flight (double-submit).
    // Each row must independently reflect its own in-flight state.
    expect(btnA.textContent).toContain('Retrying');
    expect(btnA.disabled).toBe(true);
    expect(btnB.textContent).toContain('Retrying');
    expect(btnB.disabled).toBe(true);

    // Both requests were dispatched, one per row.
    expect(adminMock.retryPayout).toHaveBeenCalledTimes(2);
    const ids = adminMock.retryPayout.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(new Set(ids)).toEqual(new Set(['aaaa', 'bbbb']));
  });
});
