// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

// Force the gate to render its "Coming soon" panel (phase1Only=true is the
// shipping default, but pin it so the test doesn't depend on the default).
vi.mock('~/hooks/use-app-config', () => ({
  useAppConfig: () => ({ config: { phase1Only: true }, isLoading: false }),
}));

import { Phase2Gate } from '../Phase2Gate';

afterEach(cleanup);

function renderGateAt(path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path=":country/:lang/*"
          element={
            <Phase2Gate>
              <div>child</div>
            </Phase2Gate>
          }
        />
        <Route
          path="*"
          element={
            <Phase2Gate>
              <div>child</div>
            </Phase2Gate>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
}

const backHref = (): string | null =>
  screen.getByRole('link', { name: 'Back to directory' }).getAttribute('href');

describe('Phase2Gate "Back to directory" link', () => {
  it('keeps the active locale prefix so a non-default visitor stays in their locale', () => {
    // A GB visitor gated on /gb/en/cashback must land back on /gb/en, not the
    // bare / (which the SSR geo-redirect resolves to the US default catalogue).
    renderGateAt('/gb/en/cashback');
    expect(backHref()).toBe('/gb/en');
  });

  it('passes the bare root through on an unprefixed route (no invented locale)', () => {
    renderGateAt('/cashback');
    expect(backHref()).toBe('/');
  });
});
