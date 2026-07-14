// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { Button } from '../Button';

afterEach(cleanup);

describe('Button focus ring (P2-01 — WCAG 1.4.11 non-text contrast)', () => {
  it('uses a SOLID blue-500 focus ring, not the sub-3:1 /40 alpha ring', () => {
    render(<Button>Save</Button>);
    const cls = screen.getByRole('button', { name: 'Save' }).className;
    // Solid `blue-500` on the white ring-offset is ~4.5:1 (>=3:1 pass);
    // the old `blue-500/40` composited to ~1.74:1 and failed.
    expect(cls).toContain('focus-visible:ring-blue-500 focus-visible:ring-offset-2');
    expect(cls).not.toContain('ring-blue-500/40');
  });
});

describe('Button icon-only accessible name guard (FE-49)', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('warns in dev when an icon-only button has no accessible name', () => {
    render(<Button leftIcon={<svg data-testid="i" />} />);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('aria-label'));
  });

  it('does not warn when an icon-only button supplies aria-label', () => {
    render(<Button rightIcon={<svg />} aria-label="Next" />);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not warn for a normal labeled button with an icon', () => {
    render(<Button leftIcon={<svg />}>Download</Button>);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not warn for a text-only button', () => {
    render(<Button>Submit</Button>);
    expect(errorSpy).not.toHaveBeenCalled();
  });
});
