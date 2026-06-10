// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { LocaleLink } from '../LocaleLink';

afterEach(cleanup);

function renderAt(path: string, to: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path=":country/:lang/*" element={<LocaleLink to={to}>link</LocaleLink>} />
        <Route path="*" element={<LocaleLink to={to}>link</LocaleLink>} />
      </Routes>
    </MemoryRouter>,
  );
}

const href = (): string | null => screen.getByText('link').getAttribute('href');

describe('LocaleLink', () => {
  it('prefixes a localizable target with the active locale', () => {
    renderAt('/gb/en/cashback', '/cashback');
    expect(href()).toBe('/gb/en/cashback');
  });

  it('prefixes the root path to the locale home', () => {
    renderAt('/de/en', '/');
    expect(href()).toBe('/de/en');
  });

  it('passes app/admin targets through unchanged on a localized route', () => {
    renderAt('/gb/en', '/orders');
    expect(href()).toBe('/orders');
  });

  it('is a no-op on an unprefixed route — never invents a locale', () => {
    renderAt('/cashback', '/map');
    expect(href()).toBe('/map');
  });
});
