import { logger } from './logger.js';
import { notifyCircuitBreaker } from './discord.js';
import { getCurrentRequestId, setCtxResponseRequestId } from './request-context.js';

export type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait in OPEN state before allowing a probe. Default: 30_000 */
  cooldownMs?: number;
  /**
   * Upper bound on how long a HALF_OPEN probe is allowed to run before the
   * breaker gives up on it and transitions back to OPEN. Protects against
   * callers that forget to pass an AbortSignal — without this failsafe a
   * hung probe would leave `halfOpenInFlight` stuck forever and every
   * subsequent request would fail with `CircuitOpenError` even after the
   * original upstream recovered. Default: 60_000.
   */
  probeTimeoutMs?: number;
  /**
   * A2-1326: opaque key the breaker uses to tag its Discord embeds
   * so the notifier's per-key dedup can tell "login open again" from
   * "merchants open" and throttle separately. Falls back to
   * `'unknown'` — which means every unnamed breaker shares one dedup
   * bucket, which is the conservative direction.
   */
  name?: string;
}

interface CircuitBreaker {
  /** Drop-in replacement for global `fetch` that respects circuit state. */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Returns the current circuit state. */
  getState: () => CircuitState;
  /**
   * CF2-01 (2026-06-30 cold audit): true iff a call through `.fetch()`
   * right now would be attempted rather than immediately rejected with
   * `CircuitOpenError`. Callers that filter OUT unavailable targets
   * BEFORE ever calling `.fetch()` on them (e.g. `pickHealthyOperator`
   * picking among several breakers) must use this, not `getState() !==
   * 'open'` — the OPEN→HALF_OPEN cooldown-expiry transition previously
   * lived only inside `wrappedFetch`, so a target filtered out via a
   * bare state check never got `.fetch()` called on it again and could
   * never recover on its own. This method runs the same idempotent
   * cooldown check `wrappedFetch` does, so probing eligibility is
   * visible to a pre-filter without needing to attempt a real request.
   */
  isAvailable: () => boolean;
  /** Resets the circuit to CLOSED (useful for testing). */
  reset: () => void;
  /**
   * CF-13: immediately trip the circuit OPEN regardless of the
   * consecutive-failure count. Used when a caller has out-of-band
   * proof the upstream is unhealthy in a way a single response can't
   * recover from — e.g. an operator bearer that returns 401 ("token
   * invalid") is dead until rotated, so there's no value in waiting
   * for five of them. The standard `cooldownMs` still applies, after
   * which a HALF_OPEN probe re-tests the credential. No-op if the
   * circuit is already OPEN so a burst of 401s doesn't push `openedAt`
   * forward and extend the cooldown indefinitely (same guard as
   * `onFailure`).
   */
  forceOpen: () => void;
}

/**
 * Creates a circuit breaker that wraps `fetch`.
 *
 * - CLOSED: requests pass through normally. Consecutive failures are tracked.
 * - OPEN: requests are immediately rejected with a `CircuitOpenError` for `cooldownMs`.
 * - HALF_OPEN: a single probe request is allowed. Success → CLOSED, failure → OPEN.
 */
export function createCircuitBreaker(options?: CircuitBreakerOptions): CircuitBreaker {
  const failureThreshold = options?.failureThreshold ?? 5;
  const cooldownMs = options?.cooldownMs ?? 30_000;
  const probeTimeoutMs = options?.probeTimeoutMs ?? 60_000;
  const name = options?.name ?? 'unknown';

  const log = logger.child({ module: 'circuit-breaker', circuit: name });

  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let openedAt = 0;
  let halfOpenInFlight = false;
  let probeTimer: ReturnType<typeof setTimeout> | null = null;

  function clearProbeTimer(): void {
    if (probeTimer !== null) {
      clearTimeout(probeTimer);
      probeTimer = null;
    }
  }

  function armProbeTimer(): void {
    clearProbeTimer();
    probeTimer = setTimeout(() => {
      // Failsafe: the probe has taken longer than probeTimeoutMs. Assume
      // the caller's fetch is hung and treat the probe as a failure so the
      // circuit can bounce back to OPEN and a future request can retry
      // after the next cooldown. Without this, `halfOpenInFlight` would
      // stay true forever and every subsequent request would reject.
      if (halfOpenInFlight && state === 'half_open') {
        log.warn({ probeTimeoutMs }, 'HALF_OPEN probe timed out — forcing circuit back to OPEN');
        onFailure();
      }
    }, probeTimeoutMs);
    // Avoid keeping the event loop alive just for this timer (important so
    // graceful shutdown isn't blocked by an in-flight breaker).
    probeTimer.unref?.();
  }

  function transitionTo(newState: CircuitState): void {
    if (state !== newState) {
      log.info({ from: state, to: newState, consecutiveFailures }, 'Circuit state transition');
      state = newState;
    }
  }

  function onSuccess(): void {
    const wasHalfOpen = state === 'half_open';
    consecutiveFailures = 0;
    halfOpenInFlight = false;
    clearProbeTimer();
    transitionTo('closed');
    if (wasHalfOpen) {
      notifyCircuitBreaker('closed', 0, undefined, name);
    }
  }

  function onFailure(): void {
    consecutiveFailures++;
    halfOpenInFlight = false;
    clearProbeTimer();
    // Only transition (and notify) if we are not already OPEN. When many
    // concurrent requests fail against a down upstream, the first N to
    // complete will push us past the threshold, but requests that were
    // already in flight when the circuit tripped also end in onFailure.
    // Without this guard they each re-fire the Discord notification and
    // keep pushing openedAt forward, extending the cooldown indefinitely.
    if (state !== 'open' && consecutiveFailures >= failureThreshold) {
      openedAt = Date.now();
      transitionTo('open');
      notifyCircuitBreaker('open', consecutiveFailures, Math.round(cooldownMs / 1000), name);
    }
  }

  /**
   * CF2-01: if OPEN and the cooldown has elapsed, transitions to
   * HALF_OPEN. Idempotent and side-effect-free otherwise — safe to
   * call from a pre-filter (`isAvailable`) as well as from the top of
   * `wrappedFetch` itself, so the two never disagree about whether the
   * cooldown has expired.
   */
  function maybeExpireOpenState(): void {
    if (state === 'open' && Date.now() - openedAt >= cooldownMs) {
      transitionTo('half_open');
    }
  }

  function isAvailable(): boolean {
    maybeExpireOpenState();
    if (state === 'open') return false;
    if (state === 'half_open') return !halfOpenInFlight;
    return true;
  }

  async function wrappedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    // OPEN — check if cooldown has elapsed
    maybeExpireOpenState();
    if (state === 'open') {
      throw new CircuitOpenError();
    }

    // HALF_OPEN — only one probe request at a time. Arm a failsafe timer
    // so a hung probe can't leave the circuit stuck.
    if (state === 'half_open') {
      if (halfOpenInFlight) {
        throw new CircuitOpenError();
      }
      halfOpenInFlight = true;
      armProbeTimer();
    }

    // A2-1305: thread our request ID onto the outbound so CTX can log
    // it against theirs. The caller's own `init.headers` wins over this
    // default — a handler that sets X-Request-Id explicitly is assumed
    // to know what it's doing. Only attached when an ambient request
    // context exists (i.e. inside a real request, not at boot-time
    // sync or a scheduled worker that runs outside the middleware).
    const requestId = getCurrentRequestId();
    let outboundInit = init;
    if (requestId !== undefined) {
      const headers = new Headers(init?.headers);
      if (!headers.has('X-Request-Id')) {
        headers.set('X-Request-Id', requestId);
        outboundInit = { ...init, headers };
      }
    }

    try {
      const response = await fetch(url, outboundInit);

      // A2-1305 follow-up: capture the CTX-side request ID off the
      // response so the post-handler middleware in app.ts can echo it
      // back to the client as `X-Ctx-Request-Id`. CTX may use either
      // `X-Request-Id` or `X-Correlation-Id` depending on which edge
      // serves the response; check both.
      const ctxId =
        response.headers.get('X-Request-Id') ?? response.headers.get('X-Correlation-Id');
      if (ctxId !== null && ctxId.length > 0) {
        setCtxResponseRequestId(ctxId);
      }

      // Treat 5xx as upstream failures for circuit-breaker purposes.
      // 4xx are client errors and should NOT trip the circuit — with
      // one exception: CF-12 — a 429 ("too many requests") is an
      // upstream-health signal, not a client bug. Counting it as a
      // success would reset `consecutiveFailures` to 0 on every
      // rate-limited response, so the breaker would never open under a
      // CTX rate-limit storm and the caller would keep hammering at
      // full cadence. Credit it toward the failure threshold so the
      // breaker opens and the existing cooldown backs us off.
      if (response.status >= 500 || response.status === 429) {
        onFailure();
      } else {
        onSuccess();
      }

      return response;
    } catch (err) {
      // Network error, timeout, etc.
      onFailure();
      throw err;
    }
  }

  function getState(): CircuitState {
    return state;
  }

  function reset(): void {
    state = 'closed';
    consecutiveFailures = 0;
    openedAt = 0;
    halfOpenInFlight = false;
    clearProbeTimer();
  }

  /**
   * CF-13: trip the circuit OPEN out-of-band. Bumps the failure
   * counter to the threshold and opens immediately so an expired
   * operator credential (CTX 401) pulls the operator from rotation
   * without waiting for five consecutive failures. No-op when already
   * OPEN — re-tripping would push `openedAt` forward and extend the
   * cooldown indefinitely under a burst of 401s.
   */
  function forceOpen(): void {
    if (state === 'open') return;
    halfOpenInFlight = false;
    clearProbeTimer();
    consecutiveFailures = Math.max(consecutiveFailures, failureThreshold);
    openedAt = Date.now();
    transitionTo('open');
    notifyCircuitBreaker('open', consecutiveFailures, Math.round(cooldownMs / 1000), name);
  }

  return { fetch: wrappedFetch, getState, isAvailable, reset, forceOpen };
}

/**
 * Error thrown when the circuit is OPEN and requests are being rejected.
 * Callers should catch this to return 503 instead of 502.
 */
export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker is open — upstream service unavailable');
    this.name = 'CircuitOpenError';
  }
}

// ─── Per-endpoint instances ─────────────────────────────────────────────────
//
// `getUpstreamCircuit(key)` and `getAllCircuitStates()` live in
// `./circuit-breaker-registry.ts` — the lazy-instantiated map of
// named breakers the request handlers dispatch through. Re-exported
// here so existing import sites against `'./circuit-breaker.js'`
// keep resolving.
export { getUpstreamCircuit, getAllCircuitStates } from './circuit-breaker-registry.js';
