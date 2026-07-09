// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Onboarding } from '../Onboarding';
import { OnboardingDesktop } from '../OnboardingDesktop';

/**
 * U-2 / UX-01 (docs/ux-pass-2026-07-09.md): the onboarding trust
 * screens (native `Onboarding.tsx` steps 0-2, and the equivalent
 * `OnboardingDesktop.tsx` `SlidePanel` slides) unconditionally showed
 * Phase-2 cashback / bank-transfer copy regardless of
 * `LOOP_PHASE_1_ONLY` -- "earn cashback on every purchase, paid by
 * instant bank transfer" plus a "Total cashback $2,847.00" card and a
 * "Cashback lands in your bank" how-it-works step. Every other
 * phase-gated surface (home.tsx's hero, /cashback, /calculator)
 * already branches on `phase1Only`; these were the last leak.
 *
 * `onboarding-skip-nav.test.tsx` already covers the existing
 * phase1Only step-*skip* behaviour (steps 5/7); this file covers the
 * *copy* on the screens that always render, on both settings of the
 * flag, for both the native and web-desktop entry points -- mirroring
 * the mock setup Onboarding.a11y.test.tsx / onboarding-skip-nav.test.tsx
 * already use.
 */

afterEach(cleanup);

const { mocks } = vi.hoisted(() => ({
  mocks: { phase1Only: true },
}));

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: mocks.phase1Only }, isLoading: false }),
}));

vi.mock('~/native/biometrics', () => ({
  checkBiometrics: () => new Promise(() => undefined),
}));

vi.mock('~/services/user', () => ({
  setHomeCurrency: vi.fn(),
}));

vi.mock('~/services/auth', () => ({
  requestOtp: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock('~/services/merchants', () => ({
  fetchAllMerchants: vi.fn().mockResolvedValue({ merchants: [] }),
}));

function renderNative(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderDesktop(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <OnboardingDesktop />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Onboarding /> trust-screen copy (native, U-2 / UX-01)', () => {
  it('shows discount-flavoured copy with no cashback/bank-transfer promise when phase1Only is true', () => {
    mocks.phase1Only = true;
    renderNative();
    // Welcome screen (step 0).
    expect(screen.getByText(/save up to 15% instantly on gift cards/i)).toBeDefined();
    expect(screen.getByText('Total saved')).toBeDefined();
    expect(screen.queryByText(/paid by instant bank transfer/i)).toBeNull();
    expect(screen.queryByText('Total cashback')).toBeNull();
    // How-it-works screen (step 1) -- mounted (inert) even when inactive.
    expect(screen.getByText('Your discount applies instantly')).toBeDefined();
    expect(screen.queryByText('Cashback lands in your bank')).toBeNull();
  });

  it('keeps the Phase-2 cashback/bank-transfer copy when phase1Only is false', () => {
    mocks.phase1Only = false;
    renderNative();
    expect(screen.getByText(/paid by instant bank transfer/i)).toBeDefined();
    expect(screen.getByText('Total cashback')).toBeDefined();
    expect(screen.getByText('Cashback lands in your bank')).toBeDefined();
    expect(screen.queryByText(/save up to 15% instantly on gift cards/i)).toBeNull();
    expect(screen.queryByText('Total saved')).toBeNull();
    expect(screen.queryByText('Your discount applies instantly')).toBeNull();
  });
});

describe('<OnboardingDesktop /> slide-panel copy (web, U-2 / UX-01)', () => {
  it('shows discount-flavoured copy with no cashback/bank-transfer promise when phase1Only is true', () => {
    mocks.phase1Only = true;
    renderDesktop();
    expect(screen.getByText(/save up to 15% instantly on gift cards/i)).toBeDefined();
    expect(screen.getByText('Total saved')).toBeDefined();
    expect(screen.queryByText(/paid by instant bank transfer/i)).toBeNull();
    expect(screen.queryByText('Total cashback')).toBeNull();
  });

  it('keeps the Phase-2 cashback/bank-transfer copy when phase1Only is false', () => {
    mocks.phase1Only = false;
    renderDesktop();
    expect(screen.getByText(/paid by instant bank transfer/i)).toBeDefined();
    expect(screen.getByText('Total cashback')).toBeDefined();
    expect(screen.queryByText(/save up to 15% instantly on gift cards/i)).toBeNull();
  });
});
