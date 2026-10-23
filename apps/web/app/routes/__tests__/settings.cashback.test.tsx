// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type { PayoutView, UserAccountView } from '@loop/shared';

const { historyMock, authMock } = vi.hoisted(() => ({
  historyMock: {
    getCashbackHistory: vi.fn(),
    getMyAccount: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/user', () => ({
  getMe: () => new Promise(() => undefined),
  getCashbackHistory: (opts?: { limit?: number; before?: string }) =>
    historyMock.getCashbackHistory(opts),
  getMyAccount: () => historyMock.getMyAccount(),
  // Monthly bar chart (#576 / #577) self-hides on reject; returning
  // a rejected promise here keeps the pre-existing tests focused on
  // the history + payouts sections without mocking a new shape.
  getCashbackMonthly: () => Promise.reject(new Error('chart not mocked in this suite')),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: {}, isLoading: false }),
}));

vi.mock('~/hooks/query-retry', () => ({
  shouldRetry: () => false,
}));

vi.mock('~/components/ui/Spinner', () => ({
  Spinner: () => <div data-testid="spinner" />,
}));

import SettingsCashbackRoute from '../settings.cashback';

function renderPage(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <SettingsCashbackRoute />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Renders the route under an explicit `/:country/:lang` URL so the page's
// `useLocaleTag()` resolves to that market's locale (ADR 034) — this is what
// lets us assert that ledger amounts follow the *route* locale, not the
// browser/host default. `getCashbackHistory` etc. are stubbed by the caller.
function renderPageAtLocale(country: string, lang: string): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/${country}/${lang}/settings/cashback`]}>
        <Routes>
          <Route path="/:country/:lang/settings/cashback" element={<SettingsCashbackRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type Entry = {
  id: string;
  type: 'cashback' | 'interest' | 'spend' | 'withdrawal' | 'refund' | 'adjustment';
  amountMinor: string;
  currency: string;
  referenceType: string | null;
  referenceId: string | null;
  createdAt: string;
};

function mkEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: overrides.id ?? 'tx-' + Math.random().toString(36).slice(2, 8),
    type: overrides.type ?? 'cashback',
    amountMinor: overrides.amountMinor ?? '150',
    currency: overrides.currency ?? 'USD',
    referenceType: overrides.referenceType ?? 'order',
    referenceId: overrides.referenceId ?? 'abcd1234ef',
    createdAt: overrides.createdAt ?? '2026-04-20T10:00:00.000Z',
  };
}

function emptyAccount(overrides: Partial<UserAccountView> = {}): UserAccountView {
  return {
    id: 'acct-1',
    userId: 'ctx-1',
    wallet: [],
    savings: [],
    savingsPrincipal: [],
    pendingOperations: [],
    linkedWallets: [],
    payouts: [],
    created: '2026-09-01T00:00:00Z',
    updated: '2026-09-23T10:00:00Z',
    ...overrides,
  };
}

function payout(overrides: Partial<PayoutView> = {}): PayoutView {
  return {
    id: 'p-1',
    status: 'complete',
    chain: 'XLM',
    address: 'G' + 'A'.repeat(55),
    currency: 'XLM.GBPLOOP',
    amount: '1.2500000',
    giftCardId: 'gc-1',
    txHash: null,
    transferId: null,
    error: null,
    created: '2026-09-23T10:00:00Z',
    finalised: '2026-09-23T10:00:05Z',
    ...overrides,
  };
}

beforeEach(() => {
  authMock.isAuthenticated = true;
  historyMock.getCashbackHistory.mockReset();
  historyMock.getMyAccount.mockReset();
  historyMock.getMyAccount.mockResolvedValue(emptyAccount());
});

afterEach(cleanup);

describe('SettingsCashbackRoute', () => {
  it('shows the sign-in prompt when unauthenticated', async () => {
    authMock.isAuthenticated = false;
    renderPage();
    expect(await screen.findByText(/Sign in to see your cashback activity/i)).toBeTruthy();
    expect(historyMock.getCashbackHistory).not.toHaveBeenCalled();
  });

  it('renders the empty state when the first page returns no rows', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    renderPage();
    expect(await screen.findByText(/No cashback activity yet/i)).toBeTruthy();
  });

  it('renders the entries list with formatted amount + label', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({
      entries: [
        mkEntry({ id: 'tx-a', type: 'cashback', amountMinor: '250', currency: 'USD' }),
        mkEntry({
          id: 'tx-b',
          type: 'withdrawal',
          amountMinor: '-100',
          currency: 'USD',
          referenceType: null,
          referenceId: null,
        }),
      ],
    });
    renderPage();
    expect(await screen.findByText(/Cashback/)).toBeTruthy();
    expect(await screen.findByText(/Withdrawal/)).toBeTruthy();
  });

  it('shows Load more when the server returns a full page and fetches the next cursor when clicked', async () => {
    const firstPage = Array.from({ length: 25 }, (_, i) =>
      mkEntry({
        id: `first-${i}`,
        createdAt: `2026-04-${String(20 - (i % 20)).padStart(2, '0')}T10:00:00.000Z`,
      }),
    );
    const secondPage = [mkEntry({ id: 'second-1' })];
    historyMock.getCashbackHistory
      .mockResolvedValueOnce({ entries: firstPage })
      .mockResolvedValueOnce({ entries: secondPage });

    renderPage();

    const loadMore = await screen.findByRole('button', { name: /Load more/i });
    await act(async () => {
      fireEvent.click(loadMore);
    });

    await waitFor(() => {
      expect(historyMock.getCashbackHistory).toHaveBeenCalledTimes(2);
    });
    // Second call should pass the `before` cursor from the last row of page 1.
    const secondCall = historyMock.getCashbackHistory.mock.calls[1]?.[0];
    expect(secondCall?.before).toBe(firstPage[firstPage.length - 1]?.createdAt);
  });

  it('hides Load more when the first page returns fewer rows than the page size', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [mkEntry()] });
    renderPage();
    await screen.findByText(/Cashback/);
    expect(screen.queryByRole('button', { name: /Load more/i })).toBeNull();
  });

  it('surfaces an error message when the fetch fails', async () => {
    historyMock.getCashbackHistory.mockRejectedValue(new Error('network down'));
    renderPage();
    expect(await screen.findByText(/Couldn.+t load this page/i)).toBeTruthy();
  });
});

describe('SettingsCashbackRoute — ledger amount formatting (AUD-12)', () => {
  // The ledger amount must follow the *active route* locale (ADR 034), not the
  // browser/host default. India's en-IN grouping ("lakh": ₹12,34,567 rather
  // than ₹1,234,567) is a signature no en-US/en-GB default produces, so this
  // pins that the route locale — not `navigator.language` — drives the figure.
  it('formats the ledger amount in the active route locale (en-IN lakh grouping)', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({
      entries: [
        mkEntry({
          id: 'tx-inr',
          type: 'cashback',
          amountMinor: '123456789',
          currency: 'INR',
          referenceType: null,
          referenceId: null,
        }),
      ],
    });
    renderPageAtLocale('in', 'en');
    // en-IN → lakh grouping + the ledger's leading '+' for a credit.
    expect(await screen.findByText('+₹12,34,567.89')).toBeTruthy();
  });

  // Guards the ledger's signDisplay:'always' convention: credits carry a
  // leading '+', debits a '-'. Rendered under a fixed route locale (en-GB) so
  // the assertion is deterministic on any host. A naive swap to the shared
  // formatter (which omits the '+') would drop the credit sign and fail here.
  it("preserves '+' for credits and '-' for debits under a fixed route locale", async () => {
    historyMock.getCashbackHistory.mockResolvedValue({
      entries: [
        mkEntry({ id: 'tx-credit', type: 'cashback', amountMinor: '250', currency: 'USD' }),
        mkEntry({
          id: 'tx-debit',
          type: 'withdrawal',
          amountMinor: '-100',
          currency: 'USD',
          referenceType: null,
          referenceId: null,
        }),
      ],
    });
    renderPageAtLocale('gb', 'en');
    // en-GB renders USD with the disambiguating "US$" symbol.
    expect(await screen.findByText('+US$2.50')).toBeTruthy();
    expect(await screen.findByText('-US$1.00')).toBeTruthy();
  });

  // The ledger row *timestamp* must ALSO follow the active route locale (ADR
  // 034), not the browser/host default — same defect class as the amount
  // above (P2-DATE). Only `en` ships as a language, so the locale axis here is
  // the *country*: rendered under `/ca/en` → `en-CA`, whose day-period for
  // these options is the dotted lowercase "a.m."/"p.m.". Neither of the two
  // plausible CI/host defaults produces that token — en-US renders uppercase
  // "PM" (no dots) and en-GB uses a 24-hour clock with no day-period at all —
  // so a match proves the *route* locale, not `navigator.language`, drove
  // `formatDate`. The assertion is timezone-robust: the dotted-lowercase style
  // is en-CA's day-period whether the hour lands as a.m. or p.m., and "Apr"
  // stays April at any host TZ, so the exact hour/day never matters.
  it('formats the ledger date in the active route locale (en-CA dotted day-period)', async () => {
    // Build the row directly rather than via `mkEntry`: its `?? 'order'`
    // default coerces an explicit `referenceType: null` back to a reference,
    // which would render inside the SAME <p> as the date. We want the date
    // alone so the format assertion can be anchored exactly.
    const row: Entry = {
      id: 'tx-ca',
      type: 'cashback',
      amountMinor: '250',
      currency: 'CAD',
      referenceType: null,
      referenceId: null,
      createdAt: '2026-04-20T12:00:00.000Z',
    };
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [row] });
    renderPageAtLocale('ca', 'en');
    // en-CA: month-first date + dotted lowercase day-period ("Apr 20, 2026,
    // 12:00 p.m."). The `[ap]\.m\.` token is produced by neither the en-US
    // (uppercase "PM") nor en-GB (24h, no marker) host default, so this is
    // red unless the route locale is threaded into `formatDate`.
    expect(await screen.findByText(/^Apr \d+, 2026, \d{1,2}:\d{2}\s[ap]\.m\.$/)).toBeTruthy();
  });
});

describe('SettingsCashbackRoute — payouts section', () => {
  it('does not render the section when the account has no payouts', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    renderPage();
    await screen.findByText(/No cashback activity yet/i);
    expect(screen.queryByText(/^Payouts$/i)).toBeNull();
  });

  it('renders a status pill and the amount as the pegged fiat', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getMyAccount.mockResolvedValue(emptyAccount({ payouts: [payout()] }));
    renderPage();
    expect(await screen.findByText(/^Payouts$/i)).toBeTruthy();
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText(/£1\.25/)).toBeTruthy();
  });

  it('links completed payouts to stellar.expert by tx hash', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getMyAccount.mockResolvedValue(
      emptyAccount({ payouts: [payout({ txHash: 'abc123' })] }),
    );
    renderPage();
    const link = (await screen.findByRole('link', { name: /View tx/i })) as HTMLAnchorElement;
    expect(link.href).toContain('stellar.expert/explorer/public/tx/abc123');
  });

  it('shows no tx link on a pending payout', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getMyAccount.mockResolvedValue(
      emptyAccount({ payouts: [payout({ status: 'pending', finalised: null })] }),
    );
    renderPage();
    expect(await screen.findByText('Sending')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /View tx/i })).toBeNull();
  });

  it('hides the section silently when the account fetch errors', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getMyAccount.mockRejectedValue(new Error('network down'));
    renderPage();
    await screen.findByText(/No cashback activity yet/i);
    await waitFor(() => expect(historyMock.getMyAccount).toHaveBeenCalled());
    expect(screen.queryByText(/^Payouts$/i)).toBeNull();
  });
});
