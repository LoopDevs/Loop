import { config } from './config/index.js';

export type RuntimeWorkerName =
  | 'asset_drift_watcher'
  | 'auth_row_purge'
  | 'ctx_mirror_sweep'
  | 'hot_float_backing_reconciliation'
  | 'ledger_invariant_watcher'
  | 'interest_mint'
  | 'interest_scheduler'
  | 'payout_worker'
  | 'redemption_backfill'
  | 'vault_apy_snapshot'
  | 'vault_drift_watcher'
  | 'vault_emission_sweep'
  | 'vault_float_reconciliation'
  | 'vault_redemption_sweep'
  | 'wallet_provisioning';

interface MutableWorkerState {
  required: boolean;
  running: boolean;
  blockedReason: string | null;
  startedAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
  staleAfterMs: number | null;
  // S4-8: skip proves liveness, so it stamps lastSuccessAtMs; this field distinguishes "alive and leading" from "alive but always losing the lock"
  lastSkippedLockedAtMs: number | null;
  // S4-8: last tick this machine actually did the work; a fleet where NO machine advances it is wedged even if liveness stamps look fresh
  lastLeadTickAtMs: number | null;
}

export interface RuntimeWorkerSnapshot extends MutableWorkerState {
  name: RuntimeWorkerName;
  degraded: boolean;
  stale: boolean;
}

interface OtpDeliveryState {
  enabled: boolean;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  lastError: string | null;
}

export interface RuntimeHealthSnapshot {
  degraded: boolean;
  otpDelivery: OtpDeliveryState & { degraded: boolean };
  workers: RuntimeWorkerSnapshot[];
}

const workerState = new Map<RuntimeWorkerName, MutableWorkerState>();

const otpDeliveryState: OtpDeliveryState = {
  enabled: Boolean(config.auth.native.enabled),
  lastSuccessAtMs: null,
  lastFailureAtMs: null,
  lastError: null,
};

function defaultWorkerState(): MutableWorkerState {
  return {
    required: false,
    running: false,
    blockedReason: null,
    startedAtMs: null,
    lastSuccessAtMs: null,
    lastErrorAtMs: null,
    lastError: null,
    staleAfterMs: null,
    lastSkippedLockedAtMs: null,
    lastLeadTickAtMs: null,
  };
}

function ensureWorker(name: RuntimeWorkerName): MutableWorkerState {
  const existing = workerState.get(name);
  if (existing !== undefined) return existing;
  const state = defaultWorkerState();
  workerState.set(name, state);
  return state;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) return err.message;
  if (typeof err === 'string' && err.length > 0) return err;
  return 'unknown error';
}

// Operator kill-switch for OTP delivery; only recordOtpSendSuccess re-arms it, as a successful send is the only real evidence of recovery
export function setOtpDeliveryEnabled(enabled: boolean): void {
  otpDeliveryState.enabled = enabled;
}

export function recordOtpSendSuccess(): void {
  // Self-heal: a successful send proves delivery works again, so a previously disabled surface re-arms its degraded reporting
  otpDeliveryState.enabled = true;
  otpDeliveryState.lastSuccessAtMs = Date.now();
  otpDeliveryState.lastError = null;
}

export function recordOtpSendFailure(err: unknown): void {
  // Deliberately does NOT flip `enabled` back on; a failed send is not evidence of recovery, and re-arming here would clobber an operator-set kill-switch
  otpDeliveryState.lastFailureAtMs = Date.now();
  otpDeliveryState.lastError = errorMessage(err);
}

export function markWorkerDisabled(name: RuntimeWorkerName, reason: string): void {
  const state = ensureWorker(name);
  state.required = false;
  state.running = false;
  state.blockedReason = reason;
  state.startedAtMs = null;
  state.lastSuccessAtMs = null;
  state.lastErrorAtMs = null;
  state.lastError = null;
  state.staleAfterMs = null;
}

export function markWorkerBlocked(
  name: RuntimeWorkerName,
  args: { reason: string; staleAfterMs: number | null },
): void {
  const state = ensureWorker(name);
  state.required = true;
  state.running = false;
  state.blockedReason = args.reason;
  state.startedAtMs = null;
  state.lastSuccessAtMs = null;
  state.lastErrorAtMs = Date.now();
  state.lastError = args.reason;
  state.staleAfterMs = args.staleAfterMs;
}

export function markWorkerStarted(
  name: RuntimeWorkerName,
  args: { required?: boolean; staleAfterMs: number },
): void {
  const state = ensureWorker(name);
  state.required = args.required ?? true;
  state.running = true;
  state.blockedReason = null;
  state.staleAfterMs = args.staleAfterMs;
  if (state.startedAtMs === null) state.startedAtMs = Date.now();
}

export function markWorkerTickSuccess(name: RuntimeWorkerName): void {
  const state = ensureWorker(name);
  state.running = true;
  if (state.startedAtMs === null) state.startedAtMs = Date.now();
  state.lastSuccessAtMs = Date.now();
  // A tick that reached markWorkerTickSuccess did the real work (for single-flighted workers: it won the fleet-wide lock this tick)
  state.lastLeadTickAtMs = state.lastSuccessAtMs;
}

// S4-8: skip stamps lastSuccessAtMs to prove liveness; if it did NOT count, a healthy fleet's consistent lock-loser would flip stale → degraded → Fly restarts a perfectly healthy machine
export function markWorkerTickSkippedLocked(name: RuntimeWorkerName): void {
  const state = ensureWorker(name);
  state.running = true;
  if (state.startedAtMs === null) state.startedAtMs = Date.now();
  state.lastSuccessAtMs = Date.now();
  state.lastSkippedLockedAtMs = state.lastSuccessAtMs;
}

export function markWorkerTickFailure(name: RuntimeWorkerName, err: unknown): void {
  const state = ensureWorker(name);
  state.running = true;
  if (state.startedAtMs === null) state.startedAtMs = Date.now();
  state.lastErrorAtMs = Date.now();
  state.lastError = errorMessage(err);
}

export function markWorkerStopped(name: RuntimeWorkerName): void {
  const state = ensureWorker(name);
  state.running = false;
}

export function getRuntimeHealthSnapshot(now: number = Date.now()): RuntimeHealthSnapshot {
  const otpDegraded =
    otpDeliveryState.enabled &&
    otpDeliveryState.lastFailureAtMs !== null &&
    (otpDeliveryState.lastSuccessAtMs === null ||
      otpDeliveryState.lastFailureAtMs > otpDeliveryState.lastSuccessAtMs);

  const workers = Array.from(workerState.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, state]) => {
      // A4-111: use startedAtMs as fallback anchor so a hung first-tick surfaces as stale/degraded once we've waited longer than the configured staleAfterMs
      const lastActivityMs = state.lastSuccessAtMs ?? state.startedAtMs;
      const stale =
        state.required &&
        state.running &&
        state.staleAfterMs !== null &&
        lastActivityMs !== null &&
        now - lastActivityMs > state.staleAfterMs;
      const degraded =
        state.required &&
        (state.blockedReason !== null ||
          !state.running ||
          stale ||
          (state.lastSuccessAtMs === null && state.lastErrorAtMs !== null));
      return {
        name,
        required: state.required,
        running: state.running,
        blockedReason: state.blockedReason,
        startedAtMs: state.startedAtMs,
        lastSuccessAtMs: state.lastSuccessAtMs,
        lastErrorAtMs: state.lastErrorAtMs,
        lastError: state.lastError,
        staleAfterMs: state.staleAfterMs,
        lastSkippedLockedAtMs: state.lastSkippedLockedAtMs,
        lastLeadTickAtMs: state.lastLeadTickAtMs,
        degraded,
        stale,
      };
    });

  return {
    degraded: otpDegraded || workers.some((worker) => worker.degraded),
    otpDelivery: {
      enabled: otpDeliveryState.enabled,
      lastSuccessAtMs: otpDeliveryState.lastSuccessAtMs,
      lastFailureAtMs: otpDeliveryState.lastFailureAtMs,
      lastError: otpDeliveryState.lastError,
      degraded: otpDegraded,
    },
    workers,
  };
}

export function __resetRuntimeHealthForTests(): void {
  workerState.clear();
  otpDeliveryState.enabled = Boolean(config.auth.native.enabled);
  otpDeliveryState.lastSuccessAtMs = null;
  otpDeliveryState.lastFailureAtMs = null;
  otpDeliveryState.lastError = null;
}
