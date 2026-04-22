// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { DiscordNotifiersCard } from '../DiscordNotifiersCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminDiscordNotifiers: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminDiscordNotifiers: () => adminMock.getAdminDiscordNotifiers(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <DiscordNotifiersCard />
    </QueryClientProvider>,
  );
}

describe('<DiscordNotifiersCard />', () => {
  it('shows the error state on fetch failure', async () => {
    adminMock.getAdminDiscordNotifiers.mockRejectedValue(new Error('boom'));
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Failed to load Discord notifier catalog/i)).toBeDefined();
    });
  });

  it('shows the empty state when no notifiers are configured', async () => {
    adminMock.getAdminDiscordNotifiers.mockResolvedValue({ notifiers: [] });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/No Discord notifiers configured/i)).toBeDefined();
    });
  });

  it('renders a row per notifier with channel pill + description', async () => {
    adminMock.getAdminDiscordNotifiers.mockResolvedValue({
      notifiers: [
        {
          name: 'notifyAdminAudit',
          channel: 'admin-audit',
          description: 'Every admin write.',
        },
        {
          name: 'notifyPayoutFailed',
          channel: 'monitoring',
          description: 'Stellar payout failed.',
        },
        {
          name: 'notifyOrderCreated',
          channel: 'orders',
          description: 'New loop-native order.',
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('notifyAdminAudit')).toBeDefined();
    });
    expect(screen.getByText('notifyPayoutFailed')).toBeDefined();
    expect(screen.getByText('notifyOrderCreated')).toBeDefined();
    // Channel pills each render their symbolic name exactly once.
    expect(screen.getByText('admin-audit')).toBeDefined();
    expect(screen.getByText('monitoring')).toBeDefined();
    expect(screen.getByText('orders')).toBeDefined();
    // Descriptions render alongside each row.
    expect(screen.getByText('Every admin write.')).toBeDefined();
    expect(screen.getByText('Stellar payout failed.')).toBeDefined();
  });
});
