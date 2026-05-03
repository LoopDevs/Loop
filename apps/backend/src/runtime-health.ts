import { env } from './env.js';

export type RuntimeWorkerName =
  | 'asset_drift_watcher'
  | 'interest_scheduler'
  | 'payment_watcher'
  | 'payout_worker'
  | 'procurement_worker';

interface MutableWorkerState {
  required: boolean;
  running: boolean;
  blockedReason: string | null;
  startedAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastErrorAtMs: number | null;
  lastError: string | null;
  staleAfterMs: number | null;
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
  enabled: Boolean(env.LOOP_AUTH_NATIVE_ENABLED),
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

export function setOtpDeliveryEnabled(enabled: boolean): void {
  otpDeliveryState.enabled = enabled;
}

export function recordOtpSendSuccess(): void {
  otpDeliveryState.enabled = true;
  otpDeliveryState.lastSuccessAtMs = Date.now();
  otpDeliveryState.lastError = null;
}

export function recordOtpSendFailure(err: unknown): void {
  otpDeliveryState.enabled = true;
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
      const stale =
        state.required &&
        state.running &&
        state.staleAfterMs !== null &&
        state.lastSuccessAtMs !== null &&
        now - state.lastSuccessAtMs > state.staleAfterMs;
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
  otpDeliveryState.enabled = Boolean(env.LOOP_AUTH_NATIVE_ENABLED);
  otpDeliveryState.lastSuccessAtMs = null;
  otpDeliveryState.lastFailureAtMs = null;
  otpDeliveryState.lastError = null;
}
