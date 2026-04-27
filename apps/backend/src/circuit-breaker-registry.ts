/**
 * Per-endpoint circuit-breaker registry.
 *
 * Lifted out of `./circuit-breaker.ts` so the breaker factory
 * (the state-machine implementation) lives separately from the
 * lazy-instantiated map of named breakers the request handlers
 * dispatch through.
 *
 * Each upstream-endpoint category gets its own independent
 * breaker keyed on a stable string (e.g. `'login'`, `'gift-cards'`,
 * `'merchants'`). One failing endpoint doesn't trip the circuit
 * for healthy siblings.
 *
 * Re-exported from `./circuit-breaker.ts` so existing import sites
 * keep resolving against the historical path.
 */
import { createCircuitBreaker, type CircuitState } from './circuit-breaker.js';

type CircuitBreaker = ReturnType<typeof createCircuitBreaker>;

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
    cb = createCircuitBreaker({ name: `upstream:${key}` });
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
