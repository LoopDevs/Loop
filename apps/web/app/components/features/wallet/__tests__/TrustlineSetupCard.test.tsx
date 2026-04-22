// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as PublicStatsModule from '~/services/public-stats';
import { TrustlineSetupCard } from '../TrustlineSetupCard';

afterEach(cleanup);

const { publicMock } = vi.hoisted(() => ({
  publicMock: {
    getPublicLoopAssets: vi.fn(),
  },
}));

vi.mock('~/services/public-stats', async (importActual) => {
  const actual = (await importActual()) as typeof PublicStatsModule;
  return {
    ...actual,
    getPublicLoopAssets: () => publicMock.getPublicLoopAssets(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TrustlineSetupCard />
    </QueryClientProvider>,
  );
}

describe('<TrustlineSetupCard />', () => {
  it('silently hides when the endpoint returns no configured assets', async () => {
    publicMock.getPublicLoopAssets.mockResolvedValue({ assets: [] });
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('[aria-labelledby="trustline-setup-heading"]')).toBeNull();
    });
    expect(screen.queryByText(/LOOP asset trustlines/i)).toBeNull();
  });

  it('silently hides on fetch failure (helper card, not load-bearing)', async () => {
    publicMock.getPublicLoopAssets.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('[aria-labelledby="trustline-setup-heading"]')).toBeNull();
    });
  });

  it('renders one row per configured asset with the code pill + issuer text + copy button', async () => {
    publicMock.getPublicLoopAssets.mockResolvedValue({
      assets: [
        { code: 'USDLOOP', issuer: 'GAUSD1234567890' },
        { code: 'GBPLOOP', issuer: 'GAGBP1234567890' },
        { code: 'EURLOOP', issuer: 'GAEUR1234567890' },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/LOOP asset trustlines/i)).toBeDefined();
    });
    // Code pills.
    expect(screen.getByText('USDLOOP')).toBeDefined();
    expect(screen.getByText('GBPLOOP')).toBeDefined();
    expect(screen.getByText('EURLOOP')).toBeDefined();
    // Issuer pubkeys surface (title + visible text).
    expect(screen.getByText('GAUSD1234567890')).toBeDefined();
    expect(screen.getByText('GAGBP1234567890')).toBeDefined();
    expect(screen.getByText('GAEUR1234567890')).toBeDefined();
    // One Copy button per row — aria-labelled with the asset code.
    expect(screen.getByLabelText(/Copy USDLOOP issuer/)).toBeDefined();
    expect(screen.getByLabelText(/Copy GBPLOOP issuer/)).toBeDefined();
    expect(screen.getByLabelText(/Copy EURLOOP issuer/)).toBeDefined();
  });

  it('surfaces the anti-spoofing copy so users verify the issuer before adding a trustline', async () => {
    publicMock.getPublicLoopAssets.mockResolvedValue({
      assets: [{ code: 'USDLOOP', issuer: 'GAUSD' }],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText(/Verify the issuer matches/i)).toBeDefined();
    });
  });
});
