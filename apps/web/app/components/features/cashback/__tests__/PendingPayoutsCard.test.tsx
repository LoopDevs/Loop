// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { PendingPayoutsCard, formatAssetAmount } from '../PendingPayoutsCard';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getUserPendingPayouts: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserPendingPayouts: () => userMock.getUserPendingPayouts(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PendingPayoutsCard />
    </QueryClientProvider>,
  );
}

describe('formatAssetAmount', () => {
  it('strips trailing zeros and preserves the asset code', () => {
    expect(formatAssetAmount('12500000', 'GBPLOOP')).toBe('1.25 GBPLOOP');
  });

  it('renders whole numbers without a decimal', () => {
    expect(formatAssetAmount('10000000', 'USDLOOP')).toBe('1 USDLOOP');
  });

  it('falls back to an em-dash on BigInt parse failure', () => {
    expect(formatAssetAmount('nope', 'EURLOOP')).toBe('—');
  });
});

describe('<PendingPayoutsCard />', () => {
  it('hides on empty — new users see nothing', async () => {
    userMock.getUserPendingPayouts.mockResolvedValue({ payouts: [] });
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('[aria-labelledby="payouts-heading"]')).toBeNull();
    });
  });

  it('hides silently on fetch error', async () => {
    userMock.getUserPendingPayouts.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      expect(userMock.getUserPendingPayouts).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-labelledby="payouts-heading"]')).toBeNull();
  });

  it('renders each payout with state pill and explorer link when confirmed', async () => {
    userMock.getUserPendingPayouts.mockResolvedValue({
      payouts: [
        {
          id: 'p-1',
          assetCode: 'GBPLOOP',
          assetIssuer: 'GBP_ISSUER',
          amountStroops: '12500000',
          state: 'confirmed',
          txHash: '0123456789abcdef',
          attempts: 1,
          createdAt: '2026-04-01T00:00:00Z',
          submittedAt: '2026-04-01T00:00:10Z',
          confirmedAt: '2026-04-01T00:00:30Z',
          failedAt: null,
        },
        {
          id: 'p-2',
          assetCode: 'USDLOOP',
          assetIssuer: 'USD_ISSUER',
          amountStroops: '5000000',
          state: 'pending',
          txHash: null,
          attempts: 0,
          createdAt: '2026-04-02T00:00:00Z',
          submittedAt: null,
          confirmedAt: null,
          failedAt: null,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('1.25 GBPLOOP')).toBeDefined();
    });
    expect(screen.getByText('0.5 USDLOOP')).toBeDefined();
    expect(screen.getByText('Confirmed')).toBeDefined();
    expect(screen.getByText('Queued')).toBeDefined();
    const link = screen.getByRole('link', { name: /View tx/ });
    expect(link.getAttribute('href')).toBe(
      'https://stellar.expert/explorer/public/tx/0123456789abcdef',
    );
    // Pending row has no hash → no explorer link on that row. Only
    // one link total (the confirmed row's).
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });
});
