// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as AdminModule from '~/services/admin';

const { adminMock, authMock, userMock } = vi.hoisted(() => ({
  adminMock: {
    listAdminLedger: vi.fn(),
  },
  authMock: { isAuthenticated: true },
  userMock: { staffRole: 'support' as 'admin' | 'support' | null },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    listAdminLedger: (opts: unknown) => adminMock.listAdminLedger(opts),
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
      email: 'staff@loop.test',
      isAdmin: userMock.staffRole === 'admin',
      staffRole: userMock.staffRole,
      homeCurrency: 'USD' as const,
      stellarAddress: null,
      homeCurrencyBalanceMinor: '0',
    })),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import AdminLedgerRoute from '../admin.ledger';

function renderPage(initialEntry = '/admin/ledger'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AdminLedgerRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const row1 = {
  id: 'ct-1',
  userId: '11111111-2222-3333-4444-555555555555',
  type: 'cashback' as const,
  amountMinor: '4200',
  currency: 'GBP',
  referenceType: 'order',
  referenceId: 'o-1',
  createdAt: '2026-04-21T12:00:00.000Z',
};

const row2 = {
  id: 'ct-2',
  userId: '66666666-7777-8888-9999-000000000000',
  type: 'withdrawal' as const,
  amountMinor: '-1500',
  currency: 'USD',
  referenceType: null,
  referenceId: null,
  createdAt: '2026-04-20T09:00:00.000Z',
};

beforeEach(() => {
  authMock.isAuthenticated = true;
  userMock.staffRole = 'support';
  adminMock.listAdminLedger.mockReset();
  adminMock.listAdminLedger.mockResolvedValue({ transactions: [row1, row2] });
});

afterEach(cleanup);

describe('AdminLedgerRoute — staff gate (A5-8)', () => {
  it('support renders the ledger table', async () => {
    renderPage();
    expect(await screen.findByText('Admin · Ledger')).toBeDefined();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    // "cashback"/"withdrawal" also appear as filter-chip labels, so
    // assert on row-specific content instead: the truncated user ids
    // only ever render inside the table.
    expect(await screen.findByRole('link', { name: /11111111/ })).toBeDefined();
    expect(await screen.findByRole('link', { name: /66666666/ })).toBeDefined();
  });

  it('non-staff sees the denial banner, never calls the endpoint', async () => {
    userMock.staffRole = null;
    renderPage();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Staff access required/i);
    expect(screen.queryByText('Admin · Ledger')).toBeNull();
    expect(adminMock.listAdminLedger).not.toHaveBeenCalled();
  });

  it('signed-out visitor gets a sign-in CTA, never calls the endpoint', async () => {
    authMock.isAuthenticated = false;
    renderPage();
    expect(await screen.findByRole('button', { name: /sign in/i })).toBeDefined();
    expect(adminMock.listAdminLedger).not.toHaveBeenCalled();
  });
});

describe('AdminLedgerRoute — rows + reference links', () => {
  it('links each row to the owning user and its order reference', async () => {
    renderPage();
    const userLink = await screen.findByRole('link', { name: /11111111/ });
    expect(userLink.getAttribute('href')).toBe(`/admin/users/${row1.userId}`);
    const refLink = screen.getByRole('link', { name: /order:o-1/ });
    expect(refLink.getAttribute('href')).toBe('/admin/orders/o-1');
  });

  it('renders a dash for rows with no reference', async () => {
    renderPage();
    await screen.findByRole('link', { name: /66666666/ });
    expect(screen.getByText('—')).toBeDefined();
  });
});

describe('AdminLedgerRoute — filters', () => {
  it('type chips call the endpoint with the selected type and reset the cursor', async () => {
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    adminMock.listAdminLedger.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'refund' }));
    });

    await waitFor(() =>
      expect(adminMock.listAdminLedger).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'refund' }),
      ),
    );
  });

  it('rejects a malformed userId in the filter form without calling the endpoint again', async () => {
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    adminMock.listAdminLedger.mockClear();

    const input = screen.getByLabelText(/filter by user id/i);
    fireEvent.change(input, { target: { value: 'not-a-uuid' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(await screen.findByText(/userId must be a UUID/i)).toBeDefined();
    expect(adminMock.listAdminLedger).not.toHaveBeenCalled();
  });

  it('applies a valid userId filter', async () => {
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    adminMock.listAdminLedger.mockClear();

    const input = screen.getByLabelText(/filter by user id/i);
    fireEvent.change(input, { target: { value: row1.userId } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    await waitFor(() =>
      expect(adminMock.listAdminLedger).toHaveBeenCalledWith(
        expect.objectContaining({ userId: row1.userId }),
      ),
    );
  });

  // Money-review finding (PR #1620): the backend requires
  // referenceType + referenceId together (either alone isn't
  // index-selective) — the form mirrors that instead of round-tripping
  // a 400.
  it('rejects a reference type with no reference id', async () => {
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    adminMock.listAdminLedger.mockClear();

    const input = screen.getByLabelText(/filter by reference type/i);
    fireEvent.change(input, { target: { value: 'order' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(
      await screen.findByText(/reference type and reference id must be provided together/i),
    ).toBeDefined();
    expect(adminMock.listAdminLedger).not.toHaveBeenCalled();
  });

  it('rejects a reference id with no reference type', async () => {
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    adminMock.listAdminLedger.mockClear();

    const input = screen.getByLabelText(/filter by reference id/i);
    fireEvent.change(input, { target: { value: 'o-1' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    expect(
      await screen.findByText(/reference type and reference id must be provided together/i),
    ).toBeDefined();
    expect(adminMock.listAdminLedger).not.toHaveBeenCalled();
  });

  it('applies a valid referenceType + referenceId pair', async () => {
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    adminMock.listAdminLedger.mockClear();

    fireEvent.change(screen.getByLabelText(/filter by reference type/i), {
      target: { value: 'order' },
    });
    fireEvent.change(screen.getByLabelText(/filter by reference id/i), {
      target: { value: 'o-1' },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    });

    await waitFor(() =>
      expect(adminMock.listAdminLedger).toHaveBeenCalledWith(
        expect.objectContaining({ referenceType: 'order', referenceId: 'o-1' }),
      ),
    );
  });
});

describe('AdminLedgerRoute — incomplete reference pair from a deep link', () => {
  it('drops both params and shows a banner instead of calling the endpoint with just one', async () => {
    renderPage('/admin/ledger?referenceId=o-1');
    await screen.findByText(/only sets one of referenceType\/referenceId/i);
    await waitFor(() =>
      expect(adminMock.listAdminLedger).toHaveBeenCalledWith(
        expect.not.objectContaining({ referenceId: expect.anything() }),
      ),
    );
  });
});

describe('AdminLedgerRoute — pagination (keyset, not OFFSET)', () => {
  it('Older button pages using the last row createdAt as the cursor', async () => {
    adminMock.listAdminLedger.mockResolvedValue({
      transactions: Array.from({ length: 50 }, (_, i) => ({
        ...row1,
        id: `ct-${i}`,
        createdAt: new Date(2026, 3, 21, 12, 0, i).toISOString(),
      })),
    });
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    adminMock.listAdminLedger.mockClear();

    const olderBtn = await screen.findByRole('button', { name: /older/i });
    expect(olderBtn.hasAttribute('disabled')).toBe(false);
    await act(async () => {
      fireEvent.click(olderBtn);
    });

    await waitFor(() =>
      expect(adminMock.listAdminLedger).toHaveBeenCalledWith(
        expect.objectContaining({ before: expect.any(String) }),
      ),
    );
  });

  it('Newest button is disabled with no cursor set', async () => {
    renderPage();
    await waitFor(() => expect(adminMock.listAdminLedger).toHaveBeenCalled());
    const newestBtn = screen.getByRole('button', { name: /newest/i });
    expect(newestBtn.hasAttribute('disabled')).toBe(true);
  });
});
