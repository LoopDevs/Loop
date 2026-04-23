// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { AssetDriftBadge, classifyDrift } from '../AssetDriftBadge';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: { getAssetCirculation: vi.fn() },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAssetCirculation: (code: string) => adminMock.getAssetCirculation(code),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderBadge(code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP' = 'USDLOOP'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AssetDriftBadge assetCode={code} />
    </QueryClientProvider>,
  );
}

describe('classifyDrift', () => {
  it('classifies zero / positive / negative', () => {
    expect(classifyDrift(0n)).toBe('zero');
    expect(classifyDrift(1n)).toBe('positive');
    expect(classifyDrift(-1n)).toBe('negative');
  });
});

describe('<AssetDriftBadge />', () => {
  const base = {
    assetCode: 'USDLOOP' as const,
    fiatCurrency: 'USD' as const,
    issuer: 'GABC',
    onChainStroops: '0',
    ledgerLiabilityMinor: '0',
    driftStroops: '0',
    onChainAsOfMs: Date.now(),
  };

  it('renders In-sync label for zero drift', async () => {
    adminMock.getAssetCirculation.mockResolvedValue({ ...base, driftStroops: '0' });
    renderBadge();
    await waitFor(() => {
      expect(screen.getByText('In sync')).toBeDefined();
    });
    expect(screen.getByLabelText(/Circulation drift: In sync/i)).toBeDefined();
  });

  it('renders Over-minted label for positive drift', async () => {
    adminMock.getAssetCirculation.mockResolvedValue({
      ...base,
      driftStroops: '10000000',
    });
    renderBadge();
    await waitFor(() => {
      expect(screen.getByText('Over-minted')).toBeDefined();
    });
  });

  it('renders Backlog label for negative drift', async () => {
    adminMock.getAssetCirculation.mockResolvedValue({
      ...base,
      driftStroops: '-10000000',
    });
    renderBadge();
    await waitFor(() => {
      expect(screen.getByText('Backlog')).toBeDefined();
    });
  });

  it('renders muted em-dash when Horizon is unavailable (503)', async () => {
    adminMock.getAssetCirculation.mockRejectedValue(
      new ApiException(503, { code: 'UPSTREAM_UNAVAILABLE', message: 'down' }),
    );
    renderBadge();
    await waitFor(() => {
      expect(screen.getByLabelText(/On-chain read unavailable/i)).toBeDefined();
    });
  });

  it('renders nothing on non-503 errors (silent degrade)', async () => {
    adminMock.getAssetCirculation.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL_ERROR', message: 'db down' }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <AssetDriftBadge assetCode="USDLOOP" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(adminMock.getAssetCirculation).toHaveBeenCalled();
    });
    expect(container.textContent).toBe('');
  });
});
