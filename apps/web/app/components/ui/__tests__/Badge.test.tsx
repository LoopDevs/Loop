// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { Badge } from '../Badge';

afterEach(cleanup);

describe('Badge solid text contrast (P2-02 — WCAG 1.4.3 AA)', () => {
  // Solid fills carry white text and need >=4.5:1. green-600 (3.22:1) and
  // amber-500 (2.15:1) failed; amber-600 (3.19:1) still fails, so warning
  // must reach amber-700 (5.05:1) and success green-700 (4.94:1).
  it('renders solid success on green-700, not the sub-4.5:1 green-600', () => {
    const { container } = render(
      <Badge tone="success" variant="solid">
        Paid
      </Badge>,
    );
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain('bg-green-700');
    expect(cls).not.toContain('bg-green-600');
  });

  it('renders solid warning on amber-700, not the sub-4.5:1 amber-500/600', () => {
    const { container } = render(
      <Badge tone="warning" variant="solid">
        Due
      </Badge>,
    );
    const cls = (container.firstChild as HTMLElement).className;
    expect(cls).toContain('bg-amber-700');
    expect(cls).not.toContain('bg-amber-500');
    expect(cls).not.toContain('bg-amber-600');
  });

  it('leaves solid danger on red-600 (already >=4.5:1)', () => {
    const { container } = render(
      <Badge tone="danger" variant="solid">
        Failed
      </Badge>,
    );
    expect((container.firstChild as HTMLElement).className).toContain('bg-red-600');
  });
});
