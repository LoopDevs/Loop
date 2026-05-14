/**
 * CTX SSE stream client — push-based gift-card status feed.
 *
 * `spend.ctx.com` exposes a Server-Sent Events variant of the
 * gift-card lookup at:
 *
 *   GET /gift-cards/{id}?stream=true&token={bearer}
 *   Accept:        text/event-stream
 *   Cache-Control: no-cache
 *   X-Client-Id:   <must match the bearer's JWT clientId>
 *
 * The bearer goes in the query string, not the `Authorization`
 * header — this is a workaround for the browser EventSource API
 * (which can't set custom request headers). CTX's reference web
 * client uses this same path, so it's the well-trodden contract
 * even though we're not actually using EventSource on our side.
 *
 * Each SSE frame is a plain `data: {json}` line, where the JSON
 * carries fields like `{fulfilmentStatus, paymentStatus, ...}`.
 * The status timeline is `unpaid → paid → fulfilled`. Frames
 * may or may not include the redemption fields (`redeemUrl`,
 * `redeemCode`, `redeemPin`) — the caller follows up with one
 * authoritative `GET /gift-cards/:id` to pull those.
 *
 * Ported from `vcc/api/src/ctx/client.js:362-431` (the working
 * reference implementation). Operator pool integration is at the
 * call-site: pick credentials via `pickOperatorCredentials()` from
 * `./operator-pool.js` and pass them in.
 *
 * On any stream error (network blip, timeout, abort), the caller is
 * expected to fall back to polling via `operatorFetch` — the stream
 * is opportunistic, polling is the safety net.
 */
import { upstreamUrl } from '../upstream.js';
import { logger } from '../logger.js';

const log = logger.child({ area: 'ctx-stream' });

/**
 * Subset of fields the stream surfaces that the orchestration layer
 * needs. CTX may include other fields; we accept the frame as
 * `Record<string, unknown>` and only narrow what we read.
 */
export interface StreamFrame {
  fulfilmentStatus?: string;
  paymentStatus?: string;
  status?: string;
  [k: string]: unknown;
}

export interface StreamCredentials {
  /** Operator bearer to use in `?token=`. */
  bearer: string;
  /** Must match the `clientId` baked into the bearer JWT or CTX 401s. */
  clientId: string;
}

export interface StreamGiftCardOptions extends StreamCredentials {
  /** Abort signal to terminate the stream mid-read. */
  signal?: AbortSignal;
  /** Called for every parsed frame — useful for observability. */
  onUpdate?: (frame: StreamFrame) => void;
}

/**
 * Reads `data:`-prefixed lines off the SSE stream and dispatches
 * parsed JSON frames to the caller. The function resolves when CTX
 * announces a terminal `fulfilled`/`complete` status — at which point
 * the caller should run a single follow-up `GET /gift-cards/:id` to
 * pull the redemption fields (codes/PIN/URL aren't always present in
 * the SSE frames).
 *
 * Throws when:
 *   - the stream returns non-2xx (e.g. 401 token-mismatch, 5xx)
 *   - CTX announces a terminal `rejected`/`failed`/`error` status
 *   - the underlying body ends before a terminal status arrives
 *   - the abort signal fires
 *
 * In every error path the caller is expected to fall back to polling.
 */
export async function streamGiftCardStatus(
  ctxOrderId: string,
  opts: StreamGiftCardOptions,
): Promise<StreamFrame> {
  // Build the URL with the bearer in `?token=`. Never log this URL —
  // it carries the operator credential. Access-log middleware records
  // method+path on inbound requests only; outbound fetch URLs aren't
  // captured, but we still keep the URL out of any `log.*` call.
  const base = upstreamUrl(`/gift-cards/${encodeURIComponent(ctxOrderId)}`);
  const url = `${base}?stream=true&token=${encodeURIComponent(opts.bearer)}`;

  const init: RequestInit = {
    method: 'GET',
    headers: {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Client-Id': opts.clientId,
    },
  };
  // `exactOptionalPropertyTypes` forbids assigning `undefined` to
  // `signal: AbortSignal | null` — set it only when the caller
  // provided one.
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

      // SSE frames are separated by `\n\n`; within a frame, lines
      // starting with `data: ` carry the JSON payload. Process every
      // complete line; leave the trailing partial in `buffer` for the
      // next read.
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
          // Malformed frame — skip it. The next valid frame will
          // resync. We don't log because a noisy upstream could
          // flood the log.
          continue;
        }
        last = frame;
        if (opts.onUpdate !== undefined) opts.onUpdate(frame);

        const status = pickStatus(frame);
        if (status === 'fulfilled' || status === 'complete') {
          // Best-effort release of the upstream socket so undici can
          // recycle the connection. `cancel()` may throw if the
          // stream is already closed — swallow.
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
    }
  } finally {
    // Reader is automatically released when cancel/read-done completes,
    // but if we throw mid-iteration the lock may still be held.
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

/**
 * CTX uses both `fulfilmentStatus` and `status` field names across
 * different endpoint versions. Prefer `fulfilmentStatus` when both
 * are present (it's the canonical column); fall back to `status`.
 */
function pickStatus(frame: StreamFrame): string | undefined {
  if (typeof frame.fulfilmentStatus === 'string') return frame.fulfilmentStatus;
  if (typeof frame.status === 'string') return frame.status;
  return undefined;
}
