// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { MerchantResyncButton } from '../MerchantResyncButton';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    resyncMerchants: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    resyncMerchants: () => adminMock.resyncMerchants(),
  };
});

function renderButton(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MerchantResyncButton />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  adminMock.resyncMerchants.mockReset();
});

describe('<MerchantResyncButton />', () => {
  it('flashes the synced merchant count on triggered: true', async () => {
    adminMock.resyncMerchants.mockResolvedValue({
      merchantCount: 473,
      loadedAt: '2026-04-22T14:00:00.000Z',
      triggered: true,
    });
    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resync catalog/i }));
    });
    await waitFor(() => {
      expect(screen.getByText(/Synced 473 merchants/i)).toBeDefined();
    });
  });

  it('flashes "Already in sync" on coalesced responses (triggered: false)', async () => {
    adminMock.resyncMerchants.mockResolvedValue({
      merchantCount: 10,
      loadedAt: '2026-04-22T14:00:00.000Z',
      triggered: false,
    });
    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resync catalog/i }));
    });
    await waitFor(() => {
      expect(screen.getByText(/Already in sync/i)).toBeDefined();
    });
  });

  it('renders an upstream-error message on 502', async () => {
    adminMock.resyncMerchants.mockRejectedValue(
      new ApiException(502, {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to refresh merchant catalog from upstream',
      }),
    );
    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resync catalog/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Upstream CTX refused the sweep/i);
  });

  it('renders a rate-limit message on 429', async () => {
    adminMock.resyncMerchants.mockRejectedValue(
      new ApiException(429, { code: 'RATE_LIMITED', message: 'Too many requests' }),
    );
    renderButton();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Resync catalog/i }));
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/Too many resyncs/i);
  });

  it('disables the button while the request is in flight', async () => {
    let resolve!: (v: unknown) => void;
    adminMock.resyncMerchants.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    renderButton();
    const button = screen.getByRole('button', { name: /Resync catalog/i }) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => {
      expect((screen.getByRole('button') as HTMLButtonElement).textContent).toMatch(/Resyncing…/);
    });
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
    // Let the promise settle so the test harness doesn't hang.
    await act(async () => {
      resolve({ merchantCount: 0, loadedAt: '2026-01-01T00:00:00Z', triggered: true });
    });
  });
});
