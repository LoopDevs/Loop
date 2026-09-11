import { notifyCtxCredentialInvalid } from '../discord.js';
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { upstreamFetch } from '../upstream.js';

const log = logger.child({ area: 'ctx-api' });

export class CtxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CtxUnavailableError';
  }
}

export class CtxRateLimitedError extends Error {
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'CtxRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

// CF-12: parse an HTTP `Retry-After` header into milliseconds. Per RFC 9110 the value is either delta-seconds (`"120"`)
// or an HTTP-date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
// Returns `null` for an absent, empty, or unparseable header, and clamps negatives (a past date) to 0.
// Caps at 5 minutes so a pathological upstream value can't park a tick indefinitely.
const RETRY_AFTER_MAX_MS = 5 * 60 * 1000;

export function parseRetryAfterMs(header: string | null): number | null {
  if (header === null) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;
  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(secs)) return null;
    return Math.min(secs * 1000, RETRY_AFTER_MAX_MS);
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const deltaMs = dateMs - Date.now();
  return Math.min(Math.max(deltaMs, 0), RETRY_AFTER_MAX_MS);
}

export interface CtxApiCredentials {
  apiKey: string;
  apiSecret: string;
  clientId: string;
}

// The operator API-key credentials. Always present — the env schema requires them at boot. Used by call sites (CTX SSE stream) that can't route through `ctxFetch` because the transport isn't a single substitutable `fetch` call.
export function ctxApiCredentials(): CtxApiCredentials {
  return {
    apiKey: config.ctx.credentials.key,
    apiSecret: config.ctx.credentials.secret,
    clientId: config.ctx.clientIds.web,
  };
}

// Snapshot of the upstream credential state — for `/health` and the admin
// treasury snapshot (ADR 013's observability bullet, collapsed to a single
// upstream under ADR 051).
// Both fields are now constant: `configured` because the env schema requires
// the credentials at boot, and `state` because the upstream breaker it used
// to report is gone. They survive for response-shape stability — `/health`
// consumers still parse this object.
// Live CTX reachability is the upstream probe's job, not this function's.
export function getCtxApiHealth(): { configured: boolean; state: string } {
  return { configured: true, state: 'closed' };
}

// A2-1510: per-request timeout cap. Callers pass a caller-owned signal for long-running streams or cancellation; absent one, we apply a conservative 30-second cap so a wedged CTX upstream can't park a procurement / payout tick forever.
const CTX_FETCH_DEFAULT_TIMEOUT_MS = 30_000;

// Release a response body we're about to discard so undici returns the socket to its pool instead of leaving it half-read. Swallows errors — an already-consumed or aborted body is harmless here.
async function drainBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* already consumed / aborted — harmless */
  }
}

// Injects the CTX API-key headers into `init.headers` and dispatches through `upstreamFetch`, which carries the A2-1305 request-id correlation in both directions. Callers may pre-set `X-User-Id` (act-as) and `X-Client-Id` (request-origin client) — `ctxFetch` only fills `X-Client-Id` when the caller didn't.
export async function ctxFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const creds = ctxApiCredentials();

  const signal: AbortSignal | undefined =
    init?.signal ?? AbortSignal.timeout(CTX_FETCH_DEFAULT_TIMEOUT_MS);

  const headers = new Headers(init?.headers);
  headers.set('X-Api-Key', creds.apiKey);
  headers.set('X-Api-Secret', creds.apiSecret);
  if (!headers.has('X-Client-Id')) {
    headers.set('X-Client-Id', creds.clientId);
  }
  // A2-1305 in both directions (our id stamped outbound, CTX's id captured off the response for the `X-Ctx-Request-Id` echo) is `upstreamFetch`'s job — see `../upstream.ts`.
  const res = await upstreamFetch(url, { ...init, headers, signal });

  // CF-13 (single-key form): a 401 means CTX rejected the API key — revoked, rotated on the CTX side, or misconfigured. It is an ops incident, not a request-shape bug: alert and surface a transient error so paid orders stay retryable while the key is restored. `notifyCtxCredentialInvalid` carries its own dedup window, so a tick that keeps retrying through the outage pages once, not once per call.
  if (res.status === 401) {
    await drainBody(res);
    log.warn('CTX returned 401 — API key rejected');
    notifyCtxCredentialInvalid();
    throw new CtxUnavailableError('CTX rejected the API key (401)');
  }

  // CF-12: a 429 is upstream back-pressure. Don't hand it to the caller as a usable response — parse Retry-After and raise the dedicated transient error so the caller defers instead of marking the order failed and re-hammering CTX at full cadence.
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'));
    await drainBody(res);
    log.warn({ retryAfterMs }, 'CTX rate-limited (429) — backing off');
    throw new CtxRateLimitedError('CTX rate-limited (429)', retryAfterMs);
  }

  return res;
}
