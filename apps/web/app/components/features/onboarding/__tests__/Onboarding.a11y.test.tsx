// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Onboarding } from '../Onboarding';

/**
 * ADR 042 (B-2): runtime DOM a11y smoke test for the onboarding flow's
 * first (active) screen. Mocking mirrors the sibling
 * onboarding-skip-nav.test.tsx pattern. Only the active step is exercised
 * per axe.org guidance — the other 8 steps are `inert` (A11Y-019 / CF-35),
 * which removes them from the accessibility tree, so scanning the full
 * container still reflects what assistive tech actually sees.
 */

expect.extend(toHaveNoViolations);

afterEach(cleanup);

vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: true }, isLoading: false }),
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

function renderOnboarding(): { container: HTMLElement } {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Onboarding />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Onboarding /> a11y', () => {
  it('has no axe violations at WCAG 2.1 A/AA on the first (welcome) screen', async () => {
    const { container } = renderOnboarding();
    const results = await axe(container, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    expect(results).toHaveNoViolations();
  });
});
