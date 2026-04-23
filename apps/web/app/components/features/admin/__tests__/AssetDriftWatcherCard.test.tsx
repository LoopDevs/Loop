// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as AdminModule from '~/services/admin';
import { AssetDriftWatcherCard, formatAgo } from '../AssetDriftWatcherCard';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: { getAssetDriftState: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAssetDriftState: () => adminMock.getAssetDriftState(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): HTMLElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={qc}>
      <AssetDriftWatcherCard />
    </QueryClientProvider>,
  );
  return container;
}

describe('formatAgo', () => {
  it('formats seconds / minutes / hours', () => {
    const now = 1_000_000_000;
    expect(formatAgo(now - 10_000, now)).toBe('10s ago');
    expect(formatAgo(now - 120_000, now)).toBe('2m ago');
    expect(formatAgo(now - 7_200_000, now)).toBe('2h ago');
  });

  it('clamps negative deltas to 0s ago', () => {
    const now = 1_000_000_000;
    expect(formatAgo(now + 10_000, now)).toBe('0s ago');
  });
});

describe('<AssetDriftWatcherCard />', () => {
  it('renders within-threshold summary when all assets are ok', async () => {
    adminMock.getAssetDriftState.mockResolvedValue({
      lastTickMs: Date.now() - 60_000,
      running: true,
      perAsset: [
        {
          assetCode: 'USDLOOP',
          state: 'ok',
          lastDriftStroops: '0',
          lastThresholdStroops: '100000000',
          lastCheckedMs: Date.now() - 60_000,
        },
        {
          assetCode: 'GBPLOOP',
          state: 'ok',
          lastDriftStroops: '0',
          lastThresholdStroops: '100000000',
          lastCheckedMs: Date.now() - 60_000,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/2 \/ 2 assets within threshold/)).toBeDefined();
    });
    expect(screen.getByText('running')).toBeDefined();
  });

  it('surfaces over-threshold assets with an amber card + named codes', async () => {
    adminMock.getAssetDriftState.mockResolvedValue({
      lastTickMs: Date.now(),
      running: true,
      perAsset: [
        {
          assetCode: 'USDLOOP',
          state: 'over',
          lastDriftStroops: '500000000',
          lastThresholdStroops: '100000000',
          lastCheckedMs: Date.now(),
        },
        {
          assetCode: 'GBPLOOP',
          state: 'ok',
          lastDriftStroops: '0',
          lastThresholdStroops: '100000000',
          lastCheckedMs: Date.now(),
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/1 \/ 2 over threshold/)).toBeDefined();
    });
    expect(screen.getByText('USDLOOP')).toBeDefined();
  });

  it('renders inactive + has-not-run when the watcher has never ticked', async () => {
    adminMock.getAssetDriftState.mockResolvedValue({
      lastTickMs: null,
      running: false,
      perAsset: [
        {
          assetCode: 'USDLOOP',
          state: 'unknown',
          lastDriftStroops: null,
          lastThresholdStroops: null,
          lastCheckedMs: null,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('inactive')).toBeDefined();
    });
    expect(screen.getByText(/has not run yet/i)).toBeDefined();
  });

  it('self-hides when the watcher is inactive and no assets are configured', async () => {
    adminMock.getAssetDriftState.mockResolvedValue({
      lastTickMs: null,
      running: false,
      perAsset: [],
    });
    const container = renderCard();
    await waitFor(() => {
      expect(adminMock.getAssetDriftState).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
