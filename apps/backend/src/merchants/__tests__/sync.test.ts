import { describe, it, expect, vi } from 'vitest';

vi.mock('../../env.js', () => ({
  env: {
    GIFT_CARD_API_BASE_URL: 'http://test',
    GIFT_CARD_API_KEY: 'test',
    GIFT_CARD_API_SECRET: 'test',
    JWT_SECRET: 'test-secret-that-is-long-enough-32ch',
    JWT_REFRESH_SECRET: 'test-refresh-secret-long-enough-32',
    PORT: 8080,
    LOG_LEVEL: 'silent',
    REFRESH_INTERVAL_HOURS: 6,
    LOCATION_REFRESH_INTERVAL_HOURS: 24,
    EMAIL_FROM: 'test@test.com',
  },
}));

vi.mock('../../logger.js', () => ({
  logger: { child: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() }) },
}));

import { merchantSlug } from '../sync.js';

describe('merchantSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(merchantSlug('Home Depot')).toBe('home-depot');
  });

  it('strips non-alphanumeric characters', () => {
    expect(merchantSlug("Dunkin' Donuts")).toBe('dunkin-donuts');
  });

  it('handles multiple consecutive spaces', () => {
    expect(merchantSlug('Some   Store')).toBe('some-store');
  });

  it('returns empty string for empty input', () => {
    expect(merchantSlug('')).toBe('');
  });

  it('handles names with numbers', () => {
    expect(merchantSlug('7-Eleven')).toBe('7-eleven');
  });

  it('handles already-lowercase names', () => {
    expect(merchantSlug('target')).toBe('target');
  });
});
