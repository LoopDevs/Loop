/**
 * CTX operator-account pool (ADR 013).
 *
 * Under the identity takeover CTX is a supplier, not a per-user
 * identity: one (and ideally several) service accounts sit between
 * Loop and CTX. This module owns pool composition, health tracking,
 * selection policy, and the `operatorFetch` entry point handlers
 * call instead of `fetch` when a request must carry a CTX operator
 * bearer.
 *
 * Selection is round-robin across healthy operators. Each operator
 * has its own circuit breaker keyed on CTX-side failures; an OPEN
 * operator is skipped until its cooldown elapses. On a single-
 * request failure we transparently retry against the next healthy
 * operator so a momentary rate-limit on one account doesn't surface
 * as an end-user error.
 *
 * This module is inert until the principal-switch work (ADR 010)
 * wires it into the gift-card / merchants / locations handlers. Leaving
 * `CTX_OPERATOR_POOL` unset is the expected state today.
 */
import { z } from 'zod';
import { createCircuitBreaker, CircuitOpenError } from '../circuit-breaker.js';
import { notifyOperatorPoolExhausted, notifyOperatorCredentialExpired } from '../discord.js';
import { logger } from '../logger.js';
import { getCurrentRequestId } from '../request-context.js';

const log = logger.child({ area: 'operator-pool' });

const OperatorEntry = z.object({
  id: z.string().min(1),
  bearer: z.string().min(1),
  // CTX cross-checks the JWT's embedded `clientId` against the
  // request's `X-Client-Id` header and 401s on mismatch ("token
  // invalid"). Operator bearers were minted via the normal CTX
  // login flow with `clientId: 'loopweb'`, so default to that.
  // Operators that were minted under a different client id (a
  // future ios/android operator pool, for example) override here.
  clientId: z.string().min(1).default('loopweb'),
});

const OperatorPoolSchema = z.array(OperatorEntry).min(1);

type OperatorConfig = z.infer<typeof OperatorEntry>;

interface Operator {
  id: string;
  bearer: string;
  clientId: string;
  breaker: ReturnType<typeof createCircuitBreaker>;
}

export class OperatorPoolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorPoolUnavailableError';
  }
}

/**
 * CF-12: every reachable operator returned 429 ("too many requests").
 * This is a transient back-pressure signal from CTX, not a per-order
 * failure — the caller (procurement tick) must DEFER and retry on a
 * later tick rather than mark the order `failed`, otherwise a CTX
 * rate-limit degrades into a self-sustaining hot loop that fails real
 * paid orders. `retryAfterMs` carries CTX's `Retry-After` (parsed
 * from the last 429) so callers can back off for the indicated window.
 */
export class OperatorRateLimitedError extends Error {
  /** Parsed `Retry-After` in ms, or `null` if CTX sent no usable header. */
  readonly retryAfterMs: number | null;
  constructor(message: string, retryAfterMs: number | null) {
    super(message);
    this.name = 'OperatorRateLimitedError';
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
  // delta-seconds form
  if (/^\d+$/.test(trimmed)) {
    const secs = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(secs)) return null;
    return Math.min(secs * 1000, RETRY_AFTER_MAX_MS);
  }
  // HTTP-date form
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const deltaMs = dateMs - Date.now();
  return Math.min(Math.max(deltaMs, 0), RETRY_AFTER_MAX_MS);
}

let operators: Operator[] = [];
let nextIndex = 0;
let initialised = false;

/**
 * Throttle for the pool-exhausted Discord alert. A sustained outage
 * would otherwise spam the monitoring channel every request. Matches
 * the 15-minute cadence used by `notifyUsdcBelowFloor` in procurement —
 * long enough to avoid noise, short enough that a "still bad" signal
 * fires within the first ops rotation.
 */
const POOL_EXHAUSTED_ALERT_INTERVAL_MS = 15 * 60 * 1000;
let lastExhaustedAlertAt = 0;

/** Test seam — resets the Discord-alert throttle between cases. */
export function __resetPoolExhaustedAlertForTests(): void {
  lastExhaustedAlertAt = 0;
}

/**
 * Parses `CTX_OPERATOR_POOL` once and constructs a per-operator
 * circuit breaker. Safe to call repeatedly — it no-ops after the
 * first successful call. Exposed for tests via
 * `__resetOperatorPoolForTests`.
 *
 * A2-573: `initialised` is set AFTER a successful parse, not before.
 * If the env is malformed on the first call, we throw — but leaving
 * `initialised = false` means a subsequent call (after ops fixes
 * CTX_OPERATOR_POOL at runtime) will retry parsing. Previously the
 * flag flipped up-front, so a malformed env required a full process
 * restart to recover even after the env was corrected.
 */
function ensureInitialised(): void {
  if (initialised) return;
  // Read process.env directly (not through env.ts's snapshot) so a
  // test that sets the env after module load still picks it up. The
  // pool's own schema validates the JSON shape — env.ts's .string()
  // check would be redundant.
  const raw = process.env['CTX_OPERATOR_POOL'];
  if (raw === undefined || raw.trim().length === 0) {
    log.info('CTX_OPERATOR_POOL is unset — pool is inert');
    initialised = true;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // A malformed env value is an ops error — throwing at first
    // pool access keeps the failure localised to callers of the
    // pool instead of crashing the whole backend on boot.
    // Leave `initialised = false` so a follow-up call after the
    // env is corrected can retry without a process restart.
    log.error({ err }, 'CTX_OPERATOR_POOL is not valid JSON');
    throw new Error('CTX_OPERATOR_POOL is not valid JSON');
  }
  const validated = OperatorPoolSchema.safeParse(parsed);
  if (!validated.success) {
    log.error({ issues: validated.error.issues }, 'CTX_OPERATOR_POOL failed schema validation');
    throw new Error('CTX_OPERATOR_POOL failed schema validation');
  }
  operators = validated.data.map((o: OperatorConfig) => ({
    id: o.id,
    bearer: o.bearer,
    clientId: o.clientId,
    // A2-1326: tag the breaker so its Discord embeds dedup per-operator
    // — one flapping operator won't suppress notifications for a
    // different operator that flaps an hour later.
    breaker: createCircuitBreaker({ name: `operator:${o.id}` }),
  }));
  initialised = true;
  log.info({ count: operators.length }, 'CTX operator pool initialised');
}

/** Test seam — forgets the parsed pool so the next access re-reads env. */
export function __resetOperatorPoolForTests(): void {
  operators = [];
  nextIndex = 0;
  initialised = false;
}

/**
 * Returns the number of configured operators. 0 when the pool is
 * inert (env unset).
 */
export function operatorPoolSize(): number {
  ensureInitialised();
  return operators.length;
}

/**
 * Picks a healthy operator and returns its credentials directly,
 * without dispatching a fetch. Used by call sites (CTX SSE stream)
 * that can't go through the `operatorFetch` wrapper because the
 * underlying transport isn't a single `fetch` call we can substitute.
 *
 * Mirrors `operatorFetch`'s selection policy: round-robin across
 * healthy operators, skipping any whose breaker is OPEN. Returns
 * `null` when every operator is unavailable — caller must surface
 * the outage themselves (the helper has no `notifyOperatorPoolExhausted`
 * hook because the stream is opportunistic and the caller falls back
 * to `operatorFetch`-based polling on failure).
 */
export function pickOperatorCredentials(): {
  id: string;
  bearer: string;
  clientId: string;
} | null {
  ensureInitialised();
  const op = pickHealthyOperator();
  if (op === null) return null;
  return { id: op.id, bearer: op.bearer, clientId: op.clientId };
}

/**
 * Picks the next healthy operator in round-robin order, skipping
 * any whose circuit breaker is OPEN.
 *
 * Returns `null` when every operator is OPEN — a pool-wide outage
 * that callers surface as a 503.
 */
function pickHealthyOperator(): Operator | null {
  if (operators.length === 0) return null;
  for (let attempt = 0; attempt < operators.length; attempt++) {
    const idx = (nextIndex + attempt) % operators.length;
    const op = operators[idx];
    // CF2-01 (2026-06-30 cold audit): `isAvailable()`, not a bare
    // `getState() !== 'open'` check. The breaker's OPEN→HALF_OPEN
    // cooldown-expiry transition previously lived only inside
    // `.fetch()` — an operator filtered out here never got `.fetch()`
    // called on it again, so it could never recover on its own. One
    // bad response (CF-13's `forceOpen` trips on a single 401) could
    // permanently strand an operator; two could brick the whole pool.
    if (op !== undefined && op.breaker.isAvailable()) {
      nextIndex = (idx + 1) % operators.length;
      return op;
    }
  }
  return null;
}

/**
 * Injects `Authorization: Bearer <operator-token>` into `init.headers`
 * and dispatches via the operator's circuit breaker. On a transient
 * failure (network error, 5xx, or breaker tripping mid-flight)
 * against the first picked operator, we retry once against the next
 * healthy operator — a single lame account shouldn't show up as an
 * end-user error (ADR 013).
 *
 * A2-572: the 5xx and network-error retry paths now match the
 * docstring. Before, only `CircuitOpenError` triggered a retry, so a
 * flat 500 or a network error on the first attempt propagated to the
 * caller even when a healthy sibling operator existed. Each 5xx /
 * throw on an operator also credits a breaker failure via
 * `op.breaker.fetch` — a second 5xx from the fallback on the same
 * request doesn't double-count because each operator's breaker is
 * independent.
 *
 * 4xx responses (other than 401 / 429) are still returned as-is —
 * those are client errors, not operator-health signals, and a second
 * operator would hit the same 4xx. Retrying would mask real
 * request-shape bugs.
 *
 * CF-13: a 401 ("token invalid") is the most likely operator-account
 * failure (an expired/revoked bearer — operator bearers are static
 * and not yet auto-rotated, ADR 013). It is NOT a request-shape bug,
 * so it must not return verbatim. On 401 we force the operator's
 * breaker OPEN (pulling it from rotation), alert via
 * `notifyOperatorCredentialExpired`, and fail over to a healthy
 * sibling. If every operator 401s, we throw `OperatorPoolUnavailableError`
 * (transient → caller defers) rather than handing back a 401 that a
 * procurement tick would treat as a hard order failure.
 *
 * CF-12: a 429 ("too many requests") is upstream back-pressure, not a
 * client error. We parse `Retry-After`, fail over to a sibling, and
 * on full exhaustion throw `OperatorRateLimitedError` (transient,
 * carrying the back-off window) so the caller defers instead of
 * marking the order failed and hammering CTX at full cadence.
 */
/**
 * A2-1510: per-request timeout cap. Callers pass a caller-owned
 * signal for long-running streams or cancellation; absent one, we
 * apply a conservative 30-second cap so a wedged CTX upstream can't
 * park a procurement / payout tick forever. Combined with the
 * circuit-breaker's half-open probe, this bounds the worst-case
 * blocking time on any single operator call.
 */
const OPERATOR_FETCH_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Release a response body we're about to discard before failing over
 * to the next operator, so undici returns the socket to its pool
 * instead of leaving it half-read. Swallows errors — an already-
 * consumed or aborted body is harmless here.
 */
async function drainBody(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* already consumed / aborted — harmless */
  }
}

export async function operatorFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  ensureInitialised();
  if (operators.length === 0) {
    throw new OperatorPoolUnavailableError(
      'CTX operator pool is not configured (CTX_OPERATOR_POOL unset)',
    );
  }

  // A2-1510: compose a default-timeout signal when the caller didn't
  // pass one. If they did, respect it verbatim — they've already
  // thought about the cancellation window.
  const signal: AbortSignal | undefined =
    init?.signal ?? AbortSignal.timeout(OPERATOR_FETCH_DEFAULT_TIMEOUT_MS);

  // Try up to 2 operators: the picked one, and one fallback on any
  // transient failure (5xx, 429, 401, network error, breaker trip).
  // `operators.length` caps attempts naturally at 1 for a single-entry
  // pool.
  const attempts = Math.min(2, operators.length);
  let lastErr: unknown = null;
  // CF-12 / CF-13: when every reachable operator failed with a
  // rate-limit (429) or an expired credential (401), surface a
  // transient pool error so the caller defers rather than failing the
  // order. These flags let the post-loop throw pick the right error
  // type / back-off window.
  let sawRateLimit = false;
  let lastRetryAfterMs: number | null = null;
  let sawAuthExpired = false;
  for (let i = 0; i < attempts; i++) {
    const op = pickHealthyOperator();
    if (op === null) break;
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${op.bearer}`);
    // CTX validates that `X-Client-Id` matches the `clientId`
    // embedded in the JWT, returning 401 "token invalid" on
    // mismatch. Operator bearers carry the clientId they were
    // minted with — attach it here so the field validator-passing
    // crypto-purchase request (`cryptoCurrency: "XLM"`) actually
    // reaches the procurement code path instead of bouncing at
    // the auth gate.
    headers.set('X-Client-Id', op.clientId);
    // A2-1305: propagate our X-Request-Id onto the CTX call so ops
    // can correlate our request id with CTX's server logs. The
    // circuit-breaker wrapper does the same when called directly,
    // but we set it here too so a caller reading `headers` before
    // the fetch can log the id they're about to send.
    const requestId = getCurrentRequestId();
    if (requestId !== undefined && !headers.has('X-Request-Id')) {
      headers.set('X-Request-Id', requestId);
    }
    const isLastAttempt = i === attempts - 1;
    try {
      const res = await op.breaker.fetch(url, { ...init, headers, signal });

      // CF-13: a 401 means this operator's bearer is dead (expired /
      // revoked / clientId mismatch). It's an operator-health signal,
      // not a request-shape bug — force the breaker OPEN so the
      // operator is pulled from rotation until its cooldown, alert
      // ops, and fail over to a healthy sibling. The breaker's
      // `forceOpen` deduped Discord embed plus the per-operator
      // credential alert keep this loud without flooding.
      if (res.status === 401) {
        await drainBody(res);
        op.breaker.forceOpen();
        sawAuthExpired = true;
        lastErr = new Error(`operator ${op.id} returned 401 (bearer expired/invalid)`);
        log.warn(
          { operatorId: op.id, failedOver: !isLastAttempt },
          'CTX operator returned 401 — bearer expired; pulled from rotation',
        );
        notifyOperatorCredentialExpired({
          operatorId: op.id,
          poolSize: operators.length,
          // A healthy sibling can still serve this request only if we
          // have another attempt left in this request's budget.
          failedOver: !isLastAttempt,
        });
        continue;
      }

      // CF-12: a 429 is upstream back-pressure. Don't credit it to the
      // caller as a usable response — parse Retry-After and fail over;
      // the breaker already counted it toward opening (see
      // circuit-breaker.ts). On exhaustion the post-loop throw raises
      // an OperatorRateLimitedError so the caller defers.
      if (res.status === 429) {
        const retryAfterMs = parseRetryAfterMs(res.headers.get('Retry-After'));
        await drainBody(res);
        sawRateLimit = true;
        if (retryAfterMs !== null) lastRetryAfterMs = retryAfterMs;
        lastErr = new Error(`operator ${op.id} returned 429 (rate limited)`);
        log.warn(
          { operatorId: op.id, retryAfterMs, failedOver: !isLastAttempt },
          'CTX operator rate-limited (429) — backing off',
        );
        continue;
      }

      // A2-572: a 5xx is a supplier-health signal per the docstring —
      // try the next operator instead of handing a 500 to the caller.
      // Only 4xx returns straight through (client errors — retrying
      // against a different operator would hit the same 4xx and mask
      // request-shape bugs). On the last attempt the 5xx propagates
      // so the caller sees CTX's real status.
      if (res.status >= 500 && !isLastAttempt) {
        // Release the response body before we shadow `res` with the
        // next attempt so undici's socket is returned to the pool.
        await drainBody(res);
        lastErr = new Error(`operator ${op.id} returned ${res.status}`);
        continue;
      }
      return res;
    } catch (err) {
      if (err instanceof CircuitOpenError) {
        // Breaker tripped mid-request — try the next operator.
        lastErr = err;
        continue;
      }
      // A2-572: network error / timeout / aborted-fetch — retry
      // against the fallback on non-last attempts. On the final
      // attempt the error propagates so the caller sees a truthful
      // failure instead of a silent success.
      if (!isLastAttempt) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : 'All operators unhealthy';

  // CF-12: every reachable operator was rate-limited. Surface a
  // dedicated transient error carrying CTX's Retry-After so the caller
  // (procurement tick) defers and backs off instead of marking the
  // order failed and re-hammering CTX. No pool-exhausted page here —
  // a 429 storm is back-pressure, not an outage; the per-operator
  // breaker + the caller's defer already throttle us.
  if (sawRateLimit) {
    log.warn(
      { reason, retryAfterMs: lastRetryAfterMs },
      'All reachable operators rate-limited (429) — deferring',
    );
    throw new OperatorRateLimitedError(reason, lastRetryAfterMs);
  }

  // CF-13: every reachable operator's bearer is expired/invalid. The
  // per-operator credential alert already fired; surface a transient
  // pool error so the caller defers (the order stays retryable for
  // when a bearer is restored) rather than failing real paid orders.
  if (sawAuthExpired) {
    log.warn({ reason }, 'All reachable operators returned 401 — deferring');
    throw new OperatorPoolUnavailableError(reason);
  }

  log.warn({ reason }, 'Operator pool exhausted — all operators unhealthy');
  // Fire the monitoring-channel alert at most once per throttle window
  // so a sustained outage doesn't produce a webhook per pool access.
  // The first request after a healthy window always pages; subsequent
  // requests within 15 minutes stay silent on Discord but still log.
  const now = Date.now();
  if (now - lastExhaustedAlertAt >= POOL_EXHAUSTED_ALERT_INTERVAL_MS) {
    lastExhaustedAlertAt = now;
    notifyOperatorPoolExhausted({ poolSize: operators.length, reason });
  }
  throw new OperatorPoolUnavailableError(reason);
}

/**
 * Snapshot of per-operator circuit state — for the `/metrics` + admin
 * "pool health" view (ADR 013 observability bullet).
 */
export function getOperatorHealth(): Array<{ id: string; state: string }> {
  ensureInitialised();
  return operators.map((o) => ({ id: o.id, state: o.breaker.getState() }));
}
