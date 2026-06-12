// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ApiException, type AdminWatcherSkipDetail, type AdminWatcherSkipRow } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import AdminSkipsRoute from '../admin.skips';

afterEach(cleanup);

// ui.store resolves the initial theme via window.matchMedia at module
// import time — jsdom doesn't implement it, so stub it before any
// import pulls the store in (vi.hoisted runs pre-import).
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
});

const { adminMock, authMock, userMock } = vi.hoisted(() => ({
  adminMock: {
    listWatcherSkips: vi.fn(),
    getWatcherSkip: vi.fn(),
    reopenWatcherSkip: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
  userMock: {
    staffRole: 'support' as 'admin' | 'support' | null,
    isAdmin: false,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    listWatcherSkips: (opts: unknown) => adminMock.listWatcherSkips(opts),
    getWatcherSkip: (id: string) => adminMock.getWatcherSkip(id),
    reopenWatcherSkip: (id: string) => adminMock.reopenWatcherSkip(id),
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

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

import type * as UserModule from '~/services/user';
vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: vi.fn(async () => ({
      id: 'u1',
      email: 'support@loop.test',
      isAdmin: userMock.isAdmin,
      staffRole: userMock.staffRole,
      homeCurrency: 'USD' as const,
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    })),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

beforeEach(() => {
  adminMock.listWatcherSkips.mockReset();
  adminMock.getWatcherSkip.mockReset();
  adminMock.reopenWatcherSkip.mockReset();
  authMock.isAuthenticated = true;
  userMock.staffRole = 'support';
  userMock.isAdmin = false;
  useUiStore.setState({ toasts: [] });

  // jsdom <dialog> polyfill (ConfirmDialog).
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

const abandonedRow: AdminWatcherSkipRow = {
  paymentId: 'pay-abandoned-1',
  memo: 'MEMO123',
  orderId: 'ord-1111',
  reason: 'processing_error',
  attempts: 5,
  status: 'abandoned',
  createdAt: '2026-06-10T08:00:00.000Z',
  updatedAt: '2026-06-11T08:00:00.000Z',
};

const pendingRow: AdminWatcherSkipRow = {
  paymentId: 'pay-pending-1',
  memo: 'MEMO456',
  orderId: null,
  reason: 'missing_credit_row',
  attempts: 1,
  status: 'pending',
  createdAt: '2026-06-11T09:00:00.000Z',
  updatedAt: '2026-06-11T09:00:00.000Z',
};

function renderAt(path = '/admin/skips'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/admin/skips" element={<AdminSkipsRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<AdminSkipsRoute />', () => {
  it('renders a spinner while the list loads', async () => {
    adminMock.listWatcherSkips.mockReturnValue(new Promise(() => undefined));
    renderAt();
    await waitFor(() => {
      expect(screen.getAllByRole('status').length).toBeGreaterThan(0);
    });
  });

  it('renders the empty state when no rows match', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ skips: [] });
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/No skip rows match/i)).toBeDefined();
    });
  });

  it('renders the error state when the list fetch fails', async () => {
    adminMock.listWatcherSkips.mockRejectedValue(
      new ApiException(503, { code: 'CIRCUIT_OPEN', message: 'down' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load watcher skips/i)).toBeDefined();
    });
  });

  it('renders rows with status pills; reopen only on abandoned rows', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ skips: [abandonedRow, pendingRow] });
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('MEMO123')).toBeDefined();
    });
    // The status words also appear in the header copy — assert the
    // row pills specifically.
    for (const status of ['abandoned', 'pending']) {
      expect(screen.getAllByText(status).some((el) => el.className.includes('rounded-full'))).toBe(
        true,
      );
    }
    // Exactly one row-level Reopen button — the abandoned row's
    // (the always-mounted ConfirmDialog holds the other). Support is
    // allowed this write (ADR 037 §3) so it renders for support too.
    const rowButtons = screen
      .getAllByRole('button', { name: 'Reopen' })
      .filter((b) => b.closest('dialog') === null);
    expect(rowButtons.length).toBe(1);
  });

  it('applies the status filter to the service call', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ skips: [abandonedRow] });
    renderAt('/admin/skips?status=abandoned');
    await waitFor(() => {
      expect(adminMock.listWatcherSkips).toHaveBeenCalledWith({
        status: 'abandoned',
        page: 1,
      });
    });
  });

  it('applies the reason filter to the service call', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ skips: [] });
    renderAt('/admin/skips?reason=asset_mismatch');
    await waitFor(() => {
      expect(adminMock.listWatcherSkips).toHaveBeenCalledWith({
        reason: 'asset_mismatch',
        page: 1,
      });
    });
  });

  it('reopen: confirm dialog → service called → success toast', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ skips: [abandonedRow] });
    adminMock.reopenWatcherSkip.mockResolvedValue({ reopened: true });
    renderAt();
    const reopenButton = await screen.findByRole('button', { name: 'Reopen' });
    await act(async () => {
      fireEvent.click(reopenButton);
    });
    // ConfirmDialog: submit its form to confirm. Two "Reopen"
    // buttons exist now (row + dialog confirm) — pick the dialog one.
    const dialogConfirm = screen
      .getAllByRole('button', { name: 'Reopen' })
      .find((b) => b.closest('dialog') !== null);
    const form = dialogConfirm?.closest('form');
    if (form === null || form === undefined) throw new Error('confirm form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(adminMock.reopenWatcherSkip).toHaveBeenCalledWith('pay-abandoned-1');
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /re-opened/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('cancelling the confirm dialog does not call the service', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ skips: [abandonedRow] });
    renderAt();
    const reopenButton = await screen.findByRole('button', { name: 'Reopen' });
    await act(async () => {
      fireEvent.click(reopenButton);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.reopenWatcherSkip).not.toHaveBeenCalled();
  });

  it('clicking a payment id loads the detail drawer with lastError + snapshot', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ skips: [abandonedRow] });
    adminMock.getWatcherSkip.mockResolvedValue({
      ...abandonedRow,
      payment: { amount: '5.0000000', asset_code: 'GBPLOOP' },
      lastError: 'markOrderPaid blew up',
    } satisfies AdminWatcherSkipDetail);
    renderAt();
    const idButton = await screen.findByRole('button', {
      name: /Toggle detail for skip pay-abandoned-1/i,
    });
    await act(async () => {
      fireEvent.click(idButton);
    });
    await waitFor(() => {
      expect(adminMock.getWatcherSkip).toHaveBeenCalledWith('pay-abandoned-1');
    });
    await waitFor(() => {
      expect(screen.getByText(/markOrderPaid blew up/)).toBeDefined();
    });
    expect(screen.getByText(/GBPLOOP/)).toBeDefined();
  });

  it('denies non-staff users at the shell gate', async () => {
    userMock.staffRole = null;
    userMock.isAdmin = false;
    renderAt();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Staff access required/i);
    });
    expect(adminMock.listWatcherSkips).not.toHaveBeenCalled();
  });
});
