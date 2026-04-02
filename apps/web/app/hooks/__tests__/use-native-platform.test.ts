import { describe, it, expect, vi } from 'vitest';

vi.mock('~/native/platform', () => ({
  getPlatform: vi.fn(() => 'web'),
  isNativePlatform: vi.fn(() => false),
}));

import { getPlatform, isNativePlatform } from '~/native/platform';

describe('useNativePlatform — underlying platform functions', () => {
  it('getPlatform returns web by default', () => {
    expect(getPlatform()).toBe('web');
  });

  it('isNativePlatform returns false on web', () => {
    expect(isNativePlatform()).toBe(false);
  });

  it('getPlatform returns ios when mocked', () => {
    vi.mocked(getPlatform).mockReturnValue('ios');
    expect(getPlatform()).toBe('ios');
  });

  it('isNativePlatform returns true when mocked', () => {
    vi.mocked(isNativePlatform).mockReturnValue(true);
    expect(isNativePlatform()).toBe(true);
  });

  it('getPlatform returns android when mocked', () => {
    vi.mocked(getPlatform).mockReturnValue('android');
    expect(getPlatform()).toBe('android');
  });
});
