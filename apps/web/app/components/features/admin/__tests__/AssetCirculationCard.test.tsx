// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { AssetCirculationCard, formatMinor, formatStroops } from '../AssetCirculationCard';

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

function renderCard(code: 'USDLOOP' | 'GBPLOOP' | 'EURLOOP' = 'USDLOOP'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <AssetCirculationCard assetCode={code} />
    </QueryClientProvider>,
  );
}

describe('formatStroops', () => {
  it('trims trailing zeros + labels the asset', () => {
    expect(formatStroops(12_345_670_000n, 'USDLOOP')).toBe('1234.567 USDLOOP');
    expect(formatStroops(10_000_000n, 'GBPLOOP')).toBe('1 GBPLOOP');
  });

  it('signs negative stroops', () => {
    expect(formatStroops(-10_000_000n, 'USDLOOP')).toBe('-1 USDLOOP');
  });
});

describe('formatMinor', () => {
  it('uses Intl.NumberFormat for known currencies', () => {
    expect(formatMinor(15_000n, 'USD')).toBe('$150.00');
  });

  it('signs negative minor amounts', () => {
    expect(formatMinor(-500n, 'USD')).toBe('-$5.00');
  });
});

describe('<AssetCirculationCard />', () => {
  it('renders In-sync pill when drift is zero', async () => {
    adminMock.getAssetCirculation.mockResolvedValue({
      assetCode: 'USDLOOP',
      fiatCurrency: 'USD',
      issuer: 'GABC',
      onChainStroops: '1500000000',
      ledgerLiabilityMinor: '15000',
      driftStroops: '0',
      onChainAsOfMs: Date.now(),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('In sync')).toBeDefined();
    });
    expect(screen.getByLabelText(/Drift: In sync/i)).toBeDefined();
  });

  it('renders Over-minted pill + amber drift for positive drift', async () => {
    adminMock.getAssetCirculation.mockResolvedValue({
      assetCode: 'USDLOOP',
      fiatCurrency: 'USD',
      issuer: 'GABC',
      onChainStroops: '20000000',
      ledgerLiabilityMinor: '100',
      driftStroops: '10000000',
      onChainAsOfMs: Date.now(),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Over-minted')).toBeDefined();
    });
    expect(screen.getByText(/\+1 USDLOOP/)).toBeDefined();
  });

  it('renders Settlement-backlog pill + blue drift for negative drift', async () => {
    adminMock.getAssetCirculation.mockResolvedValue({
      assetCode: 'USDLOOP',
      fiatCurrency: 'USD',
      issuer: 'GABC',
      onChainStroops: '10000000',
      ledgerLiabilityMinor: '200',
      driftStroops: '-10000000',
      onChainAsOfMs: Date.now(),
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('Settlement backlog')).toBeDefined();
    });
    expect(screen.getByText(/-1 USDLOOP/)).toBeDefined();
  });

  it('surfaces a targeted 503 line when Horizon is unavailable', async () => {
    adminMock.getAssetCirculation.mockRejectedValue(
      new ApiException(503, { code: 'UPSTREAM_UNAVAILABLE', message: 'down' }),
    );
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/On-chain circulation read failed/i)).toBeDefined();
    });
  });

  it('renders nothing on non-503 errors (silent degrade)', async () => {
    adminMock.getAssetCirculation.mockRejectedValue(
      new ApiException(500, { code: 'INTERNAL_ERROR', message: 'db down' }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { container } = render(
      <QueryClientProvider client={qc}>
        <AssetCirculationCard assetCode="USDLOOP" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(adminMock.getAssetCirculation).toHaveBeenCalled();
    });
    expect(container.textContent).not.toMatch(/Circulation drift/);
    expect(container.textContent).not.toMatch(/On-chain circulation read failed/);
  });
});
