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
    refundDeposit: vi.fn(),
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
    reopenWatcherSkip: (args: unknown) => adminMock.reopenWatcherSkip(args),
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

// `refundDeposit` is imported into the route directly from
// `~/services/admin-watcher-skips`, so mock that module (not the barrel).
import type * as WatcherSkipsModule from '~/services/admin-watcher-skips';
vi.mock('~/services/admin-watcher-skips', async (importActual) => {
  const actual = (await importActual()) as typeof WatcherSkipsModule;
  return {
    ...actual,
    refundDeposit: (args: unknown) => adminMock.refundDeposit(args),
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
  adminMock.refundDeposit.mockReset();
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
  lastError: 'markOrderPaid blew up',
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
  lastError: null,
  createdAt: '2026-06-11T09:00:00.000Z',
  updatedAt: '2026-06-11T09:00:00.000Z',
};

/** ADR-017 {result, audit} envelope helper — matches the backend. */
function envelope<T>(result: T, replayed = false): { result: T; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'staff-1',
      actorEmail: 'support@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-06-12T10:00:00.000Z',
      replayed,
    },
  };
}

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
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [] });
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
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [abandonedRow, pendingRow] });
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
    // (the always-mounted ReasonDialog holds the other). Support is
    // allowed this write (ADR 037 §3) so it renders for support too.
    const rowButtons = screen
      .getAllByRole('button', { name: 'Reopen' })
      .filter((b) => b.closest('dialog') === null);
    expect(rowButtons.length).toBe(1);
  });

  it('applies the status filter to the service call', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [abandonedRow] });
    renderAt('/admin/skips?status=abandoned');
    await waitFor(() => {
      expect(adminMock.listWatcherSkips).toHaveBeenCalledWith({
        status: 'abandoned',
        limit: 20,
      });
    });
  });

  it('applies the reason filter to the service call', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [] });
    renderAt('/admin/skips?reason=asset_mismatch');
    await waitFor(() => {
      expect(adminMock.listWatcherSkips).toHaveBeenCalledWith({
        reason: 'asset_mismatch',
        limit: 20,
      });
    });
  });

  it('reopen: reason dialog → service called with paymentId + reason → success toast', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [abandonedRow] });
    adminMock.reopenWatcherSkip.mockResolvedValue(
      envelope({
        paymentId: 'pay-abandoned-1',
        priorStatus: 'abandoned',
        status: 'pending',
        attempts: 0,
      }),
    );
    renderAt();
    const reopenButton = await screen.findByRole('button', { name: 'Reopen' });
    await act(async () => {
      fireEvent.click(reopenButton);
    });
    // ReasonDialog (ADR 017 — the reopen carries an audited reason):
    // type the reason into the dialog's textarea and submit its form.
    const openDialog = await waitFor(() => {
      const d = document.querySelector('dialog[open]');
      if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
      return d;
    });
    const textarea = openDialog.querySelector('textarea');
    if (textarea === null) throw new Error('reason textarea not found');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'deposit re-sent — OPS-7' } });
    });
    const form = textarea.closest('form');
    if (form === null) throw new Error('reason dialog form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(adminMock.reopenWatcherSkip).toHaveBeenCalledWith({
        paymentId: 'pay-abandoned-1',
        reason: 'deposit re-sent — OPS-7',
      });
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /re-opened/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('refund (admin): reason dialog → refundDeposit called with reason + Idempotency-Key → reads envelope result', async () => {
    userMock.staffRole = 'admin';
    userMock.isAdmin = true;
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [abandonedRow] });
    adminMock.refundDeposit.mockResolvedValue(
      envelope({ paymentId: 'pay-abandoned-1', status: 'refunded', txHash: 'deadbeefcafebabe' }),
    );
    renderAt();
    // Two 'Refund'-named buttons exist: the row action + the always-
    // mounted refund ReasonDialog's confirm button. Grab the row one
    // (not inside a <dialog>).
    const refundButton = await waitFor(() => {
      const rowBtns = screen
        .getAllByRole('button', { name: 'Refund' })
        .filter((b) => b.closest('dialog') === null);
      if (rowBtns.length !== 1)
        throw new Error(`expected 1 row refund button, got ${rowBtns.length}`);
      return rowBtns[0] as HTMLElement;
    });
    await act(async () => {
      fireEvent.click(refundButton);
    });
    // ReasonDialog (ADR-017 — the refund now carries an audited reason):
    // type the reason into the open dialog's textarea and submit.
    const openDialog = await waitFor(() => {
      const d = document.querySelector('dialog[open]');
      if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
      return d;
    });
    const textarea = openDialog.querySelector('textarea');
    if (textarea === null) throw new Error('reason textarea not found');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'sender confirmed — OPS-11' } });
    });
    const form = textarea.closest('form');
    if (form === null) throw new Error('reason dialog form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(adminMock.refundDeposit).toHaveBeenCalledTimes(1);
    });
    const args = adminMock.refundDeposit.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args['paymentId']).toBe('pay-abandoned-1');
    expect(args['reason']).toBe('sender confirmed — OPS-11');
    // Idempotency key minted at mutate-time (CF-09: stable across a
    // step-up retry of the same closure).
    expect(typeof args['idempotencyKey']).toBe('string');
    expect((args['idempotencyKey'] as string).length).toBeGreaterThan(0);
    // Success toast reads `.result` off the {result, audit} envelope.
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /refunded to sender/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('cancelling the reason dialog does not call the service', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [abandonedRow] });
    renderAt();
    const reopenButton = await screen.findByRole('button', { name: 'Reopen' });
    await act(async () => {
      fireEvent.click(reopenButton);
    });
    // Two ReasonDialogs are mounted (reopen + refund), each with a
    // Cancel button — click the Cancel inside the OPEN one.
    const openDialog = await waitFor(() => {
      const d = document.querySelector('dialog[open]');
      if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
      return d;
    });
    const cancelButton = Array.from(openDialog.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Cancel',
    );
    if (cancelButton === undefined) throw new Error('cancel button not found');
    await act(async () => {
      fireEvent.click(cancelButton);
    });
    expect(adminMock.reopenWatcherSkip).not.toHaveBeenCalled();
  });

  it('clicking a payment id loads the detail drawer with lastError + snapshot', async () => {
    adminMock.listWatcherSkips.mockResolvedValue({ rows: [abandonedRow] });
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
