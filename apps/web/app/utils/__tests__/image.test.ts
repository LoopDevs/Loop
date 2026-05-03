import { describe, it, expect, vi } from 'vitest';

vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

import { getImageProxyUrl } from '../image';

describe('getImageProxyUrl', () => {
  it('starts with API_BASE/api/image', () => {
    const url = getImageProxyUrl('https://example.com/img.png', 200);
    expect(url.startsWith('http://test-api/api/image?')).toBe(true);
  });

  it('includes encoded source URL', () => {
    const url = getImageProxyUrl('https://example.com/path?foo=bar', 100);
    expect(url).toContain(`url=${encodeURIComponent('https://example.com/path?foo=bar')}`);
  });

  it('includes width when > 0', () => {
    const url = getImageProxyUrl('https://example.com/img.png', 200);
    expect(url).toContain('width=200');
  });

  it('omits width when 0', () => {
    const url = getImageProxyUrl('https://example.com/img.png', 0);
    expect(url).not.toContain('width=');
  });

  it('omits width when not provided', () => {
    const url = getImageProxyUrl('https://example.com/img.png');
    expect(url).not.toContain('width=');
  });

  it('uses default quality of 80', () => {
    const url = getImageProxyUrl('https://example.com/img.png', 100);
    expect(url).toContain('quality=80');
  });

  it('uses custom quality when provided', () => {
    const url = getImageProxyUrl('https://example.com/img.png', 100, 50);
    expect(url).toContain('quality=50');
  });

  it('produces a valid URL with all params', () => {
    const url = getImageProxyUrl('https://cdn.example.com/photo.jpg', 300, 90);
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/image');
    expect(parsed.searchParams.get('url')).toBe('https://cdn.example.com/photo.jpg');
    expect(parsed.searchParams.get('width')).toBe('300');
    expect(parsed.searchParams.get('quality')).toBe('90');
  });

  it('includes private mode when requested', () => {
    const url = getImageProxyUrl('https://cdn.example.com/barcode.png', 640, 80, {
      mode: 'private',
    });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('mode')).toBe('private');
  });
});
