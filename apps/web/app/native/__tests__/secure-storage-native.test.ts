import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Audit A-024 — native migration behaviour for `secure-storage.ts`.
 * The sibling `native-modules.test.ts` exercises the web fallback with
 * `Capacitor.isNativePlatform()` mocked to `false`. Here we flip that
 * flag and stub both storage modules so we can assert:
 *
 *   1. `storeRefreshToken` writes to SecureStorage (keychain-backed),
 *      not Preferences.
 *   2. On read, a value already in SecureStorage is returned without
 *      touching Preferences.
 *   3. On read, a value present only in Preferences (pre-upgrade state)
 *      is migrated into SecureStorage and then deleted from Preferences.
 *   4. `clearRefreshToken` wipes both stores to prevent a stale token
 *      from surviving logout.
 */

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    getPlatform: vi.fn(() => 'ios'),
  },
}));

// In-memory fake of SecureStorage — the plugin exposes `SecureStorage`
// with `get`/`set`/`remove`. Our wrapper treats the return of `get`
// as nullable.
const secureStore = new Map<string, string>();
const mockSecureStorage = {
  get: vi.fn(async (key: string) => secureStore.get(key) ?? null),
  set: vi.fn(async (key: string, value: string) => {
    secureStore.set(key, value);
  }),
  remove: vi.fn(async (key: string) => secureStore.delete(key)),
};
vi.mock('@aparajita/capacitor-secure-storage', () => ({
  SecureStorage: mockSecureStorage,
}));

// In-memory fake of Capacitor Preferences with the legacy API shape.
const prefsStore = new Map<string, string>();
const mockPreferences = {
  get: vi.fn(async ({ key }: { key: string }) => ({
    value: prefsStore.get(key) ?? null,
  })),
  set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
    prefsStore.set(key, value);
  }),
  remove: vi.fn(async ({ key }: { key: string }) => {
    prefsStore.delete(key);
  }),
};
vi.mock('@capacitor/preferences', () => ({
  Preferences: mockPreferences,
}));

import {
  storeRefreshToken,
  getRefreshToken,
  clearRefreshToken,
  storeEmail,
  getEmail,
} from '../secure-storage';

beforeEach(() => {
  secureStore.clear();
  prefsStore.clear();
  mockSecureStorage.get.mockClear();
  mockSecureStorage.set.mockClear();
  mockSecureStorage.remove.mockClear();
  mockPreferences.get.mockClear();
  mockPreferences.set.mockClear();
  mockPreferences.remove.mockClear();
});

describe('secure-storage on native — writes go to SecureStorage', () => {
  it('storeRefreshToken writes to SecureStorage, not Preferences', async () => {
    await storeRefreshToken('rt-1');
    expect(secureStore.get('loop_refresh_token')).toBe('rt-1');
    expect(mockPreferences.set).not.toHaveBeenCalled();
  });

  it('storeEmail writes to SecureStorage, not Preferences', async () => {
    await storeEmail('u@example.com');
    expect(secureStore.get('loop_user_email')).toBe('u@example.com');
    expect(mockPreferences.set).not.toHaveBeenCalled();
  });
});

describe('secure-storage on native — read precedence', () => {
  it('returns the SecureStorage value without touching Preferences when present', async () => {
    secureStore.set('loop_refresh_token', 'rt-keychain');
    const token = await getRefreshToken();
    expect(token).toBe('rt-keychain');
    expect(mockPreferences.get).not.toHaveBeenCalled();
  });

  it('returns null when both stores are empty', async () => {
    const token = await getRefreshToken();
    expect(token).toBeNull();
  });
});

describe('secure-storage on native — migration from Preferences', () => {
  it('migrates a refresh token from Preferences into SecureStorage on first read', async () => {
    prefsStore.set('loop_refresh_token', 'rt-legacy');

    const token = await getRefreshToken();

    expect(token).toBe('rt-legacy');
    // Value was copied into the keychain-backed store…
    expect(secureStore.get('loop_refresh_token')).toBe('rt-legacy');
    // …and removed from the plaintext Preferences store.
    expect(prefsStore.has('loop_refresh_token')).toBe(false);
  });

  it('migrates an email the same way', async () => {
    prefsStore.set('loop_user_email', 'legacy@example.com');

    const email = await getEmail();

    expect(email).toBe('legacy@example.com');
    expect(secureStore.get('loop_user_email')).toBe('legacy@example.com');
    expect(prefsStore.has('loop_user_email')).toBe(false);
  });

  it('post-migration reads skip the Preferences fallback', async () => {
    prefsStore.set('loop_refresh_token', 'rt-legacy');
    await getRefreshToken(); // migrates
    mockPreferences.get.mockClear();

    const second = await getRefreshToken();
    expect(second).toBe('rt-legacy');
    expect(mockPreferences.get).not.toHaveBeenCalled();
  });
});

describe('secure-storage on native — clearRefreshToken wipes both stores', () => {
  it('removes values from SecureStorage and from any residue in Preferences', async () => {
    secureStore.set('loop_refresh_token', 'rt');
    secureStore.set('loop_user_email', 'u@example.com');
    // Simulate an interrupted migration: a value still in Preferences too.
    prefsStore.set('loop_refresh_token', 'stale-rt');
    prefsStore.set('loop_user_email', 'stale@example.com');

    await clearRefreshToken();

    expect(secureStore.has('loop_refresh_token')).toBe(false);
    expect(secureStore.has('loop_user_email')).toBe(false);
    expect(prefsStore.has('loop_refresh_token')).toBe(false);
    expect(prefsStore.has('loop_user_email')).toBe(false);
  });
});
