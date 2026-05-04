import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { THEME_INIT_SCRIPT, THEME_INIT_SCRIPT_HASH } from '../theme-init-script';

describe('theme-init script CSP hash (A4-057)', () => {
  it('hardcoded SHA-256 hash matches the live script body', () => {
    const sha = createHash('sha256').update(THEME_INIT_SCRIPT).digest('base64');
    const expected = `'sha256-${sha}='`.replace(`==`, `=`);
    // The exported hash literal is the form CSP accepts:
    //   'sha256-<base64>='
    // Compute the SAME shape from the script body and compare.
    const computed = `'sha256-${sha}'`;
    expect(THEME_INIT_SCRIPT_HASH).toBe(computed);
    // Also assert the literal opens + closes with single quotes per
    // the CSP token grammar.
    expect(THEME_INIT_SCRIPT_HASH.startsWith("'sha256-")).toBe(true);
    expect(THEME_INIT_SCRIPT_HASH.endsWith("'")).toBe(true);
    void expected;
  });

  it('the script body is small + has no obvious injection footholds', () => {
    // Sanity gate so an editor doesn't accidentally widen the script
    // to something we wouldn't want covered by a single hash. The
    // current body is ~280 chars; 1024 is generous headroom.
    expect(THEME_INIT_SCRIPT.length).toBeLessThan(1024);
    // No template-literal interpolations or dynamic content — anything
    // dynamic would invalidate the hash on every render.
    expect(THEME_INIT_SCRIPT).not.toMatch(/\$\{/);
  });
});
