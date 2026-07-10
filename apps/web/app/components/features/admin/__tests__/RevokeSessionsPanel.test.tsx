// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { useUiStore } from '~/stores/ui.store';
import { RevokeSessionsPanel } from '../RevokeSessionsPanel';

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
  adminMock: { revokeUserSessions: vi.fn() },
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
    revokeUserSessions: (userId: string) => adminMock.revokeUserSessions(userId),
  };
});

// Bypasses the getMe/useAuth resolution chain — this is a focused
// panel test, not a route integration test.
vi.mock('~/hooks/use-staff-role', () => ({
  useStaffRole: () => staffRoleMock.value,
}));

beforeEach(() => {
  adminMock.revokeUserSessions.mockReset();
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

function renderPanel(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RevokeSessionsPanel userId="user-1" userEmail="target@loop.test" />
    </QueryClientProvider>,
  );
}

/** Click the revoke button, then confirm the dialog. */
async function revokeAndConfirm(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Revoke all sessions/i }));
  });
  const openDialog = await waitFor(() => {
    const d = document.querySelector('dialog[open]');
    if (!(d instanceof HTMLElement)) throw new Error('no open dialog');
    return d;
  });
  const confirmButton = within(openDialog).getByRole('button', { name: 'Revoke sessions' });
  const form = confirmButton.closest('form');
  if (form === null) throw new Error('confirm dialog form not found');
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe('<RevokeSessionsPanel /> — gating', () => {
  it('self-hides for non-admin staff (support)', () => {
    staffRoleMock.value = {
      staffRole: 'support',
      isAdminRole: false,
      isStaff: true,
      isPending: false,
    };
    renderPanel();
    expect(screen.queryByText(/Sessions \(B4\)/i)).toBeNull();
  });

  it('renders for an admin', () => {
    renderPanel();
    expect(screen.getByText(/Sessions \(B4\)/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /Revoke all sessions/i })).toBeDefined();
  });
});

describe('<RevokeSessionsPanel /> — revoke flow', () => {
  it('revoke → confirm dialog → service called with userId → success toast', async () => {
    adminMock.revokeUserSessions.mockResolvedValue({
      userId: 'user-1',
      message: 'All sessions revoked',
    });
    renderPanel();
    await revokeAndConfirm();
    await waitFor(() => {
      expect(adminMock.revokeUserSessions).toHaveBeenCalledWith('user-1');
    });
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some(
            (t) =>
              t.type === 'success' && /All sessions revoked for target@loop\.test/i.test(t.message),
          ),
      ).toBe(true);
    });
  });

  it('cancelling the confirm dialog does not call the service', async () => {
    renderPanel();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Revoke all sessions/i }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(adminMock.revokeUserSessions).not.toHaveBeenCalled();
  });

  it('a service error lands as an error toast', async () => {
    adminMock.revokeUserSessions.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'Target user not found' }),
    );
    renderPanel();
    await revokeAndConfirm();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /Target user not found/i.test(t.message)),
      ).toBe(true);
    });
  });

  it('a non-ApiException error falls back to a generic toast', async () => {
    adminMock.revokeUserSessions.mockRejectedValue(new Error('network blip'));
    renderPanel();
    await revokeAndConfirm();
    await waitFor(() => {
      expect(
        useUiStore
          .getState()
          .toasts.some((t) => t.type === 'error' && /Failed to revoke sessions/i.test(t.message)),
      ).toBe(true);
    });
  });
});
