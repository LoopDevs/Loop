import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { streamGiftCardStatus } from '../stream.js';

// upstream.ts reads GIFT_CARD_API_BASE_URL via env.ts → set a placeholder
// before module load so `upstreamUrl` resolves. env.ts also requires
// DATABASE_URL even though this suite never touches the DB.
vi.hoisted(() => {
  process.env['GIFT_CARD_API_BASE_URL'] = 'https://ctx.test';
  process.env['DATABASE_URL'] ??= 'postgres://placeholder@localhost/test';
});

function sseResponse(frames: string[]): Response {
  // Stream the frames out one chunk at a time, mimicking real SSE
  // boundaries. Frames are joined with \n\n (the SSE record
  // separator) and emitted as a single body — the parser is line-
  // oriented so this is enough.
  const body = frames.join('\n\n') + '\n\n';
  return new Response(new TextEncoder().encode(body), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const CREDS = { bearer: 'tok-abc', clientId: 'loopweb' };

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
    // A hostile/degenerate CTX upstream that streams bytes but never a
    // `\n` delimiter. Without a cap the reader accumulates this into an
    // unbounded in-memory buffer until the worker OOMs. Emit ~576 KiB of
    // delimiter-free bytes (past the 512 KiB cap) then end the body.
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

  it('passes bearer in `?token=`, clientId via X-Client-Id header', async () => {
    fetchSpy.mockResolvedValueOnce(
      sseResponse([`data: ${JSON.stringify({ fulfilmentStatus: 'fulfilled' })}`]),
    );
    await streamGiftCardStatus('o-1', { bearer: 'BEARER-XYZ', clientId: 'loopios' });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toContain('/gift-cards/o-1');
    expect(String(url)).toContain('stream=true');
    expect(String(url)).toContain('token=BEARER-XYZ');
    const headers = new Headers(init?.headers);
    expect(headers.get('Accept')).toBe('text/event-stream');
    expect(headers.get('X-Client-Id')).toBe('loopios');
    // Never put the bearer in the Authorization header — CTX
    // wires SSE auth via the query string only.
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
