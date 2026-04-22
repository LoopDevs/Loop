// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import type * as UserModule from '~/services/user';
import { LinkWalletNudge, hasPositiveBalance } from '../LinkWalletNudge';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getMe: vi.fn(),
    getMyCredits: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getMe: () => userMock.getMe(),
    getMyCredits: () => userMock.getMyCredits(),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderNudge(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <LinkWalletNudge />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { container: result.container };
}

function meStub(overrides: { stellarAddress?: string | null } = {}): object {
  return {
    id: 'u1',
    email: 'u@loop.test',
    isAdmin: false,
    homeCurrency: 'GBP',
    stellarAddress: overrides.stellarAddress ?? null,
    homeCurrencyBalanceMinor: '0',
  };
}

describe('hasPositiveBalance', () => {
  it('returns false for undefined / empty input', () => {
    expect(hasPositiveBalance(undefined)).toBe(false);
    expect(hasPositiveBalance([])).toBe(false);
  });

  it('returns false when every row is zero', () => {
    expect(
      hasPositiveBalance([
        { currency: 'GBP', balanceMinor: '0', updatedAt: '' },
        { currency: 'USD', balanceMinor: '0', updatedAt: '' },
      ]),
    ).toBe(false);
  });

  it('returns true when at least one row is positive', () => {
    expect(
      hasPositiveBalance([
        { currency: 'GBP', balanceMinor: '0', updatedAt: '' },
        { currency: 'USD', balanceMinor: '10', updatedAt: '' },
      ]),
    ).toBe(true);
  });

  it('ignores malformed amountMinor strings', () => {
    expect(
      hasPositiveBalance([
        { currency: 'GBP', balanceMinor: 'garbage', updatedAt: '' },
        { currency: 'USD', balanceMinor: '0', updatedAt: '' },
      ]),
    ).toBe(false);
  });
});

describe('<LinkWalletNudge />', () => {
  it('renders the CTA when balance > 0 and no wallet linked', async () => {
    userMock.getMe.mockResolvedValue(meStub());
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'GBP', balanceMinor: '1500', updatedAt: '' }],
    });
    renderNudge();
    await waitFor(() => {
      expect(screen.getByText(/Link a Stellar wallet to withdraw/)).toBeDefined();
    });
    const link = screen.getByRole('link', { name: /Go to wallet settings/ });
    expect(link.getAttribute('href')).toBe('/settings/wallet');
  });

  it('hides when user has a wallet linked', async () => {
    userMock.getMe.mockResolvedValue(meStub({ stellarAddress: 'GABC...' }));
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'GBP', balanceMinor: '1500', updatedAt: '' }],
    });
    const { container } = renderNudge();
    await waitFor(() => {
      expect(userMock.getMe).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('hides when balance is zero', async () => {
    userMock.getMe.mockResolvedValue(meStub());
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'GBP', balanceMinor: '0', updatedAt: '' }],
    });
    const { container } = renderNudge();
    await waitFor(() => {
      expect(userMock.getMyCredits).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });

  it('hides while either fetch is in flight (no flash)', () => {
    userMock.getMe.mockReturnValue(new Promise(() => {}));
    userMock.getMyCredits.mockReturnValue(new Promise(() => {}));
    const { container } = renderNudge();
    expect(container.firstChild).toBeNull();
  });

  it('hides silently on fetch error', async () => {
    userMock.getMe.mockRejectedValue(new Error('boom'));
    userMock.getMyCredits.mockResolvedValue({
      credits: [{ currency: 'GBP', balanceMinor: '1500', updatedAt: '' }],
    });
    const { container } = renderNudge();
    await waitFor(() => {
      expect(userMock.getMe).toHaveBeenCalled();
    });
    expect(container.firstChild).toBeNull();
  });
});
