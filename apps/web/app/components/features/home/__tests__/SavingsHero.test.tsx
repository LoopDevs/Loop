// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SavingsHero } from '../MobileHome';

afterEach(cleanup);

describe('SavingsHero', () => {
  describe('labels', () => {
    it("renders the 'Cashback earned' label and 'earning cashback' empty subtitle", () => {
      render(<SavingsHero cashbackCents={0} ordersCount={0} isAuthenticated={true} />);
      expect(screen.getByText('Cashback earned')).toBeTruthy();
      expect(screen.getByText(/earning cashback/i)).toBeTruthy();
    });

    it("renders the 'Avg back' stat label", () => {
      render(<SavingsHero cashbackCents={5000} ordersCount={2} isAuthenticated={true} />);
      expect(screen.getByText('Avg back')).toBeTruthy();
    });
  });

  describe('empty state', () => {
    it('shows $0.00 with the empty subtitle when ordersCount=0', () => {
      render(<SavingsHero cashbackCents={0} ordersCount={0} isAuthenticated={true} />);
      // The "$0.00" appears as the headline amount.
      expect(screen.getByText('$0.00')).toBeTruthy();
      // Avg row shows '—' rather than $0.00 to avoid the noise of
      // a divide-by-zero stat.
      expect(screen.getByText('—')).toBeTruthy();
    });

    it('renders the empty-state zero in the active currency, not a hardcoded $', () => {
      render(
        <SavingsHero cashbackCents={0} ordersCount={0} isAuthenticated={true} currency="GBP" />,
      );
      // WEB-M1: a GBP ledger shows £0.00, never $0.00.
      expect(screen.getByText('£0.00')).toBeTruthy();
      expect(screen.queryByText('$0.00')).toBeNull();
    });

    it('treats unauthenticated viewers as empty regardless of order count', () => {
      // ordersCount > 0 with isAuthenticated=false should still show
      // the empty teaser — the user may have stale order data from
      // a previous session in the cache, but they're not signed in
      // so we don't show their figure.
      render(<SavingsHero cashbackCents={5000} ordersCount={3} isAuthenticated={false} />);
      expect(screen.getByText('$0.00')).toBeTruthy();
      expect(screen.getByText(/earning cashback/i)).toBeTruthy();
    });
  });
});
