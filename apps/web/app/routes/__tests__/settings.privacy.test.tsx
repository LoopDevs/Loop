// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';

const { userMock, authMock, navMock, nativePlatformMock, shareMock } = vi.hoisted(() => ({
  userMock: {
    downloadMyData: vi.fn(),
    getMyDataExport: vi.fn(),
    requestAccountDeletion: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
    logout: vi.fn(),
  },
  navMock: { navigate: vi.fn() },
  // W30-02 (2026-06-30 cold audit): mutable so individual tests can flip
  // to the native path without a second vi.mock factory per test file.
  nativePlatformMock: { isNative: false },
  shareMock: { shareJsonFile: vi.fn() },
}));

vi.mock('~/services/user', () => ({
  downloadMyData: () => userMock.downloadMyData(),
  getMyDataExport: () => userMock.getMyDataExport(),
  requestAccountDeletion: () => userMock.requestAccountDeletion(),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated, logout: authMock.logout }),
}));

// Web platform by default (anchor-download path); native-path tests
// flip `nativePlatformMock.isNative` in their own beforeEach/body.
vi.mock('~/hooks/use-native-platform', () => ({
  useNativePlatform: () => ({ platform: 'web', isNative: nativePlatformMock.isNative }),
}));

vi.mock('~/native/share', () => ({
  shareJsonFile: (...args: unknown[]) => shareMock.shareJsonFile(...args),
}));

vi.mock('react-router', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, useNavigate: () => navMock.navigate };
});

import SettingsPrivacyRoute from '../settings.privacy';

function renderPage(): ReturnType<typeof render> {
  return render(
    <MemoryRouter>
      <SettingsPrivacyRoute />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  authMock.isAuthenticated = true;
  authMock.logout.mockReset();
  authMock.logout.mockResolvedValue(undefined);
  navMock.navigate.mockReset();
  userMock.downloadMyData.mockReset();
  userMock.downloadMyData.mockResolvedValue(undefined);
  userMock.getMyDataExport.mockReset();
  userMock.requestAccountDeletion.mockReset();
  userMock.requestAccountDeletion.mockResolvedValue({ ok: true });
  nativePlatformMock.isNative = false;
  shareMock.shareJsonFile.mockReset();
  shareMock.shareJsonFile.mockResolvedValue(true);
});

afterEach(cleanup);

describe('SettingsPrivacyRoute', () => {
  it('shows a sign-in prompt when unauthenticated', () => {
    authMock.isAuthenticated = false;
    renderPage();
    expect(screen.getByText(/Sign in to export your data/i)).toBeTruthy();
  });

  it('triggers a data download and confirms it started', async () => {
    renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download my data/i }));
    });
    await waitFor(() => expect(userMock.downloadMyData).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('surfaces an export error', async () => {
    userMock.downloadMyData.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL_ERROR', message: 'Failed to build export' }),
    );
    renderPage();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Download my data/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Failed to build export');
  });

  it('keeps the delete button disabled until the confirm phrase is typed', async () => {
    renderPage();
    const button = screen.getByRole('button', { name: /Delete my account/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: 'DELETE' } });
    expect(button.disabled).toBe(false);
  });

  it('deletes the account, signs out, and navigates home', async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: 'DELETE' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Delete my account/i }));
    });
    await waitFor(() => expect(userMock.requestAccountDeletion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(authMock.logout).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(navMock.navigate).toHaveBeenCalledWith('/'));
  });

  it('renders the typed 409 block message and does not sign out', async () => {
    userMock.requestAccountDeletion.mockRejectedValue(
      new ApiException(409, { code: 'PENDING_PAYOUTS', message: 'payout in flight' }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: 'DELETE' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Delete my account/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/payout in flight/i);
    expect(authMock.logout).not.toHaveBeenCalled();
  });

  it('renders the BALANCE_NOT_ZERO block message (PLAT-30-03)', async () => {
    userMock.requestAccountDeletion.mockRejectedValue(
      new ApiException(409, { code: 'BALANCE_NOT_ZERO', message: 'balance not zero' }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText(/Type/i), { target: { value: 'DELETE' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Delete my account/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/unredeemed cashback balance/i);
    expect(authMock.logout).not.toHaveBeenCalled();
  });

  // W30-02 (2026-06-30 cold audit): native export used to only
  // console.log the payload — invisible to a real user. These pin the
  // fixed behavior: shareJsonFile is called instead, and the UI
  // reflects success/failure correctly.
  describe('native export (W30-02)', () => {
    beforeEach(() => {
      nativePlatformMock.isNative = true;
      userMock.getMyDataExport.mockResolvedValue({ schemaVersion: 1 });
    });

    it('calls shareJsonFile with the export payload instead of console.log', async () => {
      renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Download my data/i }));
      });
      await waitFor(() => expect(shareMock.shareJsonFile).toHaveBeenCalledTimes(1));
      expect(userMock.downloadMyData).not.toHaveBeenCalled();
      const [filename, payload, shareText] = shareMock.shareJsonFile.mock.calls[0]!;
      expect(filename).toMatch(/^loop-data-export-\d{4}-\d{2}-\d{2}\.json$/);
      expect(payload).toEqual({ schemaVersion: 1 });
      expect(shareText).toEqual(expect.objectContaining({ title: expect.any(String) }));
      const status = await screen.findByRole('status');
      expect(status.textContent).toMatch(/share sheet/i);
    });

    it('surfaces an error when shareJsonFile returns false (share sheet failed/cancelled)', async () => {
      shareMock.shareJsonFile.mockResolvedValue(false);
      renderPage();
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /Download my data/i }));
      });
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toMatch(/couldn't prepare your data/i);
    });
  });
});
