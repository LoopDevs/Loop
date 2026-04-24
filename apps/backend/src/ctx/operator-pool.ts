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
import { notifyOperatorPoolExhausted } from '../discord.js';
import { logger } from '../logger.js';
import { getCurrentRequestId } from '../request-context.js';

const log = logger.child({ area: 'operator-pool' });

const OperatorEntry = z.object({
  id: z.string().min(1),
  bearer: z.string().min(1),
});

const OperatorPoolSchema = z.array(OperatorEntry).min(1);

type OperatorConfig = z.infer<typeof OperatorEntry>;

interface Operator {
  id: string;
  bearer: string;
  breaker: ReturnType<typeof createCircuitBreaker>;
}

export class OperatorPoolUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperatorPoolUnavailableError';
  }
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
    breaker: createCircuitBreaker(),
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
    if (op !== undefined && op.breaker.getState() !== 'open') {
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
 * 4xx responses are still returned as-is — those are client errors,
 * not operator-health signals, and a second operator would hit the
 * same 4xx. Retrying would mask real request-shape bugs.
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
  // transient failure (5xx, network error, breaker trip). `operators.length`
  // caps attempts naturally at 1 for a single-entry pool.
  const attempts = Math.min(2, operators.length);
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    const op = pickHealthyOperator();
    if (op === null) break;
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Bearer ${op.bearer}`);
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
      // A2-572: a 5xx is a supplier-health signal per the docstring —
      // try the next operator instead of handing a 500 to the caller.
      // Only 4xx returns straight through (client errors — retrying
      // against a different operator would hit the same 4xx and mask
      // request-shape bugs). On the last attempt the 5xx propagates
      // so the caller sees CTX's real status.
      if (res.status >= 500 && !isLastAttempt) {
        // Release the response body before we shadow `res` with the
        // next attempt so undici's socket is returned to the pool.
        try {
          await res.arrayBuffer();
        } catch {
          /* already consumed / aborted — harmless */
        }
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
