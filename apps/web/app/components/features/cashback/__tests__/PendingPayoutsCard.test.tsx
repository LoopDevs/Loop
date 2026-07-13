// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Routes, Route } from 'react-router';
import type * as UserModule from '~/services/user';
import { PendingPayoutsCard, formatAssetAmount } from '../PendingPayoutsCard';

afterEach(cleanup);

const { userMock } = vi.hoisted(() => ({
  userMock: {
    getUserPendingPayouts: vi.fn(),
  },
}));

vi.mock('~/services/user', async (importActual) => {
  const actual = (await importActual()) as typeof UserModule;
  return {
    ...actual,
    getUserPendingPayouts: () => userMock.getUserPendingPayouts(),
  };
});

vi.mock('~/hooks/query-retry', () => ({ shouldRetry: () => false }));
// A2-1156: auth-gate in the component → tests need to pretend
// the user is authenticated so the query fires.
vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: true, user: null, refreshUser: () => {} }),
}));

function renderCard(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PendingPayoutsCard />
    </QueryClientProvider>,
  );
}

// Renders the card under an explicit `/:country/:lang` URL so the row's
// `useLocaleTag()` resolves to that market's locale (ADR 034) — this is what
// lets us assert the row timestamp follows the *route* locale, not the host
// default. Mirrors `settings.cashback.test`'s `renderPageAtLocale`.
function renderCardAtLocale(country: string, lang: string): ReturnType<typeof render> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/${country}/${lang}/settings/cashback`]}>
        <Routes>
          <Route path="/:country/:lang/settings/cashback" element={<PendingPayoutsCard />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('formatAssetAmount', () => {
  it('strips trailing zeros and preserves the asset code', () => {
    expect(formatAssetAmount('12500000', 'GBPLOOP')).toBe('1.25 GBPLOOP');
  });

  it('renders whole numbers without a decimal', () => {
    expect(formatAssetAmount('10000000', 'USDLOOP')).toBe('1 USDLOOP');
  });

  it('falls back to an em-dash on BigInt parse failure', () => {
    expect(formatAssetAmount('nope', 'EURLOOP')).toBe('—');
  });
});

describe('<PendingPayoutsCard />', () => {
  it('hides on empty — new users see nothing', async () => {
    userMock.getUserPendingPayouts.mockResolvedValue({ payouts: [] });
    const { container } = renderCard();
    await waitFor(() => {
      expect(container.querySelector('[aria-labelledby="payouts-heading"]')).toBeNull();
    });
  });

  it('hides silently on fetch error', async () => {
    userMock.getUserPendingPayouts.mockRejectedValue(new Error('boom'));
    const { container } = renderCard();
    await waitFor(() => {
      expect(userMock.getUserPendingPayouts).toHaveBeenCalled();
    });
    expect(container.querySelector('[aria-labelledby="payouts-heading"]')).toBeNull();
  });

  it('renders each payout with state pill and explorer link when confirmed', async () => {
    userMock.getUserPendingPayouts.mockResolvedValue({
      payouts: [
        {
          id: 'p-1',
          assetCode: 'GBPLOOP',
          assetIssuer: 'GBP_ISSUER',
          amountStroops: '12500000',
          state: 'confirmed',
          txHash: '0123456789abcdef',
          attempts: 1,
          createdAt: '2026-04-01T00:00:00Z',
          submittedAt: '2026-04-01T00:00:10Z',
          confirmedAt: '2026-04-01T00:00:30Z',
          failedAt: null,
        },
        {
          id: 'p-2',
          assetCode: 'USDLOOP',
          assetIssuer: 'USD_ISSUER',
          amountStroops: '5000000',
          state: 'pending',
          txHash: null,
          attempts: 0,
          createdAt: '2026-04-02T00:00:00Z',
          submittedAt: null,
          confirmedAt: null,
          failedAt: null,
        },
      ],
    });
    renderCard();
    await waitFor(() => {
      expect(screen.getByText('1.25 GBPLOOP')).toBeDefined();
    });
    expect(screen.getByText('0.5 USDLOOP')).toBeDefined();
    expect(screen.getByText('Confirmed')).toBeDefined();
    expect(screen.getByText('Queued')).toBeDefined();
    const link = screen.getByRole('link', { name: /View tx/ });
    expect(link.getAttribute('href')).toBe(
      'https://stellar.expert/explorer/public/tx/0123456789abcdef',
    );
    // Pending row has no hash → no explorer link on that row. Only
    // one link total (the confirmed row's).
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  // The row *timestamp* must ALSO follow the active route locale (ADR 034),
  // not the browser/host default — same defect class as the settings.cashback
  // ledger date (P2-DATE) and the money figures. Only `en` ships as a
  // language, so the locale axis here is the *country*: rendered under
  // `/ca/en` → `en-CA`, whose day-period for these options is the dotted
  // lowercase "a.m."/"p.m." token. Neither plausible CI/host default produces
  // it — en-US renders uppercase "PM" (no dots) and en-GB uses a 24-hour clock
  // with no day-period at all — so a match proves the *route* locale, not
  // `navigator.language`, drove `formatDateTime`. TZ-robust: the dotted style
  // is en-CA's marker whether the hour lands as a.m. or p.m., and the instant
  // stays "Apr 20, 2026" at any host TZ, so the exact hour never matters.
  it('formats the payout row date in the active route locale (en-CA dotted day-period)', async () => {
    userMock.getUserPendingPayouts.mockResolvedValue({
      payouts: [
        {
          id: 'p-ca',
          assetCode: 'GBPLOOP',
          assetIssuer: 'GBP_ISSUER',
          amountStroops: '12500000',
          state: 'confirmed',
          // No hash → no "· View tx" tail, so the date sits alone in its <p>
          // and the format assertion can be anchored exactly.
          txHash: null,
          attempts: 1,
          createdAt: '2026-04-20T12:00:00.000Z',
          submittedAt: '2026-04-20T12:00:10.000Z',
          confirmedAt: '2026-04-20T12:00:30.000Z',
          failedAt: null,
        },
      ],
    });
    renderCardAtLocale('ca', 'en');
    expect(await screen.findByText(/^Apr \d{1,2}, 2026, \d{1,2}:\d{2}\s[ap]\.m\.$/)).toBeTruthy();
  });
});
