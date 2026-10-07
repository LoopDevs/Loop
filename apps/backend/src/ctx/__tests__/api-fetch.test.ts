import { describe, expect, it, vi, beforeEach } from 'vitest';
import type * as ConfigModule from '../../config/index.js';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

vi.mock('../../logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

const { ctxState } = vi.hoisted(() => ({
  ctxState: {
    credentials: { key: 'loop' } as { key: string; secret?: string; privateKey?: string },
  },
}));
vi.mock('../../config/index.js', async (importActual) => {
  const actual = await importActual<typeof ConfigModule>();
  return {
    ...actual,
    get config() {
      return {
        ...actual.config,
        ctx: {
          ...actual.config.ctx,
          credentials: ctxState.credentials,
          clientIds: { web: 'loopweb', ios: 'loopios', android: 'loopandroid' },
        },
      };
    },
  };
});

const upstreamFetchMock = vi.hoisted(() => vi.fn());
vi.mock('../../upstream.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  upstreamFetch: upstreamFetchMock,
}));

import { ctxAuthHeaders, ctxFetch } from '../api-fetch.js';
import { canonicalString } from '../signing.js';

const PRIVATE_KEY = '11'.repeat(32);
const PUBLIC_KEY = hexToBytes('034f355bdcb7cc0af728ef3cceb9615d90684bb5b2ca5f859ab0f0b704075871aa');

function verifies(
  headers: Record<string, string>,
  method: string,
  uri: string,
  body: string | undefined,
): boolean {
  const digest = sha256(
    utf8ToBytes(
      canonicalString({
        method,
        uri,
        body,
        timestamp: headers['X-Signature-Timestamp'] ?? '',
        nonce: headers['X-Signature-Nonce'] ?? '',
        apiKey: headers['X-Api-Key'] ?? '',
        clientId: headers['X-Client-Id'] ?? '',
        userId: headers['X-User-Id'] ?? '',
      }),
    ),
  );
  const compact = hexToBytes(headers['X-Signature'] ?? '');
  return secp256k1.verify(compact.slice(1), digest, PUBLIC_KEY);
}

describe('ctxAuthHeaders', () => {
  beforeEach(() => {
    upstreamFetchMock.mockReset();
  });

  it('sends the legacy secret when no private key is configured', () => {
    ctxState.credentials = { key: 'loop', secret: 'shh' };
    const headers = ctxAuthHeaders('GET', 'https://ctx.test/merchants?page=1', undefined);
    expect(headers).toEqual({
      'X-Api-Key': 'loop',
      'X-Api-Secret': 'shh',
      'X-Client-Id': 'loopweb',
    });
  });

  it('signs the request and drops the secret when a private key is configured', () => {
    ctxState.credentials = { key: 'loop', secret: 'shh', privateKey: PRIVATE_KEY };
    const body = JSON.stringify({ fiatAmount: '5' });
    const headers = ctxAuthHeaders('POST', 'https://ctx.test/gift-cards?page=1', body, {
      'X-User-Id': 'user-1',
      'X-Api-Secret': 'stale',
      'Content-Type': 'application/json',
    });
    expect(headers['X-Api-Secret']).toBeUndefined();
    expect(headers['X-Api-Key']).toBe('loop');
    expect(headers['X-Client-Id']).toBe('loopweb');
    expect(headers['X-User-Id']).toBe('user-1');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Signature-Scheme']).toBe('secp256k1');
    expect(headers['X-Signature-Nonce']).toHaveLength(32);
    expect(Number(headers['X-Signature-Timestamp'])).toBeGreaterThan(1_700_000_000);
    expect(verifies(headers, 'POST', '/gift-cards?page=1', body)).toBe(true);
    expect(
      verifies({ ...headers, 'X-User-Id': 'user-2' }, 'POST', '/gift-cards?page=1', body),
    ).toBe(false);
  });

  it('keeps a caller-chosen client id inside the signed message', () => {
    ctxState.credentials = { key: 'loop', privateKey: PRIVATE_KEY };
    const headers = ctxAuthHeaders('GET', new URL('https://ctx.test/users/u1/account'), undefined, {
      'X-Client-Id': 'loopios',
    });
    expect(headers['X-Client-Id']).toBe('loopios');
    expect(verifies(headers, 'GET', '/users/u1/account', undefined)).toBe(true);
  });

  it('uses a fresh nonce per request', () => {
    ctxState.credentials = { key: 'loop', privateKey: PRIVATE_KEY };
    const first = ctxAuthHeaders('GET', 'https://ctx.test/ws', undefined);
    const second = ctxAuthHeaders('GET', 'https://ctx.test/ws', undefined);
    expect(first['X-Signature-Nonce']).not.toBe(second['X-Signature-Nonce']);
  });

  it('ctxFetch signs with the final headers and forwards the body unchanged', async () => {
    ctxState.credentials = { key: 'loop', privateKey: PRIVATE_KEY };
    upstreamFetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const body = JSON.stringify({ chain: 'XLM' });
    await ctxFetch('https://ctx.test/users/u1/wallets', {
      method: 'POST',
      headers: { 'X-User-Id': 'u1', 'X-Api-Secret': 'stale' },
      body,
    });
    const [, init] = upstreamFetchMock.mock.calls[0] as [string, RequestInit];
    const sent = init.headers as Headers;
    expect(sent.get('X-Api-Secret')).toBeNull();
    expect(init.body).toBe(body);
    const record = Object.fromEntries(sent.entries());
    expect(
      verifies(
        {
          'X-Signature': record['x-signature'] ?? '',
          'X-Signature-Timestamp': record['x-signature-timestamp'] ?? '',
          'X-Signature-Nonce': record['x-signature-nonce'] ?? '',
          'X-Api-Key': record['x-api-key'] ?? '',
          'X-Client-Id': record['x-client-id'] ?? '',
          'X-User-Id': record['x-user-id'] ?? '',
        },
        'POST',
        '/users/u1/wallets',
        body,
      ),
    ).toBe(true);
  });
});
