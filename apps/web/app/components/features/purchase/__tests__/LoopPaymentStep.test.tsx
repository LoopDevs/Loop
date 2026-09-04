// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router';

import type * as OrdersLoopModule from '~/services/orders-loop';
const getLoopOrderMock = vi.fn();
vi.mock('~/services/orders-loop', async () => {
  const actual = await vi.importActual<typeof OrdersLoopModule>('~/services/orders-loop');
  return {
    ...actual,
    getLoopOrder: (id: string) => getLoopOrderMock(id),
  };
});

import { LoopPaymentStep } from '../LoopPaymentStep';
import type {
  CreateLoopOrderResponse,
  LoopOrderPaymentInstructions,
  LoopOrderView,
} from '~/services/orders-loop';

function wrap(ui: React.ReactElement): React.JSX.Element {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  );
}

const ADDRESS = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVW';
const XLM_URI = `web+stellar:pay?destination=${ADDRESS}&amount=10.0000000`;

function mkPayment(
  overrides: Partial<LoopOrderPaymentInstructions> = {},
): LoopOrderPaymentInstructions {
  return {
    ctxPaymentId: 'pay-1',
    cryptoCurrency: 'XLM',
    cryptoAmount: '10.0000000',
    address: ADDRESS,
    paymentUrls: { XLM: XLM_URI },
    amountMinor: '1000',
    currency: 'USD',
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    ...overrides,
  };
}

function mkCreate(
  paymentOverrides: Partial<LoopOrderPaymentInstructions> = {},
): CreateLoopOrderResponse {
  return {
    orderId: '12345678-aaaa-bbbb-cccc-000000000000',
    state: 'unpaid',
    payment: mkPayment(paymentOverrides),
  };
}

function mkOrder(overrides: Partial<LoopOrderView> = {}): LoopOrderView {
  return {
    id: '12345678-aaaa-bbbb-cccc-000000000000',
    merchantId: 'm1',
    state: 'unpaid',
    faceValueMinor: '1000',
    currency: 'USD',
    chargeMinor: '1000',
    chargeCurrency: 'USD',
    userCashbackMinor: '50',
    ctxOrderId: null,
    paymentCryptoCurrency: 'XLM',
    payment: mkPayment(),
    redeemCode: null,
    redeemPin: null,
    redeemUrl: null,
    failureReason: null,
    createdAt: new Date().toISOString(),
    fulfilledAt: null,
    failedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  getLoopOrderMock.mockReset();
});
afterEach(cleanup);

describe('LoopPaymentStep — unpaid (ctx payment instructions)', () => {
  it('renders the fiat charge, crypto amount + currency, and deposit address', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText(/Waiting for payment/i));
    expect(screen.getByText(/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567/)).toBeDefined();
    expect(screen.getByText(/\$10\.00/)).toBeDefined();
    expect(screen.getByText(/10\.0000000 XLM/)).toBeDefined();
    expect(screen.getByRole('link', { name: /Open in wallet/i })).toBeDefined();
  });

  it('shows a countdown to the payment-window expiry', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText(/Time remaining/i));
  });

  it('hides the countdown when the server reported no expiry', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkCreate({ expiresAt: null })} />));
    await waitFor(() => screen.getByText(/Waiting for payment/i));
    expect(screen.queryByText(/Time remaining/i)).toBeNull();
  });

  it('shows "Payment window expired" once the expiry passes', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(
      wrap(
        <LoopPaymentStep
          create={mkCreate({ expiresAt: new Date(Date.now() - 1000).toISOString() })}
        />,
      ),
    );
    // Rendered twice: the visible countdown line + the sr-only announcement.
    await waitFor(() =>
      expect(screen.getAllByText(/Payment window expired/i).length).toBeGreaterThan(0),
    );
  });

  it('omits the "Open in wallet" link when no payment URI exists for the currency', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkCreate({ paymentUrls: {} })} />));
    await waitFor(() => screen.getByText(/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567/));
    expect(screen.queryByRole('link', { name: /Open in wallet/i })).toBeNull();
  });

  it('renders address-only instructions when cryptoAmount is null', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(
      wrap(<LoopPaymentStep create={mkCreate({ cryptoAmount: null, cryptoCurrency: 'DOGE' })} />),
    );
    await waitFor(() => screen.getByText('DOGE'));
    expect(screen.getByText(/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567/)).toBeDefined();
  });

  it('updates the state label as the order transitions to paid', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder({ state: 'paid', payment: null }));
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByRole('heading', { name: /Payment received/i }));
    expect(screen.getByText(/on the way/i)).toBeDefined();
  });

  it('shows the failure reason on a rejected order', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'rejected',
        payment: null,
        failureReason: 'CTX returned 500',
        failedAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText('CTX returned 500'));
  });

  it('shows a generic failure body on refunded / expired without a reason', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({ state: 'refunded', payment: null, failedAt: new Date().toISOString() }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText(/Order refunded/i));
  });

  it('calls onTerminal exactly once when the state becomes terminal', async () => {
    const spy = vi.fn();
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} onTerminal={spy} />));
    await waitFor(() => expect(spy).toHaveBeenCalledOnce());
    expect((spy.mock.calls[0]![0] as LoopOrderView).ctxOrderId).toBe('ctx-abc');
  });

  it('copy buttons write to navigator.clipboard', async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getAllByRole('button', { name: /Copy/i }));
    const buttons = screen.getAllByRole('button', { name: /Copy/i });
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });
    expect(writeText).toHaveBeenCalled();
  });
});

// PAYMENTURI-UNGATED (XSS): the wallet URI comes from CTX's upstream
// `paymentUrls` map. Dropped into an `<a href>` unvalidated, a
// `javascript:`/`data:` scheme executes on tap — with app privileges inside
// the Capacitor native WebView. The scheme must be gated so a dangerous URI
// never becomes a live href, while a legitimate wallet URI passes through.
describe('LoopPaymentStep — payment URI XSS gate', () => {
  const MALICIOUS: Array<[string, string]> = [
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
  ];

  it('passes a legitimate web+stellar: URI through to the href', async () => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    const link = await waitFor(() => screen.getByRole('link', { name: /Open in wallet/i }));
    expect(link.getAttribute('href')).toBe(XLM_URI);
  });

  it('passes a legitimate BIP21-style dash: URI through to the href', async () => {
    const DASH_URI = 'dash:XekiLaxnqpFb2m4NQAEcsKutZcZgcyfo6W?amount=0.5';
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(
      wrap(
        <LoopPaymentStep
          create={mkCreate({ cryptoCurrency: 'DASH', paymentUrls: { DASH: DASH_URI } })}
        />,
      ),
    );
    const link = await waitFor(() => screen.getByRole('link', { name: /Open in wallet/i }));
    expect(link.getAttribute('href')).toBe(DASH_URI);
  });

  it.each(MALICIOUS)('does NOT render a %s URI as a live href', async (_scheme, uri) => {
    getLoopOrderMock.mockResolvedValue(mkOrder());
    render(wrap(<LoopPaymentStep create={mkCreate({ paymentUrls: { XLM: uri } })} />));
    // The address copy path still renders (the user can still pay),
    // but the dangerous URI is dropped — no "Open in wallet" anchor.
    await waitFor(() => screen.getByText(/GABCDEFGHIJKLMNOPQRSTUVWXYZ234567/));
    expect(screen.queryByRole('link', { name: /Open in wallet/i })).toBeNull();
    // Belt-and-braces: the raw payload never reaches any href attribute.
    for (const anchor of document.querySelectorAll('a')) {
      expect(anchor.getAttribute('href')).not.toBe(uri);
    }
  });
});

describe('LoopPaymentStep — fulfilled redemption', () => {
  it('shows the code + PIN with copy buttons when both are present', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: 'CARD-123-XYZ',
        redeemPin: '4242',
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText('CARD-123-XYZ'));
    expect(screen.getByText('4242')).toBeDefined();
    // Two copy buttons (code + PIN)
    expect(screen.getAllByRole('button', { name: /Copy/i }).length).toBeGreaterThanOrEqual(2);
  });

  it('shows a "Open redemption link" anchor when redeemUrl is present', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: null,
        redeemPin: null,
        redeemUrl: 'https://redeem.example.com/abc',
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    const link = await waitFor(() => screen.getByRole('link', { name: /Open redemption link/i }));
    expect(link.getAttribute('href')).toBe('https://redeem.example.com/abc');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
  });

  // P2-03 (XSS): a redeemUrl is server/upstream-supplied. Dropped into an
  // `<a href>` unvalidated, a `javascript:` scheme executes on click —
  // with app privileges inside the Capacitor native WebView. The scheme
  // must be gated so a dangerous URL is neutralized to "no live link".
  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:msgbox(1)'],
  ])('does NOT render a %s redeemUrl as a live href', async (_scheme, redeemUrl) => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: null,
        redeemPin: null,
        redeemUrl,
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    // The fulfilled panel renders (fallback banner) but NO redemption
    // anchor — the dangerous scheme is dropped, not passed through.
    await waitFor(() => screen.getByText(/still coming through/i));
    expect(screen.queryByRole('link', { name: /Open redemption link/i })).toBeNull();
    // Belt-and-braces: the raw payload never reaches any href attribute.
    for (const anchor of document.querySelectorAll('a')) {
      expect(anchor.getAttribute('href')).not.toBe(redeemUrl);
    }
  });

  it('renders a fallback banner when all redemption fields are null', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: null,
        redeemPin: null,
        redeemUrl: null,
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText(/still coming through/i));
  });

  it('surfaces the cashback discount line when userCashbackMinor > 0', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: 'CODE',
        userCashbackMinor: '500', // $5.00
        currency: 'USD',
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText(/\$5\.00 cashback/i));
  });

  it('omits the cashback line when userCashbackMinor is 0', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: 'CODE',
        userCashbackMinor: '0',
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await waitFor(() => screen.getByText('CODE'));
    expect(screen.queryByText(/cashback/i)).toBeNull();
  });
});

// FE-05 (round 2): the fulfilled RedemptionBody renders the gift-card CODE
// and PIN as copyable Rows — this IS the fulfilled-redemption view for the
// Loop-native flow, so the user copies their secret from here on a primary
// path. Copying a redemption secret must route through `copySensitive` so
// the clipboard auto-clears after ~60s. The deposit address Row is NOT a
// secret and must stay on the clipboard. We drive the REAL clipboard module
// (copySensitive is not mocked) under fake timers and assert the auto-clear
// (an empty-string write) fires for the code/PIN Row but never for the
// address Row.
describe('LoopPaymentStep — FE-05 sensitive copy auto-clear', () => {
  const CLEAR_MS = 60_000;
  let writeText: ReturnType<typeof vi.fn>;
  let readText: ReturnType<typeof vi.fn>;

  /** True iff the clipboard was cleared (an empty-string write) at any point. */
  function wasCleared(): boolean {
    return writeText.mock.calls.some((call) => call[0] === '');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    writeText = vi.fn().mockResolvedValue(undefined);
    // Read-back guard in `copySensitive` reads the clipboard back before
    // clearing; model a clipboard that still holds whatever we last wrote,
    // so a scheduled sensitive clear is allowed to fire.
    readText = vi.fn().mockImplementation(async () => {
      const calls = writeText.mock.calls;
      return calls.length > 0 ? String(calls[calls.length - 1]![0]) : '';
    });
    Object.assign(navigator, { clipboard: { writeText, readText } });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Flush the react-query mount fetch (resolved-promise microtasks + its
  // internal 0ms batch) under fake timers so the polled body renders.
  async function settle(): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
    });
  }

  it('routes the fulfilled gift-card CODE Row through copySensitive (schedules the auto-clear)', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: 'CARD-123-XYZ',
        redeemPin: null,
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await settle();
    const copyBtn = screen.getByRole('button', { name: /Copy gift card code/i });
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    // The secret is written immediately, and not cleared before the delay.
    expect(writeText).toHaveBeenCalledWith('CARD-123-XYZ');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLEAR_MS - 1);
    });
    expect(wasCleared()).toBe(false);
    // Once the auto-clear delay elapses the secret is wiped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(wasCleared()).toBe(true);
  });

  it('routes the fulfilled PIN Row through copySensitive (schedules the auto-clear)', async () => {
    getLoopOrderMock.mockResolvedValue(
      mkOrder({
        state: 'fulfilled',
        payment: null,
        redeemCode: null,
        redeemPin: '4242',
        ctxOrderId: 'ctx-abc',
        fulfilledAt: new Date().toISOString(),
      }),
    );
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await settle();
    const copyBtn = screen.getByRole('button', { name: /Copy pin/i });
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(writeText).toHaveBeenCalledWith('4242');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLEAR_MS);
    });
    expect(wasCleared()).toBe(true);
  });

  it('does NOT schedule an auto-clear for the deposit address Row (it must persist)', async () => {
    // unpaid → CtxPaymentBody renders the deposit address as a copyable,
    // NON-sensitive Row. A user pastes it into their wallet, so wiping it
    // after 60s would break the payment flow — it stays put.
    getLoopOrderMock.mockResolvedValue(mkOrder({ state: 'unpaid' }));
    render(wrap(<LoopPaymentStep create={mkCreate()} />));
    await settle();
    const copyAddress = screen.getByRole('button', { name: /Copy to address/i });
    await act(async () => {
      fireEvent.click(copyAddress);
    });
    expect(writeText).toHaveBeenCalledWith(ADDRESS);
    // Long past any sensitive-clear delay: nothing is cleared. (This is the
    // control — it passes both pre-fix and post-fix.)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CLEAR_MS * 2);
    });
    expect(wasCleared()).toBe(false);
  });
});
