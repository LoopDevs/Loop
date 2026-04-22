// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';

const { adminMock, authMock, navigateMock } = vi.hoisted(() => ({
  adminMock: {
    listAdminUsers: vi.fn(),
    getAdminUserByEmail: vi.fn(),
    getTopUsers: vi.fn(),
  },
  authMock: { isAuthenticated: true },
  navigateMock: vi.fn(),
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    listAdminUsers: () => adminMock.listAdminUsers(),
    getAdminUserByEmail: (email: string) => adminMock.getAdminUserByEmail(email),
    getTopUsers: () => adminMock.getTopUsers(),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

vi.mock('react-router', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

import AdminUsersRoute from '../admin.users';

function renderPage(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AdminUsersRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  adminMock.listAdminUsers.mockReset();
  adminMock.getAdminUserByEmail.mockReset();
  adminMock.getTopUsers.mockReset();
  navigateMock.mockReset();
  adminMock.listAdminUsers.mockResolvedValue({ users: [] });
  adminMock.getTopUsers.mockResolvedValue({ since: '2026-04-01T00:00:00Z', rows: [] });
});

afterEach(cleanup);

describe('AdminUsersRoute — find-by-email', () => {
  it('renders the by-email lookup form with disabled submit until input is non-empty', async () => {
    renderPage();
    const input = (await screen.findByLabelText(/Find user by exact email/i)) as HTMLInputElement;
    const submit = screen.getByRole('button', { name: /Find by email/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'alice@example.com' } });
    expect(submit.disabled).toBe(false);
  });

  it('navigates to /admin/users/:id on successful lookup', async () => {
    adminMock.getAdminUserByEmail.mockResolvedValue({
      id: 'u-42',
      email: 'alice@example.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: '2026-01-10T00:00:00Z',
      updatedAt: '2026-04-18T12:00:00Z',
    });
    renderPage();
    const input = (await screen.findByLabelText(/Find user by exact email/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alice@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Find by email/i }));
    });
    await waitFor(() =>
      expect(adminMock.getAdminUserByEmail).toHaveBeenCalledWith('alice@example.com'),
    );
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith('/admin/users/u-42'));
  });

  it('trims whitespace around pasted emails before submit', async () => {
    adminMock.getAdminUserByEmail.mockResolvedValue({
      id: 'u-42',
      email: 'alice@example.com',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: '2026-01-10T00:00:00Z',
      updatedAt: '2026-04-18T12:00:00Z',
    });
    renderPage();
    const input = (await screen.findByLabelText(/Find user by exact email/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  alice@example.com  ' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Find by email/i }));
    });
    await waitFor(() =>
      expect(adminMock.getAdminUserByEmail).toHaveBeenCalledWith('alice@example.com'),
    );
  });

  it('renders a no-user message on 404', async () => {
    adminMock.getAdminUserByEmail.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'No user with that email' }),
    );
    renderPage();
    const input = (await screen.findByLabelText(/Find user by exact email/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'ghost@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Find by email/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/No user with that email/i);
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it('renders the ApiException message on non-404 errors (e.g. 500 from the server)', async () => {
    adminMock.getAdminUserByEmail.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL_ERROR', message: 'Failed to look up user' }),
    );
    renderPage();
    const input = (await screen.findByLabelText(/Find user by exact email/i)) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'alice@example.com' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Find by email/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed to look up user');
  });
});
