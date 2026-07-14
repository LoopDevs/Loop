/**
 * `notifyCircuitBreaker` — circuit-breaker state-transition
 * notifier (A2-1326), routed through the fleet-wide fire-once dedup
 * gate (`watchdog_alert_state`).
 *
 * Lifted out of `apps/backend/src/discord/monitoring.ts` so the
 * circuit-breaker concern lives in one focused module instead of being
 * interleaved with the eleven other monitoring-channel notifiers in the
 * parent file.
 *
 * Re-exported through `discord/monitoring.ts` (and by extension
 * the top-level `discord.ts` barrel) so existing import sites
 * — including `circuit-breaker.ts` and the discord test suite —
 * keep working unchanged.
 *
 * BK-cbdedup: the dedup was previously a per-process
 * `Map<`${name}:${state}`, timestamp>`. Every Fly machine runs its OWN
 * circuit breakers and its OWN process map, so a shared upstream outage
 * tripped the same breaker on every machine and each paged independently
 * — N machines ⇒ N pages — and the per-process map re-paged after every
 * deploy / machine-cycle. This routes the page through the same
 * fleet-wide, Postgres-persisted `watchdog_alert_state` fire-once gate
 * the money watchdogs use (`applyBinaryWatchdogAlert`), keyed
 * `circuit-breaker:<name>`: the first machine whose breaker for a given
 * circuit trips pages OPEN once fleet-wide and latches `alert_active`;
 * other machines read the persisted state and stay quiet; whichever
 * machine's breaker recovers pages the close and re-arms. Delivery is
 * at-least-once (the gate latches only after `sendWebhook` confirms a
 * 2xx), so a page lost to a Discord outage is retried by the next
 * transition on any machine rather than silently dropped.
 */
import { env } from '../env.js';
import { logger } from '../logger.js';
import { GREEN, RED, sendWebhook } from './shared.js';
import { applyBinaryWatchdogAlert } from '../credits/vaults/vault-watchdog-alert.js';

const log = logger.child({ module: 'discord', notifier: 'circuit-breaker' });

/**
 * `watchdog_alert_state` key for a circuit. One row per circuit `name`
 * (e.g. `circuit-breaker:upstream:login`), so distinct circuits dedup
 * independently while the OPEN↔Closed transitions of ONE circuit share a
 * single fleet-wide fired-state.
 */
function circuitWatchdogName(name: string): string {
  return `circuit-breaker:${name}`;
}

/**
 * Delivery-confirming send for one circuit transition. Returns whether
 * the Discord webhook actually delivered (`false` on a non-2xx OR an
 * unconfigured webhook) so the fleet gate latches only on real delivery.
 */
function sendCircuitBreakerEmbed(
  state: 'open' | 'closed',
  name: string,
  consecutiveFailures: number,
  cooldownSeconds: number,
): Promise<boolean> {
  return sendWebhook(env.DISCORD_WEBHOOK_MONITORING, {
    title: state === 'open' ? '🔴 Circuit Breaker OPEN' : '🟢 Circuit Breaker Closed',
    description:
      state === 'open'
        ? `\`${name}\` unreachable after ${consecutiveFailures} consecutive failures. Requests will fail fast for ${cooldownSeconds}s.`
        : `\`${name}\` recovered. Normal operation resumed.`,
    color: state === 'open' ? RED : GREEN,
  });
}

/**
 * Notify: circuit breaker state change.
 *
 * `name` identifies the circuit (e.g. `upstream:login`,
 * `operator:op-beta-02`). The OPEN page fires at most once fleet-wide
 * per incident (across every machine, until the circuit recovers and
 * re-arms); the Closed page fires once on recovery. Absent `name` falls
 * back to the legacy `'unknown'` bucket — all un-named breakers share
 * one fleet-wide fired-state, the conservative (too-quiet) direction.
 *
 * Fire-and-forget: the DB round-trip + Discord send run in the
 * background so a breaker transition never blocks the request that
 * tripped it. A gate failure is logged; the next transition on any
 * machine retries (the fired-state is persisted, so nothing is lost).
 */
export function notifyCircuitBreaker(
  state: 'open' | 'closed',
  consecutiveFailures: number,
  cooldownSeconds = 30,
  name = 'unknown',
): void {
  void applyBinaryWatchdogAlert({
    watchdogName: circuitWatchdogName(name),
    shouldBeActive: state === 'open',
    notifyActive: () => sendCircuitBreakerEmbed('open', name, consecutiveFailures, cooldownSeconds),
    notifyRecovered: () =>
      sendCircuitBreakerEmbed('closed', name, consecutiveFailures, cooldownSeconds),
  }).catch((err: unknown) => {
    log.warn(
      { err, name, state },
      'Circuit-breaker fleet dedup gate failed — a later transition will retry',
    );
  });
}

/**
 * Retained test seam. The fire-once state is no longer a per-process map
 * — it lives fleet-wide in `watchdog_alert_state` — so there is nothing
 * process-local left to clear. Kept as a no-op because `discord/
 * monitoring.ts` and the `discord.ts` barrel re-export it and existing
 * tests import it; integration tests reset the state by truncating
 * `watchdog_alert_state`.
 */
export function __resetCircuitNotifyDedupForTests(): void {
  // Intentionally empty — see the doc comment above.
}
