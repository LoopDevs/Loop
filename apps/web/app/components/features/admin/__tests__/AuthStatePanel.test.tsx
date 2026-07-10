// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException, type AdminUserAuthStateResponse } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { AuthStatePanel } from '../AuthStatePanel';

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

const { adminMock, staffRoleMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserAuthState: vi.fn(),
    clearAdminOtpLockout: vi.fn(),
  },
  staffRoleMock: {
    value: {
      staffRole: 'admin' as 'admin' | 'support' | null,
      isAdminRole: true,
      isStaff: true,
      isPending: false,
    },
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserAuthState: (userId: string) => adminMock.getAdminUserAuthState(userId),
    clearAdminOtpLockout: (args: unknown) => adminMock.clearAdminOtpLockout(args),
  };
});

// Bypasses the getMe/useAuth resolution chain — this is a focused
// panel test, not a route integration test (same pattern as
// RevokeSessionsPanel.test.tsx).
vi.mock('~/hooks/use-staff-role', () => ({
  useStaffRole: () => staffRoleMock.value,
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

beforeEach(() => {
  adminMock.getAdminUserAuthState.mockReset();
  adminMock.clearAdminOtpLockout.mockReset();
  staffRoleMock.value = {
    staffRole: 'admin',
    isAdminRole: true,
    isStaff: true,
    isPending: false,
  };
  useUiStore.setState({ toasts: [] });

  // jsdom doesn't ship a complete <dialog> implementation.
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

const notLocked: AdminUserAuthStateResponse = {
  userId: 'user-1',
  otpLock: { locked: false, lockedUntil: null, failedAttempts: 0 },
  lastOtpRequestedAt: null,
  lastOtpVerifiedAt: null,
  activeSessionCount: 0,
};

const locked: AdminUserAuthStateResponse = {
  userId: 'user-1',
  otpLock: {
    locked: true,
    lockedUntil: '2026-07-08T12:15:00.000Z',
    failedAttempts: 10,
  },
  lastOtpRequestedAt: '2026-07-08T12:00:00.000Z',
  lastOtpVerifiedAt: '2026-06-01T09:00:00.000Z',
  activeSessionCount: 2,
};

/** ADR-017-lite {result, audit} envelope helper — matches the backend. */
function envelope<T>(result: T, replayed = false): { result: T; audit: Record<string, unknown> } {
  return {
    result,
    audit: {
      actorUserId: 'admin-1',
      actorEmail: 'admin@loop.test',
      idempotencyKey: 'k'.repeat(32),
      appliedAt: '2026-07-08T12:20:00.000Z',
      replayed,
    },
  };
}

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AuthStatePanel userId="user-1" userEmail="target@loop.test" />
    </QueryClientProvider>,
  );
}

/** Click clear-lockout, type a reason, submit the dialog form. */
async function clearLockoutWithReason(
  reason = 'fat-fingered code, support ticket #7',
): Promise<void> {
  const trigger = await screen.findByRole('button', { name: /Clear OTP lockout/i });
  await act(async () => {
    fireEvent.click(trigger);
  });
  const openDialog = await waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
    return d;
  });
  const textarea = within(openDialog).getByRole('textbox');
  await act(async () => {
    fireEvent.change(textarea, { target: { value: reason } });
  });
  const form = textarea.closest('form');
  if (form === null) throw new Error('reason dialog form not found');
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('<AuthStatePanel /> — read state', () => {
  it('shows a spinner while auth state loads', () => {
    adminMock.getAdminUserAuthState.mockReturnValue(new Promise(() => undefined));
    renderPanel();
    expect(screen.getByRole('status')).toBeDefined();
  });

  it('renders an error line when the fetch fails', async () => {
    adminMock.getAdminUserAuthState.mockRejectedValue(
      new ApiException(503, { code: 'INTERNAL_ERROR', message: 'down' }),
    );
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load auth state/i)).toBeDefined();
    });
  });

  it('renders the "not locked" badge and empty-state dashes', async () => {
    adminMock.getAdminUserAuthState.mockResolvedValue(notLocked);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('not locked')).toBeDefined();
    });
    // Both failedAttempts and activeSessionCount render "0" — assert
    // the count rather than a single ambiguous text match.
    expect(screen.getAllByText('0')).toHaveLength(2);
    expect(screen.getAllByText('—')).toHaveLength(3); // lockedUntil + both timestamps
  });

  it('renders the "locked" badge, lockedUntil, failedAttempts, timestamps, and session count', async () => {
    adminMock.getAdminUserAuthState.mockResolvedValue(locked);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('locked')).toBeDefined();
    });
    expect(screen.getByText('10')).toBeDefined();
    expect(screen.getByText('2')).toBeDefined();
  });
});

describe('<AuthStatePanel /> — clear-lockout gating', () => {
  it('self-hides the clear-lockout button for non-admin staff (support), read state still renders', async () => {
    staffRoleMock.value = {
      staffRole: 'support',
      isAdminRole: false,
      isStaff: true,
      isPending: false,
    };
    adminMock.getAdminUserAuthState.mockResolvedValue(locked);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByText('locked')).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: /Clear OTP lockout/i })).toBeNull();
  });

  it('renders the clear-lockout button for an admin', async () => {
    adminMock.getAdminUserAuthState.mockResolvedValue(locked);
    renderPanel();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Clear OTP lockout/i })).toBeDefined();
    });
  });
});

describe('<AuthStatePanel /> — clear-lockout flow', () => {
  it('reason dialog → clear-lockout service called with userId + reason → success toast', async () => {
    adminMock.getAdminUserAuthState.mockResolvedValue(locked);
    adminMock.clearAdminOtpLockout.mockResolvedValue(
      envelope({ userId: 'user-1', wasLocked: true, cleared: true }),
    );
    renderPanel();
    await clearLockoutWithReason();
    await waitFor(() => {
      expect(adminMock.clearAdminOtpLockout).toHaveBeenCalledWith({
        userId: 'user-1',
        reason: 'fat-fingered code, support ticket #7',
      });
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => /OTP lockout cleared for target@loop\.test/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('reports "nothing to clear" when the account was not actually locked', async () => {
    adminMock.getAdminUserAuthState.mockResolvedValue(notLocked);
    adminMock.clearAdminOtpLockout.mockResolvedValue(
      envelope({ userId: 'user-1', wasLocked: false, cleared: true }),
    );
    renderPanel();
    await clearLockoutWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => /was not locked — nothing to clear/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('cancelling the reason dialog does not call the service', async () => {
    adminMock.getAdminUserAuthState.mockResolvedValue(locked);
    renderPanel();
    const trigger = await screen.findByRole('button', { name: /Clear OTP lockout/i });
    await act(async () => {
      fireEvent.click(trigger);
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.clearAdminOtpLockout).not.toHaveBeenCalled();
  });

  it('surfaces a clear-lockout failure as an error toast', async () => {
    adminMock.getAdminUserAuthState.mockResolvedValue(locked);
    adminMock.clearAdminOtpLockout.mockRejectedValue(
      new ApiException(404, { code: 'USER_NOT_FOUND', message: 'Target user not found' }),
    );
    renderPanel();
    await clearLockoutWithReason();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /Target user not found/i.test(t.message)),
      ).toBe(true);
    });
  });
});
