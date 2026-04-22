// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { WalletIntroScreen } from '../screen-wallet-intro';

afterEach(cleanup);

const copy = {
  eyebrow: 'Stellar wallet',
  title: 'Your cashback,\nyour wallet.',
  sub: 'Cashback lands in your Loop balance instantly. Move it any time.',
};

describe('WalletIntroScreen', () => {
  it('renders the eyebrow, title, and sub copy', () => {
    render(<WalletIntroScreen active copy={copy} homeCurrency="GBP" onLinkWallet={vi.fn()} />);
    expect(screen.getByText('Stellar wallet')).toBeTruthy();
    // `\n` in the title becomes a line break in the DOM — use a
    // regex that tolerates whitespace collapse.
    expect(screen.getByText(/Your cashback,/)).toBeTruthy();
    expect(screen.getByText(/Cashback lands in your Loop balance instantly/)).toBeTruthy();
  });

  it('labels the asset chip with the user home-currency LOOP code (GBP → GBPLOOP)', () => {
    render(<WalletIntroScreen active copy={copy} homeCurrency="GBP" onLinkWallet={vi.fn()} />);
    expect(screen.getByText('GBPLOOP')).toBeTruthy();
    // GBP → £ in the instant-cashback card.
    expect(screen.getByText('£')).toBeTruthy();
  });

  it('shows USDLOOP + $ for a USD home currency', () => {
    render(<WalletIntroScreen active copy={copy} homeCurrency="USD" onLinkWallet={vi.fn()} />);
    expect(screen.getByText('USDLOOP')).toBeTruthy();
    expect(screen.getByText('$')).toBeTruthy();
  });

  it('shows EURLOOP + € for a EUR home currency', () => {
    render(<WalletIntroScreen active copy={copy} homeCurrency="EUR" onLinkWallet={vi.fn()} />);
    expect(screen.getByText('EURLOOP')).toBeTruthy();
    expect(screen.getByText('€')).toBeTruthy();
  });

  it('invokes onLinkWallet when the secondary link is tapped', () => {
    const onLinkWallet = vi.fn();
    render(<WalletIntroScreen active copy={copy} homeCurrency="USD" onLinkWallet={onLinkWallet} />);
    fireEvent.click(screen.getByText(/Link a wallet now/));
    expect(onLinkWallet).toHaveBeenCalledTimes(1);
  });

  it('makes the link button non-focusable when the screen is inactive', () => {
    render(
      <WalletIntroScreen active={false} copy={copy} homeCurrency="USD" onLinkWallet={vi.fn()} />,
    );
    const link = screen.getByText(/Link a wallet now/);
    expect(link.getAttribute('tabindex')).toBe('-1');
  });
});
