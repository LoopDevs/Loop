/**
 * `notifyCircuitBreaker` — circuit-breaker state-transition
 * notifier (A2-1326), with its per-(name, state) dedup state.
 *
 * Lifted out of `apps/backend/src/discord/monitoring.ts` so the
 * circuit-breaker concern lives in one focused ~50-line module
 * instead of being interleaved with the eleven other monitoring-
 * channel notifiers in the parent file.
 *
 * Re-exported through `discord/monitoring.ts` (and by extension
 * the top-level `discord.ts` barrel) so existing import sites
 * — including `circuit-breaker.ts` and the discord test suite —
 * keep working unchanged.
 */
import { env } from '../env.js';
import { GREEN, RED, sendWebhook } from './shared.js';

/**
 * A2-1326: per-(key, state) dedup window. Within one process, a
 * flapping circuit (open → half_open → open → half_open → ...)
 * previously emitted one embed per transition — across 7 upstream
 * breakers + N operator breakers, that's the "120 embeds/hour"
 * pattern the audit flagged. The map keys are `${name}:${state}` so
 * "login open" and "merchants open" dedup independently.
 *
 * 10 minutes is chosen so a persistent-outage scenario still gets
 * one fresh embed every ten minutes — ops sees the issue isn't
 * transient — while a minute-cadence flap produces exactly one
 * embed per (key, state).
 */
const CIRCUIT_NOTIFY_DEDUP_MS = 10 * 60 * 1000;
const circuitNotifyLastAt = new Map<string, number>();

/** Test helper — wipe the dedup map so tests can exercise the throttle. */
export function __resetCircuitNotifyDedupForTests(): void {
  circuitNotifyLastAt.clear();
}

/**
 * Notify: circuit breaker state change.
 *
 * `name` identifies the circuit (e.g. `upstream:login`,
 * `operator:op-beta-02`). Within the same process, a repeat
 * `(name, state)` pair fires at most once per
 * `CIRCUIT_NOTIFY_DEDUP_MS`. Absent `name` falls back to the
 * legacy `'unknown'` bucket — all un-named breakers share one
 * dedup entry, which is the conservative direction (too-quiet
 * rather than too-loud).
 */
export function notifyCircuitBreaker(
  state: 'open' | 'closed',
  consecutiveFailures: number,
  cooldownSeconds = 30,
  name = 'unknown',
): void {
  const key = `${name}:${state}`;
  const now = Date.now();
  const lastAt = circuitNotifyLastAt.get(key) ?? 0;
  if (now - lastAt < CIRCUIT_NOTIFY_DEDUP_MS) return;
  circuitNotifyLastAt.set(key, now);

  void sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: state === 'open' ? '🔴 Circuit Breaker OPEN' : '🟢 Circuit Breaker Closed',
    description:
      state === 'open'
        ? `\`${name}\` unreachable after ${consecutiveFailures} consecutive failures. Requests will fail fast for ${cooldownSeconds}s.`
        : `\`${name}\` recovered. Normal operation resumed.`,
    color: state === 'open' ? RED : GREEN,
  });
}
