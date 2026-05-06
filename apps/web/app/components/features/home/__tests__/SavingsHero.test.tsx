// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SavingsHero } from '../MobileHome';

afterEach(cleanup);

describe('SavingsHero', () => {
  describe('Phase 1 (instant-discount delivery — phase1Only=true)', () => {
    it("renders the 'You've saved' label and 'start saving' empty subtitle", () => {
      render(
        <SavingsHero cashbackCents={0} ordersCount={0} isAuthenticated={true} phase1Only={true} />,
      );
      expect(screen.getByText(/You['’]ve saved/)).toBeTruthy();
      // The empty state shows the "start saving" subtitle, not the
      // Phase-2 "earning cashback" copy.
      expect(screen.getByText(/start saving/i)).toBeTruthy();
      expect(screen.queryByText(/earning cashback/i)).toBeNull();
    });

    it("renders the 'Avg saving' stat label", () => {
      render(
        <SavingsHero
          cashbackCents={1234}
          ordersCount={3}
          isAuthenticated={true}
          phase1Only={true}
        />,
      );
      expect(screen.getByText('Avg saving')).toBeTruthy();
      expect(screen.queryByText('Avg back')).toBeNull();
    });

    it('shows the realised savings total in dollars', () => {
      render(
        <SavingsHero
          cashbackCents={1234}
          ordersCount={3}
          isAuthenticated={true}
          phase1Only={true}
        />,
      );
      // 1234 cents → $12.34 in the hero, $4.11 average across 3 orders.
      expect(screen.getByText('$12.34')).toBeTruthy();
      expect(screen.getByText('$4.11')).toBeTruthy();
    });
  });

  describe('Phase 2 (cashback to wallet — phase1Only=false)', () => {
    it("renders the 'Cashback earned' label and 'earning cashback' empty subtitle", () => {
      render(
        <SavingsHero cashbackCents={0} ordersCount={0} isAuthenticated={true} phase1Only={false} />,
      );
      expect(screen.getByText('Cashback earned')).toBeTruthy();
      expect(screen.getByText(/earning cashback/i)).toBeTruthy();
      expect(screen.queryByText(/start saving/i)).toBeNull();
    });

    it("renders the 'Avg back' stat label", () => {
      render(
        <SavingsHero
          cashbackCents={5000}
          ordersCount={2}
          isAuthenticated={true}
          phase1Only={false}
        />,
      );
      expect(screen.getByText('Avg back')).toBeTruthy();
      expect(screen.queryByText('Avg saving')).toBeNull();
    });
  });

  describe('empty state', () => {
    it('shows $0.00 with the empty subtitle when ordersCount=0', () => {
      render(
        <SavingsHero cashbackCents={0} ordersCount={0} isAuthenticated={true} phase1Only={true} />,
      );
      // The "$0.00" appears as the headline amount.
      expect(screen.getByText('$0.00')).toBeTruthy();
      // Avg row shows '—' rather than $0.00 to avoid the noise of
      // a divide-by-zero stat.
      expect(screen.getByText('—')).toBeTruthy();
    });

    it('treats unauthenticated viewers as empty regardless of order count', () => {
      // ordersCount > 0 with isAuthenticated=false should still show
      // the empty teaser — the user may have stale order data from
      // a previous session in the cache, but they're not signed in
      // so we don't show their figure.
      render(
        <SavingsHero
          cashbackCents={5000}
          ordersCount={3}
          isAuthenticated={false}
          phase1Only={true}
        />,
      );
      expect(screen.getByText('$0.00')).toBeTruthy();
      expect(screen.getByText(/start saving/i)).toBeTruthy();
    });
  });
});
