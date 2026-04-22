// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { DiscordNotifiersCard } from '../DiscordNotifiersCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminDiscordNotifiers: vi.fn(),
    testDiscordChannel: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminDiscordNotifiers: () => adminMock.getAdminDiscordNotifiers(),
    testDiscordChannel: (channel: string) => adminMock.testDiscordChannel(channel),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

beforeEach(() => {
  adminMock.getAdminDiscordNotifiers.mockReset();
  adminMock.testDiscordChannel.mockReset();
});

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
    // Channel pills + test-ping buttons each carry the symbolic name.
    // Admin-audit appears twice (pill + button); same for monitoring
    // and orders. getAllByText reports both.
    expect(screen.getAllByText('admin-audit').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('monitoring').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('orders').length).toBeGreaterThanOrEqual(1);
    // Descriptions render alongside each row.
    expect(screen.getByText('Every admin write.')).toBeDefined();
    expect(screen.getByText('Stellar payout failed.')).toBeDefined();
  });

  it('renders one test-ping button per unique channel', async () => {
    adminMock.getAdminDiscordNotifiers.mockResolvedValue({
      notifiers: [
        { name: 'notifyOrderCreated', channel: 'orders', description: '…' },
        { name: 'notifyOrderFulfilled', channel: 'orders', description: '…' },
        { name: 'notifyPayoutFailed', channel: 'monitoring', description: '…' },
      ],
    });
    renderCard();
    await screen.findByText(/Test ping/i);
    // Two channels = two buttons. Orders appears twice (two rows) but
    // the button row deduplicates.
    const ordersBtn = screen.getByRole('button', { name: /^orders$/i });
    const monitoringBtn = screen.getByRole('button', { name: /^monitoring$/i });
    expect(ordersBtn).toBeDefined();
    expect(monitoringBtn).toBeDefined();
    expect(screen.queryByRole('button', { name: /^admin-audit$/i })).toBeNull();
  });

  it('flashes "Sent" on a successful test ping', async () => {
    adminMock.getAdminDiscordNotifiers.mockResolvedValue({
      notifiers: [{ name: 'notifyOrderCreated', channel: 'orders', description: '…' }],
    });
    adminMock.testDiscordChannel.mockResolvedValue({ status: 'delivered', channel: 'orders' });
    renderCard();
    const btn = await screen.findByRole('button', { name: /^orders$/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(adminMock.testDiscordChannel).toHaveBeenCalledWith('orders');
    });
    await screen.findByText('Sent');
  });

  it('renders "Not configured" on a 409 response', async () => {
    adminMock.getAdminDiscordNotifiers.mockResolvedValue({
      notifiers: [{ name: 'notifyPayoutFailed', channel: 'monitoring', description: '…' }],
    });
    adminMock.testDiscordChannel.mockRejectedValue(
      new ApiException(409, {
        code: 'WEBHOOK_NOT_CONFIGURED',
        message: 'Webhook for channel "monitoring" is not configured.',
      }),
    );
    renderCard();
    const btn = await screen.findByRole('button', { name: /^monitoring$/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Not configured/i);
  });

  it('renders a red generic error on non-409 failures', async () => {
    adminMock.getAdminDiscordNotifiers.mockResolvedValue({
      notifiers: [{ name: 'notifyOrderCreated', channel: 'orders', description: '…' }],
    });
    adminMock.testDiscordChannel.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL_ERROR', message: 'Upstream failure' }),
    );
    renderCard();
    const btn = await screen.findByRole('button', { name: /^orders$/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Upstream failure');
  });
});
