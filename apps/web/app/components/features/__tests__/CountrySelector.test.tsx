// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import { CountrySelector } from '../CountrySelector';

afterEach(() => {
  cleanup();
  document.cookie = 'loop_country=; path=/; max-age=0';
});

function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <div data-testid="loc">{`${loc.pathname}${loc.search}`}</div>;
}

/** Render the selector under a localized route so `useParams` resolves. */
function renderAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path=":country/:lang/*" element={<Harness />} />
        <Route path="*" element={<Harness />} />
      </Routes>
    </MemoryRouter>,
  );
}

function Harness(): React.JSX.Element {
  return (
    <>
      <CountrySelector />
      <LocationProbe />
    </>
  );
}

describe('CountrySelector', () => {
  it('shows the active country from the URL', () => {
    renderAt('/gb/en/cashback');
    expect(screen.getByRole('button', { name: /Country: United Kingdom/ })).toBeTruthy();
  });

  it('filters the list by search query', () => {
    renderAt('/us/en');
    fireEvent.click(screen.getByRole('button', { name: /Country:/ }));
    fireEvent.change(screen.getByLabelText('Search countries'), { target: { value: 'ger' } });
    const list = screen.getByRole('listbox', { name: 'Countries' });
    expect(within(list).getByText('Germany')).toBeTruthy();
    expect(within(list).queryByText('France')).toBeNull();
  });

  it('navigates to the same page under the new locale and sets the cookie', () => {
    renderAt('/gb/en/cashback');
    fireEvent.click(screen.getByRole('button', { name: /Country:/ }));
    fireEvent.click(screen.getByRole('option', { name: /Germany/ }));
    expect(screen.getByTestId('loc').textContent).toBe('/de/en/cashback');
    expect(document.cookie).toContain('loop_country=de');
  });

  it('lands on the locale home when the current page is not localizable', () => {
    renderAt('/orders');
    fireEvent.click(screen.getByRole('button', { name: /Country:/ }));
    fireEvent.click(screen.getByRole('option', { name: /Germany/ }));
    expect(screen.getByTestId('loc').textContent).toBe('/de/en');
  });

  // A11Y-004 / CF-35 — focus trap, focus restore, listbox keyboard nav.
  it('moves focus to the search input on open', () => {
    renderAt('/us/en');
    fireEvent.click(screen.getByRole('button', { name: /Country:/ }));
    expect(document.activeElement).toBe(screen.getByLabelText('Search countries'));
  });

  it('restores focus to the trigger when closed via the close button', () => {
    renderAt('/us/en');
    const trigger = screen.getByRole('button', { name: /Country:/ });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('button', { name: /close country picker/i }));
    expect(document.activeElement).toBe(trigger);
  });

  it('restores focus to the trigger when closed via Escape', () => {
    renderAt('/us/en');
    const trigger = screen.getByRole('button', { name: /Country:/ });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(trigger);
  });

  it('exposes aria-activedescendant on the combobox and advances it with ArrowDown', () => {
    renderAt('/us/en');
    fireEvent.click(screen.getByRole('button', { name: /Country:/ }));
    const input = screen.getByLabelText('Search countries');
    expect(input.getAttribute('aria-activedescendant')).toBe('country-option-0');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBe('country-option-1');
  });

  it('selects the active option on Enter', () => {
    renderAt('/gb/en/cashback');
    fireEvent.click(screen.getByRole('button', { name: /Country:/ }));
    const input = screen.getByLabelText('Search countries');
    fireEvent.change(input, { target: { value: 'ger' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('loc').textContent).toBe('/de/en/cashback');
  });
});
