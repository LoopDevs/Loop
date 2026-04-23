// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { OrderPayoutCard } from '../OrderPayoutCard';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getUserPayoutByOrder: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserPayoutByOrder: (id: string) => userMock.getUserPayoutByOrder(id),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(orderId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <OrderPayoutCard orderId={orderId} />
    </QueryClientProvider>,
  );
}

describe('<OrderPayoutCard />', () => {
  it('renders nothing when no payout exists for the order (null response)', async () => {
    userMock.getUserPayoutByOrder.mockResolvedValue(null);
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OrderPayoutCard orderId="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(userMock.getUserPayoutByOrder).toHaveBeenCalled();
    });
    // After the query settles with null, the card should self-hide
    // (returns null). The wrapper still contains the QueryClient
    // but no heading.
    expect(container.textContent).not.toMatch(/Cashback settlement/);
  });

  it('renders nothing on fetch error (silent degrade)', async () => {
    userMock.getUserPayoutByOrder.mockRejectedValue(new Error('boom'));
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OrderPayoutCard orderId="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(userMock.getUserPayoutByOrder).toHaveBeenCalled();
    });
    expect(container.textContent).not.toMatch(/Cashback settlement/);
  });

  it('renders confirmed-state card with tx explorer link', async () => {
    userMock.getUserPayoutByOrder.mockResolvedValue({
      id: 'payout-1',
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: '25000000', // 2.5 USDLOOP
      state: 'confirmed',
      txHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      attempts: 1,
      createdAt: '2026-04-20T10:00:00.000Z',
      submittedAt: '2026-04-20T10:01:00.000Z',
      confirmedAt: '2026-04-20T10:02:00.000Z',
      failedAt: null,
    });
    renderCard();

    await waitFor(() => {
      expect(screen.getByText('Cashback settlement')).toBeDefined();
    });
    expect(screen.getByText(/2\.5 USDLOOP/)).toBeDefined();
    expect(screen.getByLabelText('Payout state: Confirmed')).toBeDefined();

    const tx = screen.getByRole('link', { name: /view tx/i });
    expect(tx.getAttribute('href')).toBe(
      'https://stellar.expert/explorer/public/tx/abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    );
    expect(tx.getAttribute('target')).toBe('_blank');
  });

  it('renders pending-state card without an explorer link (txHash null)', async () => {
    userMock.getUserPayoutByOrder.mockResolvedValue({
      id: 'payout-1',
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      assetCode: 'GBPLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: '12500000',
      state: 'pending',
      txHash: null,
      attempts: 0,
      createdAt: '2026-04-20T10:00:00.000Z',
      submittedAt: null,
      confirmedAt: null,
      failedAt: null,
    });
    renderCard();

    await waitFor(() => {
      expect(screen.getByText('Cashback settlement')).toBeDefined();
    });
    expect(screen.getByLabelText('Payout state: Queued')).toBeDefined();
    expect(screen.queryByRole('link', { name: /view tx/i })).toBeNull();
  });

  it('renders failed-state pill + attempts reassurance line', async () => {
    userMock.getUserPayoutByOrder.mockResolvedValue({
      id: 'payout-1',
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      assetCode: 'EURLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: '10000000',
      state: 'failed',
      txHash: null,
      attempts: 3,
      createdAt: '2026-04-20T10:00:00.000Z',
      submittedAt: '2026-04-20T10:01:00.000Z',
      confirmedAt: null,
      failedAt: '2026-04-20T10:03:00.000Z',
    });
    renderCard();

    await waitFor(() => {
      expect(screen.getByLabelText('Payout state: Failed')).toBeDefined();
    });
    expect(screen.getByText(/Tried 3 times\. Support is reviewing\./i)).toBeDefined();
  });

  it('pluralises attempts=1 correctly on failed state', async () => {
    userMock.getUserPayoutByOrder.mockResolvedValue({
      id: 'payout-1',
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: '10000000',
      state: 'failed',
      txHash: null,
      attempts: 1,
      createdAt: '2026-04-20T10:00:00.000Z',
      submittedAt: '2026-04-20T10:01:00.000Z',
      confirmedAt: null,
      failedAt: '2026-04-20T10:03:00.000Z',
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Tried 1 time\. Support is reviewing\./i)).toBeDefined();
    });
  });

  it('covers the zero-attempts failed edge case (never-retried)', async () => {
    userMock.getUserPayoutByOrder.mockResolvedValue({
      id: 'payout-1',
      orderId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      assetCode: 'USDLOOP',
      assetIssuer: 'GISSUER',
      amountStroops: '10000000',
      state: 'failed',
      txHash: null,
      attempts: 0,
      createdAt: '2026-04-20T10:00:00.000Z',
      submittedAt: null,
      confirmedAt: null,
      failedAt: '2026-04-20T10:03:00.000Z',
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Our system hasn.t retried yet/i)).toBeDefined();
    });
  });
});
