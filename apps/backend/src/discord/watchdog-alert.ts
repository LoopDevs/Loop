/**
 * Fire-once/re-arm alert gate for the standing watchdogs. Callers:
 *   - `health.ts` (`routeHealthChangeNotify`) — the health-change page.
 *
 * Successor to the old Postgres-backed `watchdog_alert_state` gate:
 * with the fleet-wide constraint gone (Loop is single-process while
 * undeployed) the fired-state is a process-local map, and callers of
 * the same gate are serialised by a per-name promise chain so
 * overlapping ticks can't double-page one transition.
 *
 * Contract: at-least-once, confirmed-delivery. `alertActive` flips
 * only AFTER the notifier resolves `true`; an undelivered page
 * (Discord outage, timeout) leaves the state unchanged so the next
 * tick re-attempts — never silently dropped, never double-fired once
 * delivered.
 */

export interface ApplyBinaryWatchdogAlertArgs {
  /** Stable, unique key for this incident dimension, e.g. `health-change:upstream`. */
  watchdogName: string;
  /** What the state SHOULD be after this tick's computation. */
  shouldBeActive: boolean;
  /** Called (and awaited) only on a false→true transition. Must resolve `true` on confirmed delivery. */
  notifyActive: () => Promise<boolean>;
  /** Called (and awaited) only on a true→false transition. Must resolve `true` on confirmed delivery. */
  notifyRecovered: () => Promise<boolean>;
}

const alertActiveByName = new Map<string, boolean>();
const gateChainByName = new Map<string, Promise<unknown>>();

/**
 * Returns `true` when a page was sent AND confirmed delivered this
 * call (i.e. the state actually moved); `false` when nothing was due,
 * or a due page failed to deliver (state left unchanged for the next
 * tick to retry).
 */
export async function applyBinaryWatchdogAlert(
  args: ApplyBinaryWatchdogAlertArgs,
): Promise<boolean> {
  // Serialise concurrent callers of the SAME gate: chain each call
  // behind the previous one for this name so the read-decide-send-latch
  // sequence never interleaves.
  const previous = gateChainByName.get(args.watchdogName) ?? Promise.resolve();
  const run = previous.then(async (): Promise<boolean> => {
    const wasActive = alertActiveByName.get(args.watchdogName) ?? false;
    if (wasActive === args.shouldBeActive) return false;
    const delivered = args.shouldBeActive
      ? await args.notifyActive()
      : await args.notifyRecovered();
    if (!delivered) return false;
    alertActiveByName.set(args.watchdogName, args.shouldBeActive);
    return true;
  });
  // Keep the chain alive past a rejection so one failure doesn't wedge
  // the gate forever.
  gateChainByName.set(
    args.watchdogName,
    run.catch(() => undefined),
  );
  return run;
}

/** Test seam — clears every gate's fired-state. */
export function __resetWatchdogAlertStateForTests(): void {
  alertActiveByName.clear();
  gateChainByName.clear();
}
