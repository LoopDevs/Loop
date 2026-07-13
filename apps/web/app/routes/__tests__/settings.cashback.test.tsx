// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';

const { historyMock, authMock } = vi.hoisted(() => ({
  historyMock: {
    getCashbackHistory: vi.fn(),
    getUserPendingPayouts: vi.fn(),
    getMyCredits: vi.fn(),
    getMe: vi.fn(),
  },
  authMock: {
    isAuthenticated: true,
  },
}));

vi.mock('~/services/user', () => ({
  getCashbackHistory: (opts?: { limit?: number; before?: string }) =>
    historyMock.getCashbackHistory(opts),
  getUserPendingPayouts: (opts?: { limit?: number; before?: string; state?: string }) =>
    historyMock.getUserPendingPayouts(opts),
  getMyCredits: () => historyMock.getMyCredits(),
  getMe: () => historyMock.getMe(),
  // Monthly bar chart (#576 / #577) self-hides on reject; returning
  // a rejected promise here keeps the pre-existing tests focused on
  // the history + payouts sections without mocking a new shape.
  getCashbackMonthly: () => Promise.reject(new Error('chart not mocked in this suite')),
  // FlywheelChip (#599) — same silent-hide-on-reject pattern.
  getUserFlywheelStats: () => Promise.reject(new Error('chip not mocked in this suite')),
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: authMock.isAuthenticated }),
}));

// Phase-2 surface: useAppConfig defaults phase1Only=true (the shipping reality),
// so Phase2Gate would render "Coming soon". Force phase1Only=false here so these
// tests exercise the actual cashback feature rather than the launch gate.
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: false }, isLoading: false }),
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

beforeEach(() => {
  authMock.isAuthenticated = true;
  historyMock.getCashbackHistory.mockReset();
  // Every existing test expects the pending-payouts section to stay
  // hidden; default the fetch to an empty list so we don't have to
  // touch every case. Pending-payouts-specific tests below override.
  historyMock.getUserPendingPayouts.mockReset();
  historyMock.getUserPendingPayouts.mockResolvedValue({ payouts: [] });
  // Default balance-card fetch to an empty-rows snapshot so the
  // card renders its "no cashback yet" copy and existing tests
  // that don't care about the card don't need to stub it.
  historyMock.getMyCredits.mockReset();
  historyMock.getMyCredits.mockResolvedValue({ credits: [] });
  // Default to a user with a linked wallet so the LinkWalletNudge
  // hides itself — existing tests don't care about the nudge.
  // Nudge-specific tests below can override.
  historyMock.getMe.mockReset();
  historyMock.getMe.mockResolvedValue({
    id: 'u1',
    email: 'u@loop.test',
    isAdmin: false,
    homeCurrency: 'GBP',
    stellarAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGH',
    homeCurrencyBalanceMinor: '0',
  });
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

describe('SettingsCashbackRoute — on-chain payouts section', () => {
  it('does not render the section when the user has no payout rows', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getUserPendingPayouts.mockResolvedValue({ payouts: [] });
    renderPage();
    // Empty state of the ledger section still renders; the payouts
    // section should simply be absent.
    await screen.findByText(/No cashback activity yet/i);
    expect(screen.queryByText(/On-chain payouts/i)).toBeNull();
  });

  it('renders the section with a state pill + asset amount when a row exists', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getUserPendingPayouts.mockResolvedValue({
      payouts: [
        {
          id: 'p-1',
          orderId: 'o-1',
          assetCode: 'GBPLOOP',
          assetIssuer: 'GISSUER',
          amountStroops: '12500000',
          state: 'confirmed',
          txHash: 'abc123def456',
          attempts: 1,
          createdAt: '2026-04-20T10:00:00.000Z',
          submittedAt: '2026-04-20T10:01:00.000Z',
          confirmedAt: '2026-04-20T10:02:00.000Z',
          failedAt: null,
        },
      ],
    });
    renderPage();
    await screen.findByText(/On-chain payouts/i);
    // 12,500,000 stroops = 1.25 GBPLOOP (7-decimal asset)
    expect(screen.getByText(/1\.25 GBPLOOP/)).toBeDefined();
    expect(screen.getByText(/Confirmed/)).toBeDefined();
  });

  it('links confirmed payouts to stellar.expert using the tx hash', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getUserPendingPayouts.mockResolvedValue({
      payouts: [
        {
          id: 'p-1',
          orderId: 'o-1',
          assetCode: 'USDLOOP',
          assetIssuer: 'GISSUER',
          amountStroops: '10000000',
          state: 'confirmed',
          txHash: 'tx-hash-789',
          attempts: 1,
          createdAt: '2026-04-20T10:00:00.000Z',
          submittedAt: '2026-04-20T10:01:00.000Z',
          confirmedAt: '2026-04-20T10:02:00.000Z',
          failedAt: null,
        },
      ],
    });
    renderPage();
    const link = await screen.findByRole('link', { name: /View tx/i });
    expect(link.getAttribute('href')).toBe('https://stellar.expert/explorer/public/tx/tx-hash-789');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('does not show a tx link on submitted rows (no hash yet)', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getUserPendingPayouts.mockResolvedValue({
      payouts: [
        {
          id: 'p-1',
          orderId: 'o-1',
          assetCode: 'EURLOOP',
          assetIssuer: 'GISSUER',
          amountStroops: '5000000',
          state: 'submitted',
          txHash: null,
          attempts: 1,
          createdAt: '2026-04-20T10:00:00.000Z',
          submittedAt: '2026-04-20T10:01:00.000Z',
          confirmedAt: null,
          failedAt: null,
        },
      ],
    });
    renderPage();
    await screen.findByText(/Submitting/);
    expect(screen.queryByRole('link', { name: /View tx/i })).toBeNull();
  });

  it('hides the section silently when the fetch errors (ledger stays authoritative)', async () => {
    historyMock.getCashbackHistory.mockResolvedValue({ entries: [] });
    historyMock.getUserPendingPayouts.mockRejectedValue(new Error('network down'));
    renderPage();
    // Ledger section still rendered.
    await screen.findByText(/No cashback activity yet/i);
    expect(screen.queryByText(/On-chain payouts/i)).toBeNull();
  });
});
