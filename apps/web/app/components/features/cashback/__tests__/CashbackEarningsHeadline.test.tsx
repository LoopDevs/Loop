// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as UserModule from '~/services/user';
import { CashbackEarningsHeadline, fmtEarnings } from '../CashbackEarningsHeadline';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getCashbackSummary: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getCashbackSummary: () => userMock.getCashbackSummary(),
  };
});

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

function renderHeadline(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CashbackEarningsHeadline />
    </QueryClientProvider>,
  );
}

describe('fmtEarnings', () => {
  it('formats GBP minor as localised currency', () => {
    expect(fmtEarnings('4250', 'GBP')).toMatch(/42\.50/);
  });

  it('returns em-dash for non-numeric input', () => {
    expect(fmtEarnings('not-a-number', 'GBP')).toBe('—');
  });
});

describe('<CashbackEarningsHeadline />', () => {
  it('hides itself when the user has zero lifetime earnings', async () => {
    userMock.getCashbackSummary.mockResolvedValue({
      currency: 'GBP',
      lifetimeMinor: '0',
      thisMonthMinor: '0',
    });
    const { container } = renderHeadline();
    // Wait for the query to settle so we're testing the rendered
    // state, not the pending branch.
    await waitFor(() => {
      expect(userMock.getCashbackSummary).toHaveBeenCalled();
    });
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows both lifetime and this-month values when both are non-zero', async () => {
    userMock.getCashbackSummary.mockResolvedValue({
      currency: 'GBP',
      lifetimeMinor: '4250',
      thisMonthMinor: '320',
    });
    renderHeadline();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.getByText('Earned with Loop')).toBeDefined();
    expect(screen.getByText(/\+.*3\.20/)).toBeDefined();
    expect(screen.getByText('This month')).toBeDefined();
  });

  it('hides the this-month block when month total is zero but lifetime is non-zero', async () => {
    userMock.getCashbackSummary.mockResolvedValue({
      currency: 'GBP',
      lifetimeMinor: '4250',
      thisMonthMinor: '0',
    });
    renderHeadline();
    await waitFor(() => {
      expect(screen.getByText(/42\.50/)).toBeDefined();
    });
    expect(screen.queryByText('This month')).toBeNull();
  });

  it('hides itself silently on fetch error', async () => {
    userMock.getCashbackSummary.mockRejectedValue(new Error('boom'));
    const { container } = renderHeadline();
    await waitFor(() => {
      expect(userMock.getCashbackSummary).toHaveBeenCalled();
    });
    expect(container.querySelector('section')).toBeNull();
  });
});
