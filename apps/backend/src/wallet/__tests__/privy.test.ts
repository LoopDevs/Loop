import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPrivyWalletProvider } from '../privy.js';
import { WalletProviderError } from '../provider.js';

/**
 * Privy adapter tests (ADR 030 Phase B). Everything runs against a
 * mocked global fetch — no network. Coverage: request shapes (auth
 * headers, endpoints, bodies), createWallet idempotency
 * (query-before-create + deterministic idempotency key), Zod
 * rejection on response drift, the transient/terminal error
 * taxonomy, and timeouts.
 */

const USER_ID = '4f6c1a2e-9b3d-4c5e-8f7a-0b1c2d3e4f5a';
const WALLET_ID = 'clxyzwallet0000privy';
const ADDRESS = 'GBVNNPOFVV2YNXSQXDJPBVQYY7WJLHGPMLXZLHBZ3Y6HLKXQGFBPBZGY';

// 64 bytes of 0xab as hex — shape-valid ed25519 signature material.
const SIG_HEX_128 = 'ab'.repeat(64);
const TX_HASH_HEX = 'cd'.repeat(32);

const provider = createPrivyWalletProvider({ appId: 'app123', appSecret: 'sec456' });

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function walletBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: WALLET_ID,
    address: ADDRESS,
    chain_type: 'stellar',
    external_id: USER_ID,
    created_at: 1780000000000,
    policy_ids: [],
    owner_id: null,
    additional_signers: [],
    exported_at: null,
    imported_at: null,
    ...overrides,
  };
}

let fetchSpy: ReturnType<typeof vi.spyOn> | null = null;

afterEach(() => {
  fetchSpy?.mockRestore();
  fetchSpy = null;
});

async function expectWalletProviderError(
  promise: Promise<unknown>,
  kind: 'transient_provider' | 'terminal_provider',
  messageIncludes?: string,
): Promise<WalletProviderError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(WalletProviderError);
    const wpe = err as WalletProviderError;
    expect(wpe.kind).toBe(kind);
    if (messageIncludes !== undefined) {
      expect(wpe.message).toContain(messageIncludes);
    }
    return wpe;
  }
  throw new Error('expected the promise to reject with a WalletProviderError');
}

describe('createWallet', () => {
  it('creates a stellar wallet keyed on the Loop user id when none exists', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse(walletBody()));

    const result = await provider.createWallet(USER_ID);
    expect(result).toEqual({ walletId: WALLET_ID, address: ADDRESS });

    // Call 1: query-before-create on external_id.
    const [listUrl, listInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(listUrl).toBe(
      `https://api.privy.io/v1/wallets?chain_type=stellar&external_id=${USER_ID}`,
    );
    expect(listInit.method).toBe('GET');

    // Call 2: the create itself.
    const [createUrl, createInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
    expect(createUrl).toBe('https://api.privy.io/v1/wallets');
    expect(createInit.method).toBe('POST');
    expect(JSON.parse(createInit.body as string)).toEqual({
      chain_type: 'stellar',
      external_id: USER_ID,
    });

    // Auth shape: Basic appId:appSecret + privy-app-id header, and
    // the deterministic per-user idempotency key on the POST.
    const headers = createInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBe(
      `Basic ${Buffer.from('app123:sec456').toString('base64')}`,
    );
    expect(headers['privy-app-id']).toBe('app123');
    expect(headers['privy-idempotency-key']).toBe(`loop-wallet-stellar-${USER_ID}`);
  });

  it('is idempotent per user — an existing wallet short-circuits the create', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: [walletBody()] }));

    const result = await provider.createWallet(USER_ID);
    expect(result).toEqual({ walletId: WALLET_ID, address: ADDRESS });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a userId that cannot be a Privy external_id without calling the network', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expectWalletProviderError(
      provider.createWallet('not a valid id!'),
      'terminal_provider',
      'external_id',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects response drift via Zod (wallet missing address)', async () => {
    const drifted = walletBody();
    delete drifted['address'];
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ data: [] }))
      .mockResolvedValueOnce(jsonResponse(drifted));

    await expectWalletProviderError(
      provider.createWallet(USER_ID),
      'terminal_provider',
      'failed validation',
    );
  });

  it('rejects list-response drift via Zod', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ wallets: 'nope' }));

    await expectWalletProviderError(
      provider.createWallet(USER_ID),
      'terminal_provider',
      'failed validation',
    );
  });
});

describe('rawSign', () => {
  it('signs a pre-computed hash and returns the signature hex without the 0x prefix', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        method: 'raw_sign',
        data: { signature: `0x${SIG_HEX_128}`, encoding: 'hex' },
      }),
    );

    const signature = await provider.rawSign(WALLET_ID, TX_HASH_HEX);
    expect(signature).toBe(SIG_HEX_128);

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.privy.io/v1/wallets/${WALLET_ID}/raw_sign`);
    expect(init.method).toBe('POST');
    // Privy's Hex type requires the 0x prefix on the request side.
    expect(JSON.parse(init.body as string)).toEqual({
      params: { hash: `0x${TX_HASH_HEX}` },
    });
  });

  it('accepts a 0x-prefixed input hash', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        method: 'raw_sign',
        data: { signature: `0x${SIG_HEX_128}`, encoding: 'hex' },
      }),
    );
    await expect(provider.rawSign(WALLET_ID, `0x${TX_HASH_HEX}`)).resolves.toBe(SIG_HEX_128);
  });

  it('rejects a malformed hash without calling the network', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expectWalletProviderError(
      provider.rawSign(WALLET_ID, 'deadbeef'),
      'terminal_provider',
      '32-byte',
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects response drift via Zod (non-hex signature)', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        method: 'raw_sign',
        data: { signature: 'not-hex', encoding: 'hex' },
      }),
    );
    await expectWalletProviderError(
      provider.rawSign(WALLET_ID, TX_HASH_HEX),
      'terminal_provider',
      'failed validation',
    );
  });

  it('rejects a signature that is not 64 bytes', async () => {
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      jsonResponse({
        method: 'raw_sign',
        // 32 bytes — valid hex, wrong length for ed25519.
        data: { signature: `0x${'ab'.repeat(32)}`, encoding: 'hex' },
      }),
    );
    await expectWalletProviderError(
      provider.rawSign(WALLET_ID, TX_HASH_HEX),
      'terminal_provider',
      'expected 64 bytes',
    );
  });
});

describe('error classification (mirrors the payout-submit taxonomy)', () => {
  it('classifies 5xx as transient', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'upstream sad' }, 503));
    const err = await expectWalletProviderError(
      provider.createWallet(USER_ID),
      'transient_provider',
    );
    expect(err.status).toBe(503);
  });

  it('classifies 429 as transient', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'slow down' }, 429));
    const err = await expectWalletProviderError(
      provider.rawSign(WALLET_ID, TX_HASH_HEX),
      'transient_provider',
    );
    expect(err.status).toBe(429);
  });

  it('classifies other 4xx as terminal', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse({ error: 'bad request' }, 400));
    const err = await expectWalletProviderError(
      provider.createWallet(USER_ID),
      'terminal_provider',
    );
    expect(err.status).toBe(400);
  });

  it('classifies network failure as transient', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed: ECONNRESET'));
    await expectWalletProviderError(
      provider.createWallet(USER_ID),
      'transient_provider',
      'before a response',
    );
  });

  it('classifies an AbortSignal timeout as transient', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'));
    await expectWalletProviderError(
      provider.rawSign(WALLET_ID, TX_HASH_HEX),
      'transient_provider',
      'TimeoutError',
    );
  });

  it('classifies a 2xx non-JSON body as terminal contract drift', async () => {
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<html>gateway</html>', { status: 200 }));
    await expectWalletProviderError(
      provider.createWallet(USER_ID),
      'terminal_provider',
      'non-JSON body',
    );
  });
});
