/**
 * Auth-row retention purge sweeper (CF-26 / X-PRIV-07 + X-PRIV-08).
 *
 * Two PII-bearing auth tables grew without bound because nothing ever
 * deleted dead rows:
 *
 *   - `otps` — holds `email` + a SHA-256 code hash. An expired or
 *     consumed OTP is never re-used (verify-otp only matches live,
 *     unconsumed rows), yet the row sat forever. (X-PRIV-07)
 *   - `refresh_tokens` — holds `token_hash` + `user_id`. The
 *     `refresh_tokens_expires` index docstring promised a "periodic
 *     cleanup job that trims fully-expired rows" that never existed.
 *     (X-PRIV-08)
 *
 * This sweeper periodically deletes rows in both tables past a
 * retention grace, via `purgeExpiredOtps` / `purgeDeadRefreshTokens`.
 * DELETE-only — no migration needed.
 *
 * Wiring mirrors the sibling sweeps (`redemption-backfill.ts`,
 * `asset-drift-watcher.ts`): a `start…/stop…` timer pair gated in
 * `index.ts` on `LOOP_WORKERS_ENABLED`, registered with the runtime-
 * health worker registry, with per-tick errors swallowed so a
 * transient DB blip doesn't kill the interval — the next tick retries.
 *
 * Gating note: this runs only when `LOOP_WORKERS_ENABLED=true`, same as
 * the other background workers. In Phase-1 discount mode (workers off)
 * the auth tables still accrue rows; operators flipping the workers on
 * for any reason — or running the manual one-shot in the DSR runbook —
 * reclaim them. See `docs/runbooks/dsr.md` for the manual sweep.
 */
import { env } from '../env.js';
import { logger } from '../logger.js';
import { purgeExpiredOtps } from './otps.js';
import { purgeDeadRefreshTokens } from './refresh-tokens.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';

const log = logger.child({ area: 'auth-row-purge' });

export interface AuthRowPurgeTickResult {
  /** OTP rows deleted this tick. */
  otpsDeleted: number;
  /** Refresh-token rows deleted this tick. */
  refreshTokensDeleted: number;
}

/**
 * Single purge tick. Exported so tests (and the runbook one-shot) can
 * drive it directly. Each table is swept independently so a failure on
 * one still reclaims the other; the OTP delete runs first, then the
 * refresh-token delete, and either error propagates to the caller (the
 * interval loop swallows it for the next tick).
 *
 * @param retentionMs grace before a dead row is eligible for deletion.
 *        Defaults to `LOOP_AUTH_ROW_RETENTION_DAYS`.
 */
export async function runAuthRowPurgeTick(args?: {
  retentionMs?: number;
  now?: Date;
}): Promise<AuthRowPurgeTickResult> {
  const retentionMs = args?.retentionMs ?? env.LOOP_AUTH_ROW_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const now = args?.now;
  const otpsDeleted = await purgeExpiredOtps({ retentionMs, ...(now ? { now } : {}) });
  const refreshTokensDeleted = await purgeDeadRefreshTokens({
    retentionMs,
    ...(now ? { now } : {}),
  });
  return { otpsDeleted, refreshTokensDeleted };
}

// ─── Interval loop ────────────────────────────────────────────────────────

let purgeTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Starts the periodic auth-row purge sweeper. Gated at the caller
 * (`index.ts`) by `LOOP_WORKERS_ENABLED`. Per-tick errors are swallowed
 * so a transient DB blip doesn't kill the interval.
 */
export function startAuthRowPurge(args?: { intervalMs?: number }): void {
  if (purgeTimer !== null) return;
  const intervalMs = args?.intervalMs ?? env.LOOP_AUTH_ROW_PURGE_INTERVAL_HOURS * 60 * 60 * 1000;
  markWorkerStarted('auth_row_purge', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info(
    { intervalMs, retentionDays: env.LOOP_AUTH_ROW_RETENTION_DAYS },
    'Starting auth-row purge sweeper',
  );
  const tick = async (): Promise<void> => {
    try {
      const r = await runAuthRowPurgeTick();
      if (r.otpsDeleted > 0 || r.refreshTokensDeleted > 0) {
        log.info(r, 'Auth-row purge tick reclaimed rows');
      }
      markWorkerTickSuccess('auth_row_purge');
    } catch (err) {
      markWorkerTickFailure('auth_row_purge', err);
      log.error({ err }, 'Auth-row purge tick failed');
    }
  };
  void tick();
  purgeTimer = setInterval(() => void tick(), intervalMs);
  purgeTimer.unref();
}

export function stopAuthRowPurge(): void {
  if (purgeTimer === null) return;
  clearInterval(purgeTimer);
  purgeTimer = null;
  markWorkerStopped('auth_row_purge');
  log.info('Auth-row purge sweeper stopped');
}
