// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ReplayedBadge } from '../ReplayedBadge';

afterEach(cleanup);

/**
 * A2-1163 surfaces `audit.replayed` to operators. The badge's
 * contract is minimal:
 *   - `replayed={false}` → renders null (no DOM)
 *   - `replayed={true}`  → renders a "Replayed" chip with an
 *                          accessible description explaining that
 *                          the new reason was NOT re-applied.
 */
describe('ReplayedBadge (A2-1163)', () => {
  it('renders nothing when not replayed', () => {
    const { container } = render(<ReplayedBadge replayed={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a chip with accessible role + label + title when replayed', () => {
    render(<ReplayedBadge replayed={true} />);
    const badge = screen.getByRole('note');
    expect(badge.textContent).toBe('Replayed');
    expect(badge.getAttribute('aria-label')).toBe('Replayed from idempotency snapshot');
    // The tooltip carries the operational nuance: new reason wasn't re-applied.
    expect(badge.getAttribute('title')).toMatch(/NOT re-applied/);
  });
});
