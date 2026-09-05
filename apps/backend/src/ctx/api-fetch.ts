/**
 * CTX API-key fetch (ADR 051, retiring ADR 013's operator pool).
 *
 * Loop is a first-class operator in the CTX namespace: one API key
 * (`GIFT_CARD_API_KEY` / `GIFT_CARD_API_SECRET`) authenticates every
 * server-to-server call, optionally narrowed to a customer via the
 * `X-User-Id` act-as header (attributed-operator-traffic contract).
 * This replaces the multi-bearer operator pool — there is no pool to
 * balance, no per-operator failover, and no bearer expiry to rotate
 * around: API keys are long-lived credentials CTX scopes to Loop's
 * company.
 *
 * What survives from the pool era, because callers still depend on
 * the semantics:
 *   - a single circuit breaker on the CTX upstream (OPEN → callers
 *     defer instead of hammering a down supplier)
 *   - 429 → `CtxRateLimitedError` carrying `Retry-After`, so the
 *     procurement tick backs off instead of failing paid orders
 *   - 401 → credential alert + breaker forced OPEN + a transient
 *     `CtxUnavailableError`, so orders stay retryable while the key
 *     is rotated (a 401 here is an ops incident, not an order bug)
 *   - other 4xx/5xx returned verbatim (request-shape bugs and real
 *     CTX statuses must reach the caller)
 *   - default 30s timeout, `X-Request-Id` propagation
 */
import { createCircuitBreaker, CircuitOpenError } from '../circuit-breaker.js';
import { notifyCtxCredentialInvalid } from '../discord.js';
import { env } from '../env.js';
import { logger } from '../logger.js';
import { getCurrentRequestId } from '../request-context.js';

const log = logger.child({ area: 'ctx-api' });

/**
 * Transient CTX-side outage or misconfiguration: credentials unset,
 * breaker OPEN, or the API key rejected (401). Callers treat this as
 * "defer and retry later", never as a per-order failure.
 */
export class CtxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CtxUnavailableError';
  }
}

/**
 * CF-12: CTX returned 429 — back-pressure, not a per-order failure.
 * `retryAfterMs` carries CTX's `Retry-After` (parsed) so callers can
 * gate their next tick on the indicated window.
 */
export class CtxRateLimitedError extends Error {
  /** Parsed `Retry-After` in ms, or `null` if CTX sent no usable header. */
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'CtxRateLimitedError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * CF-12: parse an HTTP `Retry-After` header into milliseconds. Per
 * RFC 9110 the value is either delta-seconds (`"120"`) or an HTTP-date
 * (`"Wed, 21 Oct 2026 07:28:00 GMT"`). Returns `null` for an absent,
 * empty, or unparseable header, and clamps negatives (a past date) to
 * 0. Caps at 5 minutes so a pathological upstream value can't park a
 * tick indefinitely.
 */
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

let breaker: ReturnType<typeof createCircuitBreaker> | null = null;

function getBreaker(): ReturnType<typeof createCircuitBreaker> {
  breaker ??= createCircuitBreaker({ name: 'ctx-api' });
  return breaker;
}

/** Test seam — forgets the upstream breaker so the next call re-creates it. */
export function __resetCtxApiBreakerForTests(): void {
  breaker = null;
}

export interface CtxApiCredentials {
  apiKey: string;
  apiSecret: string;
  clientId: string;
}

/**
 * The operator API-key credentials. Always present — the env schema
 * requires them at boot. Used by call sites (CTX SSE stream) that
 * can't route through `ctxFetch` because the transport isn't a single
 * substitutable `fetch` call.
 */
export function ctxApiCredentials(): CtxApiCredentials {
  return {
    apiKey: env.GIFT_CARD_API_KEY,
    apiSecret: env.GIFT_CARD_API_SECRET,
    clientId: env.CTX_CLIENT_ID_WEB,
  };
}

/**
 * Snapshot of the upstream credential + breaker state — for `/health`
 * and the admin treasury snapshot (ADR 013's observability bullet,
 * collapsed to a single upstream under ADR 051). `configured` is
 * always true now that the env schema requires the credentials; the
 * field survives for response-shape stability.
 */
export function getCtxApiHealth(): { configured: boolean; state: string } {
  return { configured: true, state: getBreaker().getState() };
}

/**
 * A2-1510: per-request timeout cap. Callers pass a caller-owned
 * signal for long-running streams or cancellation; absent one, we
 * apply a conservative 30-second cap so a wedged CTX upstream can't
 * park a procurement / payout tick forever.
 */
const CTX_FETCH_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Release a response body we're about to discard so undici returns
 * the socket to its pool instead of leaving it half-read. Swallows
 * errors — an already-consumed or aborted body is harmless here.
 */
async function drainBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* already consumed / aborted — harmless */
  }
}

/**
 * Injects the CTX API-key headers into `init.headers` and dispatches
 * via the upstream circuit breaker. Callers may pre-set `X-User-Id`
 * (act-as) and `X-Client-Id` (request-origin client) — `ctxFetch`
 * only fills `X-Client-Id` when the caller didn't.
 */
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
  // A2-1305: propagate our X-Request-Id onto the CTX call so ops can
  // correlate our request id with CTX's server logs.
  const requestId = getCurrentRequestId();
  if (requestId !== undefined && !headers.has('X-Request-Id')) {
    headers.set('X-Request-Id', requestId);
  }

  const b = getBreaker();
  let res: Response;
  try {
    res = await b.fetch(url, { ...init, headers, signal });
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      throw new CtxUnavailableError('CTX upstream circuit is open — deferring');
    }
    throw err;
  }

  // CF-13 (single-key form): a 401 means CTX rejected the API key —
  // revoked, rotated on the CTX side, or misconfigured. It is an ops
  // incident, not a request-shape bug: force the breaker OPEN so
  // callers defer during the cooldown, alert, and surface a transient
  // error so paid orders stay retryable while the key is restored.
  if (res.status === 401) {
    await drainBody(res);
    b.forceOpen();
    log.warn('CTX returned 401 — API key rejected; deferring all CTX calls');
    notifyCtxCredentialInvalid();
    throw new CtxUnavailableError('CTX rejected the API key (401)');
  }

  // CF-12: a 429 is upstream back-pressure. Don't hand it to the
  // caller as a usable response — parse Retry-After and raise the
  // dedicated transient error so the caller defers instead of
  // marking the order failed and re-hammering CTX at full cadence.
  if (res.status === 429) {
    const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'));
    await drainBody(res);
    log.warn({ retryAfterMs }, 'CTX rate-limited (429) — backing off');
    throw new CtxRateLimitedError('CTX rate-limited (429)', retryAfterMs);
  }

  return res;
}
