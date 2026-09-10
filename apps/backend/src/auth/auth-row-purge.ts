// Auth-row retention purge sweeper — CF-26, X-PRIV-07, X-PRIV-08, AGT-06
import { config } from '../config/index.js';
import { logger } from '../logger.js';
import { purgeExpiredOtps } from './otps.js';
import { purgeDeadRefreshTokens } from './refresh-tokens.js';
import { purgeStaleOtpAttemptCounters } from './otp-attempt-counter.js';
import { purgeExpiredIdTokenUses } from './id-token-replay.js';
import {
  markWorkerStarted,
  markWorkerStopped,
  markWorkerTickFailure,
  markWorkerTickSuccess,
} from '../runtime-health.js';

const log = logger.child({ area: 'auth-row-purge' });

export interface AuthRowPurgeTickResult {
  otpsDeleted: number;
  refreshTokensDeleted: number;
  otpAttemptCountersDeleted: number;
  idTokenUsesDeleted: number;
}

// CF-14 (X-2): DELETE-WHERE is idempotent across instances; no SKIP LOCKED needed.
export async function runAuthRowPurgeTick(args?: {
  retentionMs?: number;
  now?: Date;
}): Promise<AuthRowPurgeTickResult> {
  const retentionMs = args?.retentionMs ?? config.auth.retention.retainDays * 24 * 60 * 60 * 1000;
  const now = args?.now;
  const otpsDeleted = await purgeExpiredOtps({ retentionMs, ...(now ? { now } : {}) });
  const refreshTokensDeleted = await purgeDeadRefreshTokens({
    retentionMs,
    ...(now ? { now } : {}),
  });
  const otpAttemptCountersDeleted = await purgeStaleOtpAttemptCounters({
    retentionMs,
    ...(now ? { now } : {}),
  });
  const idTokenUsesDeleted = await purgeExpiredIdTokenUses({
    retentionMs,
    ...(now ? { now } : {}),
  });
  return {
    otpsDeleted,
    refreshTokensDeleted,
    otpAttemptCountersDeleted,
    idTokenUsesDeleted,
  };
}

let purgeTimer: ReturnType<typeof setInterval> | null = null;

export function startAuthRowPurge(args?: { intervalMs?: number }): void {
  if (purgeTimer !== null) return;
  const intervalMs = args?.intervalMs ?? config.auth.retention.purgeIntervalHours * 60 * 60 * 1000;
  markWorkerStarted('auth_row_purge', { staleAfterMs: Math.max(intervalMs * 3, 60_000) });
  log.info(
    { intervalMs, retentionDays: config.auth.retention.retainDays },
    'Starting auth-row purge sweeper',
  );
  const tick = async (): Promise<void> => {
    try {
      const r = await runAuthRowPurgeTick();
      if (
        r.otpsDeleted > 0 ||
        r.refreshTokensDeleted > 0 ||
        r.otpAttemptCountersDeleted > 0 ||
        r.idTokenUsesDeleted > 0
      ) {
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
