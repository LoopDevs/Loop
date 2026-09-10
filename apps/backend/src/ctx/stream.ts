// CTX SSE stream client — push-based gift-card status feed — ADR 051
import { upstreamUrl } from '../upstream.js';
import { logger } from '../logger.js';

const log = logger.child({ area: 'ctx-stream' });

// Cap prevents OOM if upstream emits no delimiters or one oversized frame.
const MAX_SSE_BUFFER_CHARS = 512 * 1024;

export interface StreamFrame {
  fulfilmentStatus?: string;
  paymentStatus?: string;
  status?: string;
  [k: string]: unknown;
}

export interface StreamCredentials {
  apiKey: string;
  apiSecret: string;
  clientId: string;
}

export interface StreamGiftCardOptions extends StreamCredentials {
  signal?: AbortSignal;
  onUpdate?: (frame: StreamFrame) => void;
}

export async function streamGiftCardStatus(
  ctxOrderId: string,
  opts: StreamGiftCardOptions,
): Promise<StreamFrame> {
  // ADR 051: server-side fetch uses header auth; `?token=` is only for browser EventSource.
  const base = upstreamUrl(`/gift-cards/${encodeURIComponent(ctxOrderId)}`);
  const url = `${base}?stream=true`;

  const init: RequestInit = {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Api-Key': opts.apiKey,
      'X-Api-Secret': opts.apiSecret,
      'X-Client-Id': opts.clientId,
    },
  };
  if (opts.signal !== undefined) init.signal = opts.signal;
  const res = await fetch(url, init);
  if (!res.ok || res.body === null) {
    log.warn(
      { ctxOrderId, status: res.status },
      'CTX SSE stream did not return a usable body — caller should poll',
    );
    throw new Error(`CTX SSE GET /gift-cards/${ctxOrderId} → ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last: StreamFrame | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;

        let frame: StreamFrame;
        try {
          frame = JSON.parse(payload) as StreamFrame;
        } catch {
          continue;
        }
        last = frame;
        if (opts.onUpdate !== undefined) opts.onUpdate(frame);

        const status = pickStatus(frame);
        if (status === 'fulfilled' || status === 'complete') {
          try {
            await reader.cancel();
          } catch {
            /* already cancelled */
          }
          return frame;
        }
        if (status === 'rejected' || status === 'failed' || status === 'error') {
          try {
            await reader.cancel();
          } catch {
            /* already cancelled */
          }
          throw new Error(`CTX order ${ctxOrderId} ${status}`);
        }
      }

      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        try {
          await reader.cancel();
        } catch {
          /* already cancelled */
        }
        log.warn(
          { ctxOrderId, bufferChars: buffer.length },
          'CTX SSE buffer exceeded cap without a frame delimiter — aborting; caller should poll',
        );
        throw new Error(
          `CTX SSE stream for ${ctxOrderId} exceeded ${MAX_SSE_BUFFER_CHARS}-char buffer cap`,
        );
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* lock already released */
    }
  }

  throw new Error(
    `CTX SSE stream ended without terminal status (last: ${
      last === null ? 'null' : JSON.stringify(last)
    })`,
  );
}

// `fulfilmentStatus` is canonical; `status` is a fallback for older endpoint versions.
function pickStatus(frame: StreamFrame): string | undefined {
  if (typeof frame.fulfilmentStatus === 'string') return frame.fulfilmentStatus;
  if (typeof frame.status === 'string') return frame.status;
  return undefined;
}
