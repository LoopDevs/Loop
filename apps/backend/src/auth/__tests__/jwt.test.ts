import { describe, it, expect, vi } from 'vitest';

// Mock env before importing jwt (jwt reads env at module level)
vi.mock('../../env.js', () => ({
  env: {
    JWT_SECRET: 'test-access-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    JWT_REFRESH_SECRET: 'test-refresh-secret-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  },
}));

// Import after mock is set up
const { issueTokenPair, verifyAccessToken, refreshAccessToken } = await import('../jwt.js');

describe('issueTokenPair', () => {
  it('returns two non-empty token strings', () => {
    const { accessToken, refreshToken } = issueTokenPair('user@example.com');
    expect(typeof accessToken).toBe('string');
    expect(accessToken.length).toBeGreaterThan(0);
    expect(typeof refreshToken).toBe('string');
    expect(refreshToken.length).toBeGreaterThan(0);
  });

  it('tokens are different (different jti)', () => {
    const { accessToken, refreshToken } = issueTokenPair('user@example.com');
    expect(accessToken).not.toBe(refreshToken);
  });

  it('tokens follow HS256 JWT format (3 base64url parts)', () => {
    const { accessToken, refreshToken } = issueTokenPair('user@example.com');
    expect(accessToken.split('.')).toHaveLength(3);
    expect(refreshToken.split('.')).toHaveLength(3);
  });

  it('two calls produce different tokens (different jti)', () => {
    const first = issueTokenPair('user@example.com');
    const second = issueTokenPair('user@example.com');
    expect(first.accessToken).not.toBe(second.accessToken);
    expect(first.refreshToken).not.toBe(second.refreshToken);
  });
});

describe('verifyAccessToken', () => {
  it('returns the email for a valid access token', () => {
    const { accessToken } = issueTokenPair('verified@example.com');
    expect(verifyAccessToken(accessToken)).toBe('verified@example.com');
  });

  it('returns null for a tampered token', () => {
    const { accessToken } = issueTokenPair('tamper@example.com');
    const tampered = accessToken.slice(0, -4) + 'xxxx';
    expect(verifyAccessToken(tampered)).toBeNull();
  });

  it('returns null for a refresh token verified as access token (wrong secret)', () => {
    const { refreshToken } = issueTokenPair('cross@example.com');
    expect(verifyAccessToken(refreshToken)).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(verifyAccessToken('')).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(verifyAccessToken('not.a.valid.jwt.at.all')).toBeNull();
    expect(verifyAccessToken('abc')).toBeNull();
  });

  it('returns null for an expired token', async () => {
    vi.useFakeTimers();
    const { accessToken } = issueTokenPair('expired@example.com');
    // Advance past 15-minute access token TTL
    vi.advanceTimersByTime(16 * 60 * 1000);
    expect(verifyAccessToken(accessToken)).toBeNull();
    vi.useRealTimers();
  });
});

describe('refreshAccessToken', () => {
  it('returns a new access token from a valid refresh token', () => {
    const { refreshToken } = issueTokenPair('refresh@example.com');
    const newAccess = refreshAccessToken(refreshToken);
    expect(newAccess).not.toBeNull();
    expect(verifyAccessToken(newAccess!)).toBe('refresh@example.com');
  });

  it('returns null for an access token used as refresh token (wrong secret)', () => {
    const { accessToken } = issueTokenPair('wrong-token@example.com');
    expect(refreshAccessToken(accessToken)).toBeNull();
  });

  it('returns null for a tampered refresh token', () => {
    const { refreshToken } = issueTokenPair('tamper@example.com');
    const tampered = refreshToken.slice(0, -4) + 'xxxx';
    expect(refreshAccessToken(tampered)).toBeNull();
  });

  it('new access token is different from original (new jti)', () => {
    const { accessToken, refreshToken } = issueTokenPair('new-jti@example.com');
    const newAccess = refreshAccessToken(refreshToken);
    expect(newAccess).not.toBe(accessToken);
  });
});
