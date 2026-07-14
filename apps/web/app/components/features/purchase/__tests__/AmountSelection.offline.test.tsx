// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render as rtlRender, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import type { Merchant } from '@loop/shared';
import { AmountSelection } from '../AmountSelection';

// Confirming an amount POSTs create-order (a money/network action) via the
// parent's onConfirm. The offline guard (FE-43) disables the confirm button
// while the device is offline. `~/native/network` is deliberately NOT mocked
// so the real web `watchNetwork` path drives `useOnline()` end to end.
afterEach(() => {
  cleanup();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

beforeEach(() => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

// AmountSelection reads the active route locale (useLocaleTag → useParams),
// so every render runs inside a router context (CF-22).
function render(ui: React.ReactElement): ReturnType<typeof rtlRender> {
  return rtlRender(<MemoryRouter>{ui}</MemoryRouter>);
}

const fixedMerchant: Merchant = {
  id: 'm-1',
  name: 'Target',
  enabled: true,
  denominations: { type: 'fixed', denominations: ['10', '25', '50'], currency: 'USD' },
};

describe('AmountSelection — offline gating (FE-43)', () => {
  it('disables the create-order button on network loss and re-enables it on reconnect', () => {
    render(<AmountSelection merchant={fixedMerchant} onConfirm={vi.fn()} />);

    // Pick a denomination so the button's ONLY remaining gate is connectivity.
    fireEvent.click(screen.getByRole('button', { name: '$25' }));
    const button = screen.getByRole('button', { name: /Buy \$25/i });
    expect(button.hasAttribute('disabled')).toBe(false);

    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });

    expect(button.hasAttribute('disabled')).toBe(true);
    const hint = screen.getByText(/You.re offline/);
    expect(hint.textContent).toMatch(/reconnect to place your order/i);
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);

    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText(/You.re offline/)).toBeNull();
  });
});
