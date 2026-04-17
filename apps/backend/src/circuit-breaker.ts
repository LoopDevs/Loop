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

interface CircuitBreaker {
  /** Drop-in replacement for global `fetch` that respects circuit state. */
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
  /** Returns the current circuit state. */
  getState: () => CircuitState;
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
      notifyCircuitBreaker('closed', 0);
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

  function reset(): void {
    state = 'closed';
    consecutiveFailures = 0;
    openedAt = 0;
    halfOpenInFlight = false;
    clearProbeTimer();
  }

  return { fetch: wrappedFetch, getState, reset };
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

// ─── Singleton instance for all upstream API calls ──────────────────────────

export const upstreamCircuit = createCircuitBreaker();
