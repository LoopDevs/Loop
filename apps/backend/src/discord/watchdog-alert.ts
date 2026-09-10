// Fire-once/re-arm alert gate for standing watchdogs — at-least-once, confirmed-delivery
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
