import { notifyStuckPayouts } from '../discord.js';
import { listStuckPayoutRows } from '../admin/stuck-payouts.js';

let stuckPayoutAlertFired = false;

export const STUCK_PAYOUT_WATCHDOG_INTERVAL_MS = 60 * 1000;

export async function runStuckPayoutWatchdog(args?: {
  thresholdMinutes?: number;
  limit?: number;
}): Promise<void> {
  const thresholdMinutes = args?.thresholdMinutes ?? 5;
  const limit = args?.limit ?? 20;
  const rows = await listStuckPayoutRows({ thresholdMinutes, limit });
  if (rows.length === 0) {
    stuckPayoutAlertFired = false;
    return;
  }
  if (stuckPayoutAlertFired) return;
  stuckPayoutAlertFired = true;

  const pendingCount = rows.filter((row) => row.state === 'pending').length;
  const submittedCount = rows.length - pendingCount;
  const oldest = rows.reduce((max, row) => (row.ageMinutes > max ? row.ageMinutes : max), 0);
  const firstRow = rows[0] ?? null;

  notifyStuckPayouts({
    rowCount: rows.length,
    thresholdMinutes,
    oldestAgeMinutes: oldest,
    pendingCount,
    submittedCount,
    payoutId: firstRow?.id ?? null,
    assetCode: firstRow?.assetCode ?? null,
  });
}

export function __resetStuckPayoutWatchdogForTests(): void {
  stuckPayoutAlertFired = false;
}
