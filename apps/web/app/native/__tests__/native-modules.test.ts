import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Capacitor core
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    getPlatform: vi.fn(() => 'web'),
  },
}));

// Import modules under test
import { getPlatform, isNativePlatform } from '../platform';
import { copyToClipboard } from '../clipboard';
import { triggerHaptic, triggerHapticNotification } from '../haptics';

describe('platform', () => {
  it('returns web platform by default', () => {
    expect(getPlatform()).toBe('web');
  });

  it('isNativePlatform returns false on web', () => {
    expect(isNativePlatform()).toBe(false);
  });
});

describe('clipboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('copies to clipboard on web using navigator.clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const result = await copyToClipboard('test text');
    expect(result).toBe(true);
    expect(writeText).toHaveBeenCalledWith('test text');
  });

  it('returns false if clipboard write fails', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    const result = await copyToClipboard('test');
    expect(result).toBe(false);
  });
});

describe('haptics', () => {
  it('triggerHaptic is a no-op on web', async () => {
    await expect(triggerHaptic()).resolves.toBeUndefined();
  });

  it('triggerHapticNotification is a no-op on web', async () => {
    await expect(triggerHapticNotification('success')).resolves.toBeUndefined();
  });
});
