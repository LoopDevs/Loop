/** ADR 034 Phase 2 — SSR locale-layout loader validation. */
import { describe, it, expect } from 'vitest';
import { loader } from '../locale-layout-ssr';

type Args = Parameters<typeof loader>[0];
const call = (country: string, lang: string): unknown => {
  try {
    return loader({ params: { country, lang } } as unknown as Args);
  } catch (e) {
    return e;
  }
};

describe('locale-layout-ssr loader', () => {
  it('passes a routed locale through (returns null, no throw)', () => {
    expect(call('gb', 'en')).toBeNull();
    expect(call('us', 'en')).toBeNull();
    expect(call('de', 'en')).toBeNull();
  });

  it('throws a 404 Response for an unrouted country', () => {
    const r = call('zz', 'en');
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(404);
  });

  it('throws a 404 Response for an unsupported language', () => {
    const r = call('gb', 'de');
    expect(r).toBeInstanceOf(Response);
    expect((r as Response).status).toBe(404);
  });
});
