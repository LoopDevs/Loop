// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as PublicStatsModule from '~/services/public-stats';
import { FlywheelStatsBand } from '../FlywheelStatsBand';

afterEach(cleanup);

const { publicMock } = vi.hoisted(() => ({
  publicMock: {
    getPublicFlywheelStats: vi.fn(),
  },
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStatsModule;
  return {
    ...actual,
    getPublicFlywheelStats: () => publicMock.getPublicFlywheelStats(),
  };
});

function renderBand(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FlywheelStatsBand />
    </QueryClientProvider>,
  );
}

describe('<FlywheelStatsBand />', () => {
  it('silently hides for zero-recycle fleet (pre-flywheel state)', async () => {
    publicMock.getPublicFlywheelStats.mockResolvedValue({
      windowDays: 30,
      fulfilledOrders: 100,
      recycledOrders: 0,
      pctRecycled: '0.0',
    });
    const { container } = renderBand();
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Loop flywheel stats"]')).toBeNull();
    });
  });

  it('silently hides on fetch error (marketing surface — no red banners)', async () => {
    publicMock.getPublicFlywheelStats.mockRejectedValue(new Error('boom'));
    const { container } = renderBand();
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Loop flywheel stats"]')).toBeNull();
    });
  });

  it('renders the one-sentence pitch when recycled > 0', async () => {
    publicMock.getPublicFlywheelStats.mockResolvedValue({
      windowDays: 30,
      fulfilledOrders: 448,
      recycledOrders: 56,
      pctRecycled: '12.5',
    });
    renderBand();
    await waitFor(() => {
      expect(screen.getByLabelText(/Loop flywheel stats/i)).toBeDefined();
    });
    // Key surfaces: the % and the fulfilled-count.
    expect(screen.getByText(/12\.5/)).toBeDefined();
    expect(screen.getByText(/448/)).toBeDefined();
    expect(screen.getByText(/recycled cashback/i)).toBeDefined();
  });
});
