// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Onboarding } from '../Onboarding';
import { EmailEntry, OtpEntry } from '../signup-tail';
import { Dots } from '../atoms';

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

vi.mock('~/native/clipboard', () => ({
  readClipboard: vi.fn().mockResolvedValue(null),
}));

const OTP_COPY = { title: 'Check your inbox', sub: 'We sent a 6-digit code to' };
const EMAIL_COPY = { title: 'What’s your email?', sub: 'We’ll send you a 6-digit code.' };

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

function renderOtp(overrides: Partial<Parameters<typeof OtpEntry>[0]> = {}): void {
  render(
    <OtpEntry
      active
      copy={OTP_COPY}
      email="ash@example.com"
      otp=""
      setOtp={() => undefined}
      error={null}
      onResend={() => undefined}
      onVerified={() => undefined}
      {...overrides}
    />,
  );
}

// FE-50: the six OTP boxes were anonymous text inputs. AT should hear a
// named group and "Digit N of 6" per box, not six unlabelled fields.
describe('OtpEntry OTP box labels (FE-50)', () => {
  it('names each of the six OTP boxes and groups them', () => {
    renderOtp();
    for (let i = 1; i <= 6; i++) {
      expect(screen.getByLabelText(`Digit ${i} of 6`)).toBeDefined();
    }
    expect(screen.getByRole('group', { name: 'Verification code' })).toBeDefined();
  });
});

// FE-51: onboarding network errors were colour-only. They must sit in an
// assertive live region so a screen reader announces the failure.
describe('onboarding error text is announced (FE-51)', () => {
  it('marks the email-entry error as role=alert', () => {
    render(
      <EmailEntry
        active
        copy={EMAIL_COPY}
        email="bad"
        setEmail={() => undefined}
        error="Couldn’t send the code."
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('Couldn’t send the code.');
  });

  it('marks the OTP-entry error as role=alert', () => {
    renderOtp({ error: 'That code was invalid.' });
    expect(screen.getByRole('alert').textContent).toContain('That code was invalid.');
  });
});

// FE-52: "Resend code" gave no feedback and could be hammered. After a tap
// it must show a visible countdown, disable, announce, then re-enable.
describe('OTP resend cooldown (FE-52)', () => {
  it('disables resend with a countdown + SR announcement after tapping', () => {
    const onResend = vi.fn();
    renderOtp({ onResend });

    const resend = screen.getByRole('button', { name: 'Resend code' });
    expect(resend).toHaveProperty('disabled', false);

    fireEvent.click(resend);
    expect(onResend).toHaveBeenCalledTimes(1);

    const cooling = screen.getByRole('button', { name: 'Resend code in 30s' });
    expect(cooling).toHaveProperty('disabled', true);

    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toContain('A new code is on its way.');
  });

  it('re-enables resend once the 30s cooldown elapses', () => {
    vi.useFakeTimers();
    try {
      renderOtp();
      fireEvent.click(screen.getByRole('button', { name: 'Resend code' }));
      expect(screen.getByRole('button', { name: 'Resend code in 30s' })).toBeDefined();

      act(() => {
        vi.advanceTimersByTime(30_000);
      });

      expect(screen.getByRole('button', { name: 'Resend code' })).toHaveProperty('disabled', false);
    } finally {
      vi.useRealTimers();
    }
  });
});

// FE-53: the inter-step slide animation ignored prefers-reduced-motion.
function mockReducedMotion(reduced: boolean): () => void {
  const original = window.matchMedia;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: /reduce/.test(query) ? reduced : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  return () => {
    if (original) {
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: original,
      });
    } else {
      delete (window as unknown as { matchMedia?: unknown }).matchMedia;
    }
  };
}

function activeSlideOf(container: HTMLElement): HTMLElement {
  const stage = container.querySelector('.overflow-hidden');
  const slides = Array.from(stage?.children ?? []) as HTMLElement[];
  const active = slides.find((s) => s.style.opacity === '1');
  if (active === undefined) throw new Error('no active slide found');
  return active;
}

describe('reduced-motion gating (FE-53)', () => {
  it('drops the slide transition when prefers-reduced-motion is set', () => {
    const restore = mockReducedMotion(true);
    try {
      const { container } = renderOnboarding();
      expect(activeSlideOf(container).style.transition).toBe('none');
    } finally {
      restore();
    }
  });

  it('keeps the slide transition when reduced motion is not requested', () => {
    const restore = mockReducedMotion(false);
    try {
      const { container } = renderOnboarding();
      expect(activeSlideOf(container).style.transition).toContain('cubic-bezier');
    } finally {
      restore();
    }
  });
});

// FE-54: progress dots conveyed step position by width/colour only.
describe('progress dots semantics (FE-54)', () => {
  it('exposes step position to assistive tech', () => {
    render(<Dots active={2} total={9} />);
    expect(screen.getByText('Step 3 of 9')).toBeDefined();
    const group = screen.getByRole('group', { name: 'Onboarding progress' });
    expect(group.querySelector('[aria-current="step"]')).not.toBeNull();
  });
});
