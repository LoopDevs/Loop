import { logger } from './logger.js';
import { notifyCircuitBreaker } from './discord.js';

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
}

/**
 * Telemetry snapshot for an individual breaker — surfaced on the
 * admin treasury view so ops can triage which supplier account is
 * actually sick (ADR 013 observability). Timestamps are unix ms,
 * null when the breaker has never seen that event yet.
 */
export interface CircuitBreakerStats {
  state: CircuitState;
  /** Consecutive failure count since the last success. Resets to 0 on success. */
  consecutiveFailures: number;
  /** When the breaker most recently transitioned to OPEN. Null when never tripped. */
  openedAt: number | null;
  /** When the breaker last saw a non-5xx response (unix ms). Null when never succeeded. */
  lastSuccessAt: number | null;
  /** When the breaker last saw a 5xx / network error (unix ms). Null when never failed. */
  lastFailureAt: number | null;
}

interface CircuitBreaker {
  /** Drop-in replacement for global `fetch` that respects circuit state. */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Returns the current circuit state. */
  getState: () => CircuitState;
  /** Returns a richer telemetry snapshot — used by the admin pool view. */
  getStats: () => CircuitBreakerStats;
  /** Resets the circuit to CLOSED (useful for testing). */
  reset: () => void;
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

  const log = logger.child({ module: 'circuit-breaker' });

  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let openedAt = 0;
  // Nullable timestamps — the breaker has never seen the matching
  // event until the first success/failure. Distinguishing "never
  // failed" from "failed at epoch 0" matters for the admin UI copy.
  let lastSuccessAt: number | null = null;
  let lastFailureAt: number | null = null;
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
    lastSuccessAt = Date.now();
    halfOpenInFlight = false;
    clearProbeTimer();
    transitionTo('closed');
    if (wasHalfOpen) {
      notifyCircuitBreaker('closed', 0);
    }
  }

  function onFailure(): void {
    consecutiveFailures++;
    lastFailureAt = Date.now();
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
      notifyCircuitBreaker('open', consecutiveFailures, Math.round(cooldownMs / 1000));
    }
  }

  async function wrappedFetch(url: string | URL, init?: RequestInit): Promise<Response> {
    // OPEN — check if cooldown has elapsed
    if (state === 'open') {
      if (Date.now() - openedAt >= cooldownMs) {
        transitionTo('half_open');
      } else {
        throw new CircuitOpenError();
      }
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

    try {
      const response = await fetch(url, init);

      // Treat 5xx as upstream failures for circuit-breaker purposes.
      // 4xx are client errors and should NOT trip the circuit.
      if (response.status >= 500) {
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

  function getStats(): CircuitBreakerStats {
    return {
      state,
      consecutiveFailures,
      openedAt: openedAt === 0 ? null : openedAt,
      lastSuccessAt,
      lastFailureAt,
    };
  }

  function reset(): void {
    state = 'closed';
    consecutiveFailures = 0;
    openedAt = 0;
    lastSuccessAt = null;
    lastFailureAt = null;
    halfOpenInFlight = false;
    clearProbeTimer();
  }

  return { fetch: wrappedFetch, getState, getStats, reset };
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

const circuitsByKey = new Map<string, CircuitBreaker>();

/**
 * Returns the circuit breaker for a given upstream endpoint category, lazily
 * creating it on first use. Callers pass a stable key string (e.g. 'login',
 * 'gift-cards', 'merchants'). Each key gets its own independent breaker so
 * that one failing endpoint doesn't trip the circuit for healthy ones —
 * previously `/merchants` sync timing out would have killed auth too.
 */
export function getUpstreamCircuit(key: string): CircuitBreaker {
  let cb = circuitsByKey.get(key);
  if (cb === undefined) {
    cb = createCircuitBreaker();
    circuitsByKey.set(key, cb);
  }
  return cb;
}

/**
 * Snapshot of every known breaker's state. Exposed for the /metrics
 * endpoint; also useful for tests.
 */
export function getAllCircuitStates(): Record<string, CircuitState> {
  const out: Record<string, CircuitState> = {};
  for (const [key, cb] of circuitsByKey) {
    out[key] = cb.getState();
  }
  return out;
}
