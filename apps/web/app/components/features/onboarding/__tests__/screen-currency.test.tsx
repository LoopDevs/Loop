// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CurrencyPickerScreen, guessHomeCurrency } from '../screen-currency';

afterEach(cleanup);

describe('CurrencyPickerScreen', () => {
  const copy = { eyebrow: 'Your region', title: 'Pick your currency', sub: 'sub' };

  it('renders all three supported currencies with codes + hints', () => {
    render(<CurrencyPickerScreen active copy={copy} selected={null} onSelect={vi.fn()} />);
    expect(screen.getByText('US Dollar')).toBeTruthy();
    expect(screen.getByText('British Pound')).toBeTruthy();
    expect(screen.getByText('Euro')).toBeTruthy();
    expect(screen.getByText('USD')).toBeTruthy();
    expect(screen.getByText('GBP')).toBeTruthy();
    expect(screen.getByText('EUR')).toBeTruthy();
  });

  it('calls onSelect with the chosen code', () => {
    const onSelect = vi.fn();
    render(<CurrencyPickerScreen active copy={copy} selected={null} onSelect={onSelect} />);
    fireEvent.click(screen.getByText('British Pound'));
    expect(onSelect).toHaveBeenCalledWith('GBP');
  });

  it('marks the selected option with aria-checked=true', () => {
    render(<CurrencyPickerScreen active copy={copy} selected="EUR" onSelect={vi.fn()} />);
    const radios = screen.getAllByRole('radio');
    const checked = radios.filter((r) => r.getAttribute('aria-checked') === 'true');
    expect(checked).toHaveLength(1);
    expect(checked[0]!.textContent).toContain('Euro');
  });

  it('renders an inline error when supplied', () => {
    render(
      <CurrencyPickerScreen
        active
        copy={copy}
        selected="USD"
        onSelect={vi.fn()}
        error="Could not save — please try again"
      />,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('Could not save');
  });

  it('makes radio buttons non-focusable when the screen is inactive', () => {
    render(<CurrencyPickerScreen active={false} copy={copy} selected={null} onSelect={vi.fn()} />);
    for (const r of screen.getAllByRole('radio')) {
      expect(r.getAttribute('tabindex')).toBe('-1');
    }
  });

  it('does not render the error element when error is null or undefined', () => {
    const { rerender } = render(
      <CurrencyPickerScreen active copy={copy} selected="USD" onSelect={vi.fn()} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(
      <CurrencyPickerScreen active copy={copy} selected="USD" onSelect={vi.fn()} error={null} />,
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('guessHomeCurrency', () => {
  it('maps en-GB / en_GB to GBP', () => {
    expect(guessHomeCurrency('en-GB')).toBe('GBP');
    expect(guessHomeCurrency('en_GB')).toBe('GBP');
  });

  it('maps en-US and bare en to USD', () => {
    expect(guessHomeCurrency('en-US')).toBe('USD');
    expect(guessHomeCurrency('en')).toBe('USD');
  });

  it('maps eurozone locales to EUR', () => {
    expect(guessHomeCurrency('de-DE')).toBe('EUR');
    expect(guessHomeCurrency('fr-FR')).toBe('EUR');
    expect(guessHomeCurrency('es-ES')).toBe('EUR');
    expect(guessHomeCurrency('it-IT')).toBe('EUR');
    expect(guessHomeCurrency('pt-PT')).toBe('EUR');
  });

  it('maps non-country eurozone languages to EUR', () => {
    expect(guessHomeCurrency('de')).toBe('EUR');
    expect(guessHomeCurrency('fr')).toBe('EUR');
  });

  it('defaults to USD for unsupported locales', () => {
    expect(guessHomeCurrency('ja-JP')).toBe('USD');
    expect(guessHomeCurrency('zh-CN')).toBe('USD');
    expect(guessHomeCurrency('')).toBe('USD');
    expect(guessHomeCurrency(undefined)).toBe('USD');
  });
});
