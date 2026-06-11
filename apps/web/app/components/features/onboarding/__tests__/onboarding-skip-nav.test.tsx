// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Onboarding } from '../Onboarding';

afterEach(cleanup);

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: true }, isLoading: false }),
}));

vi.mock('~/native/biometrics', () => ({
  // Never resolves → `available` stays null, so the biometric screen
  // neither offers the prompt nor self-skips. Keeps the container
  // parked on step 6 while the test drives navigation.
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
  // TrustMerchants (step 2) renders a brand grid via useAllMerchants.
  fetchAllMerchants: vi.fn().mockResolvedValue({ merchants: [] }),
}));

/** The step panel wrapping `text` must be the active (non-hidden) one. */
function activePanelContaining(text: RegExp): HTMLElement {
  const el = screen.getByText(text);
  const panel = el.closest('[aria-hidden]');
  expect(panel).not.toBeNull();
  return panel as HTMLElement;
}

/**
 * Comprehensive-audit 2026-06-11 P10: with `phase1Only`, steps 5
 * (currency) and 7 (wallet intro) auto-skip. The skip-effect used to
 * be forward-only, so navigating Back ONTO a skipped step bounced
 * the user forward again — Back from the biometric step was a no-op
 * trap. The effect is now direction-aware.
 */
describe('<Onboarding /> phase1Only skip navigation', () => {
  function renderOnboarding(): void {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Onboarding />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  /**
   * The arrow-key handler deliberately ignores keystrokes while an
   * input is focused (caret motion). The email/OTP screens autofocus
   * their inputs, so blur before each synthetic arrow press.
   */
  function pressArrow(key: 'ArrowRight' | 'ArrowLeft'): void {
    (document.activeElement as HTMLElement | null)?.blur?.();
    fireEvent.keyDown(window, { key });
  }

  async function driveToBiometricStep(): Promise<void> {
    // Step 0 → 3 via the "existing account" shortcut, then arrow-key
    // forward through email (3) and OTP (4); 5 auto-skips to 6.
    fireEvent.click(screen.getByRole('button', { name: /i already have an account/i }));
    pressArrow('ArrowRight');
    pressArrow('ArrowRight');
    await waitFor(() => {
      expect(activePanelContaining(/one-tap sign in/i).getAttribute('aria-hidden')).toBe('false');
    });
  }

  it('auto-skips forward over the currency step when advancing', async () => {
    renderOnboarding();
    await driveToBiometricStep();
    // The currency step never sticks as the active panel.
    const currencyPanel = activePanelContaining(/pick your currency/i);
    expect(currencyPanel.getAttribute('aria-hidden')).toBe('true');
  });

  it('skips backward (not forward) when the user presses Back onto a skipped step', async () => {
    renderOnboarding();
    await driveToBiometricStep();

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }));

    // Direction-aware skip: 6 → 5 (skipped) → 4 (OTP). The old
    // forward-only effect bounced 5 → 6 and trapped the user.
    await waitFor(() => {
      expect(activePanelContaining(/check your inbox/i).getAttribute('aria-hidden')).toBe('false');
    });
    expect(activePanelContaining(/one-tap sign in/i).getAttribute('aria-hidden')).toBe('true');
  });
});
