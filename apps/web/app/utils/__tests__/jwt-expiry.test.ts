import { describe, it, expect } from 'vitest';
import { getJwtExpiryMs, isJwtExpired, JWT_EXPIRY_SKEW_MS } from '../jwt-expiry';

/** Unsigned three-segment token with the given payload — decode-only tests. */
const fakeJwt = (payload: Record<string, unknown>): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `eyJhbGciOiJIUzI1NiJ9.${body}.sig`;
};

const inSeconds = (s: number): number => Math.floor(Date.now() / 1000) + s;

describe('getJwtExpiryMs', () => {
  it('decodes a numeric exp claim to epoch-ms', () => {
    const exp = inSeconds(3600);
    expect(getJwtExpiryMs(fakeJwt({ exp }))).toBe(exp * 1000);
  });

  it('returns null for a non-JWT string', () => {
    expect(getJwtExpiryMs('opaque-token')).toBeNull();
  });

  it('returns null when the payload segment is not base64 JSON', () => {
    expect(getJwtExpiryMs('a.!!!not-base64!!!.c')).toBeNull();
  });

  it('returns null when exp is absent or non-numeric', () => {
    expect(getJwtExpiryMs(fakeJwt({ sub: 'u1' }))).toBeNull();
    expect(getJwtExpiryMs(fakeJwt({ exp: 'tomorrow' }))).toBeNull();
  });
});

describe('isJwtExpired', () => {
  it('is false for a token expiring well beyond the skew window', () => {
    expect(isJwtExpired(fakeJwt({ exp: inSeconds(3600) }))).toBe(false);
  });

  it('is true for a token already past exp', () => {
    expect(isJwtExpired(fakeJwt({ exp: inSeconds(-60) }))).toBe(true);
  });

  it('is true for a token expiring inside the skew window', () => {
    const insideSkew = inSeconds(Math.floor(JWT_EXPIRY_SKEW_MS / 1000) - 5);
    expect(isJwtExpired(fakeJwt({ exp: insideSkew }))).toBe(true);
  });

  it('fails open (false) for opaque / exp-less tokens', () => {
    // The 401 → refresh → retry path stays the authority for tokens
    // whose expiry the client cannot read.
    expect(isJwtExpired('opaque-token')).toBe(false);
    expect(isJwtExpired(fakeJwt({ sub: 'u1' }))).toBe(false);
  });
});
