// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';
import { ApiException } from '@loop/shared';
import type { TreasurySnapshot } from '~/services/admin';
import type * as AdminModule from '~/services/admin';
import { AdminNav, failedPayoutsCount, operatorPoolStatus } from '../AdminNav';

afterEach(cleanup);

const { adminMock, authMock } = vi.hoisted(() => ({
  adminMock: {
    getTreasurySnapshot: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/admin', async (importActual) => {
  const actual = (await importActual()) as typeof AdminModule;
  return {
    ...actual,
    getTreasurySnapshot: () => adminMock.getTreasurySnapshot(),
  };
});

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

/** Helper — full operator-health row with zero telemetry by default. */
function makeOp(id: string, state: string): TreasurySnapshot['operatorPool']['operators'][number] {
  return {
    id,
    state,
    consecutiveFailures: 0,
    openedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
  };
}

function baseSnapshot(
  overrides?: Partial<TreasurySnapshot['operatorPool']>,
  payoutOverrides?: Partial<TreasurySnapshot['payouts']>,
): TreasurySnapshot {
  return {
    outstanding: {},
    totals: {},
    liabilities: {
      USDLOOP: { outstandingMinor: '0', issuer: null },
      GBPLOOP: { outstandingMinor: '0', issuer: null },
      EURLOOP: { outstandingMinor: '0', issuer: null },
    },
    assets: { USDC: { stroops: null }, XLM: { stroops: null } },
    payouts: {
      pending: '0',
      submitted: '0',
      confirmed: '0',
      failed: '0',
      ...(payoutOverrides ?? {}),
    },
    operatorPool: {
      size: 2,
      operators: [makeOp('op-1', 'closed'), makeOp('op-2', 'closed')],
      ...(overrides ?? {}),
    },
  };
}

function renderAt(path: string): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <AdminNav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authMock.isAuthenticated = true;
  adminMock.getTreasurySnapshot.mockReset();
});

describe('AdminNav — tabs', () => {
  beforeEach(() => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot());
  });

  it('renders one link per admin section with the correct hrefs', () => {
    renderAt('/admin/cashback');
    // Ignore the "CTX healthy" pill link; only the three tab links
    // have href targeting admin sections.
    const tabHrefs = ['/admin/cashback', '/admin/treasury', '/admin/payouts'];
    for (const href of tabHrefs) {
      expect(screen.getAllByRole('link').some((l) => l.getAttribute('href') === href)).toBe(true);
    }
  });

  it('marks the Cashback tab as aria-current=page on /admin/cashback', () => {
    renderAt('/admin/cashback');
    expect(screen.getByRole('link', { name: 'Cashback' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'Treasury' }).getAttribute('aria-current')).toBeNull();
  });

  it('marks the Payouts tab as active on nested paths like /admin/payouts/abc', () => {
    renderAt('/admin/payouts/abc-123');
    expect(screen.getByRole('link', { name: 'Payouts' }).getAttribute('aria-current')).toBe('page');
  });

  it('does not highlight any tab on /admin (no subpath)', () => {
    renderAt('/admin');
    for (const label of ['Cashback', 'Treasury', 'Payouts']) {
      expect(screen.getByRole('link', { name: label }).getAttribute('aria-current')).toBeNull();
    }
  });
});

describe('AdminNav — CTX status pill', () => {
  it('renders "CTX healthy" when every operator circuit is closed', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot());
    renderAt('/admin/cashback');
    await waitFor(() => {
      expect(screen.getByText(/CTX healthy/)).toBeDefined();
    });
  });

  it('renders "CTX degraded" when any operator is half_open', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(
      baseSnapshot({
        operators: [makeOp('op-1', 'closed'), makeOp('op-2', 'half_open')],
      }),
    );
    renderAt('/admin/cashback');
    await waitFor(() => {
      expect(screen.getByText(/CTX degraded/)).toBeDefined();
    });
  });

  it('renders "CTX unavailable" when any operator circuit is open', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(
      baseSnapshot({
        operators: [makeOp('op-1', 'open'), makeOp('op-2', 'closed')],
      }),
    );
    renderAt('/admin/cashback');
    await waitFor(() => {
      expect(screen.getByText(/CTX unavailable/)).toBeDefined();
    });
  });

  it('renders "CTX unconfigured" when the pool is empty', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot({ size: 0, operators: [] }));
    renderAt('/admin/cashback');
    await waitFor(() => {
      expect(screen.getByText(/CTX unconfigured/)).toBeDefined();
    });
  });

  it('hides the pill entirely for non-admin callers (401 response)', async () => {
    adminMock.getTreasurySnapshot.mockRejectedValue(
      new ApiException(401, { code: 'UNAUTHORIZED', message: 'nope' }),
    );
    renderAt('/admin/cashback');
    // Wait until the error has propagated and the pill has unmounted.
    // The initial render shows "CTX status loading"; after the rejection
    // settles, `denied` becomes true and the pill is hidden entirely.
    await waitFor(() => {
      expect(screen.queryByText(/CTX /)).toBeNull();
    });
  });

  it('links the pill to /admin/treasury for one-click drill-in', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot());
    renderAt('/admin/cashback');
    await waitFor(() => {
      const pill = screen.getByText(/CTX healthy/).closest('a');
      expect(pill?.getAttribute('href')).toBe('/admin/treasury');
    });
  });
});

describe('AdminNav — failed-payouts badge', () => {
  it('does not render the badge when failed count is zero', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot());
    renderAt('/admin/cashback');
    // Wait for the snapshot to resolve so we're not just seeing the
    // pre-fetch render.
    await waitFor(() => {
      expect(screen.getByText(/CTX /)).toBeDefined();
    });
    expect(screen.queryByText(/failed$/i)).toBeNull();
  });

  it('renders a red badge with the failed count when > 0', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot(undefined, { failed: '3' }));
    renderAt('/admin/cashback');
    await waitFor(() => {
      expect(screen.getByText(/3 failed/)).toBeDefined();
    });
  });

  it('caps the label at 99+ when the backlog spirals', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot(undefined, { failed: '142' }));
    renderAt('/admin/cashback');
    await waitFor(() => {
      expect(screen.getByText(/99\+ failed/)).toBeDefined();
    });
  });

  it('links the badge to /admin/payouts?state=failed for drill-in', async () => {
    adminMock.getTreasurySnapshot.mockResolvedValue(baseSnapshot(undefined, { failed: '7' }));
    renderAt('/admin/cashback');
    await waitFor(() => {
      const badge = screen.getByText(/7 failed/).closest('a');
      expect(badge?.getAttribute('href')).toBe('/admin/payouts?state=failed');
    });
  });

  it('hides the badge for non-admin callers (401 response)', async () => {
    adminMock.getTreasurySnapshot.mockRejectedValue(
      new ApiException(401, { code: 'UNAUTHORIZED', message: 'nope' }),
    );
    renderAt('/admin/cashback');
    await waitFor(() => {
      expect(screen.queryByText(/failed/)).toBeNull();
    });
  });
});

describe('failedPayoutsCount (pure)', () => {
  it('returns 0 when payouts is undefined', () => {
    expect(failedPayoutsCount(undefined)).toBe(0);
  });
  it('parses a positive bigint-string', () => {
    expect(failedPayoutsCount({ pending: '0', submitted: '0', confirmed: '0', failed: '17' })).toBe(
      17,
    );
  });
  it('clamps negatives to 0 (guards a buggy server)', () => {
    expect(failedPayoutsCount({ pending: '0', submitted: '0', confirmed: '0', failed: '-4' })).toBe(
      0,
    );
  });
  it('returns 0 on unparseable strings', () => {
    expect(
      failedPayoutsCount({ pending: '0', submitted: '0', confirmed: '0', failed: 'nope' }),
    ).toBe(0);
  });
});

describe('operatorPoolStatus (pure)', () => {
  it('returns unknown when the pool is undefined', () => {
    expect(operatorPoolStatus(undefined)).toBe('unknown');
  });
  it('returns unconfigured when size is 0', () => {
    expect(operatorPoolStatus({ size: 0, operators: [] })).toBe('unconfigured');
  });
  it('returns healthy when all operators are closed', () => {
    expect(
      operatorPoolStatus({
        size: 2,
        operators: [makeOp('a', 'closed'), makeOp('b', 'closed')],
      }),
    ).toBe('healthy');
  });
  it('returns degraded when any operator is half_open', () => {
    expect(
      operatorPoolStatus({
        size: 2,
        operators: [makeOp('a', 'closed'), makeOp('b', 'half_open')],
      }),
    ).toBe('degraded');
  });
  it('returns unavailable when any operator is open, overriding half_open', () => {
    expect(
      operatorPoolStatus({
        size: 2,
        operators: [makeOp('a', 'open'), makeOp('b', 'half_open')],
      }),
    ).toBe('unavailable');
  });
});
