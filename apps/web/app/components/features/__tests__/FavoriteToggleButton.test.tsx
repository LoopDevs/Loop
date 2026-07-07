// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

const { state } = vi.hoisted(() => ({
  state: {
    isAuthenticated: true,
    favoritedIds: new Set<string>(),
    isLoading: false,
    isPending: false,
    mutate: vi.fn(),
  },
}));

vi.mock('~/hooks/use-auth', () => ({
  useAuth: () => ({ isAuthenticated: state.isAuthenticated }),
}));
vi.mock('~/hooks/use-favorites', () => ({
  useFavorites: () => ({ favoritedIds: state.favoritedIds, isLoading: state.isLoading }),
  useToggleFavorite: () => ({ mutate: state.mutate, isPending: state.isPending }),
}));
vi.mock('~/native/haptics', () => ({ triggerHaptic: vi.fn() }));

import { FavoriteToggleButton } from '../FavoriteToggleButton';

afterEach(cleanup);
beforeEach(() => {
  state.isAuthenticated = true;
  state.favoritedIds = new Set();
  state.isLoading = false;
  state.isPending = false;
  state.mutate = vi.fn();
});

describe('FavoriteToggleButton', () => {
  it('renders nothing for signed-out visitors', () => {
    state.isAuthenticated = false;
    render(<FavoriteToggleButton merchantId="m1" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is labelled "Add to favourites" with aria-pressed=false when not favourited', () => {
    render(<FavoriteToggleButton merchantId="m1" />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('Add to favourites');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('is labelled "Remove from favourites" with aria-pressed=true when favourited', () => {
    state.favoritedIds = new Set(['m1']);
    render(<FavoriteToggleButton merchantId="m1" />);
    const btn = screen.getByRole('button');
    expect(btn.getAttribute('aria-label')).toBe('Remove from favourites');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
  });

  it('toggles via mutate with the current favourited state', () => {
    state.favoritedIds = new Set(['m1']);
    render(<FavoriteToggleButton merchantId="m1" />);
    fireEvent.click(screen.getByRole('button'));
    expect(state.mutate).toHaveBeenCalledWith({ merchantId: 'm1', currentlyFavorited: true });
  });

  it('is disabled while a mutation is pending and does not fire the toggle', () => {
    state.isPending = true;
    render(<FavoriteToggleButton merchantId="m1" />);
    const btn = screen.getByRole('button');
    expect(btn.hasAttribute('disabled')).toBe(true);
    fireEvent.click(btn);
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
