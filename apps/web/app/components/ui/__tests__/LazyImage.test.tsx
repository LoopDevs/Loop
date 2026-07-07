// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { LazyImage } from '../LazyImage';

afterEach(cleanup);

describe('LazyImage', () => {
  it('renders the image with its src and alt', () => {
    render(<LazyImage src="https://x.test/logo.png" alt="Acme logo" />);
    expect(screen.getByAltText('Acme logo').getAttribute('src')).toBe('https://x.test/logo.png');
  });

  it('lazy-loads by default and eager-loads when asked', () => {
    const { rerender } = render(<LazyImage src="a.png" alt="a" />);
    expect(screen.getByAltText('a').getAttribute('loading')).toBe('lazy');
    rerender(<LazyImage src="a.png" alt="a" eager />);
    expect(screen.getByAltText('a').getAttribute('loading')).toBe('eager');
  });

  it('on load error, drops the img and renders the provided fallback (A2)', () => {
    render(<LazyImage src="dead.png" alt="Acme logo" fallback={<span>AC</span>} />);
    fireEvent.error(screen.getByAltText('Acme logo'));
    // the broken img is removed…
    expect(screen.queryByAltText('Acme logo')).toBeNull();
    // …and the caller's fallback (the monogram) shows instead of a grey box
    expect(screen.queryByText('AC')).not.toBeNull();
  });

  it('on load error without a fallback, drops the img (neutral grey box, no fallback content)', () => {
    render(<LazyImage src="dead.png" alt="Acme logo" />);
    fireEvent.error(screen.getByAltText('Acme logo'));
    expect(screen.queryByAltText('Acme logo')).toBeNull();
  });

  it('keeps the image mounted and fades it in after a successful load', () => {
    render(<LazyImage src="ok.png" alt="Acme logo" />);
    const img = screen.getByAltText('Acme logo');
    fireEvent.load(img);
    expect(screen.queryByAltText('Acme logo')).not.toBeNull();
    expect(img.className).toContain('opacity-100'); // faded in once loaded
  });
});
