import { describe, it, expect } from 'vitest';
import { decodeJwtPayload } from '../jwt.js';

function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function makeJwt(payload: unknown): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  // Signature is not verified — any non-empty string works.
  return `${header}.${body}.signature`;
}

describe('decodeJwtPayload', () => {
  it('returns the payload for a well-formed JWT', () => {
    const token = makeJwt({ sub: 'user-1', email: 'a@example.com' });
    const out = decodeJwtPayload(token);
    expect(out).not.toBeNull();
    expect(out?.sub).toBe('user-1');
    expect(out?.['email']).toBe('a@example.com');
  });

  it('passes through extra claims via the index signature', () => {
    const token = makeJwt({ sub: 'user-2', custom: 42 });
    const out = decodeJwtPayload(token);
    expect(out?.['custom']).toBe(42);
  });

  it('returns null when the token is not three segments', () => {
    expect(decodeJwtPayload('a.b')).toBeNull();
    expect(decodeJwtPayload('not-a-jwt')).toBeNull();
    expect(decodeJwtPayload('a.b.c.d')).toBeNull();
  });

  it('returns null when the payload segment is empty', () => {
    expect(decodeJwtPayload('header..signature')).toBeNull();
  });

  it('returns null when the payload is not valid base64url JSON', () => {
    expect(decodeJwtPayload('header.!!!not-base64!!!.sig')).toBeNull();
    expect(decodeJwtPayload(`header.${b64url('not json')}.sig`)).toBeNull();
  });

  it('returns null when the payload is not an object', () => {
    expect(decodeJwtPayload(`header.${b64url('"a-string"')}.sig`)).toBeNull();
    expect(decodeJwtPayload(`header.${b64url('null')}.sig`)).toBeNull();
    expect(decodeJwtPayload(`header.${b64url('123')}.sig`)).toBeNull();
  });

  it('returns null when `sub` is missing or not a non-empty string', () => {
    expect(decodeJwtPayload(makeJwt({ email: 'a@example.com' }))).toBeNull();
    expect(decodeJwtPayload(makeJwt({ sub: '' }))).toBeNull();
    expect(decodeJwtPayload(makeJwt({ sub: 42 }))).toBeNull();
  });
});
