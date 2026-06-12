// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import { ApiException, type AdminStaffMember } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import AdminStaffRoute from '../admin.staff';

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
    listAdminStaff: vi.fn(),
    setStaffRole: vi.fn(),
    revokeStaffRole: vi.fn(),
    getAdminUserByEmail: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
  userMock: {
    staffRole: 'admin' as 'admin' | 'support' | null,
    isAdmin: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    listAdminStaff: () => adminMock.listAdminStaff(),
    setStaffRole: (args: unknown) => adminMock.setStaffRole(args),
    revokeStaffRole: (args: unknown) => adminMock.revokeStaffRole(args),
    getAdminUserByEmail: (email: string) => adminMock.getAdminUserByEmail(email),
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
      id: 'admin-1',
      email: 'admin@loop.test',
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
  adminMock.listAdminStaff.mockReset();
  adminMock.setStaffRole.mockReset();
  adminMock.revokeStaffRole.mockReset();
  adminMock.getAdminUserByEmail.mockReset();
  authMock.isAuthenticated = true;
  userMock.staffRole = 'admin';
  userMock.isAdmin = true;
  useUiStore.setState({ toasts: [] });

  // jsdom <dialog> polyfill (ConfirmDialog / ReasonDialog / StepUpModal).
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

const supportMember: AdminStaffMember = {
  userId: 'u-support',
  email: 'sam@loop.test',
  role: 'support',
  grantedAt: '2026-06-10T10:00:00.000Z',
  grantedByUserId: 'admin-1',
  reason: 'support rotation',
};

const adminMember: AdminStaffMember = {
  userId: 'u-admin',
  email: 'ash@loop.test',
  role: 'admin',
  grantedAt: '2026-06-01T10:00:00.000Z',
  grantedByUserId: null,
  reason: null,
};

/** ADR-017 {result, audit} envelope helper — matches the backend. */
function envelope<T>(result: T, replayed = false): { result: T; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-06-12T10:00:00.000Z',
      replayed,
    },
  };
}

function renderAt(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/admin/staff']}>
        <Routes>
          <Route path="/admin/staff" element={<AdminStaffRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Resolve the email, fill role+reason, submit, and confirm the dialog. */
async function grantFlow(email: string, role: string, reason: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: /Email of the user to grant/i }), {
      target: { value: email },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Look up/i }));
  });
  await waitFor(() => {
    expect(screen.getByText(/Resolved:/i)).toBeDefined();
  });
  await act(async () => {
    fireEvent.change(screen.getByRole('combobox', { name: /Role to grant/i }), {
      target: { value: role },
    });
  });
  await act(async () => {
    fireEvent.change(screen.getByRole('textbox', { name: /Reason for the grant/i }), {
      target: { value: reason },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Grant role/i }));
  });
  // ConfirmDialog → submit its form. Both dialogs stay mounted, so
  // scope the query to the one that is actually open.
  const openDialog = await waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
    return d;
  });
  const confirm = within(openDialog).getByRole('button', { name: 'Grant' });
  const form = confirm.closest('form');
  if (form === null) throw new Error('confirm form not found');
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('<AdminStaffRoute /> — gate', () => {
  it('denies the support role — staff management is admin-only', async () => {
    userMock.staffRole = 'support';
    userMock.isAdmin = false;
    renderAt();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Admin access required/i);
    });
    expect(adminMock.listAdminStaff).not.toHaveBeenCalled();
  });

  it('denies non-staff users', async () => {
    userMock.staffRole = null;
    userMock.isAdmin = false;
    renderAt();
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/Admin access required/i);
    });
  });
});

describe('<AdminStaffRoute /> — list', () => {
  it('renders the staff list with role pills and migration-seeded grants', async () => {
    adminMock.listAdminStaff.mockResolvedValue({ staff: [supportMember, adminMember] });
    renderAt();
    await waitFor(() => {
      expect(screen.getByText('sam@loop.test')).toBeDefined();
    });
    expect(screen.getByText('ash@loop.test')).toBeDefined();
    // 'support' also appears in the page header copy — assert the
    // pill specifically.
    expect(screen.getAllByText('support').some((el) => el.className.includes('rounded-full'))).toBe(
      true,
    );
    // Null grantedByUserId renders as the migration seed marker.
    expect(screen.getByText('migration')).toBeDefined();
  });

  it('renders the empty state', async () => {
    adminMock.listAdminStaff.mockResolvedValue({ staff: [] });
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/No staff grants yet/i)).toBeDefined();
    });
  });

  it('renders the error state', async () => {
    adminMock.listAdminStaff.mockRejectedValue(
      new ApiException(503, { code: 'CIRCUIT_OPEN', message: 'down' }),
    );
    renderAt();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load the staff list/i)).toBeDefined();
    });
  });
});

describe('<AdminStaffRoute /> — grant', () => {
  it('email lookup resolves the userId, then grant calls the service with role + reason', async () => {
    adminMock.listAdminStaff.mockResolvedValue({ staff: [] });
    adminMock.getAdminUserByEmail.mockResolvedValue({
      id: 'u-new',
      email: 'jo@loop.test',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    adminMock.setStaffRole.mockResolvedValue(
      envelope({
        userId: 'u-new',
        role: 'support',
        grantedAt: '2026-06-12T10:00:00.000Z',
        grantedByUserId: 'admin-1',
        reason: 'onboarding',
      }),
    );
    renderAt();
    await screen.findByText(/No staff grants yet/i);
    await grantFlow('jo@loop.test', 'support', 'onboarding Jo to support');
    await waitFor(() => {
      expect(adminMock.setStaffRole).toHaveBeenCalledWith({
        userId: 'u-new',
        role: 'support',
        reason: 'onboarding Jo to support',
      });
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some(
            (t) => t.type === 'success' && /Granted support to jo@loop.test/i.test(t.message),
          ),
      ).toBe(true);
    });
  });

  it('shows "No user with that email." when the lookup 404s', async () => {
    adminMock.listAdminStaff.mockResolvedValue({ staff: [] });
    adminMock.getAdminUserByEmail.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'nope' }),
    );
    renderAt();
    await screen.findByText(/No staff grants yet/i);
    await act(async () => {
      fireEvent.change(screen.getByRole('textbox', { name: /Email of the user to grant/i }), {
        target: { value: 'ghost@loop.test' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Look up/i }));
    });
    await waitFor(() => {
      expect(screen.getByText(/No user with that email/i)).toBeDefined();
    });
    expect(adminMock.setStaffRole).not.toHaveBeenCalled();
  });

  it('opens the step-up modal when the grant bounces with STEP_UP_REQUIRED', async () => {
    adminMock.listAdminStaff.mockResolvedValue({ staff: [] });
    adminMock.getAdminUserByEmail.mockResolvedValue({
      id: 'u-new',
      email: 'jo@loop.test',
      isAdmin: false,
      homeCurrency: 'GBP',
      stellarAddress: null,
      ctxUserId: null,
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    adminMock.setStaffRole.mockRejectedValue(
      new ApiException(401, { code: 'STEP_UP_REQUIRED', message: 'step up' }),
    );
    renderAt();
    await screen.findByText(/No staff grants yet/i);
    await grantFlow('jo@loop.test', 'support', 'onboarding Jo to support');
    // useAdminStepUp intercepts the failure and mounts <StepUpModal />.
    await waitFor(() => {
      expect(screen.getByText(/Confirm with your verification code/i)).toBeDefined();
    });
  });
});

describe('<AdminStaffRoute /> — revoke', () => {
  it('revoke: reason dialog → service called → success toast', async () => {
    adminMock.listAdminStaff.mockResolvedValue({ staff: [supportMember] });
    adminMock.revokeStaffRole.mockResolvedValue(envelope({ userId: 'u-support', revoked: true }));
    renderAt();
    const revokeButton = await screen.findByRole('button', { name: 'Revoke' });
    await act(async () => {
      fireEvent.click(revokeButton);
    });
    // ReasonDialog: type the reason and submit its form. Scope to
    // the open dialog — the grant form's textboxes are also on-page.
    const openDialog = await waitFor(() => {
      const d = document.querySelector('dialog[open]');
      if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
      return d;
    });
    const textarea = within(openDialog).getByRole('textbox');
    await act(async () => {
      fireEvent.change(textarea, { target: { value: 'left the team' } });
    });
    const form = textarea.closest('form');
    if (form === null) throw new Error('reason dialog form not found');
    await act(async () => {
      fireEvent.submit(form);
    });
    await waitFor(() => {
      expect(adminMock.revokeStaffRole).toHaveBeenCalledWith({
        userId: 'u-support',
        reason: 'left the team',
      });
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'success' && /revoked/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('cancelling the reason dialog does not call the service', async () => {
    adminMock.listAdminStaff.mockResolvedValue({ staff: [supportMember] });
    renderAt();
    const revokeButton = await screen.findByRole('button', { name: 'Revoke' });
    await act(async () => {
      fireEvent.click(revokeButton);
    });
    const openDialog = await waitFor(() => {
      const d = document.querySelector('dialog[open]');
      if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
      return d;
    });
    await act(async () => {
      fireEvent.click(within(openDialog).getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.revokeStaffRole).not.toHaveBeenCalled();
  });
});
