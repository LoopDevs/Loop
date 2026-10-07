import { describe, expect, it } from 'vitest';
import {
  bodyHash,
  canonicalString,
  requestUri,
  signCtxRequest,
  signingPublicKey,
  type CtxSignatureInput,
} from '../signing.js';

// Test vector from spend-api/doc/handover-loop.md ("Authenticating"), verified by the Go side.
const PRIVATE_KEY = '11'.repeat(32);
const PUBLIC_KEY = '034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa';
const VECTOR: CtxSignatureInput = {
  method: 'POST',
  uri: '/gift-cards?page=1',
  body: '{}',
  timestamp: '1700000000',
  nonce: '0123456789abcdef0123456789abcdef',
  apiKey: 'loop',
  clientId: 'loopweb',
  userId: 'user-1',
};

describe('CTX request signing', () => {
  it('derives the compressed public key to register on the API user', () => {
    expect(signingPublicKey(PRIVATE_KEY)).toBe(PUBLIC_KEY);
  });

  it('hashes the exact body bytes, with the empty hash for no body', () => {
    expect(bodyHash('{}')).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(bodyHash(undefined)).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(bodyHash(null)).toBe(bodyHash(undefined));
    expect(() => bodyHash(new FormData())).toThrow(/string, bytes or URLSearchParams/);
  });

  it('joins the eight canonical fields with newlines and no trailing newline', () => {
    expect(canonicalString(VECTOR)).toBe(
      'POST\n/gift-cards?page=1\n44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a\n1700000000\n0123456789abcdef0123456789abcdef\nloop\nloopweb\nuser-1',
    );
    expect(canonicalString({ ...VECTOR, clientId: '', userId: '' })).toMatch(/\nloop\n\n$/);
  });

  it('produces the documented compact recoverable signature', () => {
    const headers = signCtxRequest(VECTOR, PRIVATE_KEY);
    expect(headers['X-Signature']).toBe(
      '1f53e86b73c3678e37ca971f2c94daeefe9e654b0acbe2f75788cea0cf7232f56f7b70cfebbce5c5af0a21e20c5c02cd387ec9e50c3273cf49d8fed270092bbb08',
    );
    expect(headers['X-Signature-Scheme']).toBe('secp256k1');
    expect(headers['X-Signature-Timestamp']).toBe('1700000000');
    expect(headers['X-Signature-Nonce']).toBe('0123456789abcdef0123456789abcdef');
  });

  it('signs the path and query exactly as sent', () => {
    expect(requestUri('https://spend.ctx.com/gift-cards?page=1&perPage=50')).toBe(
      '/gift-cards?page=1&perPage=50',
    );
    expect(requestUri(new URL('https://spend.ctx.com/ws'))).toBe('/ws');
    expect(requestUri('https://spend.ctx.com/api/users?x=1#frag')).toBe('/api/users?x=1');
  });
});
