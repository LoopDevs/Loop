// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiException } from '@loop/shared';
import type * as AdminModule from '~/services/admin';
import { formatMinorCurrency as formatMinor } from '@loop/shared';
import { CashbackSummaryChip } from '../CashbackSummaryChip';

afterEach(cleanup);

const { adminMock } = vi.hoisted(() => ({
  adminMock: {
    getAdminUserCashbackSummary: vi.fn(),
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getAdminUserCashbackSummary: (userId: string) => adminMock.getAdminUserCashbackSummary(userId),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));

function renderChip(userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CashbackSummaryChip userId={userId} />
    </QueryClientProvider>,
  );
}

describe('formatMinor', () => {
  it('renders bigint minor as localised currency', () => {
    expect(formatMinor(4200n, 'GBP')).toMatch(/£42\.00/);
    expect(formatMinor(320n, 'USD')).toMatch(/\$3\.20/);
    expect(formatMinor(0n, 'EUR')).toMatch(/€0\.00/);
  });

  it('preserves bigint precision past Number.MAX_SAFE_INTEGER', () => {
    // 9_007_199_254_740_993 is 2^53 + 1 — would lose precision via Number.
    const huge = 9_007_199_254_740_993n;
    const out = formatMinor(huge, 'USD');
    // Regardless of locale format, the digits should survive — check a
    // representative high-order substring.
    expect(out).toContain('90,071,992,547,409');
  });

  it('falls back to `amount CODE` when Intl rejects the currency code', () => {
    // 2-letter codes throw via Intl.NumberFormat; a genuinely unknown
    // 3-letter code (e.g. 'XYZ') is silently accepted and formatted
    // differently per engine — so exercise the throw path explicitly
    // with a shape Intl definitely rejects.
    expect(formatMinor(1234n, 'XX')).toBe('12.34 XX');
  });
});

describe('<CashbackSummaryChip />', () => {
  it('hides the chip for zero-earnings users', async () => {
    adminMock.getAdminUserCashbackSummary.mockResolvedValue({
      userId: 'u-1',
      currency: 'GBP',
      lifetimeMinor: '0',
      thisMonthMinor: '0',
    });
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CashbackSummaryChip userId="u-1" />
      </QueryClientProvider>,
    );
    // Wait for the query to resolve — the loading spinner renders
    // first, then the component returns null.
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Cashback earned"]')).toBeNull();
      expect(screen.queryByText(/lifetime/i)).toBeNull();
    });
  });

  it('renders the lifetime + this-month chip for earning users', async () => {
    adminMock.getAdminUserCashbackSummary.mockResolvedValue({
      userId: 'u-2',
      currency: 'GBP',
      lifetimeMinor: '4200',
      thisMonthMinor: '320',
    });
    renderChip('u-2');
    await waitFor(() => {
      expect(screen.getByLabelText(/Cashback earned/i)).toBeDefined();
    });
    expect(screen.getByText(/lifetime/i)).toBeDefined();
    expect(screen.getByText(/this month/i)).toBeDefined();
    // Both amounts rendered; the £42.00 / £3.20 strings are locale-
    // dependent but the digit groups survive.
    expect(screen.getByText(/42\.00/)).toBeDefined();
    expect(screen.getByText(/3\.20/)).toBeDefined();
  });

  it('shows an inline error line on non-404 failure', async () => {
    adminMock.getAdminUserCashbackSummary.mockRejectedValue(new Error('boom'));
    renderChip('u-3');
    await waitFor(() => {
      expect(screen.getByText(/Failed to load cashback summary/i)).toBeDefined();
    });
  });

  it('silent no-op on 404 (user deleted between list and drill)', async () => {
    adminMock.getAdminUserCashbackSummary.mockRejectedValue(
      new ApiException(404, { code: 'NOT_FOUND', message: 'User not found' }),
    );
    const { container } = render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <CashbackSummaryChip userId="u-4" />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Cashback earned"]')).toBeNull();
    });
    expect(screen.queryByText(/Failed to load/i)).toBeNull();
  });
});
