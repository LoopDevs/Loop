// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { merchantsMock } = vi.hoisted(() => ({
  merchantsMock: {
    fetchMerchants: vi.fn(),
    fetchAllMerchants: vi.fn(),
    fetchMerchant: vi.fn(),
    fetchMerchantBySlug: vi.fn(),
    fetchMerchantCashbackRate: vi.fn(),
    fetchMerchantsCashbackRates: vi.fn(),
  },
}));

vi.mock('~/services/merchants', () => ({
  fetchMerchants: (args: unknown) => merchantsMock.fetchMerchants(args),
  fetchAllMerchants: () => merchantsMock.fetchAllMerchants(),
  fetchMerchant: (id: string) => merchantsMock.fetchMerchant(id),
  fetchMerchantBySlug: (slug: string) => merchantsMock.fetchMerchantBySlug(slug),
  fetchMerchantCashbackRate: (id: string) => merchantsMock.fetchMerchantCashbackRate(id),
  fetchMerchantsCashbackRates: () => merchantsMock.fetchMerchantsCashbackRates(),
}));

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

import {
  useMerchants,
  useAllMerchants,
  useMerchantBySlug,
  useMerchant,
  useMerchantCashbackRate,
  useMerchantsCashbackRatesMap,
} from '../use-merchants';

afterEach(cleanup);

beforeEach(() => {
  Object.values(merchantsMock).forEach((m) => m.mockReset());
});

function withProvider(node: React.ReactElement): React.ReactElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, throwOnError: false } },
  });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function ListProbe(props: { page?: number; q?: string }): React.ReactElement {
  const r = useMerchants(props);
  return (
    <div>
      <span data-testid="count">{r.merchants.length}</span>
      <span data-testid="total">{r.total}</span>
    </div>
  );
}

describe('useMerchants', () => {
  it('passes page+limit+q through to fetchMerchants', async () => {
    merchantsMock.fetchMerchants.mockResolvedValue({
      merchants: [],
      pagination: { page: 2, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
    });
    render(withProvider(<ListProbe page={2} q="cof" />));
    await waitFor(() =>
      expect(merchantsMock.fetchMerchants).toHaveBeenCalledWith({ page: 2, limit: 20, q: 'cof' }),
    );
  });

  it('omits q from the request when not supplied', async () => {
    merchantsMock.fetchMerchants.mockResolvedValue({
      merchants: [],
      pagination: { page: 1, limit: 20, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
    });
    render(withProvider(<ListProbe page={1} />));
    await waitFor(() =>
      expect(merchantsMock.fetchMerchants).toHaveBeenCalledWith({ page: 1, limit: 20 }),
    );
  });
});

describe('useAllMerchants', () => {
  it('returns the catalog merchants + total', async () => {
    merchantsMock.fetchAllMerchants.mockResolvedValue({
      merchants: [{ id: 'm-1' }, { id: 'm-2' }],
      total: 2,
    });
    function Probe(): React.ReactElement {
      const r = useAllMerchants();
      return (
        <div>
          <span data-testid="count">{r.merchants.length}</span>
        </div>
      );
    }
    render(withProvider(<Probe />));
    await waitFor(() => expect(screen.getByTestId('count').textContent).toBe('2'));
  });
});

describe('useMerchantBySlug', () => {
  it('does not fire when slug is whitespace-only (avoids guaranteed 404)', () => {
    function Probe(): React.ReactElement {
      const r = useMerchantBySlug('   ');
      return <span data-testid="ml">{r.merchant?.id ?? '_none_'}</span>;
    }
    render(withProvider(<Probe />));
    expect(merchantsMock.fetchMerchantBySlug).not.toHaveBeenCalled();
  });

  it('fires with the trimmed slug and returns the merchant', async () => {
    merchantsMock.fetchMerchantBySlug.mockResolvedValue({ merchant: { id: 'amazon-us' } });
    function Probe(): React.ReactElement {
      const r = useMerchantBySlug('  amazon  ');
      return <span data-testid="ml">{r.merchant?.id ?? '_none_'}</span>;
    }
    render(withProvider(<Probe />));
    await waitFor(() => expect(screen.getByTestId('ml').textContent).toBe('amazon-us'));
    expect(merchantsMock.fetchMerchantBySlug).toHaveBeenCalledWith('amazon');
  });
});

describe('useMerchant (authed detail)', () => {
  it('honours the explicit `enabled: false` flag and skips the fetch', () => {
    function Probe(): React.ReactElement {
      const r = useMerchant('m-1', { enabled: false });
      return <span data-testid="ml">{r.merchant?.id ?? '_none_'}</span>;
    }
    render(withProvider(<Probe />));
    expect(merchantsMock.fetchMerchant).not.toHaveBeenCalled();
  });

  it('defaults enabled to true and fetches when id is non-empty', async () => {
    merchantsMock.fetchMerchant.mockResolvedValue({ merchant: { id: 'm-1' } });
    function Probe(): React.ReactElement {
      const r = useMerchant('m-1');
      return <span data-testid="ml">{r.merchant?.id ?? '_none_'}</span>;
    }
    render(withProvider(<Probe />));
    await waitFor(() => expect(screen.getByTestId('ml').textContent).toBe('m-1'));
  });
});

describe('useMerchantCashbackRate', () => {
  it('returns null pct while loading + when missing', async () => {
    merchantsMock.fetchMerchantCashbackRate.mockResolvedValue({ userCashbackPct: null });
    function Probe(): React.ReactElement {
      const r = useMerchantCashbackRate('m-1');
      return <span data-testid="pct">{r.userCashbackPct ?? '_null_'}</span>;
    }
    render(withProvider(<Probe />));
    await waitFor(() =>
      expect(merchantsMock.fetchMerchantCashbackRate).toHaveBeenCalledWith('m-1'),
    );
    expect(screen.getByTestId('pct').textContent).toBe('_null_');
  });

  it('surfaces the configured pct once the request resolves', async () => {
    merchantsMock.fetchMerchantCashbackRate.mockResolvedValue({ userCashbackPct: '4.50' });
    function Probe(): React.ReactElement {
      const r = useMerchantCashbackRate('m-1');
      return <span data-testid="pct">{r.userCashbackPct ?? '_null_'}</span>;
    }
    render(withProvider(<Probe />));
    await waitFor(() => expect(screen.getByTestId('pct').textContent).toBe('4.50'));
  });
});

describe('useMerchantsCashbackRatesMap', () => {
  it('returns null for unknown ids until the rates map resolves', async () => {
    merchantsMock.fetchMerchantsCashbackRates.mockResolvedValue({
      rates: { 'amazon-us': '4.00', target: '2.50' },
    });
    function Probe(): React.ReactElement {
      const { lookup } = useMerchantsCashbackRatesMap();
      return (
        <div>
          <span data-testid="amazon">{lookup('amazon-us') ?? '_null_'}</span>
          <span data-testid="unknown">{lookup('unknown') ?? '_null_'}</span>
        </div>
      );
    }
    render(withProvider(<Probe />));
    await waitFor(() => expect(merchantsMock.fetchMerchantsCashbackRates).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('amazon').textContent).toBe('4.00'));
    expect(screen.getByTestId('unknown').textContent).toBe('_null_');
  });
});
