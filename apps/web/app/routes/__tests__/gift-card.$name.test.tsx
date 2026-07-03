import { describe, it, expect } from 'vitest';
import { meta } from '../gift-card.$name';
import type { Route } from '../+types/gift-card.$name';

// The meta fn is pure — it owns the SEO title/description AND a
// crash-guard: a crawler hitting a junk URL like /gift-card/%ZZ must
// not 500 the SSR render (C3 — this is exactly the route-loader/meta
// logic that route-level coverage was previously blind to).
function run(name: string | undefined): { title: string; description: string } {
  const params: Record<string, string> = {};
  if (name !== undefined) params.name = name;
  const descriptors = meta({ params } as unknown as Route.MetaArgs);
  let title = '';
  let description = '';
  for (const d of descriptors as Array<Record<string, string>>) {
    if (typeof d.title === 'string') title = d.title;
    if (d.name === 'description' && typeof d.content === 'string') description = d.content;
  }
  return { title, description };
}

describe('gift-card.$name meta', () => {
  it('builds a title + description from the slug, hyphens → spaces', () => {
    const r = run('amazon-gift');
    expect(r.title).toBe('amazon gift Gift Card — Loop');
    expect(r.description).toContain('amazon gift');
  });

  it('decodes percent-escapes in the slug', () => {
    const r = run('caf%C3%A9'); // café
    expect(r.title).toBe('café Gift Card — Loop');
  });

  it('does NOT throw on a malformed percent-escape (crawler junk URL)', () => {
    // decodeURIComponent('%ZZ') throws; the guard must fall back to raw.
    expect(() => run('%ZZ')).not.toThrow();
    const r = run('%ZZ');
    expect(r.title).toBe('%ZZ Gift Card — Loop');
  });

  it('handles a missing param without throwing', () => {
    expect(() => run(undefined)).not.toThrow();
  });
});
