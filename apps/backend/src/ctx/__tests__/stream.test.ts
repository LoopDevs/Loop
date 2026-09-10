import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamGiftCardStatus } from '../stream.js';

function sseResponse(frames: string[]): Response {
  const body = frames.join('\n\n') + '\n\n';
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const CREDS = { apiKey: 'key-abc', apiSecret: 'secret-abc', clientId: 'loopweb' };

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(global, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe('streamGiftCardStatus', () => {
  it('resolves on terminal fulfilled', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ fulfilmentStatus: 'paid' })}`,
        `data: ${JSON.stringify({ fulfilmentStatus: 'fulfilled', ctxOrderId: 'x' })}`,
      ]),
    );
    const result = await streamGiftCardStatus('o-1', CREDS);
    expect(result.fulfilmentStatus).toBe('fulfilled');
  });

  it('resolves on terminal complete (alternative status field name)', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([`data: ${JSON.stringify({ status: 'complete' })}`]),
    );
    const result = await streamGiftCardStatus('o-1', CREDS);
    expect(result.status).toBe('complete');
  });

  it('throws on terminal rejected', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([`data: ${JSON.stringify({ fulfilmentStatus: 'rejected' })}`]),
    );
    await expect(streamGiftCardStatus('o-1', CREDS)).rejects.toThrow(/rejected/);
  });

  it('throws on terminal failed', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([`data: ${JSON.stringify({ fulfilmentStatus: 'failed' })}`]),
    );
    await expect(streamGiftCardStatus('o-1', CREDS)).rejects.toThrow(/failed/);
  });

  it('throws on terminal error', async () => {
    fetchSpy.mockResolvedValueOnce(sseResponse([`data: ${JSON.stringify({ status: 'error' })}`]));
    await expect(streamGiftCardStatus('o-1', CREDS)).rejects.toThrow(/error/);
  });

  it('skips malformed JSON frames without aborting the stream', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        'data: {not json',
        '',
        `data: ${JSON.stringify({ fulfilmentStatus: 'fulfilled' })}`,
      ]),
    );
    const result = await streamGiftCardStatus('o-1', CREDS);
    expect(result.fulfilmentStatus).toBe('fulfilled');
  });

  it('ignores non-data lines (event:, id:, comments)', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        ': keep-alive',
        'event: status',
        'id: 42',
        `data: ${JSON.stringify({ fulfilmentStatus: 'fulfilled' })}`,
      ]),
    );
    const result = await streamGiftCardStatus('o-1', CREDS);
    expect(result.fulfilmentStatus).toBe('fulfilled');
  });

  it('throws when stream ends without a terminal status', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ fulfilmentStatus: 'paid' })}`,
        `data: ${JSON.stringify({ fulfilmentStatus: 'processing' })}`,
      ]),
    );
    await expect(streamGiftCardStatus('o-1', CREDS)).rejects.toThrow(
      /ended without terminal status/,
    );
  });

  it('aborts when a degenerate upstream never emits a frame delimiter (buffer cap)', async () => {
    // Prevents OOM from unbounded buffer accumulation if upstream streams bytes without newlines
    const noDelimiter = 'x'.repeat(576 * 1024);
    fetchSpy.mockResolvedValueOnce(
      new Response(new TextEncoder().encode(noDelimiter), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      }),
    );
    await expect(streamGiftCardStatus('o-1', CREDS)).rejects.toThrow(/buffer cap/);
  });

  it('throws when CTX returns non-2xx', async () => {
    fetchSpy.mockResolvedValueOnce(new Response('boom', { status: 503 }));
    await expect(streamGiftCardStatus('o-1', CREDS)).rejects.toThrow(/503/);
  });

  it('passes the API-key pair + clientId via headers, never the URL', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([`data: ${JSON.stringify({ fulfilmentStatus: 'fulfilled' })}`]),
    );
    await streamGiftCardStatus('o-1', {
      apiKey: 'KEY-XYZ',
      apiSecret: 'SECRET-XYZ',
      clientId: 'loopios',
    });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/gift-cards/o-1');
    expect(String(url)).toContain('stream=true');
    expect(String(url)).not.toContain('token=');
    expect(String(url)).not.toContain('SECRET-XYZ');
    const headers = new Headers(init?.headers);
    expect(headers.get('Accept')).toBe('text/event-stream');
    expect(headers.get('X-Api-Key')).toBe('KEY-XYZ');
    expect(headers.get('X-Api-Secret')).toBe('SECRET-XYZ');
    expect(headers.get('X-Client-Id')).toBe('loopios');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('calls onUpdate for each frame', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([
        `data: ${JSON.stringify({ fulfilmentStatus: 'unpaid' })}`,
        `data: ${JSON.stringify({ fulfilmentStatus: 'paid' })}`,
        `data: ${JSON.stringify({ fulfilmentStatus: 'fulfilled' })}`,
      ]),
    );
    const seen: string[] = [];
    await streamGiftCardStatus('o-1', {
      ...CREDS,
      onUpdate: (f) => {
        if (typeof f.fulfilmentStatus === 'string') seen.push(f.fulfilmentStatus);
      },
    });
    expect(seen).toEqual(['unpaid', 'paid', 'fulfilled']);
  });

  it('url-encodes the order id', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([`data: ${JSON.stringify({ fulfilmentStatus: 'fulfilled' })}`]),
    );
    await streamGiftCardStatus('weird/id with spaces', CREDS);
    expect(String(fetchSpy.mock.calls[0]![0])).toContain('/gift-cards/weird%2Fid%20with%20spaces');
  });
});
