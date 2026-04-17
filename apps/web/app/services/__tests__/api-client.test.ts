import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config before importing api-client
vi.mock('~/services/config', () => ({ API_BASE: 'http://test-api' }));

import { apiRequest } from '../api-client';
import { ApiException } from '@loop/shared';

describe('apiRequest', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('makes a GET request and returns JSON', async () => {
    const mockData = { merchants: [] };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockData), { status: 200 }),
    );

    const result = await apiRequest('/api/merchants');
    expect(result).toEqual(mockData);
    expect(fetch).toHaveBeenCalledWith(
      'http://test-api/api/merchants',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('sends JSON body for POST requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await apiRequest('/api/auth/request-otp', {
      method: 'POST',
      body: { email: 'test@example.com' },
    });

    const call = vi.mocked(fetch).mock.calls[0]!;
    const [, init] = call;
    expect(init?.body).toBe(JSON.stringify({ email: 'test@example.com' }));
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('throws ApiException on non-2xx response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }), { status: 404 }),
    );

    await expect(apiRequest('/api/missing')).rejects.toThrow(ApiException);
  });

  it('includes error code from JSON error response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: 'NOT_FOUND', message: 'Not found' }), { status: 404 }),
    );

    await expect(apiRequest('/api/missing')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });

  it('falls back to NETWORK_ERROR when error response is not JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(apiRequest('/api/broken')).rejects.toMatchObject({
      status: 500,
      code: 'NETWORK_ERROR',
    });
  });

  it('returns ArrayBuffer when binary option is set', async () => {
    const buffer = new ArrayBuffer(8);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(buffer, { status: 200 }));

    const result = await apiRequest('/api/image', { binary: true });
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it('passes an AbortSignal with the request (timeout wired up)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await apiRequest('/api/merchants');

    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('translates TimeoutError into ApiException{ code: TIMEOUT }', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new DOMException('The operation timed out.', 'TimeoutError'),
    );

    await expect(apiRequest('/api/slow')).rejects.toMatchObject({
      name: 'ApiException',
      code: 'TIMEOUT',
      status: 0,
    });
  });

  it('translates other fetch rejections into ApiException{ code: NETWORK_ERROR }', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Failed to fetch'));

    await expect(apiRequest('/api/broken')).rejects.toMatchObject({
      name: 'ApiException',
      code: 'NETWORK_ERROR',
      status: 0,
    });
  });

  it('honors timeoutMs=0 to disable the default timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    await apiRequest('/api/slow-on-purpose', { timeoutMs: 0 });

    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    // No caller signal + timeoutMs=0 means we don't pass a signal at all.
    expect(init.signal ?? null).toBeNull();
  });
});
