import { describe, expect, it } from 'vitest';
import { compareVersions, isOutdated } from '../version';

describe('compareVersions', () => {
  it('compares numerically, not lexically (1.10.0 > 1.9.0)', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.9.0', '1.10.0')).toBe(-1);
  });

  it('treats missing trailing segments as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2.1', '1.2')).toBe(1);
  });

  it('ignores pre-release / build metadata', () => {
    expect(compareVersions('0.4.0-beta.1', '0.4.0')).toBe(0);
    expect(compareVersions('0.4.0+sha', '0.4.0')).toBe(0);
  });
});

describe('isOutdated', () => {
  it('blocks a strictly-older client', () => {
    expect(isOutdated('0.3.9', '0.4.0')).toBe(true);
  });

  it('passes an equal or newer client', () => {
    expect(isOutdated('0.4.0', '0.4.0')).toBe(false);
    expect(isOutdated('0.5.0', '0.4.0')).toBe(false);
  });

  it('fails open on an absent / blank floor (no gate configured)', () => {
    expect(isOutdated('0.0.1', null)).toBe(false);
    expect(isOutdated('0.0.1', undefined)).toBe(false);
    expect(isOutdated('0.0.1', '')).toBe(false);
    expect(isOutdated('0.0.1', '   ')).toBe(false);
  });

  it('fails open on a malformed version rather than blocking a working build', () => {
    expect(isOutdated('', '0.4.0')).toBe(false);
    expect(isOutdated('not-a-version', '0.4.0')).toBe(false);
  });
});
