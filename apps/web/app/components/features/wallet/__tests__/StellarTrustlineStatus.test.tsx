// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { StellarTrustlineStatus } from '../StellarTrustlineStatus';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: { getUserStellarTrustlines: vi.fn() },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserStellarTrustlines: () => userMock.getUserStellarTrustlines(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderStatus(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <StellarTrustlineStatus />
    </QueryClientProvider>,
  );
  return container;
}

const STUB_ROW_PRESENT = {
  code: 'USDLOOP' as const,
  issuer: 'GUSD',
  present: true,
  balanceStroops: '0',
  limitStroops: '0',
};
const STUB_ROW_ABSENT = { ...STUB_ROW_PRESENT, present: false };

describe('<StellarTrustlineStatus />', () => {
  it('self-hides when no wallet is linked', async () => {
    userMock.getUserStellarTrustlines.mockResolvedValue({
      address: null,
      accountLinked: false,
      accountExists: false,
      rows: [STUB_ROW_ABSENT],
    });
    const container = renderStatus();
    await waitFor(() => {
      expect(userMock.getUserStellarTrustlines).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });

  it('shows amber "wallet not funded" when accountExists=false', async () => {
    userMock.getUserStellarTrustlines.mockResolvedValue({
      address: 'GUSER',
      accountLinked: true,
      accountExists: false,
      rows: [STUB_ROW_ABSENT],
    });
    renderStatus();
    await waitFor(() => {
      expect(screen.getByText('Wallet not funded')).toBeDefined();
    });
    expect(screen.getByText(/XLM reserve/i)).toBeDefined();
  });

  it('names missing trustline codes when some are absent', async () => {
    userMock.getUserStellarTrustlines.mockResolvedValue({
      address: 'GUSER',
      accountLinked: true,
      accountExists: true,
      rows: [
        STUB_ROW_PRESENT,
        { ...STUB_ROW_ABSENT, code: 'GBPLOOP' as const, issuer: 'GGBP' },
        { ...STUB_ROW_ABSENT, code: 'EURLOOP' as const, issuer: 'GEUR' },
      ],
    });
    renderStatus();
    await waitFor(() => {
      expect(screen.getByText(/Missing trustlines/)).toBeDefined();
    });
    expect(screen.getByText('GBPLOOP, EURLOOP')).toBeDefined();
  });

  it('pluralises correctly for a single missing trustline', async () => {
    userMock.getUserStellarTrustlines.mockResolvedValue({
      address: 'GUSER',
      accountLinked: true,
      accountExists: true,
      rows: [STUB_ROW_PRESENT, { ...STUB_ROW_ABSENT, code: 'GBPLOOP' as const, issuer: 'GGBP' }],
    });
    renderStatus();
    await waitFor(() => {
      expect(screen.getByText(/Missing trustline:/)).toBeDefined();
    });
    // Singular — not "Missing trustlines:"
    expect(screen.queryByText(/Missing trustlines:/)).toBeNull();
  });

  it('shows green "wallet ready" when all trustlines are present', async () => {
    userMock.getUserStellarTrustlines.mockResolvedValue({
      address: 'GUSER',
      accountLinked: true,
      accountExists: true,
      rows: [
        STUB_ROW_PRESENT,
        { ...STUB_ROW_PRESENT, code: 'GBPLOOP' as const, issuer: 'GGBP' },
        { ...STUB_ROW_PRESENT, code: 'EURLOOP' as const, issuer: 'GEUR' },
      ],
    });
    renderStatus();
    await waitFor(() => {
      expect(screen.getByText('Wallet ready to receive cashback')).toBeDefined();
    });
  });

  it('self-hides on error (the form above is already the primary control)', async () => {
    userMock.getUserStellarTrustlines.mockRejectedValue(new Error('boom'));
    const container = renderStatus();
    await waitFor(() => {
      expect(userMock.getUserStellarTrustlines).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
