// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AdminNav } from '../AdminNav';

afterEach(cleanup);

function renderAt(path: string): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AdminNav />
    </MemoryRouter>,
  );
}

describe('AdminNav', () => {
  it('renders one link per admin section with the correct hrefs', () => {
    renderAt('/admin/cashback');
    const links = screen.getAllByRole('link');
    const hrefs = links.map((l) => l.getAttribute('href'));
    expect(hrefs).toEqual(['/admin/cashback', '/admin/treasury', '/admin/payouts']);
  });

  it('marks the Cashback tab as aria-current=page on /admin/cashback', () => {
    renderAt('/admin/cashback');
    const active = screen.getByRole('link', { name: 'Cashback' });
    expect(active.getAttribute('aria-current')).toBe('page');
    const inactive = screen.getByRole('link', { name: 'Treasury' });
    expect(inactive.getAttribute('aria-current')).toBeNull();
  });

  it('marks the Treasury tab as aria-current=page on /admin/treasury', () => {
    renderAt('/admin/treasury');
    expect(screen.getByRole('link', { name: 'Treasury' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('marks the Payouts tab as active on nested paths like /admin/payouts/abc', () => {
    renderAt('/admin/payouts/abc-123');
    expect(screen.getByRole('link', { name: 'Payouts' }).getAttribute('aria-current')).toBe('page');
  });

  it('does not highlight any tab on unrelated admin-ish paths', () => {
    // Defensive check: /admin (no subpath) shouldn't mark anything as current.
    renderAt('/admin');
    for (const label of ['Cashback', 'Treasury', 'Payouts']) {
      expect(screen.getByRole('link', { name: label }).getAttribute('aria-current')).toBeNull();
    }
  });
});
