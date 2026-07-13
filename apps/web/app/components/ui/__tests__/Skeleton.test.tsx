// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { Skeleton, MerchantCardSkeleton, OrderRowSkeleton } from '../Skeleton';

afterEach(cleanup);

describe('Skeleton a11y', () => {
  it('MerchantCardSkeleton exposes a polite loading status to AT', () => {
    render(<MerchantCardSkeleton />);
    const status = screen.getByRole('status');
    expect(within(status).getByText('Loading')).not.toBeNull();
  });

  it('OrderRowSkeleton exposes a polite loading status to AT', () => {
    render(<OrderRowSkeleton />);
    const status = screen.getByRole('status');
    expect(within(status).getByText('Loading')).not.toBeNull();
  });

  it('the base Skeleton shape is decorative (hidden from AT)', () => {
    // A lone pulsing bar carries no meaning; it must not litter the
    // accessibility tree (mirrors Spinner's aria-hidden SVG).
    const { container } = render(<Skeleton className="h-4 w-10" />);
    expect((container.firstChild as HTMLElement).getAttribute('aria-hidden')).toBe('true');
  });
});
