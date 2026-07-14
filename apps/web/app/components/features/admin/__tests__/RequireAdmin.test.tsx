// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as ReactRouter from 'react-router';
import type { UserMeView } from '@loop/shared';

/**
 * FE-10: auth-restore hydration flash.
 *
 * On a hard reload the access token (memory-only, never persisted) is
 * briefly null for an already-authenticated staff user while the
 * refresh-token restore is in flight. RequireStaff must render the
 * neutral loading spinner during that window — NOT the sign-in CTA —
 * and only fall through to sign-in once the boot-restore attempt has
 * completed (`restoreComplete`) and the user is genuinely unauthed.
 *
 * `isAuthenticated` is mocked via `~/hooks/use-auth` (the same seam
 * `admin.users.test.tsx` uses); `restoreComplete` is driven through the
 * REAL auth store so we exercise the actual store selector RequireStaff
 * reads. `getMe` supplies the /me staff role.
 */

const { authMock, navigateMock, meMock } = vi.hoisted(() => ({
  authMock: { isAuthenticated: false },
  navigateMock: vi.fn(),
  meMock: { value: null as UserMeView | null },
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// Keep the real auth store module importable in jsdom (it pulls in
// native secure-storage at load); the store's own state is driven
// directly via setState below.
vi.mock('~/native/secure-storage', () => ({
  storeRefreshToken: vi.fn(() => Promise.resolve()),
  storeEmail: vi.fn(() => Promise.resolve()),
  clearRefreshToken: vi.fn(() => Promise.resolve()),
  getRefreshToken: vi.fn(async () => null),
  getEmail: vi.fn(async () => null),
}));

import type * as UserModule from '~/services/user';
vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: vi.fn(async (): Promise<UserMeView> => {
      if (meMock.value === null) throw new Error('getMe called with no fixture set');
      return meMock.value;
    }),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof ReactRouter>('react-router');
  return { ...actual, useNavigate: () => navigateMock };
});

import { RequireAdmin } from '../RequireAdmin';
import { useAuthStore } from '~/stores/auth.store';

function meView(over: Partial<UserMeView>): UserMeView {
  return {
    id: 'u1',
    email: 'staff@loop.test',
    isAdmin: false,
    staffRole: null,
    homeCurrency: 'USD',
    stellarAddress: null,
    homeCurrencyBalanceMinor: '0',
    ...over,
  };
}

function renderGuard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RequireAdmin>
          <div>ADMIN CONTENT</div>
        </RequireAdmin>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authMock.isAuthenticated = false;
  meMock.value = null;
  navigateMock.mockReset();
  useAuthStore.setState({ email: null, accessToken: null, restoreComplete: false });
});

afterEach(() => {
  cleanup();
});

describe('RequireAdmin — FE-10 auth-restore flash', () => {
  it('shows the loading spinner (not sign-in) while session restore is still in flight', () => {
    // Cold reload: access token not yet restored → useAuth sees unauthed,
    // but the boot-restore attempt has NOT completed yet.
    authMock.isAuthenticated = false;
    useAuthStore.setState({ restoreComplete: false });

    renderGuard();

    // Neutral loading affordance is shown...
    expect(screen.getByRole('status')).toBeTruthy();
    // ...and the sign-in prompt must NOT flash during restore.
    expect(screen.queryByText('Sign in with a staff account.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
  });

  it('renders admin children once restore completes for an authenticated admin', async () => {
    authMock.isAuthenticated = true;
    useAuthStore.setState({ accessToken: 'at-restored', restoreComplete: true });
    meMock.value = meView({ isAdmin: true, staffRole: 'admin' });

    renderGuard();

    expect(await screen.findByText('ADMIN CONTENT')).toBeTruthy();
    expect(screen.queryByText('Sign in with a staff account.')).toBeNull();
  });

  it('renders the sign-in CTA once restore completes and the user is genuinely logged out', () => {
    // Restore ran, found no session → genuinely unauthenticated.
    authMock.isAuthenticated = false;
    useAuthStore.setState({ accessToken: null, restoreComplete: true });

    renderGuard();

    expect(screen.getByText('Sign in with a staff account.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    // No infinite spinner: a genuinely logged-out user must land on sign-in.
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders the not-authorized banner for an authenticated non-staff user after restore', async () => {
    authMock.isAuthenticated = true;
    useAuthStore.setState({ accessToken: 'at-restored', restoreComplete: true });
    meMock.value = meView({ isAdmin: false, staffRole: null });

    renderGuard();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Admin access required');
    expect(screen.queryByText('ADMIN CONTENT')).toBeNull();
    expect(screen.queryByText('Sign in with a staff account.')).toBeNull();
  });
});
