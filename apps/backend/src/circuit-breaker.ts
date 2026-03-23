import { logger } from './logger.js';

type CircuitState = 'closed' | 'open' | 'half_open';

interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. Default: 5 */
  failureThreshold?: number;
  /** Milliseconds to wait in OPEN state before allowing a probe. Default: 30_000 */
  cooldownMs?: number;
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

  const log = logger.child({ module: 'circuit-breaker' });

  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let openedAt = 0;
  let halfOpenInFlight = false;

  function transitionTo(newState: CircuitState): void {
    if (state !== newState) {
      log.info({ from: state, to: newState, consecutiveFailures }, 'Circuit state transition');
      state = newState;
    }
  }

  function onSuccess(): void {
    consecutiveFailures = 0;
    halfOpenInFlight = false;
    transitionTo('closed');
  }

  function onFailure(): void {
    consecutiveFailures++;
    halfOpenInFlight = false;
    if (consecutiveFailures >= failureThreshold) {
      openedAt = Date.now();
      transitionTo('open');
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

    // HALF_OPEN — only one probe request at a time
    if (state === 'half_open') {
      if (halfOpenInFlight) {
        throw new CircuitOpenError();
      }
      halfOpenInFlight = true;
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
